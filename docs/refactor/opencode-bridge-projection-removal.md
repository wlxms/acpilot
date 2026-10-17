# OpenCode projection 层移除记录

> 当前状态（已落地）：OpenCode 已直接由 `OpenCodePipeline` 解包并解析 raw
> `OpenCodeStreamEvent`，再把统一 SSP 写入构造时绑定的 SSS。旧的
> `OpenCodeBridge`/`BackendBridge`、`createBridge`、`setSSS`、共享 `AcpEvent` 投影
> 类型和 projection 函数不再是运行时主链路。本文后半部分保留原始迁移记录，作为
> 设计背景和字段映射参考，不是当前待执行的任务清单。

当前模型链路也已归属 Backend：每个 Backend 只有一个 Copilot Vendor，模型目录由
`CopilotModelCatalog` 聚合，调用统一进入对应 Backend 的 `BackendModelProvider`。
Copilot 接入层不再直连 AI SDK 或 provider API。

---

## 背景与问题

### 什么是 projection，为什么要删

历史上，文件 `src/backends/opencode/opencode-bridge.ts`（约 1747 行）是 OpenCode
后端的协议解释器，把 OpenCode SDK 的 SSE 事件流转换成 SSS
（SerializableSessionStream）的 push 调用。

本次重构前的架构有一个 **projection 中间层**：
```
rawEvent (OpenCodeStreamEvent)
  → projectOpenCodeStreamEvent()    [projection：字段重命名 + 状态扁平化]
  → AcpEvent                         [投影后的中间类型]
  → 15 个 handler 方法（消费 AcpEvent）
  → sss.push(SSP)
```

**问题**：
1. `AcpEvent` 及其子类型（`AcpPartUpdatedEvent`、`AcpToolPart`、`AcpPermissionRequestEvent` 等约 15 个）定义在 `src/backend/types.ts`（共享层），但**实际只有 OpenCode backend 用**。这是历史误命名——“Acp” 前缀暗示是标准 Agent Client Protocol，其实只是 OpenCode 私有 SSE 协议的归一化形态。
2. projection 是一个纯重命名的中间层，增加了一层不必要的间接性。标准 ACP 后端（`src/backends/acp/`）根本不碰这套类型，它消费官方 SDK 的 `SessionUpdate`。

### 已落地终态

```
rawEvent (OpenCodeStreamEvent)
  → OpenCodePipeline.run() 直接解包（unwrapOpenCodeStreamEvent）
  → 15 个 handler 方法直接消费 raw OpenCodeEvent，读 raw 字段名
  → sss.push(SSP)
```

- projection 函数、`OpenCodeProtocolBridge` 和共享 `AcpEvent` 事件类型均已移除。
- OpenCode Pipeline 的 handler 直接消费 raw OpenCode 事件并在本地处理工具状态、子
  session 和增量事件。
- 模型目录按 `backendId` 隔离，每个 Backend 的单一 Vendor 只暴露自身可执行模型。

---

## 关键文件与字段映射（历史参考）

本节记录 projection 移除时使用过的 raw 字段对照。它用于理解旧数据和审阅历史
提交，不是当前 `OpenCodePipeline` 的新增任务；当前实现入口和内部类型以
`pipeline.ts`、`pipeline-types.ts` 与 `sdk-events.ts` 为准。

### 原始事件类型（src/backends/opencode/sdk-events.ts）

这是 **raw 字段名**（大写 ID、嵌套 time、tool 而非 toolName）。handler 要直接读这些：

| Raw 字段 | 旧投影字段（要替换掉） | 说明 |
|----------|---------------------|------|
| `part.messageID` | `part.messageId` | 注意大写 ID |
| `part.sessionID` | `part.sessionId` | |
| `part.callID` | `part.callId` | |
| `part.tool` | `part.toolName` | |
| `part.state.time.start` / `part.state.time.end` | `part.state.startTime` / `part.state.endTime` | **嵌套拆平**，见下 |
| `event.properties.part` | `event.part` | raw 事件的 part 在 properties 里 |
| `event.properties.delta` | `event.delta` | |
| `event.properties.partID` | `event.partId` | |
| `event.properties.sessionID` | `event.sessionId` | |
| `event.properties.id` | `event.permissionId` / `event.questionId` | permission/question 事件 |
| `event.properties.metadata.filepath` | `event.metadata.filepath` | permission 事件 |
| `event.properties.tool.callID` | `event.tool.callId` | permission 事件 |
| `event.properties.info.id` | `event.sessionId`（session.* 事件） | |
| `event.properties.info.parentID` | `event.parentId`（session.created） | 子会话路由用 |
| `event.properties.diff` | `event.diffs`（session.diff） | |

