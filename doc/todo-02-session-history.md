# TODO 知识储备：还原会话历史 (provideChatSessionContent)

> **历史调研归档**：会话恢复现在从 v2 SSP/SSS 记录重放，不再按正文中的旧
> `src/acp/*` 路径或后端消息投影方案实现。现行设计见
> [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md)。
>
> **完成状态（2026-09）**：会话历史已由 `experimental-session.ts` 从
> `session.jsonl`/`meta.jsonl` 的 SSP/SSS 记录恢复；本文的 SDK messages 方案仅作
> 历史调研。

> 对应 TODO 条目：**还原会话历史** — 使 `provideChatSessionContent` 返回真实的会话历史，支持从已注册的 session target 恢复之前的对话。
>
> 本文档在开始实现之前编写，目的是收集所有必要的 API 知识、架构上下文和实现指引。

---

## 1. TODO 目标描述

**历史现状**：本文编写时 `createSessionContentProvider()` 返回的 `history` 是**空数组 `[]`**（见第 332 行）；现行实现已从 SSP/SSS 记录重建历史。

**目标**：当用户选择 OpenCode session target 并切换到一个已有 session 时，VS Code 会调用 `provideChatSessionContent`。我们的实现需要：

1. 从 `resource` URI 中提取 session ID
2. 通过 OpenCode SDK 从 backend 获取该 session 的消息历史
3. 将消息映射为 VS Code 的 `ChatRequestTurn` / `ChatResponseTurn` 交替数组
4. 返回 `ChatSession` 对象（包含 `history`、`requestHandler`、`title` 等）
5. 恢复后的会话支持继续对话（`requestHandler` 路由到 OpenCode backend）
6. 恢复后的 `ChatResponseTurn` 仍携带 `metadata`（sessionId / turnMap），使后续的 `resolveSession` 正常工作

---

## 2. VS Code Proposed API 参考

### 2.1 注册入口

```json
// package.json
"enabledApiProposals": [
    "chatParticipantAdditions",
    "chatParticipantPrivate",
    "chatSessionsProvider"
],
"contributes": {
    "chatSessions": [{
        "type": "acpilot.opencode",
        "name": "opencode",
        "displayName": "OpenCode",
        "description": "AI coding agent powered by OpenCode",
        "icon": "$(terminal)",
        "inputPlaceholder": "Ask OpenCode anything...",
        "canDelegate": true,
        "capabilities": {
            "supportsFileAttachments": true,
            "supportsToolAttachments": true
        }
    }]
}
```

### 2.2 ChatSessionContentProvider 接口

```typescript
interface ChatSessionContentProvider {
    provideChatSessionContent(
        resource: Uri,
        token: CancellationToken,
        context: { readonly inputState: ChatSessionInputState },
    ): Thenable<ChatSession> | ChatSession;

    readonly onDidChangeChatSessionProviderOptions?: Event<void>;
    readonly optionGroups?: readonly ChatSessionProviderOptionGroup[];
}
```

**关键点**：
- `resource` 参数是一个 URI，包含 session ID（在 `path` 中）
- `context.inputState` 包含用户选择的选项（model、agent 等）
- 当用户选择 session target 或切换已有 session 时，VS Code 调用此方法
- 当前 scheme 是 `acpilot.opencode`（定义见 `OPENCODE_SESSION_SCHEME`）

### 2.3 ChatSession 返回类型

```typescript
interface ChatSession {
    readonly title?: string;
    readonly history: (ChatRequestTurn | ChatResponseTurn)[];
    readonly options?: ChatSessionInputState;
    readonly activeResponseCallback?: (
        stream: ChatResponseStream,
        token: CancellationToken,
    ) => Thenable<void>;
    readonly requestHandler: ChatRequestHandler | undefined;
    readonly forkHandler?: (
        sessionResource: Uri,
        request: ChatRequestTurn | undefined,
        token: CancellationToken,
    ) => Thenable<ChatSessionItem> | ChatSessionItem;
}
```

**关键点**：
- `history` 是核心：一个 `ChatRequestTurn` / `ChatResponseTurn` **交替**的数组
- `requestHandler` **必须设置**，否则 session 是只读的
- `activeResponseCallback` 用于恢复正在进行的交互（可选）
- `forkHandler` 用于处理会话分叉（可选）

### 2.4 ChatRequestTurn 类型

```typescript
// Stable API
class ChatRequestTurn {
    readonly prompt: string;
    readonly command: string | undefined;
    readonly references: readonly ChatPromptReference[];
}

// Proposed API (chatParticipantPrivate) - ChatRequestTurn2 扩展
interface ChatRequestTurn2 extends ChatRequestTurn {
    readonly sessionId: string;
    readonly sessionResource: Uri;
    readonly attempt: number;
}
```

