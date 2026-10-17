# Permission 机制分析与可行性验证

> **历史实现记录**：本文保留早期 Permission 调研及旧 `StreamBridge` 路径，正文的
> “当前”状态不代表现行代码。权限事件现在由各 Backend Pipeline 映射为统一 SSP；
> 现行边界见 [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md)。
>
> **现行状态（2026-09）**：当前依赖为 `@opencode-ai/sdk@1.16.0`，入口使用
> `@opencode-ai/sdk/v2`；OpenCode 与 ACP Pipeline 已处理 permission 请求并将
> 交互映射到 SSP。下文的 v1 API、版本号和“零匹配”结论均属于历史快照。

## 概述

OpenCode 服务端有一套完整的 permission 系统，可以控制工具（edit、bash、read 等）的执行行为：`allow`（自动执行）、`ask`（暂停等待审批）、`deny`（拒绝）。

（历史快照）当时的 VSCode 扩展 **完全没有处理** `permission.asked` 事件，导致即使服务端配置了 `permission.edit = "ask"`，审批机制也不会在扩展侧生效。现行实现已由 Backend Pipeline 接管。

---

## 1. OpenCode 服务端 Permission 系统

### 1.1 配置格式

在项目根目录 `opencode.json` 中配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "ask",
    "bash": "allow",
    "read": "allow"
  }
}
```

**三种动作：**

| 动作 | 行为 |
|------|------|
| `"allow"` | 自动执行，无需审批 |
| `"ask"` | 暂停工具执行，发出 `permission.asked` 事件，等待客户端回复 |
| `"deny"` | 直接拒绝，工具不执行 |

**细粒度规则（对象语法）：**

```json
{
  "permission": {
    "edit": {
      "*": "deny",
      "src/**/*.ts": "ask",
      "package.json": "allow"
    },
    "bash": {
      "*": "ask",
      "git *": "allow",
      "rm *": "deny"
    }
  }
}
```

规则按模式匹配评估，最后匹配的规则生效。通配符 `"*"` 放前面，更具体的规则放后面。

**可用的 Permission 键：**

| 键 | 覆盖范围 | 匹配内容 |
|----|----------|----------|
| `edit` | `edit`、`write`、`patch`、`multiedit` | 文件路径 |
| `bash` | Shell 命令 | 解析后的命令（如 `git status --porcelain`） |
| `read` | 读取文件 | 文件路径 |
| `glob` | 文件搜索 | glob 模式 |
| `grep` | 内容搜索 | 正则表达式 |
| `task` | 子代理 | 子代理类型 |
| `webfetch` | URL 获取 | URL |
| `websearch` | Web 搜索 | 查询内容 |
| `external_directory` | 项目外路径访问 | 触发时自动 ask |
| `doom_loop` | 重复调用检测（同一输入 3 次） | 触发时自动 ask |

**默认值（无配置时）：**
- 大部分权限默认 `"allow"`
- `doom_loop` 和 `external_directory` 默认 `"ask"`
- `.env` 文件默认拒绝读取

配置优先级（从低到高）：远程配置 → 全局配置 → 项目配置 → 环境变量覆盖。

### 1.2 SSE 事件流

当配置 `permission.edit = "ask"` 且 LLM 决定调用 edit 工具时，事件流如下：

```
message.part.updated  type=tool  status=running     ← 工具开始运行
permission.asked                                        ← 服务端暂停，发出审批请求
                                                         (等待客户端回复)