### StreamToolState 的嵌套结构（raw）vs AcpToolState（扁平，要删）

```typescript
// RAW StreamToolState（sdk-events.ts）—— 判别联合，time 嵌套
type StreamToolState =
  | { status: 'pending'; input: Record<string, unknown> }
  | { status: 'running'; input; title?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
  | { status: 'completed'; input; output?: string; title?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
  | { status: 'error'; input; error?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } };

// 旧 AcpToolState（types.ts，要删）—— 扁平
interface AcpToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  startTime?: number;   // ← 从 time.start 拆平
  endTime?: number;     // ← 从 time.end 拆平
}
```

SSP 的 `SerializableToolState`（`src/ssp/types.ts`）是**扁平的**（有 `startTime`/`endTime`）。所以 handler 在构建 SSP 的 `state` payload 时，必须把 raw `StreamToolState` 扁平化成 `SerializableToolState`。

**历史建议（已由当前实现取代）**：当时曾考虑在 opencode 文件夹内定义
`flattenToolState(raw: StreamToolState): BridgeToolState`。当前实现不创建
`BridgeToolState`，而是在 `pipeline-types.ts`/`OpenCodePipeline` 内使用
`PipelineToolState` 与现有 `SerializableToolState` 映射；raw 的 `time.{start,end}`
仍需在构建 SSP 时转换为 `startTime/endTime`。

### sessionId 提取

raw 事件的 sessionId 分布：
- `message.part.updated`: `event.properties.part.sessionID`
- `message.part.delta`: `event.properties.sessionID`
- `session.created`/`session.updated`/`session.deleted`: `event.properties.info.id`
- `permission.asked`/`question.asked`/其他: `event.properties.sessionID`

需要一个 `getRawEventSessionId(event: OpenCodeEvent): string | undefined` 帮助函数，按 event.type 分支提取。

---

## 历史迁移记录（已完成）

以下章节保留当时的拆解步骤、raw 字段映射和验证要求，便于追溯实现决策。它们已经
完成，不应再作为当前架构的 API 或实施计划；当前公共边界以
`src/backend/backend.ts`、`src/surfaces/vscode/model-catalog.ts` 和各 Backend 实现为准。

> 历史参考说明：下面出现的 `bridge-types.ts`、`BridgeToolState`、旧
> `OpenCodeBridge`/`OpenCodeProtocolBridge`、`writeLegacyEvent`、
> `readLegacySessionEvents` 和 `rawAcpEvent` 是当时讨论或迁移检查中的名称，不代表
> 当前必须创建或保留的 API。当前实现使用
> `src/backends/opencode/pipeline.ts`、`pipeline-types.ts`（含
> `PipelineToolState`）和 v2 SSP serializer；生产代码没有旧 event 读写路径。

### 历史任务 1：新建 opencode 内部类型文件

**新建** `src/backends/opencode/bridge-types.ts`，把 OpenCode 私有的事件/工具状态类型从 `src/backend/types.ts` **移动**过来（不是复制——types.ts 里的要删，见任务 4）。内容：
- `BridgeToolState`（扁平，匹配 SerializableToolState）
- 其他 OpenCode 内部需要的类型（如果 handler 需要参数化的中间类型）

**注意**：大部分情况不需要中间事件类型——handler 直接读 raw `OpenCodeEvent` 即可。只在确实需要的地方定义最小化的内部类型。

### 历史任务 2：重写 OpenCodePipeline 的入口与 dispatch

文件：`src/backends/opencode/opencode-bridge.ts`