**构造方式**：
```typescript
new vscode.ChatRequestTurn(
    prompt: string,             // 用户输入的文本
    command: string | undefined, // 斜杠命令（如果有）
    references: readonly ChatPromptReference[],  // 引用/附件
)
```

### 2.5 ChatResponseTurn 类型

```typescript
// Stable API
class ChatResponseTurn {
    readonly responses: readonly ChatResponsePart[];
    readonly result?: ChatResult;
}
```

**ChatResponsePart 可以是**：
- `ChatResponseMarkdownPart` — 文本回复
- `ChatResponseFileTreePart` — 文件树
- `ChatResponseTerminalPart` — 终端输出
- 加上 proposed API：
  - `ChatToolInvocationPart` — 工具调用卡片
  - `ChatResponseExternalEditPart` — 外部编辑
  - `ChatResponseMultiDiffPart` — 文件 diff
  - `ChatResponseWorkspaceEditPart` — 新建文件

**构造方式**：
```typescript
new vscode.ChatResponseTurn(
    responses: readonly ChatResponsePart[],
    result?: ChatResult,   // 可包含 metadata
)
```

**metadata 传递方式**：
```typescript
new vscode.ChatResponseTurn(
    responses,
    {
        metadata: {
            sessionId: opencodeSessionId,
            turnMap: currentTurnMap,
        },
    },
)
```

### 2.6 完整调用链

```
1. package.json → "chatSessions" contribution → 声明 URI scheme + label
2. extension.ts → vscode.chat.registerChatSessionContentProvider(scheme, provider, participant, caps)
3. 用户选择 OpenCode session target 或切换已有 session
4. VS Code core → provider.provideChatSessionContent(uri, token, { inputState })
5. 我们的实现：
   a. 从 uri.path 解析 session ID（可能为空表示新建）
   b. 从 OpenCode backend 获取消息历史（client.v2.session.messages()）
   c. 转换为 ChatRequestTurn[] + ChatResponseTurn[]
   d. 在 ChatResponseTurn 的 result.metadata 中存储 sessionId + turnMap
   e. 返回 { history, requestHandler, title }
6. VS Code core → 渲染 history[] 到 chat UI
7. 新用户消息通过 requestHandler 路由到 OpenCode backend
```

---

## 3. OpenCode SDK v2 的消息获取 API

### 3.1 关键发现

通过分析 `@opencode-ai/sdk` v2 的类型定义，确认 SDK 提供两个层级的消息获取 API：

#### 3.1.1 旧路径：`client.session.messages()`

```typescript
// SDK v2 - Session2 类的 messages 方法
class Session2 {
    messages(parameters: {
        sessionID: string;
        directory?: string;
        workspace?: string;
        limit?: number;
        before?: string;  // 分页游标
    }): Promise<RequestResult<SessionMessagesResponses, SessionMessagesErrors>>;
}

// 返回类型：Array<{ info: Message; parts: Array<Part> }>
// Message = UserMessage | AssistantMessage
```

**UserMessage 结构**：
```typescript
type UserMessage = {
    id: string;
    sessionID: string;
    role: "user";
    time: { created: number };
    agent: string;
    model: { providerID: string; modelID: string; variant?: string };
    // 注意：UserMessage 没有 content 字段
    // prompt 内容需要从 Parts 中获取
};
```

**AssistantMessage 结构**：
```typescript
type AssistantMessage = {
    id: string;
    sessionID: string;
    role: "assistant";
    time: { created: number; completed?: number };
    parentID: string;
    modelID: string;
    providerID: string;
    agent: string;
    cost: number;
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    error?: ProviderAuthError | UnknownError | ...;
};
```

**Part 类型**（消息的组成部分）：
```typescript
type Part = TextPart | ReasoningPart | FilePart | ToolPart | SubtaskPart | ...;
type TextPart = { id: string; sessionID: string; messageID: string; type: "text"; text: string; ... };
type ReasoningPart = { id: string; sessionID: string; messageID: string; type: "reasoning"; text: string; ... };
type ToolPart = { id: string; sessionID: string; messageID: string; type: "tool"; tool: string; ... };
```

#### 3.1.2 新路径：`client.v2.session.messages()`（推荐）

```typescript
// SDK v2 - V2 命名空间下的 Session3 类的 messages 方法
class V2 {
    get session(): Session3;
}
class Session3 {
    messages(parameters: {
        sessionID: string;
        directory?: string;
        workspace?: string;
        limit?: number;
        order?: "asc" | "desc";
        cursor?: string;
    }): Promise<RequestResult<V2SessionMessagesResponses, V2SessionMessagesErrors>>;
}

// 返回类型
type V2SessionMessagesResponse = {
    items: Array<SessionMessage>;
    cursor: { previous?: string; next?: string };
};
```