permission.replied                                      ← 客户端回复后服务端确认
file.edited                                             ← 文件被修改
message.part.updated  type=tool  status=completed      ← 工具完成
session.idle                                            ← 回合结束
```

### 1.3 `permission.asked` 事件结构

```typescript
interface EventPermissionAsked {
  type: "permission.asked";
  properties: {
    id: string;           // 请求 ID，用于回复 API
    sessionID: string;    // 会话 ID
    permission: string;   // "edit" | "bash" | "read" | ...
    patterns: string[];   // 匹配的文件/命令模式
    metadata: {
      filepath?: string;  // 目标文件路径
      diff?: string;      // 完整的 unified diff（仅 edit）
      // ...其他工具特定信息
    };
    always: string[];     // "always" 回复会批准的模式列表
    tool?: {
      messageID: string;  // 关联的消息 ID
      callID: string;     // 关联的工具调用 ID
    };
  };
}
```

**关键：`metadata.diff` 包含完整的 unified diff，可以在审批 UI 中展示具体修改内容。**

### 1.4 Permission Reply API

```typescript
// SDK 方法
client.postSessionIdPermissionsPermissionId({
  path: { id: sessionId, permissionID: permissionAskedEvent.properties.id },
  body: { response: "once" | "always" | "reject" },
  query: { directory: projectDir },
});
```

**三种回复：**

| 回复 | 效果 |
|------|------|
| `"once"` | 仅批准本次请求 |
| `"always"` | 批准本次 + 后续匹配相同模式的请求（当前会话内有效） |
| `"reject"` | 拒绝本次请求 |

### 1.5 SDK 类型定义位置

当时记录的 SDK 版本为 `@opencode-ai/sdk@1.14.41`（历史版本；当前为 1.16.0）：

```
node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
  - EventPermissionUpdated    (L384)
  - EventPermissionReplied    (L388)
  - PostSessionIdPermissionsPermissionIdData  (L2507)

node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
  - OpencodeClient.postSessionIdPermissionsPermissionId()  (L381)

node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts
  - EventPermissionAsked      (L1888)
  - EventPermissionReplied    (L1893)
  - PermissionRequest         (L26)
  - PermissionConfig          (L614)
  - PermissionActionConfig    (L609)
```

---

## 2. 历史扩展状态（缺失分析）

### 2.1 当时完全不处理 Permission 事件

`src/` 目录中搜索 `permission`、`asked`、`replied`、`reply` — **零匹配**（排除无关的 `subtask` 子串）。

### 2.2 三个断裂点

| # | 文件 | 问题 |
|---|------|------|
| 1 | `src/types/events.ts` | `RealEventType` 只定义了 `message.*`、`session.*`、`server.*` — 没有 `permission.asked` |
| 2 | `src/participant/event-broker.ts` | `getSessionId()` 不处理 `permission.asked`，事件走 `default` 分支被忽略 |
| 3 | `src/types/index.ts` | `OpenCodeClient` 接口没有 `postSessionIdPermissionsPermissionId` 方法 |

### 2.3 EventBroker 当前路由逻辑

```typescript
// event-broker.ts L154-170
private getSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case 'message.part.updated': ...    // ✅ 处理
    case 'message.part.delta': ...      // ✅ 处理
    case 'session.idle': ...            // ✅ 处理
    default:
      return getEventSessionIdFromProperties(event);  // ❌ permission.asked 走这里 → 可能返回 undefined → 被丢弃
  }
}
```

### 2.4 Checkpoint ≠ Permission

当前 `CheckpointManager` + `ChatResponseExternalEditPart` 是 **VSCode 的 undo/checkpoint 机制**，不是 permission：

```
ChatResponseExternalEditPart 流程：
  1. send(start=true)  → 捕获文件基线快照
  2. await callback()  → 执行整个 turn（所有 edit 已经执行完毕）
  3. send(start=false) → 启用 undo
```

这是事后撤销，不是事前拦截。Edit 在 `callback()` 内部已经执行完毕，没有用户审批环节。

---

## 3. 可行性验证（真实测试）

### 3.1 测试环境

- OpenCode CLI: v1.14.48
- `@opencode-ai/sdk`: v1.14.41
- 平台: Windows (win32)
- 测试时间: 2026-05-15

### 3.2 Test 1: `permission.edit = "ask"` → 应出现 `permission.asked`

**配置** (`opencode.json`):
```json
{ "permission": { "edit": "ask", "bash": "allow", "read": "allow" } }
```

**操作**: Prompt 要求用 edit 工具修改测试文件中的 `version=1.0.0` → `version=2.0.0`

**结果 ✓ PASSED:**

```
[18:04:20] tool=edit status=running              ← edit 工具开始
[18:04:20] ★ permission.asked ★                  ← 服务端暂停！
           id:         per_e27a93348001TfbzYUFyaD9y7y
           permission: edit
           patterns:   ["_permission_test_file.txt"]
           metadata.diff: "-version=1.0.0\n+version=2.0.0"
           tool:       { messageID: "msg_...", callID: "call_..." }