1. **改 import**：删除从 `../../backend/types` 导入 `AcpEvent`/`AcpPartUpdatedEvent`/`AcpPartDeltaEvent`/`AcpPermissionRequestEvent`/`AcpQuestionRequestEvent`/`AcpQuestionInfo`/`AcpTextPart`/`AcpToolPart`/`AcpToolState`。改为从 `./sdk-events` 导入 raw 类型：`OpenCodeEvent`、`MessagePartUpdatedEvent`、`MessagePartDeltaEvent`、`PermissionAskedEvent`、`QuestionAskedEvent`、`StreamToolPart`、`StreamToolState`、`TextStreamPart`、`ReasoningStreamPart` 等（按实际需要）。从 `./bridge-types` 导入 `BridgeToolState`。

2. **`run()` 方法**：直接解包 + 直接 dispatch raw event：
   ```typescript
   async run(events: AsyncIterable<OpenCodeStreamEvent>, token): Promise<boolean> {
     for await (const streamEvent of events) {
       if (token.isCancellationRequested) break;
       const raw = unwrapOpenCodeStreamEvent(streamEvent);
       if (await this.handleEvent(raw)) break;
     }
   }
   ```
   删除调用 `projectOpenCodeStreamEvent`。删除 `runWithProjected` 方法（不再需要）。

3. **`handleEvent(event: OpenCodeEvent)`**：switch 改为 raw 事件类型：
   ```typescript
   switch (event.type) {
     case 'message.part.updated': this.handlePartUpdated(event); break;
     case 'message.part.delta':   this.handlePartDelta(event); break;
     case 'permission.asked':     this.handlePermissionAsked(event); break;
     case 'question.asked':       this.handleQuestionAsked(event); break;
     case 'session.updated':      await this.handleSessionUpdated(event); break;
     case 'session.created':      this.handleSessionCreated(event); break;
     case 'session.idle':         return this.handleSessionIdle();
     case 'session.diff':         this.handleSessionDiff(event); break;
     case 'session.status':       break;
   }
   ```
   子会话路由用 `getRawEventSessionId(event)`。

### 历史任务 3：逐个重写 15 个 handler（核心工作）

每个 handler 改参数类型为 raw 类型，改字段访问为 raw 字段名。完整清单（按文件顺序）：

1. **`handlePartDelta(event: MessagePartDeltaEvent)`** —— 读 `event.properties.delta`、`event.properties.partID`、`event.properties.sessionID`。
2. **`handlePartUpdated(event: MessagePartUpdatedEvent)`** —— 提取 `const part = event.properties.part; const eventSessionId = part.sessionID ?? undefined;`，调用 `handlePartUpdatedForTarget(event, target, ...)`.
3. **`handlePartUpdatedForTarget(event: MessagePartUpdatedEvent, target, captureRootUserMessage)`** —— 内部用 `part = event.properties.part`。`part.messageId`→`part.messageID`，`part.sessionId`→`part.sessionID`，`part.callId`→`part.callID`，`part.toolName`→`part.tool`。text/reasoning/tool case 的所有字段访问都要改。
4. **`renderDeltaToTarget(event: MessagePartDeltaEvent, fallbackTarget)`** —— `event.delta`→`event.properties.delta`，`event.partId`→`event.properties.partID`，`event.sessionId`→`event.properties.sessionID`。
5. **`pushSystemNoticeTool(target, part: TextStreamPart, notice, eventSessionId)`** —— `part.messageId`→`part.messageID`，`part.sessionId`→`part.sessionID`。
6. **`ensureRootSubagentScope(part: StreamToolPart, sessionId)`** —— `part.toolName`→`part.tool`，`part.callId`→`part.callID`，`part.state?.title`（注意 running/completed 才有 title）。
7. **`handleToolState(part: StreamToolPart, target, eventSessionId)`** —— `part.callId`→`part.callID`，`part.toolName`→`part.tool`，`part.messageId`→`part.messageID`，`part.sessionId`→`part.sessionID`。`state` 用 `flattenToolState(part.state)`。构建 SSP 时传扁平后的 state。
8. **`completeScopeFromToolPart(part: StreamToolPart, sessionId)`** —— `part.toolName`→`part.tool`，`part.callId`→`part.callID`，`part.state.output`（注意 completed 才有 output）。
9. **`handlePermissionAsked(event: PermissionAskedEvent)`** —— 读 `event.properties.id`（permissionId）、`event.properties.sessionID`、`event.properties.metadata?.filepath`、`event.properties.tool?.callID`、`event.properties.permission`、`event.properties.patterns`、`event.properties.always`。
10. **`startExternalEdit(event, target)`** —— 同上字段。
11. **`handleQuestionAsked(event: QuestionAskedEvent)`** —— `event.properties.id`（questionId）、`event.properties.sessionID`、`event.properties.questions`（QuestionInfo[]）。
12. **`startQuestion(event, target)`** —— 同上，`mapQuestionAnswers` 用 raw QuestionInfo。
13. **`handleSessionUpdated(event)`** —— `event.properties.info?.title`。
14. **`handleSessionCreated(event)`** —— `event.properties.info`（含 id/parentID/title）。
15. **`handleSessionDiff(event)`** —— `event.properties.sessionID`、`event.properties.diff`（raw diff 数组）。
16. **`handleChildSessionEvent(event, eventSessionId)`** —— 子会话路由，读 `event.properties.info?.parentID`、`event.properties.part` 等。**这是最复杂的**（约 150 行），注意所有 `event.part`→`event.properties.part`、`event.parentId`→`event.properties.info.parentID`、`event.diffs`→`event.properties.diff`。
17. **`bufferChildEvent`、`handleSubagentToolPart`、`updateScopeTool`、`getToolSessionId`、`describeEvent`、`describePart`** —— 同样改 raw 字段。