**SessionMessage 类型**（被"投影"过的消息，更易于消费）：
```typescript
type SessionMessage =
    | SessionMessageUser          // type: "user" - 用户输入
    | SessionMessageAssistant     // type: "assistant" - AI 回复
    | SessionMessageSynthetic     // type: "synthetic" - 系统合成
    | SessionMessageShell         // type: "shell" - shell 命令
    | SessionMessageAgentSwitched // agent 切换记录
    | SessionMessageModelSwitched // model 切换记录
    | SessionMessageCompaction;   // 会话压缩
```

**SessionMessageUser**（用户消息）：
```typescript
type SessionMessageUser = {
    id: string;
    type: "user";
    text: string;           // 用户输入的文本
    time: { created: number };
    files?: Array<PromptFileAttachment>;
    agents?: Array<PromptAgentAttachment>;
    references?: Array<PromptReferenceAttachment>;
    metadata?: { [key: string]: unknown };
};
```

**SessionMessageAssistant**（AI 回复）：
```typescript
type SessionMessageAssistant = {
    id: string;
    type: "assistant";
    time: { created: number; completed?: number };
    content: Array<
        | SessionMessageAssistantText      // { type: "text"; text: string }
        | SessionMessageAssistantReasoning // { type: "reasoning"; id: string; text: string }
        | SessionMessageAssistantTool      // { type: "tool"; id: string; name: string; state: ... }
    >;
    metadata?: { [key: string]: unknown };
};
```

### 3.2 推荐使用 `client.v2.session.messages()`

**理由**：

| 对比维度 | `client.session.messages()` (旧) | `client.v2.session.messages()` (新) |
|----------|----------------------------------|--------------------------------------|
| 返回结构 | 嵌套：`{ info: Message, parts: Part[] }[]` | 扁平：`SessionMessage[]` |
| 用户消息内容 | 需要从 parts 中拼装 | 直接有 `text` 字段 |
| AI 回复内容 | 需要遍历 parts 解析 text/tool | 直接有 `content[]` 结构化数组 |
| 分页 | `before` 游标 | `cursor` + `order` 双向游标 |
| 易用性 | 需要手动组合 info + parts | 直接可用，无需组合 |

### 3.3 当前 OpenCodeClient 接口的缺失

当前 `src/types/index.ts` 中的 `OpenCodeClient` 接口缺少 `v2` 命名空间和 `messsages()` 方法：

```typescript
// 当前接口 —— 缺少 messages() 和 v2
export interface OpenCodeClient {
    session: {
        create(...): ...;
        get(...): ...;
        prompt(...): ...;
        revert(...): ...;
        abort(...): ...;
        list(...): ...;
        children(...): ...;
        status(...): ...;
        // ❌ 缺少 messages()
    };
    // ❌ 缺少 v2 命名空间
}
```

**需要添加**：
- `session.messages()` — 旧路径，用于获取消息 + parts
- `v2.session.messages()` — 新路径，推荐用于历史还原

---

## 4. 现有代码中的会话管理机制

### 4.1 TurnMap 系统

`src/types/index.ts` 定义了 `TurnMapping` 接口：

```typescript
export interface TurnMapping {
    /** VSCode 用户 turn 的 0-based 索引 */
    vscodeTurn: number;
    /** 对应的 OpenCode message ID */
    opencodeMessageId: string;
}

export interface SessionState {
    opencodeSessionId: string;
    turnMap: TurnMapping[];
}
```

每个 VSCode chat panel 维护一个 turnMap，记录 VSCode turn 与 OpenCode message ID 的映射关系。turnMap 通过 `ChatResponseTurn.result.metadata` 持久化。

### 4.2 Session 同步机制 (participant/handler.ts)

`recoverFromHistory()` 函数：
```typescript
function recoverFromHistory(context: vscode.ChatContext): RecoveredHistory {
    // 从 ChatResponseTurn.metadata 中恢复 sessionId 和 turnMap
    // 扫描方向：从最新到最旧
    for (let i = history.length - 1; i >= 0; i--) {
        const metadata = (turn as any)?.metadata;
        if (metadata?.sessionId && metadata?.turnMap) {
            return { sessionId, turnMap };
        }
    }
    return { sessionId: null, turnMap: [] };
}
```

`resolveSession()` 处理三种情况：
1. **新 chat** — 无先前状态，创建新 OpenCode session
2. **继续** — turn 数量匹配，复用已有 session
3. **回退** — turn 数量减少，revert 到匹配的 message

### 4.3 当前 provideChatSessionContent 实现

```typescript
// src/surfaces/vscode/experimental-session.ts (第 321-472 行)
provideChatSessionContent(resource, _token, _context): ChatSession {
    return {
        history: [],  // ← 历史实现曾为空数组；现行实现走 SSP/SSS 重放
        requestHandler: async (request, _context, stream, token) => {
            // 处理新消息的逻辑已经实现
            // ...
        },
    };
}
```