[18:04:22] REPLY: POST /permissions/{pid} → 200  ← 回复 "once"
[18:04:22] permission.replied reply=once
[18:04:22] file.edited                           ← 修改生效
[18:04:45] tool=edit status=completed
[18:04:48] session.idle

验证点:
  permission.asked 事件收到: YES ✓
  metadata 包含完整 diff:    YES ✓
  tool 字段关联具体调用:      YES ✓
  Reply API 返回 200:        YES ✓
  回复后工具继续执行:         YES ✓
  文件确实被修改:            YES ✓
```

### 3.3 Test 2: 无 permission 配置（默认 allow）→ 不应拦截

**操作**: 移除 `opencode.json`，同样的 edit prompt

**结果 ✓ PASSED:**

```
事件流:
  ... tool=edit 直接 completed ...
  permission.asked seen: NO (符合预期)
  File modified to 3.0.0: YES

验证点:
  无 permission 配置时不拦截:   YES ✓
  工具直接执行:                YES ✓
```

### 3.4 Test 3（隐含）: 服务端在未收到 reply 时确实暂停

从 Test 1 的时间线可确认：
- 18:04:20 — `permission.asked` 发出
- 18:04:22 — 手动延迟 2 秒后才回复
- 这 2 秒间**无任何工具事件** — 服务端完全暂停等待

---

## 4. 正确的 Permission 流程（扩展侧需实现）

```
OpenCode Server                              VSCode Extension
    |                                              |
    | 1. LLM 决定调用 edit 工具                    |
    | 2. server 检查 permission config             |
    | 3. permission.edit = "ask"                   |
    |                                              |
    | 4. ── permission.asked event ────────────►  |  ← 当前完全被忽略!
    |    (暂停工具执行，等待回复)                     |
    |                                              |  [需实现] 拦截事件
    |                                              |  [需实现] 暂停事件消费
    |                                              |  [需实现] 显示审批 UI
    |                                              |       ├─ 展示 metadata.diff
    |                                              |       ├─ 展示文件路径
    |                                              |       ├─ [Allow Once]
    |                                              |       ├─ [Allow Always]
    |                                              |       └─ [Reject]
    |                                              |
    | 5. ◄── POST /permissions/{id}/reply ──────  |  ← 当前从未调用!
    |    body: { response: "once" }                |
    |                                              |
    | 6. server 执行 edit 工具                      |
    | 7. ── tool pending → running → completed ─► |  ← 现有流程继续
```

---

## 5. 实现路线图

### 5.1 第一层：类型定义

文件：`src/types/events.ts`

```typescript
// 添加事件类型常量
export const EVENT_PERMISSION_ASKED = 'permission.asked' as const;
export const EVENT_PERMISSION_REPLIED = 'permission.replied' as const;

// 添加到 RealEventType 联合类型
export type RealEventType =
  | ... // 现有类型
  | typeof EVENT_PERMISSION_ASKED
  | typeof EVENT_PERMISSION_REPLIED;

// 添加事件接口
export interface PermissionAskedEvent {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: { [key: string]: unknown };
    always: string[];
    tool?: { messageID: string; callID: string };
  };
}

export interface PermissionRepliedEvent {
  type: 'permission.replied';
  properties: {
    sessionID: string;
    requestID: string;
    reply: 'once' | 'always' | 'reject';
  };
}
```

### 5.2 第二层：Client 接口

文件：`src/types/index.ts`

```typescript
export interface OpenCodeClient {
  // ... 现有方法 ...
  postSessionIdPermissionsPermissionId(options: {
    path: { id: string; permissionID: string };
    body?: { response: 'once' | 'always' | 'reject' };
    query?: { directory?: string };
  }): Promise<unknown>;
}
```

### 5.3 第三层：事件路由

文件：`src/participant/event-broker.ts`

在 `getSessionId()` 中添加 permission 事件的 sessionID 提取：

```typescript
case 'permission.asked':
  return event.properties?.sessionID;
