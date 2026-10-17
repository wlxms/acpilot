# ACPilot — VSCode 扩展技术总结（历史 v4 归档）

> 本文记录的是重构前的 v4 实现，保留作历史参考。当前架构和代码契约以
> [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md) 和 README 为准：
> `Copilot 接入层 ↔ SSS/SSP ↔ Agent Backend`。其中旧文中的 `AcpEvent`、
> `OpenCodeBridge`、`acpmodels` 等名称已经从生产路径移除。

> **归档说明**：以下正文保留 v4 重构前的实现细节，包含已删除的文件路径、事件
> 类型和桥接流程，仅用于历史追溯。不要按本文的旧目录、`AcpEvent` 或
> `OpenCodeBridge` 设计新增代码；当前实现以阶段一架构设计和各 Backend 的
> `BackendPipeline`/SSP 契约为准。

## 概述

`acpilot` 是一个 VSCode 扩展，将 OpenCode AI 编码助手集成到 Copilot Chat 中。通过在聊天输入框中使用 `@opencode`，用户可以无缝地与 OpenCode 服务器交互，获得完整的 AI 思考过程、工具调用和流式响应。

---

## 架构

当前代码库采用 **SSP-first / SSS-owned-stream** 分层架构（v4），彻底解耦协议语义、序列化与平台渲染：

```
┌─────────────────────────────────────────────────────┐
│ VSCode Copilot Chat UI                              │
│  @opencode hello → ChatResponseStream               │
└─────────────────────┬───────────────────────────────┘
                      │ ChatRequestHandler
┌─────────────────────▼───────────────────────────────┐
│ src/participant/handler.ts                          │
│  • 斜杠命令路由 / 会话解析（create/reuse/rewind）      │
│  • 模型 & agent 解析（AcpModels ⇄ SelectionStore）    │
│  • Checkpoint 包裹（ChatResponseExternalEditPart）    │
└─────────────────────┬───────────────────────────────┘
                      │ backend.sessions.prompt + AsyncIterable<AcpEvent>
┌─────────────────────▼───────────────────────────────┐
│ src/backends/opencode/opencode-bridge.ts            │
│  • 薄路由（~825 行）：ACP 事件 → SSS push/update      │
│  • SubagentManager 协调子会话                         │
│  • 不含渲染、不含状态机                                │
└─────────────────────┬───────────────────────────────┘
                      │ push(ssp) / update(id, data)
┌─────────────────────▼───────────────────────────────┐
│ src/acp/streaming/session-stream.ts (SSS)           │
│  • SerializableSessionStream 拥有 vscode 流           │
│  • push(ssp) → 渲染 + 追加 session.jsonl             │
│  • update(id) → 合并 + 渲染 + 追加                    │
│  • SubsessionStream 子代理独立文件                     │
└─────────────────────┬───────────────────────────────┘
                      │ ssp.render(stream) + append JSONL
┌─────────────────────▼───────────────────────────────┐
│ src/ssp/impl/* (SSP 自洽层)                          │
│  • AssistantTextSSP → stream.markdown()              │
│  • ReasoningSSP → stream.thinkingProgress()          │
│  • ToolInvocationSSP → ChatToolInvocationPart        │
│  • ExternalEditSSP → stream.externalEdit()           │
│  • QuestionSSP → question carousel                   │
└─────────────────────┬───────────────────────────────┘
                      │ SSE events (SDK)
┌─────────────────────▼───────────────────────────────┐
│ src/opencode/server.ts + client.ts                  │
│  createOpencode({ port: 0 }) → server + client       │
│  @opencode-ai/sdk ^1.16.0                            │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP + SSE
┌─────────────────────▼───────────────────────────────┐
│ OpenCode CLI (localhost, ephemeral port)             │
└─────────────────────────────────────────────────────┘
```

### 文件结构