history 为空意味着用户切换到 OpenCode session target 时看不到历史消息。requestHandler 已经能正常工作（创建 session、发送 prompt、渲染事件流）。

### 4.4 Event Broker

`GlobalEventBroker`（`src/backends/opencode/event-broker.ts`）管理所有活跃的 session event streams：

```typescript
class GlobalEventBroker {
    private sessionChannels: Map<string, SessionChannel> = new Map();
    private partSessions: Map<string, string> = new Map(); // partID → sessionID
    private childToParent: Map<string, string> = new Map();

    async ensureStarted(client: OpenCodeClient, logger?): Promise<void>;
    openSessionStream(sessionId: string): OpenCodeEventStream;
    closeSessionStream(sessionId: string): void;
    getDescendantSessions(parentId: string): string[];
    findAncestorIn(sessionId: string, candidateIds: Set<string>): string | undefined;
}
```

Event broker 是实时的，不持久化历史消息。但它维护了 session 的父子关系（sub-agent 树），在恢复历史时可能有用（用于 fork 检测）。

---

## 5. 实现方案设计

### 5.1 架构图

```
provideChatSessionContent(uri, token, { inputState })
    │
    ├─ 解析 session ID: uri.path
    │
    ├─ [新 session] uri.path 为空或 "new"
    │   └─ 返回 { history: [], requestHandler, title: "New Chat" }
    │
    ├─ [已有 session] uri.path 包含 session ID
    │   ├─ 1. state.backend.v2.session.messages({ sessionID, order: "asc" })
    │   ├─ 2. 过滤 SessionMessageUser + SessionMessageAssistant
    │   ├─ 3. 排序（按 time.created 升序）
    │   ├─ 4. 交替构建 ChatRequestTurn / ChatResponseTurn
    │   │   ├─ SessionMessageUser    → ChatRequestTurn
    │   │   └─ SessionMessageAssistant → ChatResponseTurn + metadata
    │   ├─ 5. 重建 turnMap
    │   └─ 6. 返回 { history, requestHandler, title }
    │
    └─ [异常/backend 未启动] 优雅降级
        └─ 返回 { history: [], requestHandler, title: "Offline" }
```

### 5.2 方案 A：使用 v2.session.messages()（推荐）

**步骤分解**：

**A. 添加 SDK 接口**

在 `src/types/index.ts` 的 `OpenCodeClient` 中添加：

```typescript
export interface OpenCodeClient {
    session: {
        // ... 现有方法 ...
        messages(parameters: {
            sessionID: string;
            directory?: string;
            limit?: number;
            before?: string;
        }): Promise<SdkResponse<Array<{ info: Message; parts: Array<Part> }>>>;
    };
    v2: {
        session: {
            messages(parameters: {
                sessionID: string;
                directory?: string;
                limit?: number;
                order?: "asc" | "desc";
                cursor?: string;
            }): Promise<SdkResponse<{ items: Array<SessionMessage>; cursor: { previous?: string; next?: string } }>>;
        };
    };
}
```

**B. 在 AcpSessionOperations 中添加消息获取接口**

```typescript
// src/acp/backend.ts
export interface AcpSessionOperations {
    // ... 现有方法 ...
    messages(id: string, directory?: string): Promise<AcpResult<SessionMessageHistory>>;
}

export interface SessionMessageHistory {
    items: Array<{ role: "user" | "assistant"; text: string; id: string; metadata?: Record<string, unknown> }>;
}
```

**C. 在 OpenCodeBackend 中实现**

```typescript
// src/backends/opencode/adapter.ts
readonly sessions: AcpSessionOperations = {
    // ... 现有实现 ...
    
    messages: async (id: string, directory?: string): Promise<AcpResult<SessionMessageHistory>> => {
        try {
            const result = await this.sdk.v2.session.messages({ sessionID: id, directory, order: "asc" });
            const error = getResultError(result);
            if (error) return { error: extractErrorMessage(error, 'Failed to get messages') };
            
            const items = result.data?.items ?? [];
            const mapped: Array<{ role: "user" | "assistant"; text: string; id: string }> = [];
            
            for (const msg of items) {
                if (msg.type === "user") {
                    mapped.push({ role: "user", text: msg.text, id: msg.id });
                } else if (msg.type === "assistant") {
                    const textContent = msg.content
                        .filter(c => c.type === "text")
                        .map(c => (c as SessionMessageAssistantText).text)
                        .join("\n");
                    mapped.push({ role: "assistant", text: textContent, id: msg.id });
                }
            }
            
            return { data: { items: mapped } };
        } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
        }
    },
};
```

**D. 在 provideChatSessionContent 中使用**