**关键检查点**：`getToolSessionId(state)` 读 `state.metadata?.sessionId ?? state.metadata?.sessionID`。raw `StreamToolState` 的 `metadata` 只在 running/completed/error 分支存在，注意类型收窄。

### 历史任务 4：物理删除 projection 函数

文件底部有这些函数，**全部删除**：
- `projectOpenCodeStreamEvent`
- `projectStreamPart`
- `projectToolState`
- `isAcpEvent`（如果有）
- `toAcpFileDiff`
- `formatOpenCodeError`
- 重复的 `getRawEventSessionId`（保留任务 2 新建的那个）
- **保留** `unwrapOpenCodeStreamEvent`（run() 用）、`previewText`（日志用）

### 历史任务 5：删除 OpenCodeProtocolBridge

文件底部有 `export class OpenCodeProtocolBridge`（@deprecated wrapper），**删除整个类**。然后修复引用：
- `src/test/streaming.test.ts`：之前改成了 `OpenCodeProtocolBridge`，要改回 `OpenCodeBridge`，但**注意**测试现在喂的是 AcpEvent 格式的事件（如 `{type:'part.updated', part:{...}}`）。要么把测试事件生成器改成 raw 格式（如 `{type:'message.part.updated', properties:{part:{...}}}`），要么保留一个测试专用的桥。**推荐**：改测试事件生成器为 raw 格式（最彻底）。详见任务 8。
- 搜索全仓库 `OpenCodeProtocolBridge` 引用，全部修复。

### 历史任务 6：删除 AcpEvent 及子类型

文件：`src/backend/types.ts`（注意：Phase 2 把 `src/acp/` 重命名成了 `src/backend/`）。

**删除**：`AcpEvent`、`AcpPartUpdatedEvent`、`AcpPartDeltaEvent`、`AcpPermissionRequestEvent`、`AcpPermissionReplyEvent`、`AcpQuestionRequestEvent`、`AcpQuestionReplyEvent`、`AcpQuestionRejectedEvent`、`AcpQuestionInfo`、`AcpQuestionOption`、`AcpSessionIdleEvent`、`AcpSessionDiffEvent`、`AcpSessionLifecycleEvent`、`AcpSessionStatusEvent`、`AcpServerLifecycleEvent`、`AcpTextPart`、`AcpReasoningPart`、`AcpToolPart`、`AcpToolState`、`AcpToolStatus`、`AcpStepPart`、`AcpBasePart`、`AcpStreamPart`、`AcpPartType`、`AcpFileDiff`、`AcpEventType` 等所有 `Acp*Event`/`Acp*Part` 类型。