```
src/
├── extension.ts              # activate/deactivate, 注册 ChatParticipant
├── statusbar.ts              # 状态栏管理
├── acp/                      # ACP 协议语义层（零 vscode/SDK 依赖）
│   ├── backend.ts            #   AcpBackend / AcpBridge 核心接口
│   ├── types.ts              #   AcpEvent / AcpStreamPart 类型定义
│   ├── backend-registry.ts   #   后端工厂注册（插件式）
│   ├── app-event-bus.ts      #   类型化事件总线
│   ├── selection-store.ts    #   agent/model 选择状态
│   ├── session-manager.ts    #   VSCode ⇄ backend 会话映射
│   ├── streaming/            #   SSS 可序列化会话流
│   │   ├── session-stream.ts #     SerializableSessionStream（拥有 vscode 流）
│   │   ├── subsession-stream.ts  # SubsessionStream（子代理）
│   │   ├── session-store.ts  #     文件系统持久化
│   │   └── deserialize.ts    #     读时合并 + 中断修复
│   ├── serializable/         #   JSONL 序列化器
│   └── checkpoint/           #   Checkpoint 审批状态
├── ssp/                      # 可序列化流部件层（自洽状态 + 渲染）
│   ├── types.ts              #   SerializableStreamPart 基类
│   └── impl/                 #   10+ 具体 SSP
│       ├── assistant-text.ts #     AssistantTextSSP (append-only)
│       ├── reasoning.ts      #     ReasoningSSP (append-only)
│       ├── tool-invocation.ts#     ToolInvocationSSP (mutable 生命周期)
│       ├── external-edit.ts  #     ExternalEditSSP (合并了旧 Tracker)
│       ├── question.ts       #     QuestionSSP (mutable + 回调)
│       ├── subagent.ts       #     SubagentManager 子会话协调
│       └── ...
├── backends/opencode/        # OpenCode 后端实现
│   ├── adapter.ts            #   OpenCodeBackend (implements AcpBackend)
│   ├── opencode-bridge.ts    #   OpenCodeBridge (薄路由 ~825 行)
│   ├── event-broker.ts       #   GlobalEventBroker (SSE 多路复用)
│   └── events.ts             #   normalizeStreamEvent (ACP 归一化)
├── acpmodels/                # Copilot ⇄ ACP 模型双向同步
├── surfaces/vscode/          # VS Code surfaces
│   ├── acp-renderer.ts       #   ACP 事件 → Chat UI 渲染
│   ├── capabilities.ts       #   运行时能力检测
│   ├── stable-participant.ts #   稳定 surface（仅 markdown）
│   └── experimental-session.ts # 实验 ChatSessionContentProvider
├── participant/              # ChatRequestHandler 编排层
│   ├── handler.ts            #   主流程（会话/模型/agent/checkpoint 编排）
│   ├── commands.ts           #   斜杠命令路由
│   ├── checkpoint.ts         #   CheckpointManager
│   └── ...
├── settings/                 # Webview 设置面板
├── opencode/                 # SDK 封装
│   ├── server.ts             #   OpenCodeServerManager (生命周期)
│   └── client.ts             #   OpenCodeClient (HTTP 客户端)
├── types/                    # 共享类型
│   ├── index.ts              #   ExtensionState, SessionState
│   └── vscode-proposed-additions.ts # vscode proposed API 类型声明
└── test/                     # vitest 测试（350+ 用例）
    ├── vscode-mock.ts        #   VSCode API 模拟
    ├── *.test.ts             #   各模块单元测试
    ├── streaming/            #   SSS/序列化集成测试
    └── integration/          #   端到端测试
```

---

## 核心技术点

### 1. VSCode Chat Participant API (稳定)

```typescript
// package.json
"contributes": {
  "chatParticipants": [{
    "id": "acpilot.opencode",
    "name": "opencode",
    "isSticky": true,
    "commands": [{"name": "new"}, {"name": "help"}, {"name": "model"}]
  }]
}

// extension.ts
const participant = vscode.chat.createChatParticipant(
  'acpilot.opencode',
  createParticipantHandler(state),
);
```

**稳定 API 方法：**
| 方法 | 参数 | 用途 |
|------|------|------|
| `stream.markdown(value)` | `string` | 输出 Markdown 文本（支持代码块、表格等） |
| `stream.progress(value)` | `string` | 显示进度条消息 |
| `stream.push(part)` | `ChatResponsePart` | 推送自定义渲染部件 |

### 2. Proposed API: chatParticipantAdditions

需在 `package.json` 中声明：
```json
"enabledApiProposals": ["chatParticipantAdditions"]
```

这些类型**不在** `@types/vscode` 中，需要本地声明。

**Proposed API 方法：**

| 方法 | 签名 | 用途 |
|------|------|------|
| `stream.thinkingProgress(delta)` | `(delta: ThinkingDelta)` | 实时流式显示思考 token |
| `stream.beginToolInvocation(id, name, data?)` | `(callId, toolName, streamData?)` | 开始流式工具调用 UI（spinner） |
| `stream.updateToolInvocation(id, data)` | `(callId, streamData)` | 更新工具调用参数 |
| `stream.push(ChatToolInvocationPart)` | `ChatToolInvocationPart` | 推送完成的工具调用卡片 |

**ThinkingDelta 类型：**
```typescript
{ text?: string | string[]; id?: string; metadata?: { readonly [key]: string]: unknown } }
```

### 3. ChatToolInvocationPart — 工具调用渲染