```typescript
export function createSessionContentProvider(state, _context): ChatSessionContentProvider {
    return {
        provideChatSessionContent(resource, token, _context): ChatSession {
            const logger = state.outputChannel;
            const sessionId = resource.path?.replace(/^\//, "") || "";
            
            // 新 session 处理
            if (!sessionId || sessionId === "new") {
                return {
                    title: "New OpenCode Session",
                    history: [],
                    requestHandler: createRequestHandler(state),
                };
            }
            
            // 已有 session — 异步获取历史
            return fetchSessionHistory(state, sessionId, logger, token)
                .then(chatSession => chatSession)
                .catch(err => {
                    logger.appendLine(`[session-provider] Failed to fetch history: ${err}`);
                    return {
                        title: "OpenCode (offline)",
                        history: [],
                        requestHandler: createRequestHandler(state),
                    };
                });
        },
    };
}

async function fetchSessionHistory(
    state: ExtensionState,
    sessionId: string,
    logger: { appendLine: (m: string) => void },
    token: CancellationToken,
): Promise<ChatSession> {
    // 1. 获取 session 信息（用于 title）
    const sessionInfo = await state.backend.sessions.get(sessionId);
    const title = sessionInfo.data?.title ?? `Session ${sessionId.slice(0, 8)}`;
    
    // 2. 获取消息历史
    const result = await state.backend.sessions.messages(sessionId);
    if (result.error || !result.data) {
        throw new Error(result.error as string ?? "Failed to fetch messages");
    }
    
    // 3. 过滤并排序消息
    const messages = result.data.items.filter(m => m.role === "user" || m.role === "assistant");
    
    // 4. 转换为 ChatRequestTurn / ChatResponseTurn 交替数组
    const history: (ChatRequestTurn | ChatResponseTurn)[] = [];
    const turnMap: TurnMapping[] = [];
    let vscodeTurnIndex = 0;
    
    for (const msg of messages) {
        if (msg.role === "user") {
            history.push(new vscode.ChatRequestTurn(
                msg.text,
                undefined, // command
                [],        // references
            ));
        } else if (msg.role === "assistant") {
            const responses: ChatResponsePart[] = [
                new vscode.ChatResponseMarkdownPart(msg.text),
            ];
            
            history.push(new vscode.ChatResponseTurn(
                responses,
                {
                    metadata: {
                        sessionId,
                        turnMap: [...turnMap], // 拍平快照
                    },
                },
            ));
            
            turnMap.push({
                vscodeTurn: vscodeTurnIndex,
                opencodeMessageId: msg.id,
            });
            vscodeTurnIndex++;
        }
    }
    
    // 5. 返回 ChatSession
    return {
        title,
        history,
        requestHandler: createRequestHandler(state),
    };
}
```

### 5.3 方案 B：使用旧路径 `session.messages()`（备选）

如果 v2 路径不可用，可以回退到旧路径：

```typescript
const result = await this.sdk.session.messages({ sessionID: id, directory });
const items = result.data ?? []; // Array<{ info: Message; parts: Part[] }>

for (const item of items) {
    if (item.info.role === "user") {
        // 从 parts 中提取 text
        const text = item.parts
            .filter(p => p.type === "text")
            .map(p => (p as TextPart).text)
            .join("\n");
        history.push(new ChatRequestTurn(text, undefined, []));
    } else if (item.info.role === "assistant") {
        const text = item.parts
            .filter(p => p.type === "text")
            .map(p => (p as TextPart).text)
            .join("\n");
        history.push(new ChatResponseTurn(
            [new ChatResponseMarkdownPart(text)],
            { metadata: { sessionId, turnMap: [...] } },
        ));
    }
}
```

### 5.4 方案 C：混合策略

1. 优先尝试 `v2.session.messages()`（返回结构化数据）
2. 如果报错或未实现，fallback 到 `session.messages()`
3. 如果 backend 未启动，返回空 history + 降级提示

---

## 6. ChatRequestTurn / ChatResponseTurn 构造注意事项

### 6.1 构造 ChatRequestTurn

```typescript
new vscode.ChatRequestTurn(
    prompt: string,                                    // 用户消息文本
    command: string | undefined,                       // 斜杠命令（如 "/model"）
    references: readonly vscode.ChatPromptReference[], // 引用/附件
)
```

**注意**：
- 恢复历史时，command 通常为 `undefined`（除非我们记录了每条消息的 command）
- references 在历史中通常为空 `[]`
- prompt 不应超过 VSCode 的消息长度限制

### 6.2 构造 ChatResponseTurn

```typescript
new vscode.ChatResponseTurn(
    responses: readonly vscode.ChatResponsePart[],
    result?: vscode.ChatResult,  // 包含 metadata
)
```

**注意**：
- 构造函数的第二个参数是 `ChatResult` 类型，其中 `metadata` 是 proposed API 属性
- 需要类型断言来设置 metadata：
  ```typescript
  const turn = new vscode.ChatResponseTurn(
      [new vscode.ChatResponseMarkdownPart(text)],
      { metadata: { sessionId, turnMap } } as any,
  );
  ```
