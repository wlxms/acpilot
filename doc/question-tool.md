# Question Tool 支持 — 实现与调试记录

> **历史实现记录**：本文保留 Question Tool 的协议调研和重构前调用路径，其中
> `StreamBridge`、`src/acp/*` 等名称已不是生产 API。现行实现由 Backend Pipeline
> 创建 `QuestionSSP`；架构边界见
> [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md)。
>
> **现行状态（2026-09）**：本文第 3、5、6 节中的 SDK v1/raw HTTP 结果是历史
> 快照，不是当前实现指引。当前 OpenCode 适配器使用 `@opencode-ai/sdk/v2` 的
> `sdk.question.reply()` / `sdk.question.reject()`。

## 概述

OpenCode 后端的 AI 代理可以通过 `question` 工具向用户提问（单选、多选、文本输入）。本文记录了从协议实现到端到端验证的完整过程，包括关键 bug 的发现与修复。

---

## 1. 协议格式

### 1.1 SSE 事件：`question.asked`

服务端发送的原始 SSE 事件结构：

```json
{
  "directory": "D:\\project",
  "project": "global",
  "payload": {
    "id": "evt_e64b5d0d60025...",
    "type": "question.asked",
    "properties": {
      "id": "que_e64b5d0d60017...",
      "sessionID": "ses_19b4a66b8ffe...",
      "questions": [
        {
          "question": "What is your favorite color?",
          "header": "Favorite Color",
          "options": [
            { "label": "Red", "description": "The color red" },
            { "label": "Green", "description": "The color green" },
            { "label": "Blue", "description": "The color blue" }
          ],
          "multiple": false
        }
      ],
      "tool": {
        "messageID": "msg_e64b5a06d001...",
        "callID": "call_8611bae27b09..."
      }
    }
  }
}
```

**关键字段**：
- `payload.properties.id` → question request ID（`que_` 前缀）
- `payload.properties.sessionID` → 关联的 session
- `payload.properties.questions[].question` → 问题文本
- `payload.properties.questions[].options[].label` → 选项标签
- `payload.properties.questions[].multiple` → 是否多选

### 1.2 回复 API

```
POST /question/{requestID}/reply?directory={dir}
Content-Type: application/json

{ "answers": [["Red"]] }
```

- `answers` 是 `Array<Array<string>>`，外层对应每个问题，内层对应选中的选项
- 成功返回 200

### 1.3 拒绝 API

```
POST /question/{requestID}/reject?directory={dir}
```

### 1.4 后续事件

回复成功后，SSE 流会继续推送：
1. `question.replied` — 确认回复已收到
2. `message.part.updated` — AI 继续生成文本
3. `session.updated` / `session.status` — 会话状态更新
4. 其他正常事件流继续

---

## 2. 实现架构

```
                         SSE Events
OpenCode Server ──────────────────► GlobalEventBroker
                                           │
                                    openSessionStream()
                                           │
                                           ▼
                                    BufferedSessionChannel
                                           │
                                     for await (event)
                                           │
                                           ▼
StreamBridge.run() ◄──────── ACP 归一化事件流
  │
  ├── event.type === 'question.asked'
  │     └── await handleQuestionAsked(event, stream)
  │           ├── 构建 ChatQuestion[] (VSCode proposed API 类型)
  │           ├── stream.questionCarousel(questions) ← 阻塞等待用户
  │           │   ├── 成功 → extract answers → replyToQuestion()
  │           │   └── undefined (skip) → rejectQuestion()
  │           └── return → 继续消费后续事件
  │
  └── 其他事件 → 正常渲染 (text, tool, thinking 等)
```

### 2.1 事件归一化层

`src/backends/opencode/events.ts` → `normalizeQuestionAsked()`：

```typescript
function normalizeQuestionAsked(ev: QuestionAskedEvent): AcpQuestionRequestEvent {
  const props = ev.properties;
  return {
    type: 'question.asked',
    questionId: props.id,          // ← 注意：字段名是 id，不是 requestID
    sessionId: props.sessionID,
    questions: props.questions.map(q => ({
      question: q.question,
      header: q.header,
      options: q.options.map(o => ({ label: o.label, description: o.description })),
      multiple: q.multiple,
      custom: q.custom,
    })),
    tool: props.tool ? { messageId: props.tool.messageID, callId: props.tool.callID } : undefined,
  };
}
```

### 2.2 VSCode Question UI

`src/types/vscode-proposed-additions.ts` 中的类型：