case 'permission.replied':
  return event.properties?.sessionID;
```

### 5.4 第四层：StreamBridge 处理

文件：`src/participant/streaming.ts`

在 `handlePartUpdated()` 或新方法中处理 `permission.asked`：

1. 收到 `permission.asked` → 暂停 SSE 事件消费（因为 server 在等待）
2. 解析 `metadata.diff` 展示变更内容
3. 用 VSCode API（如 `window.showInformationMessage` 或自定义 WebView）显示审批 UI
4. 用户选择后调用 `client.postSessionIdPermissionsPermissionId()`
5. 恢复 SSE 事件消费

### 5.5 配置要求

项目根目录需要 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "ask",
    "bash": "allow",
    "read": "allow"
  }
}
```

或通过 `OPENCODE_CONFIG_CONTENT` 环境变量在 `server.ts` 的 `start()` 中注入。

---

## 6. SDK 接口详解与前置条件

### 6.1 v1 vs v2 SDK 事件类型差异

该历史快照使用 `@opencode-ai/sdk@1.14.41`，其类型分为两个版本：

| | v1 (`dist/gen/`) | v2 (`dist/v2/gen/`) |
|---|---|---|
| Permission 请求事件 | `EventPermissionUpdated` (`permission.updated`) | `EventPermissionAsked` (`permission.asked`) |
| Permission 回复事件 | `EventPermissionReplied` (`permission.replied`) | `EventPermissionReplied` (`permission.replied`) |
| Reply API | `PostSessionIdPermissionsPermissionIdData` | `PermissionReplyData` |
| `Event` 联合类型包含 | `EventPermissionUpdated`, `EventPermissionReplied` | `EventPermissionAsked`, `EventPermissionReplied` |

**历史注意：实际运行时服务端发送的事件类型是 `permission.asked`，但当时 v1 SDK 的 `Event` 联合类型中没有这个字符串。** 这意味着：

1. TypeScript 类型检查不会覆盖 `permission.asked`
2. 但 SSE 流中确实会传来这个事件
3. 需要在扩展的类型定义中手动补充

### 6.2 完整前置条件清单

#### 环境要求

| 前置 | 说明 | 验证方式 |
|------|------|----------|
| Node.js ≥ 18 | SDK 运行时要求 | `node --version` |
| OpenCode CLI ≥ 1.14 | 服务端引擎 | `opencode --version` |
| `@opencode-ai/sdk` ≥ 1.14 | SDK 包 | `npm ls @opencode-ai/sdk` |
| 已配置 AI Provider | OpenCode 需要至少一个 AI 模型提供商 | 项目或全局 `opencode.json` 中的 `provider` 配置 |
| `opencode.json` 中 `permission.edit = "ask"` | 触发 permission 机制的前提 | 项目根目录或全局配置 |

#### SDK `createOpencode()` 调用

```typescript
import { createOpencode } from '@opencode-ai/sdk';

// 返回值类型
type CreateOpencodeResult = {
  client: OpencodeClient;  // API 客户端
  server: {                // 服务器实例
    url: string;           // 如 "http://127.0.0.1:4096"
    close(): void;         // 关闭服务器
  };
};

// 参数类型
type ServerOptions = {
  hostname?: string;   // 默认 "127.0.0.1"
  port?: number;       // 0 = 随机端口
  signal?: AbortSignal;
  timeout?: number;
  config?: Config;     // 内联配置（覆盖文件配置）
};

// 调用
const { client, server } = await createOpencode({
  port: 0,            // 随机端口
});
```

**注意：** `createOpencode()` 会继承 `process.cwd()` 所在目录的 `opencode.json` 配置。在 VSCode 扩展中，`server.ts` 的 `start()` 方法通过临时 `process.chdir(cwd)` 来设置项目目录。

#### Session 创建