```typescript
class ChatToolInvocationPart {
  toolName: string;           // 工具名 (read, bash, write...)
  toolCallId: string;         // 唯一调用 ID
  isComplete?: boolean;       // 是否完成
  invocationMessage?: string; // 运行中消息
  pastTenseMessage?: string;  // 完成后消息 (Read file.ts 0.5s)
  enablePartialUpdate?: bool; // 支持流式更新
  toolSpecificData?:          // 工具特定数据（决定 UI 渲染方式）
    | ChatTerminalToolInvocationData  // → 终端命令行样式
    | ChatSimpleToolResultData        // → 可折叠 Input/Output
    | ChatToolResourcesInvocationData // → 文件引用列表
    | ChatSubagentToolInvocationData; // → 子代理展开
}
```

### 4. 工具特定数据类型

工具数据使用 VS Code `chatParticipantAdditions` proposal API 类型，声明在 `src/types/vscode-proposed-additions.ts`：

| 类型 | 场景 | 字段 | UI 效果 |
|------|------|------|---------|
| `ChatTerminalToolInvocationData` | bash/shell | `commandLine`, `language`, `output`, `state` | 终端样式 + 退出码 + 耗时 |
| `ChatSimpleToolResultData` | read/list/grep | `input`, `output` | 可折叠的输入/输出块 |
| `ChatToolResourcesInvocationData` | write/edit | `values: Uri[]` | 文件引用列表（可点击跳转） |
| `ChatSubagentToolInvocationData` (class) | task/subagent | `description`, `agentName`, `prompt`, `result` | 点击展开子代理完整对话 |

`ChatSubagentToolInvocationData` 是有构造函数的 class，运行时通过 `new VS.ChatSubagentToolInvocationData(...)` 实例化（带 fallback 到普通对象）。其余三个是 interface，用 `satisfies` 确保类型安全。`buildToolSpecificData()` 存在两处实现：`surfaces/vscode/acp-renderer.ts`（导出函数）和 `ssp/impl/tool-invocation.ts`（SSP 私有方法）。

### 5. OpenCode SDK 集成

```typescript
import { createOpencode } from '@opencode-ai/sdk';

// 核心函数
const oc = await createOpencode({ port: 0 });
// → { server: { url, close }, client }

// 会话创建
const result = await oc.client.session.create({ body: {} });
const sessionId = result.data.id;  // ← 注意: data.id

// 事件订阅（必须在 prompt 之前）
const events = await oc.client.event.subscribe();

// 发送 prompt（fire-and-forget, 不 await）
const promise = oc.client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: userPrompt }] },
});

// 消费事件流（并行的）
for await (const evt of events.stream) { ... }
await promise;  // 最后才 await
```

**关键陷阱：**
- ❌ 不要设置 `OPENCODE_SERVER_PASSWORD` — 会导致 401
- ❌ 不要 `await prompt()` — 会阻塞事件消费，导致所有事件丢失
- ✅ 先 `subscribe()` 再 `prompt()`
- ✅ `session.create()` 返回 `{ data: { id } }`，不是直接的 `{ id }`

---

## 事件流详解

### SSE 事件 → ACP 归一化 → SSP 路由

SDK 原始事件经 `normalizeStreamEvent()` 归一化为 `AcpEvent`，再由 `OpenCodeBridge` 路由到 SSS：

```
SDK SSE event                AcpEvent                  SSS 操作
─────────────────────────────────────────────────────────────────
message.part.updated (text)  → part.updated(text)      → sss.push(AssistantTextSSP)
message.part.updated (reasoning) → part.updated(reasoning) → sss.push(ReasoningSSP)
message.part.delta (reasoning) → part.delta(text)       → sss.push(ReasoningSSP, delta)
message.part.updated (tool)  → part.updated(tool)       → sss.push/update(ToolInvocationSSP)
message.part.delta (text)    → part.delta(text)         → sss.push(AssistantTextSSP, delta)
permission.asked (edit)      → permission.asked         → sss.push(ExternalEditSSP) + 自动回复
question.asked               → (ACP 扩展)               → sss.push(QuestionSSP) + 回调
session.idle                 → session.idle             → 延迟空闲检查 → sss.drain()
session.diff                 → session.diff             → sss.writeMeta()
子会话事件                    → (路由到 SubsessionStream)  → 子 SSS 独立 push/update
```

### 工具调用状态机（ToolInvocationSSP）

SSP 自治管理生命周期状态，SSS 只负责 push/update：

