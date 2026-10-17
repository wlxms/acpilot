# Streaming 渲染技术文档

> **历史实现记录**：本文描述重构前的 OpenCode 专用 `StreamBridge` 流程。当前生产
> 路径由每个 Backend 的 `BackendPipeline` 直接把原始事件转换为 SSP，并写入绑定的
> SSS。现行边界见 [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md)。

## 架构选型：SSE 事件流 vs 轮询

### 结论

**必须使用 SSE 事件流（Server-Sent Events），禁止使用轮询方案。**

### 原因

OpenCode 服务端通过 `/event` SSE 端点推送两种粒度的实时事件：

| 事件类型 | 粒度 | 用途 |
|---|---|---|
| `message.part.updated` | 整个 Part 的状态变更 | 工具状态机 `pending→running→completed` |
| `message.part.delta` | 单次增量文本（几个 token） | 逐字流式输出思考/回复 |
| `session.idle` | 信号 | 标记回合结束 |

轮询（`promptAsync` + `messages()` 轮询）只能拿到 **已完成** 的 Part 快照，丧失了：

1. **逐字流式**：SSE 的 `delta` 是几个 token 的增量，轮询拿到的是整个 `part.text`
2. **工具状态机**：SSE 有 `pending→running→completed` 三阶段渐进渲染，轮询只能拿到 `completed`
3. **实时性**：SSE 服务端推送延迟毫秒级，轮询至少 400ms

---

## SSE 事件处理流程

## 文件气泡（read/view）渲染研究结论

### 背景

在 VSCode / Copilot Chat 中，`read` / `view` 工具的文件引用有时会显示为“文件气泡”。
本仓库对该行为做过专门实验，目标不是复刻一个近似 UI，而是找出**什么生命周期阶段会保留或破坏气泡**。

### 关键结论