```typescript
// SDK 签名
type SessionCreateData = {
  body?: {
    parentID?: string;   // 父会话 ID（用于 fork）
    title?: string;      // 会话标题
  };
  query?: {
    directory?: string;  // 项目目录
  };
};

// 调用
const result = await client.session.create({
  query: { directory: '/path/to/project' },
});
const sessionId = result.data?.id;  // 注意：是 data.id，不是直接的 id
```

#### 全局事件订阅

```typescript
// SDK 签名
type GlobalEventData = {
  // 无参数
};

// 返回 SSE 流
type ServerSentEventsResult = {
  stream: AsyncIterable<GlobalEvent>;  // 异步迭代器
};

// GlobalEvent 是信封格式
type GlobalEvent = {
  directory: string;   // 来源项目目录
  payload: Event;      // 实际事件（v1 SDK 的 Event 联合类型）
};

// 调用
const events = await client.global.event();
for await (const rawEvent of events.stream) {
  // 解包：rawEvent.payload 才是实际事件
  const event = rawEvent.payload;
  console.log(event.type);  // "message.part.updated", "permission.asked", ...
}
```

**重要：** `events.stream` 是异步迭代器，`for await` 循环会阻塞直到流关闭。必须和 `prompt()` 并行执行（fire-and-forget 模式）。

#### Prompt 发送

```typescript
// SDK 签名
type SessionPromptData = {
  body?: {
    messageID?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
    noReply?: boolean;
    system?: string;
    tools?: { [key: string]: boolean };
    parts: Array<{
      type: 'text';
      text: string;
    }>;
  };
  path: { id: string };           // Session ID
  query?: { directory?: string };
};

// 调用（fire-and-forget，不能 await！）
const promptPromise = client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: '修改 foo.txt' }] },
  query: { directory: projectDir },
}).catch(err => { /* 日志 */ });

// ... 消费事件流 ...

// 最后才 await
await promptPromise;
```

**为什么不能 await prompt：** `prompt()` 是 HTTP POST，服务端在处理期间保持连接。如果 await，所有 SSE 事件在 await 期间触发，但此时没有消费者 → 事件丢失。

### 6.3 `permission.asked` 事件完整结构（实测）

```typescript
// 实际收到的 SSE 事件（解包 GlobalEvent.payload 后）
{
  type: "permission.asked",
  properties: {
    id: "per_e27a93348001TfbzYUFyaD9y7y",  // ★ 请求 ID，Reply API 需要
    sessionID: "ses_1d8570269ffeoaMdT0Fm2JJP9C",
    permission: "edit",                      // "edit" | "bash" | "read" | ...
    patterns: ["_permission_test_file.txt"], // 匹配的文件/命令模式
    metadata: {
      filepath: "H:\\PyProjects\\acpilot\\_permission_test_file.txt",
      diff: "Index: ...\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n hello world\n-version=1.0.0\n+version=2.0.0\n"
      // ★ edit 类型的 permission 包含完整 unified diff
    },
    always: ["*"],                           // "always" 回复将批准的模式
    tool: {
      messageID: "msg_e27a92755001SuC7hQzKgIhKSS",
      callID: "call_4b90532b953f41c680604036"  // ★ 关联到具体的工具调用
    }
  }
}
```

**事件时序关键点：**

```
message.part.updated  type=tool  status=running     ← edit 工具开始
permission.asked                                          ← 紧接着服务端暂停
  （2秒内无任何事件 → 服务端确实在等待）                      ← 需要调用 Reply API
permission.replied                                        ← Reply 后确认
file.edited                                               ← 文件修改发生
message.part.updated  type=tool  status=completed         ← 工具完成
```

### 6.4 Permission Reply API 完整调用方式

```typescript
// ★ v1 SDK 方法名（当前项目使用的）
client.postSessionIdPermissionsPermissionId({
  path: {
    id: sessionId,                              // Session ID
    permissionID: permissionAskedEvent.properties.id,  // permission.asked 事件中的 id
  },
  body: {
    response: "once",    // "once" | "always" | "reject"
  },
  query: {
    directory: projectDir,  // 可选，项目目录
  },
});
// 返回: RequestResult<PostSessionIdPermissionsPermissionIdResponses, ...>
//       成功时 data = true (boolean), HTTP 200
//       失败时 400 (Bad request) 或 404 (Not found)
```