```typescript
enum ChatQuestionType { SingleSelect, MultiSelect, Text }

class ChatQuestion {
  constructor(
    public readonly id: string,
    public readonly type: ChatQuestionType,
    public readonly title: string,
    public readonly details: {
      message: string;
      options: ChatQuestionOption[];
    },
  ) {}
}

interface ChatQuestionOption {
  label: string;
  detail?: string;
  value: unknown;  // ← 关键！VSCode 返回此值作为 selectedValue
}
```

`StreamBridge.handleQuestionAsked()` 使用 VSCode proposed API：

```typescript
// 优先使用 proposed API
const result = await stream.questionCarousel(vscodeQuestions, true);

// Fallback: vscode.window.showQuickPick / showInputBox
if (!result) {
  // ... 手动构建 QuickPick UI
}
```

### 2.3 Answer 提取

VSCode `questionCarousel` 返回格式：

```typescript
// SingleSelect: { "q_0": { selectedValue: "TypeScript" } }
// MultiSelect:  { "q_1": { selectedValues: ["AWS", "Azure"] } }
// Text:         { "q_2": { freeformValue: "custom text" } }
```

提取逻辑（`streaming.ts`）：

```typescript
const answers = Object.entries(result).map(([, answer]) => {
  if (typeof answer === 'string') return [answer];
  if (answer && typeof answer === 'object') {
    const obj = answer as Record<string, unknown>;
    if ('selectedValue' in obj && obj.selectedValue !== undefined) {
      return [String(obj.selectedValue)];
    }
    if ('selectedValues' in obj && Array.isArray(obj.selectedValues)) {
      return obj.selectedValues.map(v => String(v));
    }
  }
  return [];
});
```

### 2.4 Reply 回调链

```
StreamBridge.replyToQuestion(sessionId, questionId, answers, directory)
    ↓ handler.ts
state.backend.questions.reply(sessionId, requestId, answers, directory)
    ↓ adapter.ts
POST /question/{requestId}/reply?directory={dir}
    body: { answers: [["Red"]] }
```

---

## 3. 关键 Bug 与修复

### 3.1 SDK v1 客户端缺少 `question` 属性

**症状**：
```
[handler] question reply result: {"error":"Cannot read properties of undefined (reading 'reply')"}
```

**根因**：

`@opencode-ai/sdk` v1.15.10 有两套 `OpencodeClient`：

| 入口 | 文件 | 模块数量 | question |
|------|------|---------|----------|
| `@opencode-ai/sdk` (v1) | `dist/gen/sdk.gen.js` | 20 | ❌ 无 |
| `@opencode-ai/sdk/v2` | `dist/v2/gen/sdk.gen.js` | 26 | ✅ 有 |

v1 客户端用**实例属性**（`this.session = new Session(...)`），只有 20 个模块，**没有 question 和 permission**。

v2 客户端用 **lazy getter**（`get question() { return new Question(...) }`），有 26 个模块。

验证：
```
v1: OpencodeClient.prototype keys = constructor, postSessionIdPermissionsPermissionId
v2: OpencodeClient.prototype getters = auth, app, global, event, config, ..., question, permission, ...
```

**当时的修复**：adapter 的 `questions.reply()` / `questions.reject()` 使用 raw HTTP：
```typescript
const response = await fetch(`${baseUrl}/question/${requestId}/reply?directory=...`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ answers }),
});
```

**后续迁移（已完成）**：将 `server.ts` 的导入改为 v2：
```typescript
// 历史
import { createOpencode } from '@opencode-ai/sdk';
// 现行
import { createOpencode } from '@opencode-ai/sdk/v2';
```

v2 的 `createOpencode()` 返回的 client 自带 `question` 模块，可直接调用 `client.question.reply()`。

### 3.2 ChatQuestionOption 缺少 `value` 字段

**症状**：VSCode 返回的 `selectedValue` 是 `"undefined"` 字符串。

**原因**：`ChatQuestionOption` 接口最初没有 `value` 字段。VSCode 的 `questionCarousel` 把 `option.value` 作为 `selectedValue` 返回。

**修复**：给 `ChatQuestionOption` 加上 `value: unknown`，构建时设 `value: label`。

### 3.3 Event-Broker SSE 流断连

**症状**：question 回复后，bridge loop 退出（`done=true`），后续事件丢失。

**原因**：全局 SSE 流（`/global/event`）结束后 `pump()` 方法关闭了所有 session channels。