- 恢复历史时，工具调用 (`ChatToolInvocationPart`) 可以省略，因为它们主要用于交互式显示
- 但如果需要完整的体验，应该解析 assistant message 的 content 中的 tool 条目

### 6.3 metadata 传递

```typescript
// ChatResult 中的 metadata
{
    metadata: {
        sessionId: string;         // OpenCode session ID
        turnMap: TurnMapping[];    // turn 映射表（仅 assistant 消息）
    }
}
```

**关键**：恢复历史时，每个 `ChatResponseTurn` 的 `result.metadata` 必须包含 `sessionId` 和 `turnMap`。这样后续用户发消息时，`recoverFromHistory()` 可以从这些 metadata 中恢复 session 状态。

### 6.4 与现有 recoverFromHistory 的兼容性

`recoverFromHistory()`（`src/participant/handler.ts`）通过以下方式提取 metadata：

```typescript
const metadata = (turn as unknown as { metadata?: Record<string, unknown> })?.metadata;
const sessionId = metadata.sessionId as string | undefined;
const turnMapRaw = metadata.turnMap as Array<{ vscodeTurn: number; opencodeMessageId: string }> | undefined;
```

这意味着：
- 每个 `ChatResponseTurn` 都必须设置 `metadata.sessionId` 和 `metadata.turnMap`
- `turnMap` 应该是该点的完整快照（包含之前所有 turn 的映射）
- `vscodeTurn` 索引需要与 `history` 数组中的位置一致

### 6.5 关于 ChatResponsePart 的完整性

在恢复历史时，需要决定是否要渲染完整的 part 类型：

| Part 类型 | 是否恢复 | 理由 |
|-----------|----------|------|
| `ChatResponseMarkdownPart` | **是** | 核心文本回复，必须恢复 |
| `ChatResponseFileTreePart` | 可选 | 如果有文件树信息 |
| `ChatResponseTerminalPart` | 否 | 终端输出在历史中不易重建 |
| `ChatToolInvocationPart` | 可选 | 工具调用卡片增强体验，但非必需 |
| `ChatResponseMultiDiffPart` | 否 | diff 在回复上下文中可见即可 |
| `ChatResponseExternalEditPart` | 否 | 仅用于实时显示 |

**建议**：第一阶段只恢复 `ChatResponseMarkdownPart`，后续迭代再补充 tool 和 diff 部分。

---

## 7. 实现步骤与文件修改

### 7.1 需要修改的文件

| 文件 | 修改内容 | 优先级 |
|------|---------|--------|
| `src/types/index.ts` | 添加 `session.messages()` 和 `v2.session.messages()` 到 `OpenCodeClient` | **高** |
| `src/acp/backend.ts` | 添加 `AcpSessionOperations.messages()` 和 `SessionMessageHistory` 类型 | **高** |
| `src/acp/types.ts` | 可选：添加 `AcpMessage` 类型定义 | 中 |
| `src/backends/opencode/adapter.ts` | 实现 `sessions.messages()` 调用 SDK | **高** |
| `src/surfaces/vscode/experimental-session.ts` | 修改 `provideChatSessionContent` 实现历史获取 | **高** |
| `src/participant/handler.ts` | 确保与恢复后的历史兼容（已有 `recoverFromHistory`，通常不需要修改） | 低 |

### 7.2 详细的实现顺序

1. **给 OpenCodeClient 添加接口**（types/index.ts）
   - 从 SDK 类型定义中引入 `Message`、`Part`、`SessionMessage` 等类型
   - 添加 `session.messages()` 方法签名
   - 添加 `v2` 命名空间和 `v2.session.messages()` 方法签名

2. **给 AcpSessionOperations 添加方法**（acp/backend.ts）
   - 定义 `SessionMessageItem` 接口（`{ role, text, id }`）
   - 定义 `SessionMessageHistory` 接口（`{ items: SessionMessageItem[] }`）
   - 添加 `messages(id, directory)` 方法

3. **在 OpenCodeBackend 实现**（backends/opencode/adapter.ts）
   - 优先调用 `this.sdk.v2.session.messages()`
   - fallback 到 `this.sdk.session.messages()`
   - 将 SDK 返回转换为 ACP 类型
   - 添加日志以方便调试

4. **重写 provideChatSessionContent**（experimental-session.ts）
   - 解析 `resource.path` 获取 session ID
   - 新 session → 返回空 history
   - 已有 session → 调用 `state.backend.sessions.messages()`
   - 映射为 `(ChatRequestTurn | ChatResponseTurn)[]`
   - 在每个 `ChatResponseTurn` 的 metadata 中设置 sessionId + turnMap
   - 返回 `{ title, history, requestHandler }`
   - 异常处理（backend 未启动、消息获取失败等）