```
pending ──→ sss.push(ToolInvocationSSP { state: 'pending' })
  │           └── SSP.render() → stream.beginToolInvocation()
  │
  ├─ running ──→ sss.update(callId, { state: 'running', input, title })
  │              └── SSP.render() → stream.updateToolInvocation()
  │
  └─ completed ──→ sss.update(callId, { state: 'completed', output, time })
                   └── SSP.render() → stream.push(ChatToolInvocationPart)
                       └── toolSpecificData = buildToolSpecificData(toolName, ...)
```

### 工具名 → 数据类型映射

```typescript
function buildToolSpecificData(toolName, input, output, ...) {
  switch (toolName) {
    case 'bash':
    case 'shell':  return { commandLine, language, output, state }
                        satisfies ChatTerminalToolInvocationData;
    case 'read':
    case 'list':
    case 'grep':   return { input, output }
                        satisfies ChatSimpleToolResultData;
    case 'write':
    case 'edit':   return { values: [vscode.Uri.file(filePath)] }
                        satisfies ChatToolResourcesInvocationData;
    case 'task':
    case 'subagent': return new VS.ChatSubagentToolInvocationData(
                        description, agentName, prompt, result);
    default:       return { input, output }
                        satisfies ChatSimpleToolResultData;  // 降级
  }
}
```

---

## 配置与构建

### package.json 关键字段

```json
{
  "engines": { "vscode": "^1.118.0" },
  "enabledApiProposals": ["chatParticipantAdditions"],
  "main": "./out/extension.js",
  "activationEvents": ["onStartupFinished"],
  "dependencies": { "@opencode-ai/sdk": "^1.16.0" }
}
```

### 构建 (esbuild)

```bash
# CJS 格式, vscode 作为外部依赖, ESM SDK 自动处理
esbuild src/extension.ts --bundle --outfile=out/extension.js \
  --external:vscode --format=cjs --platform=node
```

### 测试 (vitest)

```typescript
// vitest.config.ts
resolve: {
  alias: {
    vscode: path.resolve(__dirname, 'src/test/vscode-mock.ts'),
  },
}
```

- 350+ 单元测试
- 通过 `paths` 别名将 `vscode` 映射到 mock 模块
- SDK 调用全部被 mock（不依赖真实 OpenCode 服务）
- 通过真机终端 E2E 测试验证了完整的 SSE 事件流

### 类型检查

`tsconfig.json` 中 `vscode` 通过 `paths` 映射到 mock 类型声明，避免了 `@types/vscode` 中缺少 proposed API 类型的问题。

---

## 关键设计决策

| 决策 | 原因 |
|------|------|
| `createOpencode({ port: 0 })` 而非子进程 | SDK 管理完整的服务器生命周期 |
| 不设置 `OPENCODE_SERVER_PASSWORD` | 导致 401；SDK 无需密码即可运行 |
| prompt fire-and-forget + 并行事件消费 | `await prompt()` 会阻塞事件流，导致所有事件丢失 |
| **SSP 自洽：每个 SSP 拥有自身状态 + 渲染 + 序列化** | 消除 Bridge 2201 行巨型状态机，状态归属各部件 |
| **SSS 拥有 vscode 流（push/update API）** | Bridge 永不直接触达 UI，单一变更入口 |
| **Bridge 薄路由（~825 行）** | 只做 ACP 事件 → SSP 映射，不含渲染/持久化 |
| **3 文件 append-only 持久化** | 中断安全；读时合并（materializeRecords）；子代理独立文件 |
| **ExternalEditSSP 合并了旧 Tracker** | 编辑同步闭环在单个 SSP 内，消除跨文件状态碎片 |
| **Checkpoint 包裹 prompt+bridge** | baseline 在 prompt 前捕获，编辑进入 VS Code undo 体系 |
| 工具数据用 VS Code proposal 类型（`satisfies` + `new`） | 原生 UI 渲染；类型安全；`ChatSubagentToolInvocationData` 运行时构造 |
| esbuild 打包，`--external:vscode` | VSCode 扩展的标准构建方式 |
| vitest + mock vscode 模块 | 无需 VSCode 扩展主机即可运行测试 |

---

## 依赖版本

| 包 | 版本 | 用途 |
|---|------|------|
| `@opencode-ai/sdk` | ^1.16.0 | OpenCode 服务器和客户端管理 |
| `@types/vscode` | ^1.118.0 | VSCode API 类型（稳定部分） |
| `@types/node` | ^20.19.40 | Node.js 类型 |
| `esbuild` | ^0.24.2 | ESM→CJS 打包 |
| `typescript` | ^5.9.3 | 类型检查 |
| `vitest` | ^4.1.5 | 单元测试 |
| VSCode | ≥1.118.0 | 运行环境（支持 chatParticipantAdditions） |
| OpenCode CLI | 1.16.0 | 本地 AI 服务器 |