**修复**：`pumpWithReconnect()` — SSE 流正常结束时自动重连，保留 session channels：
```typescript
private async pumpWithReconnect(client: OpenCodeClient): Promise<void> {
  while (true) {
    const events = await client.global.event();
    for await (const rawEvent of events.stream) {
      this.dispatch(rawEvent);
    }
    // Stream ended normally — reconnect, don't close channels
    this.log(`global event stream completed, reconnecting in 1000ms`);
    await delay(1000);
  }
}
```

---

## 4. 文件清单

### 新增文件
| 文件 | 用途 |
|------|------|
| `src/test/integration/question-flow.integration.test.ts` | question flow 端到端集成测试 |

### 核心修改文件
| 文件 | 变更 |
|------|------|
| `src/backends/opencode/adapter.ts` | 历史记录：`questions.reply()` / `questions.reject()` 曾使用 raw HTTP；现行实现调用 SDK v2 |
| `src/backends/opencode/event-broker.ts` | `pumpWithReconnect()` 自动重连、session channel 生命周期 |
| `src/backends/opencode/events.ts` | `normalizeQuestionAsked()` 事件归一化 |
| `src/backends/opencode/sdk-events.ts` | `QuestionAskedEvent` 类型定义 |
| `src/acp/types.ts` | `AcpQuestionRequestEvent` 等 ACP 层类型 |
| `src/acp/backend.ts` | `AcpQuestionOperations` 接口 |
| `src/participant/streaming.ts` | `handleQuestionAsked()` — questionCarousel + fallback + answer 提取 |
| `src/participant/handler.ts` | `replyToQuestion` / `rejectQuestion` 回调接线 |
| `src/participant/commands.ts` | `/test-question` 斜杠命令 |
| `src/types/vscode-proposed-additions.ts` | `ChatQuestionType`, `ChatQuestionOption`, `ChatQuestion`, `ChatResponseQuestionCarouselPart` |

---

## 5. 集成测试

### 运行命令

```bash
# 全部 question flow 测试
npx vitest run -c vitest.integration.config.ts src/test/integration/question-flow.integration.test.ts

# 单个测试
npx vitest run -c vitest.integration.config.ts --testNamePattern "full flow" src/test/integration/question-flow.integration.test.ts
```

### 测试结果（全部通过）

```
✓ confirms SDK v1 client does NOT have question property     (2.3s)
✓ raw HTTP POST /question/{id}/reply returns proper error     (2.3s)
✓ full flow: prompt → question.asked → HTTP reply → continue (26.7s)

Test Files  1 passed (1)
Tests       3 passed (3)
```

### 端到端验证的完整流程

1. **启动**：`createOpencode({ port: 0 })` → 真实 OpenCode 服务器
2. **创建会话**：`client.session.create()`
3. **订阅 SSE**：`client.global.event()` → 全局事件流
4. **发送 prompt**：非阻塞调用 `client.session.prompt()`（不 await，因为需要并行消费 SSE）
5. **等待 question.asked**：SSE 流中检测到 `payload.type === 'question.asked'`
6. **提取 requestID**：`payload.properties.id`（`que_` 前缀）
7. **HTTP 回复**：`POST /question/{que_xxx}/reply` → 200 OK
8. **验证后续事件**：收到 `question.replied`、`message.part.updated` 等 47 个后续事件

---

## 6. 已知问题与待办

### 历史待办（已归档；不作为当前实施清单）

- [x] **迁移到 SDK v2**：现行入口为 `src/opencode/server.ts` 的 `@opencode-ai/sdk/v2`
- [x] **检查 v2 类型兼容性**：现行 Question 操作位于 `src/backends/opencode/adapter.ts`
- [ ] **清理诊断日志**：streaming.ts、handler.ts 中的临时 console.log 可移除
- [ ] **ESLint 进一步调优**：当前 moderate config，后续可考虑更严格

### 已解决

- [x] SDK `client.question` 为 `undefined` → 使用 raw HTTP fallback
- [x] `ChatQuestionOption.value` 缺失 → 添加 `value: unknown` 字段
- [x] Answer 提取格式错误 → 使用 `selectedValue` / `selectedValues` / `freeformValue`
- [x] Event-Broker SSE 流断连 → `pumpWithReconnect()` 自动重连
- [x] 44 个 TypeScript 编译错误全部修复

---

## 7. 配置参考

### opencode.json（question 工具需要）

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

`permission.edit = "ask"` 是 externalEdit checkpoint 机制所需。question 工具本身不需要特殊权限配置。

### vitest.integration.config.ts

```typescript
export default defineConfig({
  test: {
    include: ['src/test/integration/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
```