5. **验证兼容性**
   - 检查 `recoverFromHistory` 是否能从恢复后的 metadata 中提取数据
   - 验证 `resolveSession` 在历史恢复后能正确处理"继续"场景
   - 测试从 session target 切换回已有 session 时能显示历史

### 7.3 关键代码示意

```typescript
// experimental-session.ts — provideChatSessionContent 核心实现

provideChatSessionContent(
    resource: vscode.Uri,
    token: vscode.CancellationToken,
    _context: { readonly inputState: vscode.ChatSessionInputState },
): vscode.ChatSession {
    const sessionId = resource.path?.replace(/^\//, "") || "";
    
    // 新 session
    if (!sessionId || sessionId === "new") {
        return {
            title: "New OpenCode Session",
            history: [],
            requestHandler: this.createRequestHandler(state),
        };
    }
    
    // 异步获取历史（provideChatSessionContent 支持 Thenable 返回）
    return this.fetchAndBuildHistory(state, sessionId, token);
}

private async fetchAndBuildHistory(
    state: ExtensionState,
    sessionId: string,
    token: vscode.CancellationToken,
): Promise<vscode.ChatSession> {
    // 1. 获取 session 元数据
    const sessionResult = await state.backend.sessions.get(sessionId);
    const title = sessionResult.data?.title ?? `Session ${sessionId.slice(0, 8)}`;
    
    // 2. 获取消息历史
    const messagesResult = await state.backend.sessions.messages(sessionId);
    if (messagesResult.error || !messagesResult.data) {
        state.outputChannel.appendLine(
            `[session-provider] Failed to get messages: ${JSON.stringify(messagesResult.error)}`,
        );
        return { title, history: [], requestHandler: this.createRequestHandler(state) };
    }
    
    // 3. 构建 turns
    const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] = [];
    const turnMap: TurnMapping[] = [];
    let turnIndex = 0;
    
    for (const msg of messagesResult.data.items) {
        if (token.isCancellationRequested) break;
        
        if (msg.role === "user") {
            history.push(new vscode.ChatRequestTurn(msg.text, undefined, []));
        } else if (msg.role === "assistant") {
            // 注意：turnMap 在 ChatResponseTurn 中记录
            // 因为 ChatRequestTurn 没有 metadata
            history.push(new vscode.ChatResponseTurn(
                [new vscode.ChatResponseMarkdownPart(msg.text)],
                { metadata: { sessionId, turnMap: [...turnMap] } } as any,
            ));
            turnMap.push({ vscodeTurn: turnIndex, opencodeMessageId: msg.id });
            turnIndex++;
        }
    }
    
    state.outputChannel.appendLine(
        `[session-provider] Built history for ${sessionId}: ${history.length} turns`,
    );
    
    return {
        title,
        history,
        requestHandler: createRequestHandler(state),
    };
}
```

---

## 8. 风险与边界情况

### 8.1 已知风险

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| SDK 可能没有 `v2.session.messages()` | 无法获取消息 | Fallback 到 `session.messages()` |
| `ChatResponseTurn` 的 `metadata` 是 proposed API | 类型检查错误 | 使用类型断言 `as any` 或条件编译 |
| 大量历史消息（100+ turn） | 渲染性能问题 | 限制加载数量，支持分页 |
| Session 包含 sub-agent 消息 | 消息顺序复杂 | 只显示顶级 user/assistant 消息 |
| Backend 未启动 | 无法获取历史 | 优雅降级，返回空 history |
| Session 已被删除 | 404 错误 | 捕获异常，返回降级内容 |
| 消息中包含工具调用 | 无法恢复 tool card | 第一阶段只恢复 markdown |

### 8.2 URI Path 格式约定

当前 `resource` URI 的 path 格式还没有统一的约定。需要考虑：

```typescript
// VS Code 传给 provideChatSessionContent 的 URI 示例
// 方案 A: /{sessionID}
//   示例: acpilot.opencode:/abc123
// 方案 B: /chat/{sessionID}
//   示例: acpilot.opencode:/chat/abc123

// 解析方式
const sessionId = resource.path
    .replace(/^\//, "")           // 去掉前导 /
    .replace(/^chat\//, "")       // 可选：去掉 chat/ 前缀
    .split("/")[0];               // 取第一段
```

**当前做法**（查看 `forkHandler` 调用处的日志）：
```typescript
// 在现有代码中的日志输出
`[session-provider] provideChatSessionContent called for ${resource.toString()}`
```

因此 URI 格式需要在实现时确认。

### 8.3 空 history 的降级行为

当无法获取历史时，返回 `{ history: [] }` 是安全的：
- VS Code 会显示一个空的聊天面板
- 用户可以继续输入新消息
- requestHandler 会创建新 session 或尝试恢复

### 8.4 forkHandler 的兼容性