**三种回复的效果：**

| 回复 | 效果 | 使用场景 |
|------|------|----------|
| `"once"` | 仅批准本次请求，下次同类型仍需审批 | 默认安全选项 |
| `"always"` | 批准本次 + 后续匹配 `always` 模式的请求（当前会话内有效） | 用户信任某类操作 |
| `"reject"` | 拒绝本次请求，工具不执行 | 用户不同意修改 |

**HTTP 错误码：**

| 状态码 | 含义 | 原因 |
|--------|------|------|
| 200 | 成功 | 回复已处理 |
| 400 | Bad request | 参数错误（如无效的 response 值） |
| 404 | Not found | permissionID 不存在或已过期 |

### 6.5 v2 SDK 的 Permission Reply（备选）

```typescript
// v2 SDK 方法签名（dist/v2/）— 当前项目未使用但 SDK 包中包含
type PermissionReplyData = {
  body?: {
    reply: "once" | "always" | "reject";
    message?: string;   // v2 新增：可附带消息
  };
  path: {
    requestID: string;  // v2 用 requestID 而非 permissionID
  };
  query?: {
    directory?: string;
    workspace?: string;  // v2 新增：workspace 参数
  };
  url: "/permission/{requestID}/reply";
};
```

### 6.6 Permission List API（查看待处理的权限请求）

```typescript
// v2 SDK
type PermissionListData = {
  query?: {
    directory?: string;
    workspace?: string;
  };
  url: "/permission";
};
// 返回: Array<PermissionRequest> — 当前待处理的权限请求列表

// 可用于：服务端重启后恢复未处理的 permission 状态
```

---

## 7. 完整可运行 Demo

以下脚本可直接在项目根目录运行：`node doc/demo/permission-demo.mjs`

前置：项目根目录需有 `opencode.json`（见下方说明）。Demo 脚本会自动创建临时配置文件。

### 7.1 Demo 脚本

```typescript
// 文件: doc/demo/permission-demo.mjs
// 运行: node doc/demo/permission-demo.mjs
//
// 前置:
//   - Node.js >= 18
//   - OpenCode CLI 已安装 (npm i -g opencode-ai)
//   - @opencode-ai/sdk 已安装 (npm install)
//   - 已配置 AI Provider（全局或项目级 opencode.json）
//
// 本脚本演示:
//   1. 启动 OpenCode server
//   2. 用 permission.edit="ask" 配置触发 permission.asked 事件
//   3. 拦截事件并展示 diff
//   4. 自动回复 "once" 让 edit 继续
//   5. 验证文件确实被修改
```

Demo 脚本太长不适合内联，见独立文件 `doc/demo/permission-demo.mjs`。

### 7.2 独立配置文件示例

最小的触发 permission 的配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "ask"
  }
}
```

将此文件放在项目根目录命名为 `opencode.json`，OpenCode server 启动时会自动读取。

### 7.3 在 VSCode 扩展中注入配置的备选方案

如果不希望在项目根目录放配置文件，可以在 `server.ts` 的 `start()` 方法中通过环境变量注入：

```typescript
// server.ts — 修改 start() 方法
async start(cwd?: string): Promise<string> {
  // ... existing code ...

  // 注入 permission 配置（优先级高于文件配置）
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    permission: { edit: "ask" }
  });

  const instance = await createOpencode({ port: 0 });
  // ...
}
```

或通过 `createOpencode` 的 `config` 参数：

```typescript
const instance = await createOpencode({
  port: 0,
  config: {
    permission: { edit: "ask" }
  }
});
```

---

## 8. 官方参考

- Permission 文档: https://opencode.ai/docs/permissions/
- Config 文档: https://opencode.ai/docs/config/
- Tools 文档: https://opencode.ai/docs/tools/
- Config Schema: https://opencode.ai/config.json
- GitHub: https://github.com/sst/opencode (原 anomalyco/opencode)
- Permission Issue 讨论: https://github.com/anomalyco/opencode/issues/3205