**保留**（这些不是事件类型，是持久化/后端契约）：
- `BackendModel`、`BackendAgent`、`BackendConfig`、`BackendSessionInfo` 等持久类型
- `OpaqueEventStreamPartPayload` / `OpaqueEventSSP` 相关（unknown-kind 受限兜底，保持
  backend-neutral；当前主链路统一写 `opaqueEvent`，不再读取旧 `rawAcpEvent`）

删除后跑 `npx tsc --noEmit`，**修复所有因删除导致的引用错误**（grep 全仓库 `AcpEvent` 等找出残留引用）。残留引用可能在：
- `src/participant/handler.ts`（死 import，删）
- `src/backends/opencode/opencode-bridge.ts`（应在任务 2-3 已处理）
- 测试文件（见任务 8）
- 旧迁移脚本/legacy 输入兼容（若从历史分支带入）不属于当前主链路；生产代码中不应
  再新增 `rawAcpEvent` 读写分支。

### 历史任务 7：修多后端隔离 bug —— ACPModels vendor 污染

模型隔离问题已解决。历史的共享模型同步目录已删除；当前由
`src/surfaces/vscode/model-catalog.ts` 的 `CopilotModelCatalog` 聚合各 Backend 的
`BackendModelProvider.listModels()` 结果。每条注册都带有 `backendId`，Language Model
Provider 同时按 Vendor 和 Backend 过滤，避免跨后端暴露或路由模型。OpenCode 当前只
使用单一 `opencode` Vendor，不再存在 Zen 多 Vendor 别名。

### 历史任务 8：修多后端隔离 bug —— StatusBar activeBackendId

文件：`src/extension.ts`、`src/statusbar.ts`

状态栏隔离问题已解决。`StatusBarManager` 按 Backend 保存状态并维护当前活跃
Backend，请求入口和后端选择变化时更新 active backend，单个状态栏只展示当前后端。

实现保持单个状态栏项，由 `StatusBarManager` 内部维护状态 Map 和 active backend。

### 历史任务 9：测试文件适配

1. `src/test/streaming.test.ts` 已改为直接覆盖 `OpenCodePipeline` 的 raw 事件输入；不再
   依赖已删除的协议桥接 wrapper 或投影事件。

2. **`src/test/serializable/serializer.test.ts`**：历史检查曾要求确认
   `writeLegacyEvent`/`readLegacySessionEvents`；当前 serializer 已移除这两个 API，
   测试应只覆盖 v2 `writeStreamPart`、snapshot、turn envelope 和对应读取函数。

3. 其余测试中的共享 `AcpEvent` 与旧 wrapper 引用已清理。

### 历史任务 10：最终验证

当时的局部验证结果已过时。当前分支应以仓库现有命令为准：
`npm run lint`、`npm test`（当前 555 个用例）和 `npm run test:runtime`；不要根据本节
旧的“3 个文件、10 个用例”数字判断完成度。

---

## 风险提示

1. **handleChildSessionEvent 是最复杂的**（约 150 行，子会话路由、ad-hoc cast、buffering）。审计警告它有 ~10 处 cast 假定投影 shape。逐处改为读 raw `event.properties.*`。
2. **tool state 嵌套**：raw `StreamToolState.time.{start,end}` 必须在构建 SSP 时扁平化为 `startTime/endTime`。漏了会导致 SSP 工具状态显示错误。
3. **不要保留任何 projection 函数**——用户明确否决了“projection 私有化”方案。
4. **每步验证**：改完一个 handler 就跑 tsc，确保错误数下降而非上升。

## 字段映射速查卡（打印参考）

```
messageID ← messageId        (part.messageID)
sessionID  ← sessionId       (part.sessionID, event.properties.sessionID)
callID     ← callId          (part.callID, event.properties.tool.callID)
tool       ← toolName        (part.tool)
state.time.start ← state.startTime   (flattenToolState)
state.time.end   ← state.endTime     (flattenToolState)
event.properties.part     ← event.part
event.properties.delta    ← event.delta
event.properties.partID   ← event.partId
event.properties.id       ← event.permissionId / event.questionId
event.properties.metadata.filepath ← event.metadata.filepath
event.properties.info.id  ← event.sessionId (session.* events)
event.properties.info.parentID ← event.parentId (session.created)
event.properties.diff     ← event.diffs (session.diff)
```