如果提供了 `forkHandler`，用户可以从历史 session 分叉出新会话。这需要：
- 分叉时创建新的 OpenCode session（设置 `parentID`）
- 新 session 继承当前 context 中的文件状态
- 分叉后的会话独立于原会话

第一阶段可以省略 `forkHandler`，只提供只读历史 + 可继续对话。

---

## 9. 需确认的前置问题

1. **URI 格式**：session resource URI 的 path 格式是什么？`/{sessionID}` 还是 `/{type}/{sessionID}`？

2. **SDK 中的 v2 命名空间**：当前 SDK 初始化方式 `createOpencode()` 返回的 `client` 是否已经包含 `v2` 属性？需要确认：
   - `client.v2.session.messages()` 是否可用
   - 返回的 `SessionMessage` 类型是否与类型定义一致

3. **消息排序**：`v2.session.messages()` 的 `order: "asc"` 是否按时间正序返回？cursor 分页的具体行为？

4. **消息完整性**：`SessionMessageAssistant` 的 `content` 数组是否包含完整的 text + reasoning + tool 条目？还是只包含最终状态的摘要？

5. **会话状态**：如果一个 session 有正在进行的交互（未 idle），`v2.session.messages()` 返回的是不完整的消息还是最终状态？

6. **会话标题**：`session.get()` 返回的 `Session` 类型包含 `title` 字段。当用户通过 OpenCode CLI/TUI 修改标题后，这个字段是否同步更新？

7. **turnMap 重建**：目前 turnMap 在 VSCode 侧管理（`ExtensionState.sessionMap`）。恢复历史时：
   - turnMap 需要从 ChatResponseTurn 的 metadata 中重建
   - 还是从 backend 消息中获取 message ID 重新生成？
   - 推荐：从 metadata 重建（利用持久化的 turnMap）

8. **VSCode 版本要求**：`chatSessionsProvider` 是 proposed API，仅在 VSCode >= 1.110.0 中可用。是否需要对更低版本做兼容？

9. **测试方法**：如何在开发环境中测试恢复历史的功能？
   - 可以通过 OpenCode CLI 创建一些会话数据
   - 然后在 VSCode 中切换到 OpenCode session target
   - 确认历史消息显示正确

---

## 10. 附录：关键文件与类型引用

### 10.1 代码文件

| 文件 | 作用 |
|------|------|
| `src/surfaces/vscode/experimental-session.ts` | 主要修改目标，ChatSessionContentProvider 实现 |
| `src/types/index.ts` | OpenCodeClient 接口定义 |
| `src/acp/backend.ts` | ACP 抽象层接口 |
| `src/acp/types.ts` | ACP 领域类型 |
| `src/backends/opencode/adapter.ts` | OpenCode backend 适配器 |
| `src/backends/opencode/event-broker.ts` | 会话事件流管理 |
| `src/participant/handler.ts` | 会话同步逻辑（recoverFromHistory, resolveSession） |
| `src/opencode/server.ts` | SDK 初始化 |
| `src/extension.ts` | 扩展入口，注册 provider |

### 10.2 SDK 类型文件

| 文件 | 作用 |
|------|------|
| `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` | SDK v2 完整类型定义 |
| `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` | SDK v2 OpencodeClient 类定义 |
| `node_modules/@opencode-ai/sdk/dist/v2/client.d.ts` | SDK v2 创建 client 的函数 |

### 10.3 关键类型索引

```
类型                          文件                          行号
─────────────────────────────────────────────────────────────────
Session (SDK 返回)            types.gen.d.ts               563
Message = UserMessage         types.gen.d.ts               328
UserMessage                   types.gen.d.ts               270
AssistantMessage              types.gen.d.ts               294
TextPart                      types.gen.d.ts               329
ToolPart                      types.gen.d.ts               445+
Part (union type)             types.gen.d.ts               553
SessionMessage (union)        types.gen.d.ts               3024
SessionMessageUser            types.gen.d.ts               2874
SessionMessageAssistant       types.gen.d.ts               2977
SessionMessageData            types.gen.d.ts               5295
V2SessionMessagesResponse     types.gen.d.ts               1452
V2SessionMessagesData         types.gen.d.ts               6236
Session2 (session.messages)   sdk.gen.d.ts                 897
Session3 (v2.session.messages) sdk.gen.d.ts                1299
```

---

## 11. 参考资源

- VS Code Proposed API: `vscode.chat.registerChatSessionContentProvider`
- VS Code Proposed API: `ChatSessionContentProvider` / `ChatSession`
- OpenCode SDK v2: `@opencode-ai/sdk/v2` — `client.session.messages()` 和 `client.v2.session.messages()`
- 现有实现参考：`src/surfaces/vscode/experimental-session.ts`（特别是 `renderWithExperimentalSurface` 和 `createSessionContentProvider`）
- 会话同步逻辑：`src/participant/handler.ts`（`recoverFromHistory` / `resolveSession`）