1. **初始 `MarkdownString` 文件气泡格式是可行的**

   运行态的 `read` 消息使用如下格式时，可以渲染为文件气泡：

   ```ts
   new vscode.MarkdownString(`Read [](${uri}#${start}-${end})`)
   ```

2. **`updateToolInvocation(...)` 不是主要破坏点**

   在目标环境中，单独加入 `updateToolInvocation` 并不会必然让气泡消失。

3. **completed state 的 plain-string `pastTenseMessage` 才是关键破坏点**

   如果工具完成后切换成：

   ```ts
   part.pastTenseMessage = `Read file.ts`
   ```

   那么之前的文件气泡会被普通文本覆盖掉。

4. **completed state 只要继续保持 Markdown bubble，气泡就能保留**

   也就是说，`invocationMessage` 和 `pastTenseMessage` 都要保持同一套 bubble markdown。

### 实际规则

对 `read` 工具：

- 运行态：使用 `Read [](${uri}#range)`
- 完成态：`pastTenseMessage` 也必须继续使用同样的 `Read [](${uri}#range)` 风格
- 不要在完成态退回普通字符串

### Windows URI 说明

实验里对 `file:///...` URI 使用了 `.toLowerCase()` 处理，以匹配在 Windows 上更稳定的文件气泡形式。

### 稳定兜底方案

如果目标是“稳定可点击跳转”，而不是强依赖 Copilot 风格的单气泡视觉效果，则公开 API 下最稳的方式仍然是：

```ts
toolSpecificData = {
  values: [new vscode.Location(uri, range)]
} satisfies ChatToolResourcesInvocationData;
```

这会渲染为稳定的资源条目/文件引用列表。

### 端点选择：使用 `/global/event`，不再为每个请求单独订阅 `/event`

当前 SDK/服务端组合里，`client.event.subscribe()` 对应 `/event`，真实运行时只稳定产出服务级事件，例如 `server.connected`，不足以承载会话内的 `message.part.*` 流式事件。

因此当前实现改为：

1. 扩展级只建立一个 `/global/event` 订阅
2. 在扩展内按 `sessionID` 做事件分发
3. 每个 VS Code chat 请求只消费自己会话对应的事件队列

这避免了两个问题：

- 每个请求各自建立 `/global/event` 连接会重复消费同一份全局事件流
- 直接在 `StreamBridge` 里过滤全局事件，仍然会暴露跨会话 `session.idle`、子代理事件、目录级事件等串流干扰

---

### 事件时序

一个完整的对话回合，SSE 事件按以下顺序到达：

```
message.part.updated  type=text         ← 用户回显（记录 messageID 后跳过）
message.part.updated  type=reasoning    ← 思考部分创建（空文本）
message.part.delta    field=text        ← 思考 token 增量 → thinkingProgress()
message.part.updated  type=tool         ← 工具调用（state.status=pending）
message.part.updated  type=tool         ← 工具调用（state.status=running，含 input）
message.part.updated  type=tool         ← 工具调用（state.status=completed，含 output）
... (可能多个工具循环)
message.part.updated  type=text         ← AI 文本部分创建（空文本）
message.part.delta    field=text        ← AI token 增量 → markdown()
session.idle                             ← 回合结束信号
```

### 消费模式：Broker + Fire-and-Forget

```typescript
// 1. 先为当前 OpenCode session 打开一个本地事件队列
const events = state.eventBroker.openSessionStream(sessionId);

// 2. 确保扩展级全局 SSE broker 已启动
await state.eventBroker.ensureStarted(client, outputChannel);

// 3. Fire-and-forget：不 await prompt，让事件并发流过
const promptPromise = client.session
  .prompt({ path: { id: sessionId }, body: { parts: [...] } })
  .catch(err => { /* log error */ });

// 4. 消费当前 session 对应的事件流（并发的）
await bridge.bridgeEventsToStream(events, stream, token);

// 5. 最后才 await prompt
await promptPromise;
```

**为什么不能 await prompt()：** `prompt()` 内部是 HTTP POST，服务端在处理期间保持连接。如果 await，所有 SSE 事件在 await 期间触发，但此时没有任何消费者在读取事件流 → 事件丢失。

**为什么要先打开 session 队列，再启动 broker：** 在测试环境或异常场景里，全局 SSE 可能很快结束。如果先启动 broker、后创建 session 队列，当前请求可能会拿到一个永远等不到结束信号的空队列。

---

## SDK 调用格式

### 正确格式（path/body/query）

```typescript
// session.create
client.session.create({
  body: {},
  query: directory ? { directory } : undefined,
});

// session.prompt
client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: prompt }] },
  query: directory ? { directory } : undefined,
});

// session.revert
client.session.revert({
  path: { id: sessionId },
  body: { messageID: messageId },
  query: directory ? { directory } : undefined,
});
```

### 错误格式（flat 格式，会导致 SSE 事件不触发）

```typescript
// ❌ 不要使用这种 flat 格式
client.session.prompt({
  sessionID: sessionId,
  parts: [{ type: 'text', text: prompt }],
  directory,
});
```

`flat` 格式会让 SDK 生成错误的 HTTP 请求 → 服务端无法正确关联 session → SSE 只会收到服务级生命周期事件，收不到当前会话的 `message.part.*` 处理事件。

---

## 多会话模型

### VS Code 侧状态边界

VS Code chat participant 是在扩展 `activate()` 中创建一次的，请求处理函数运行在同一个扩展 host 进程里。因此：

- 扩展内存是共享的
- 不能假设“每个聊天页一个独立 participant 实例”
- 必须显式按 chat/session 维度做状态隔离

当前实现的隔离方式：

- `request.sessionId` 标识 VS Code chat 会话
- `state.sessionMap` 维护 `VS Code chat sessionId -> OpenCode sessionId`
- `context.history` 只代表当前 chat session 的历史，而不是所有聊天页的全局历史

### 为什么不能做“切换聊天页时再重放缓存”

当前 VS Code Chat API 没有提供“用户切换到某个聊天页”时的 participant 回调，也没有允许扩展在请求处理函数结束后重新拿到同一条响应的 `ChatResponseStream`。

因此能做的是：

- 在请求仍进行中时，持续把该请求对应的 OpenCode 事件路由到它自己的 `ChatResponseStream`
- 在扩展级缓存尚未被当前请求消费的会话事件，直到该请求的 bridge 消费它们

不能做的是：

- 在请求处理函数已经返回后，等用户切换回某个聊天页，再把旧缓存“补画”到那条历史响应里

换句话说，支持的是“多会话并发中的正确路由”，不是“已结束请求的任意时刻重放”。

---

## GlobalEventBroker 设计

### 目标

`GlobalEventBroker` 是扩展级单例，负责：

1. 只建立一次 `/global/event` 长连接
2. 按 `sessionID` 将事件路由到会话专属队列
3. 通过 `partID -> sessionID` 映射把 `message.part.delta` 路由回正确会话
4. 在 `session.idle` 时关闭对应会话队列，结束该次请求的 bridge

### 为什么需要 partID 映射

`message.part.delta` 事件只有 `partID`，没有稳定的 `sessionID` 字段。为了把 delta 路由回正确会话，broker 必须先从 `message.part.updated` 中记录：

```typescript
partID -> sessionID
```

之后再用这个映射分发 delta。

### 生命周期

```typescript
handler(request)
  -> openSessionStream(sessionId)
  -> ensureStarted(client)
  -> prompt(...)
  -> bridgeEventsToStream(sessionQueue)

broker
  -> global.event()
  -> dispatch by sessionID
  -> close session queue on session.idle
```

### 对多会话并发的影响

这种设计下：

- 同时发起多个 chat 请求时，共享一个全局 SSE 连接
- 每个请求消费自己的 session 队列
- 其他会话的 `session.idle` 不会提前结束当前请求
- 非当前会话的 delta 不会串到错误的 chat 页里

---

## 工具调用渲染

### 状态机：pending → running → completed

```
┌──────────────────────────────────────────────────────────┐
│ pending                                                   │
│   → beginToolInvocation(callID, toolName)  [spinner]      │
│   → toolMetas.set(callID, { name, ... })                  │
├──────────────────────────────────────────────────────────┤
│ running                                                   │
│   → updateToolInvocation(callID, { partialInput })        │
│   → meta.input = state.input; meta.title = state.title    │
├──────────────────────────────────────────────────────────┤
│ completed                                                 │
│   → new ChatToolInvocationPart(toolName, callID)          │
│   → part.toolSpecificData = buildToolSpecificData(...)    │
│   → stream.push(part)                        [完成卡片]    │
│   → toolMetas.delete(callID)                              │
└──────────────────────────────────────────────────────────┘
```

### 工具名 → toolSpecificData 映射

| 工具名 | 数据类型 | UI 效果 |
|---|---|---|
| `bash`, `shell` | `TerminalToolData` | 终端样式：命令行 + 输出 + 耗时 |
| `read`, `list`, `grep` | `SimpleToolResultData` | 可折叠的 Input/Output 块 |
| `write`, `edit` | `ToolResourcesData` | 文件引用列表（可点击跳转） |
| `task`, `subagent` | `SubagentToolData` | 子代理展开面板 |
| 其他 | `SimpleToolResultData` | 通用可折叠降级 |

### 非工具事件的处理

- `message.part.updated` + `type=text`：通过 `messageID` 区分用户回显（跳过）和 AI 回复（记录 partKind）
- `message.part.updated` + `type=reasoning`：仅记录 partKind，等待后续 delta
- `message.part.delta`：根据 partKind 决定走 `thinkingProgress()` 还是 `markdown()`

---

## StreamBridge 类设计

### 核心状态

```typescript
class StreamBridge {
  private userMessageId: string | null;    // 用户消息 ID（用于 turn 追踪）
  private partKinds: Map<string, PartKind>; // partID → 'reasoning' | 'text' | 'tool'
  private toolCallIds: Map<string, string>; // partID → callID
  private toolMetas: Map<string, ToolMeta>; // callID → 累积的工具元数据
}
```

`StreamBridge` 不再负责从全局事件里“挑出”自己的会话，而是假设输入流已经由 `GlobalEventBroker` 过滤到当前 session。它的职责只剩下：

- 把会话内 SSE 事件翻译成 VS Code Chat UI 输出
- 维护当前请求的 `userMessageId` / `partKinds` / tool state
- 在 `session.idle` 时正常结束当前桥接

### userMessageId 的生命周期

```
handlePartUpdated() 中捕获首个非空 text part 的 messageID
    ↓
reset() 中不清除（保留给外部读取）
    ↓
handler.ts 通过 getUserMessageId() 读取
    ↓
写入 turnMap 用于 revert 追踪
```

`reset()` 必须跳过 `userMessageId` — 否则 finally 块执行后，handler 读取时为 null。

### 可选 API 降级

```typescript
hasThinking = typeof stream.thinkingProgress === 'function';
hasToolUI    = typeof stream.beginToolInvocation === 'function';
```

- `hasThinking = false` → reasoning delta 被忽略（用户看不到思考过程）
- `hasToolUI = false` → 工具渲染降级为 markdown 格式（`🔧 **toolName**` + 代码块输出）

---

## 历史教训：为什么轮询方案不可行

### 失败演化路径

```
V2 (22d7abd)     用了 flat SDK 格式 → SSE 事件不触发
     ↓
V2.5 (7f7d567)   误判为 "SSE 不支持" → 抛弃 SSE，改用同步 prompt()
     ↓
V3 (92e566e)     同步太慢 → 改用 promptAsync() + 400ms 轮询
```

### V2 的根因

V2 将 SDK 调用从 `path/body` 格式改为 `flat` 格式，并错误依赖 `/event`：

```typescript
// V2 错误的 flat 格式
client.session.prompt({ sessionID, parts, directory })
```

导致会话事件无法稳定进入渲染链路。V2.5 的注释记录了这个误判：

> *"Server-Sent Events (SSE) via /event only deliver server-level events (server.connected) — session processing events DO NOT flow through SSE."*

### V3 轮询方案的具体缺陷

| 维度 | SSE | 400ms 轮询 |
|---|---|---|
| 文本渲染 | 逐 token（delta） | 整块 part.text 一次性出现 |
| 工具渲染 | 三阶段状态机（spinner→输入→完成） | 仅 completed/error |
| 延迟 | 毫秒级（服务端推送） | 400ms+（poll interval） |
| 取消响应 | 立即 break | 需等下一次 poll |
| 服务端负载 | 1 个长连接 | 频繁 HTTP GET |

### 教训

1. **SDK 格式必须使用 `path/body/query`**，不要发明 flat 格式
2. **`/event` 与 `/global/event` 的语义不同**，不能把服务级 SSE 当成会话级 SSE
3. **多会话场景要在扩展内做 broker/mux**，不要为每个请求各拉一条全局 SSE
4. **SSE 事件不触发时，先排查 SDK 调用格式和订阅端点**，不要假设 SSE 不可用
5. **没有聊天切换事件，就不要设计“切页重放”能力**，应聚焦在进行中请求的正确路由
6. **不要为了解决一个问题（revert）而引入更大的问题（重写渲染层）**
7. **解耦是关键**：revert 逻辑（sessionMap + turnMap + resolveSession）与渲染逻辑（broker + StreamBridge）完全独立，可以独立移植
