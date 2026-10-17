# TODO-03 知识储备：接收图片 / 文件附件 / 会话上下文

> **历史调研归档**：本文保留附件能力的早期调研，正文中的 `src/acp/*` 文件路径和
> “当前状态”已过时。现行公共类型位于 `src/backend/*`，具体协议转换由对应 Backend
> 负责；架构边界见
> [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md)。
>
> **完成状态（2026-09）**：附件提取已接入 `handler.ts`，通过
> `BackendFileAttachment` 传给各 Backend adapter；下文保留为早期方案和 API 调研。

## 1. TODO 目标描述

**任务**: 支持从 VSCode 会话中接收图片、文件附件、会话历史等额外信息，传递给 OpenCode backend 处理。

**历史状态**: VSCode Chat 的 `chatSessions` contribution 已声明 `supportsFileAttachments: true`，但本文编写时 request handler 仅处理了 `request.prompt`（文本输入）和 `context.history`（会话同步），**完全未解析 `request.references`**（附件数组）；现行 `handler.ts` 已通过 `extractAttachmentsFromReferences()` 提取附件和路径引用。

**最终目标**: 
1. 用户在 VSCode Chat 输入框中粘贴图片、拖放文件、引用代码选区时，OpenCode 能正确接收并传递给模型
2. 会话上下文（`ChatContext.history`）能在需要时被消费（当前架构中 OpenCode 服务端维护自己的消息历史，客户端不需要转发）

---

## 2. VSCode Chat Attachment API 参考

### 2.1 核心发现：没有独立的 Attachment 类型

VSCode Chat 中所有附件都通过一个统一的机制传递：**`request.references`**（类型为 `ChatPromptReference[]`）。

不存在 `ChatRequestFileAttachment` 或 `ChatRequestImageAttachment` 这样的独立类型。所有附件都通过 `ChatPromptReference.value` 的类型判别来区分。

### 2.2 附件架构

```
用户在 VSCode Chat 中附加图片/文件
        ↓
request.references: ChatPromptReference[]
        ↓
ref.value 类型判别:
  ├── ChatReferenceBinaryData  → 图片粘贴/拖放 (proposed API)
  ├── Uri                      → 文件附件
  ├── Location                 → 代码选区引用
  └── string                   → 文本变量
```

### 2.3 ChatRequest 接口

```typescript
interface ChatRequest {
    readonly prompt: string;              // 用户输入的文本
    readonly references: readonly ChatPromptReference[];  // 所有附件/引用
    readonly command: string | undefined;  // 斜杠命令

    // Proposed API (chatParticipantPrivate):
    readonly id: string;
    readonly sessionId: string;
    readonly sessionResource: Uri;
    readonly attempt: number;
}
```

**注意**: `id`、`sessionId`、`sessionResource`、`attempt` 来自 proposed API `chatParticipantPrivate`，当前项目已启用并在 `src/types/vscode-proposed.d.ts` 中声明。

### 2.4 ChatPromptReference 类型

```typescript
interface ChatPromptReference {
    readonly value: string | Uri | Location | ChatReferenceBinaryData | unknown;
    readonly range?: [number, number];  // 在 prompt 字符串中的偏移
    readonly name: string;               // 引用标识符
    readonly id: string;                 // 唯一 ID
}
```

- `value` 是判别联合类型，根据实际附件类型返回不同值
- `range` 指示 prompt 中 `#ref` 占位符的位置
- `name` 是用户可见的引用名称

### 2.5 ChatReferenceBinaryData（图片支持）

**这是 proposed API**，需要在 `package.json` 的 `enabledApiProposals` 中启用 `chatReferenceBinaryData`。

```typescript
// 需要 proposed API: chatReferenceBinaryData
interface ChatReferenceBinaryData {
    readonly mimeType: string;     // e.g. 'image/png', 'image/jpeg'
    data(): Promise<Uint8Array>;   // 异步获取原始二进制数据
    readonly reference?: Uri;      // 可选的源文件 URI
}
```

**关键要点**:
- `data()` 是异步方法，返回 `Promise<Uint8Array>`，不能在同步上下文中调用
- `mimeType` 可用于判断是图片还是其他二进制数据
- 这是 proposed API，运行时能力检查必不可少
- `reference` 可选，如果是拖放已有文件，会指向源文件 URI

### 2.6 文件附件（Uri 类型）

```typescript
// 当用户附加文件时，ref.value 是一个 vscode.Uri
if (ref.value instanceof vscode.Uri) {
    const filePath = ref.value.fsPath;
    const content = await vscode.workspace.fs.readFile(ref.value);
    // content 为 Uint8Array
}
```

### 2.7 代码引用（Location 类型）

```typescript
// 当用户引用代码选区时，ref.value 是一个 vscode.Location
if (ref.value instanceof vscode.Location) {
    const uri = ref.value.uri;       // 文件 URI
    const range = ref.value.range;   // 选区范围
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText(range);  // 选中的代码文本
}
```

### 2.8 VSCode 内置支持的用户交互方式

| 交互方式 | 触发条件 | ref.value 类型 | mimeType 示例 |
|---------|---------|---------------|--------------|
| 粘贴图片 | Ctrl+V / Cmd+V 粘贴截图 | `ChatReferenceBinaryData` | `image/png`, `image/jpeg` |
| 拖放文件 | 从资源管理器拖放 | `Uri` | N/A |
| 拖放图片文件 | 拖放 `.png/.jpg` 文件 | `ChatReferenceBinaryData` | `image/png` |
| 拖放图片（二进制） | 从浏览器拖出图片 | `ChatReferenceBinaryData` | 由源决定 |
| 代码选区引用 | 在 prompt 中输入 `#` 选择 | `Location` | N/A |
| 文本变量 | 复制粘贴变量 | `string` | N/A |

**关键发现**: 图片文件的拖放有两种路径：
- 从 VSCode 文件资源管理器拖放图片文件 → `Uri`
- 从外部（浏览器、截图工具）拖放/粘贴图片 → `ChatReferenceBinaryData`

两种路径都需要处理。

---

## 3. 当前代码库架构分析

### 3.1 文件目录结构（相关部分）

```
src/
├── participant/
│   ├── handler.ts          # 入口：ChatRequestHandler，处理 request 和 context
│   ├── streaming.ts        # SSE 事件桥接到 VSCode ChatResponseStream
│   ├── commands.ts         # 斜杠命令路由
│   └── errors.ts           # 错误消息
├── backends/
│   └── opencode/
│       ├── adapter.ts      # AcpBackend 实现：OpenCode SDK 适配层
│       ├── events.ts       # 事件标准化
│       ├── event-broker.ts # 全局事件路由
│       └── sdk-events.ts   # SDK 事件类型
├── acp/
│   ├── backend.ts          # ACP 抽象接口定义
│   └── types.ts            # ACP 协议类型（无 VSCode/SDK 依赖）
├── types/
│   ├── index.ts            # OpenCodeClient 接口定义
│   ├── vscode-proposed.d.ts       # chatParticipantPrivate proposed API
│   └── vscode-proposed-additions.ts # chatParticipantAdditions proposed API
├── opencode/
│   └── server.ts           # OpenCode 服务生命周期管理
└── test/
    └── handler.test.ts     # 单元测试
```

### 3.2 数据流（当前）

```
VSCode Chat input (text only)
    ↓
handler.ts: createParticipantHandler()
    ├── 解析 request.prompt (text)
    ├── 解析 context.history (仅用于 session 同步，不转发)
    ├── 调用 state.backend.sessions.prompt(id, text, dir, options)
    │       ↓
    │   adapter.ts OpenCodeBackend.sessions.prompt()
    │       ↓
    │   sdk.session.prompt({ sessionID, directory, parts: [{ type: 'text', text }], model, agent })
    │       ↓
    │   OpenCode Server v2 SDK
    └── 桥接 SSE 事件到 VSCode stream
```

### 3.3 OpenCode SDK v2 的 parts 类型

从 `@opencode-ai/sdk` v2 的类型定义中，确认了以下 input part 类型：

```typescript
export type TextPartInput = {
    id?: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
};

export type FilePartInput = {
    id?: string;
    type: "file";
    mime: string;          // MIME 类型，如 "image/png"
    filename?: string;     // 可选文件名
    url: string;           // 内容 URL（支持 data: URI）
};

export type AgentPartInput = {
    id?: string;
    type: "agent";
    name: string;
    source?: { value: string };
};

export type SubtaskPartInput = {
    id?: string;
    type: "subtask";
    prompt: string;
    description: string;
    agent: string;
};
```

当前 `adapter.ts` 中的 prompt 调用:

```typescript
// src/backends/opencode/adapter.ts:262
const result = await this.sdk.session.prompt({
    sessionID: id,
    directory,
    parts: [{ type: 'text', text }],  // 仅为文本
    model: options?.model,
    agent: options?.agent,
});
```

**关键发现**: SDK 完整支持 `FilePartInput`，其中 `url` 字段可以接受 `data:` URI。这意味着图片附件可以编码为 base64 后通过 `data:image/png;base64,...` 格式传递。

### 3.4 历史 handler.ts 中缺失的附件处理

本文快照中的 `createParticipantHandler` 函数中：

- ✅ `request.prompt` — 已解析（用户文本输入）
- ✅ `context.history` — 已解析（仅用于 session 同步，不转发内容）
- ❌ `request.references` — **当时完全未解析**
- ❌ `request.references` 中的 `ChatReferenceBinaryData` — 当时完全未提取
- ❌ `request.references` 中的 `Uri` — 当时完全未读取
- ❌ `request.references` 中的 `Location` — 当时完全未读取

`handler.ts` 中的 prompt 调用（第 302-306 行）:

```typescript
const promptPromise = state.backend.sessions.prompt(
    sessionId,
    request.prompt,       // 仅传递文本
    directory,
    promptOptions,
);
```

### 3.5 ACP 接口的局限性

`src/acp/backend.ts` 中的 `AcpSessionOperations.prompt` 签名：

```typescript
prompt(
    id: string,
    text: string,              // 仅文本
    directory?: string,
    options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
    },
): Promise<AcpResult<unknown>>;
```

**历史接口不支持传递附件或 parts。** 现行 `BackendSessionOperations.prompt()` 已接受
`BackendFileAttachment[]`，由具体 adapter 转换为后端协议。

---

## 4. OpenCode SDK 对图片/多模态的支持

### 4.1 确认：SDK v2 支持 FilePartInput

从 `@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` 确认：

```typescript
export type FilePartInput = {
    id?: string;
    type: "file";
    mime: string;        // 例如 "image/png"
    filename?: string;
    url: string;          // data: URI 格式
};
```

图片可以通过 `url: "data:image/png;base64,iVBORw0KGgo..."` 传递。

### 4.2 未确认事项

1. **图片大小限制**: OpenCode 服务端是否有图片大小限制？base64 编码后体积增加约 33%。
2. **模型侧支持**: 底层模型（GPT-4o, Claude 3.5 等）是否支持图片输入？这取决于 OpenCode backend 配置的模型。
3. **多图片支持**: SDK 是否支持在一个 prompt 中包含多个 `FilePartInput`？从类型定义看是数组，应该支持。
4. **非图片二进制文件**: 对于非图片二进制文件（PDF、Word 等），SDK 是否支持？`FilePartInput` 的 `mime` 字段可指定任意类型，但模型处理能力取决于具体模型。

---

## 5. ACP 层接口扩展设计

### 5.1 方案 A：在 prompt 参数中附加 parts

在 `AcpSessionOperations.prompt` 的 `options` 中添加 `parts` 字段：

```typescript
// src/acp/backend.ts
prompt(
    id: string,
    text: string,
    directory?: string,
    options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        // 新增：附件 parts
        parts?: Array<{
            type: 'text' | 'file' | 'image';
            text?: string;
            mime?: string;
            url?: string;       // data: URI 格式
            filename?: string;
        }>;
    },
): Promise<AcpResult<unknown>>;
```

**优点**:
- 向后兼容（`parts` 可选）
- 扩展现有接口而非新建

**缺点**:
- ACP 协议需要感知 "part" 概念
- 与 SDK 的 FilePartInput 耦合

### 5.2 方案 B：新建专门的附件类型

在 `src/acp/types.ts` 中新增：

```typescript
// ACP 附件类型（协议无关）
export interface AcpAttachment {
    type: 'image' | 'file';
    mimeType: string;
    data: Uint8Array;     // 原始二进制数据
    filename?: string;
    reference?: string;   // 源文件路径（若有）
}
```

然后修改 `prompt` 接口：

```typescript
prompt(
    id: string,
    text: string,
    directory?: string,
    options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        attachments?: AcpAttachment[];
    },
): Promise<AcpResult<unknown>>;
```

**优点**:
- 协议无关，A->B 灵活映射
- 类型安全

**缺点**:
- 额外抽象层
- 需要 adapter 层转换 `AcpAttachment[]` → `FilePartInput[]`

### 5.3 推荐的实现路径

建议采用 **方案 B**，原因：
1. ACP 层应保持协议无关性
2. 附件处理逻辑集中在 adapter 层转换
3. handler.ts 只需要发送 ACP 附件，不需要关心 SDK 的 FilePartInput 格式
4. 未来切换 backend 实现时（如直接调用 OpenAI API），ACP 层的附件类型定义仍然适用

---

## 6. 图片数据提取与处理

### 6.1 基本提取模式

```typescript
import * as vscode from 'vscode';

// 运行时类型检查（因为 ChatReferenceBinaryData 是 proposed API）
interface ChatReferenceBinaryData {
    readonly mimeType: string;
    data(): Promise<Uint8Array>;
    readonly reference?: vscode.Uri;
}

function isBinaryData(value: unknown): value is ChatReferenceBinaryData {
    return typeof value === 'object' && value !== null
        && 'mimeType' in value
        && typeof (value as any).data === 'function';
}

async function extractAttachments(
    request: vscode.ChatRequest,
): Promise<{
    images: Array<{ mimeType: string; data: Uint8Array }>;
    files: vscode.Uri[];
    locations: vscode.Location[];
}> {
    const images: Array<{ mimeType: string; data: Uint8Array }> = [];
    const files: vscode.Uri[] = [];
    const locations: vscode.Location[] = [];

    for (const ref of request.references) {
        const val = ref.value;

        if (isBinaryData(val)) {
            const binary = val as ChatReferenceBinaryData;
            const rawData = await binary.data();
            images.push({ mimeType: binary.mimeType, data: rawData });
        }
        else if (val instanceof vscode.Uri) {
            files.push(val);
        }
        else if (val instanceof vscode.Location) {
            locations.push(val);
        }
    }

    return { images, files, locations };
}
```

### 6.2 Base64 编码

```typescript
import { Buffer } from 'buffer';

function uint8ArrayToBase64(data: Uint8Array): string {
    return Buffer.from(data).toString('base64');
}

function buildDataUri(mimeType: string, base64: string): string {
    return `data:${mimeType};base64,${base64}`;
}
```

### 6.3 文件内容读取（Uri 类型）

```typescript
async function readFileAttachment(uri: vscode.Uri): Promise<{
    content: Uint8Array;
    filename: string;
    mimeType: string;
}> {
    const content = await vscode.workspace.fs.readFile(uri);
    const filename = uri.fsPath.split(/[/\\]/).pop() ?? 'unknown';
    // 简单的 MIME 推断（VSCode 没有内置的 mime lookup）
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeType = ext === 'pdf' ? 'application/pdf'
        : ext === 'md' ? 'text/markdown'
        : ext === 'json' ? 'application/json'
        : ext === 'py' ? 'text/x-python'
        : ext === 'ts' || ext === 'tsx' ? 'text/typescript'
        : 'application/octet-stream';

    return { content, filename, mimeType };
}
```

### 6.4 代码选区提取（Location 类型）

```typescript
async function extractLocationCode(location: vscode.Location): Promise<{
    uri: vscode.Uri;
    range: vscode.Range;
    code: string;
}> {
    const doc = await vscode.workspace.openTextDocument(location.uri);
    const code = doc.getText(location.range);
    return { uri: location.uri, range: location.range, code };
}
```

---

## 7. 实现方案设计

### 7.1 总体架构变更

```
VSCode Chat input (text + images + files + code references)
    ↓
handler.ts: createParticipantHandler()
    ├── 解析 request.prompt
    ├── 解析 request.references  <-- 新增
    │   ├── ChatReferenceBinaryData → 提取图片 base64
    │   ├── Uri → 读取文件内容
    │   └── Location → 提取代码选区
    ├── 构建 AcpAttachment[] <-- 新增
    ├── 调用 state.backend.sessions.prompt(id, text, dir, { attachments, model, agent })
    │       ↓
    │   adapter.ts OpenCodeBackend.sessions.prompt()
    │       ↓  转换 attachments → FilePartInput[]
    │   sdk.session.prompt({ sessionID, parts: [TextPartInput, ...FilePartInput], ... })
    │       ↓
    │   OpenCode Server v2 SDK
    └── 桥接 SSE 事件到 VSCode stream
```

### 7.2 阶段 1：文件附件支持

**目标**: 处理 `Uri` 类型的引用，将文件路径/内容传递给 OpenCode。

**步骤**:

1. 在 `src/acp/types.ts` 中添加 `AcpAttachment` 类型
2. 在 `src/acp/backend.ts` 中扩展 `prompt` 接口，添加可选 `attachments` 参数
3. 在 `handler.ts` 中解析 `request.references`，提取 `Uri` 类型的附件
4. 读取文件内容，构建 `AcpAttachment[]`
5. 在 `adapter.ts` 中将 `AcpAttachment[]` 转换为 `FilePartInput[]`

**代码示例（handler.ts 变更）**:

```typescript
// handler.ts 中新增附件提取函数
async function buildAttachments(
    request: vscode.ChatRequest,
): Promise<AcpAttachment[]> {
    const attachments: AcpAttachment[] = [];

    for (const ref of request.references) {
        const val = ref.value;

        // 图片/二进制数据
        if (isBinaryData(val)) {
            const binary = val as ChatReferenceBinaryData;
            const rawData = await binary.data();
            attachments.push({
                type: 'image',
                mimeType: binary.mimeType,
                data: rawData,
                reference: binary.reference?.fsPath,
            });
        }
        // 文件附件
        else if (val instanceof vscode.Uri) {
            const content = await vscode.workspace.fs.readFile(val);
            const filename = val.fsPath.split(/[/\\]/).pop() ?? 'file';
            attachments.push({
                type: 'file',
                mimeType: guessMimeType(filename),
                data: content,
                filename,
                reference: val.fsPath,
            });
        }
        // 代码选区 — 提取文本后通过 prompt 上下文传递
        else if (val instanceof vscode.Location) {
            const doc = await vscode.workspace.openTextDocument(val.uri);
            const code = doc.getText(val.range);
            const relativePath = vscode.workspace.asRelativePath(val.uri);
            attachments.push({
                type: 'file',
                mimeType: 'text/plain',
                data: new TextEncoder().encode(code),
                filename: `${relativePath}:${val.range.start.line + 1}`,
                reference: val.uri.fsPath,
            });
        }
    }

    return attachments;
}
```

### 7.3 阶段 2：图片支持

**目标**: 处理 `ChatReferenceBinaryData`，将图片数据发送给 OpenCode。

**前置条件**:
1. `package.json` 的 `enabledApiProposals` 中添加 `"chatReferenceBinaryData"`
2. 在 `src/types/vscode-proposed-additions.ts` 或新建 `src/types/vscode-proposed-binary.d.ts` 中声明类型

**类型声明**:

```typescript
// src/types/vscode-proposed-binary.d.ts
declare module 'vscode' {
    /**
     * Proposed API: chatReferenceBinaryData
     * Source: vscode.proposed.chatReferenceBinaryData.d.ts
     *
     * Binary data associated with a chat prompt reference.
     * This is used for image attachments (paste/drag-drop).
     */
    export interface ChatReferenceBinaryData {
        readonly mimeType: string;
        data(): Promise<Uint8Array>;
        readonly reference?: Uri;
    }
}
```

**package.json 变更**:

```json
{
    "enabledApiProposals": [
        "chatParticipantAdditions",
        "chatParticipantPrivate",
        "chatSessionsProvider",
        "chatReferenceBinaryData"
    ]
}
```

### 7.4 阶段 3：adapter 层转换

```typescript
// src/backends/opencode/adapter.ts
// 在 prompt 实现中：

prompt: async (
    id: string,
    text: string,
    directory?: string,
    options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        attachments?: AcpAttachment[];
    },
): Promise<AcpResult<unknown>> => {
    try {
        // 构建 parts 数组
        const parts: Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }> = [];

        // 主文本
        parts.push({ type: 'text', text });

        // 附件
        if (options?.attachments) {
            for (const att of options.attachments) {
                if (att.type === 'image' || att.type === 'file') {
                    const base64 = Buffer.from(att.data).toString('base64');
                    parts.push({
                        type: 'file',
                        mime: att.mimeType,
                        filename: att.filename,
                        url: `data:${att.mimeType};base64,${base64}`,
                    });
                }
            }
        }

        const result = await this.sdk.session.prompt({
            sessionID: id,
            directory,
            parts,
            model: options?.model,
            agent: options?.agent,
        });
        // ...
    }
}
```

### 7.5 阶段 4：代码引用支持

代码选区（`Location`）可以作为提取的代码文本片段，通过两种方式传递：

**方案 A**: 作为文件附件，但 `url` 使用数据 URI 编码代码文本。
**方案 B**: 在 `text` 部分中引用，例如：

```
用户消息: "解释这个函数"
代码上下文: "// file: src/foo.ts:42-50\nfunction bar() { ... }"
```

推荐 **方案 B**，因为代码引用的语义不同于二进制文件附件，且模型更容易理解。

---

## 8. 会话上下文（ChatContext）

### 8.1 当前用途

`src/participant/handler.ts` 中的 `context.history` 当前用途：

```typescript
// 1. Session 恢复（VSCode 重启后）
const recovered = recoverFromHistory(context);
// 从 ChatResponseTurn.metadata 中提取 sessionId 和 turnMap

// 2. Rewind 检测（用户编辑历史消息）
const requestTurns = history.filter(h => h instanceof vscode.ChatRequestTurn);
const currentTurnIndex = requestTurns.length;
// 对比 currentTurnIndex 与 chatState.turnMap.length 来判断
```

### 8.2 不需要转发消息内容

当前架构中，**不需要**将 `context.history` 中的消息内容转发给 OpenCode backend，因为：

1. OpenCode 服务端维护自己的消息历史（通过 sessionId 关联）
2. 客户端（VSCode 扩展）只负责发送新消息和接收事件流
3. 转发历史消息会导致重复和状态不一致

### 8.3 需要转发的场景

以下场景可能需要转发历史上下文：

- **Session 首次恢复时**：如果 OpenCode 服务端丢失了会话状态（重启、切换工作区），可能需要重新发送历史消息
- **上传附件时**：如果附件与历史消息中的代码/文件相关，更好的方式是在新 prompt 中引用文件路径（让 OpenCode 自行读取）

**结论**: 当前无需修改 `context.history` 的处理逻辑。

---

## 9. 需要修改的文件清单

| 文件 | 修改类型 | 修改内容 |
|------|---------|---------|
| `package.json` | 编辑 | 在 `enabledApiProposals` 中添加 `"chatReferenceBinaryData"` |
| `src/types/vscode-proposed-additions.ts` (或新文件) | 新增/编辑 | 声明 `ChatReferenceBinaryData` 接口（module augmentation） |
| `src/acp/types.ts` | 编辑 | 新增 `AcpAttachment` 接口定义 |
| `src/acp/backend.ts` | 编辑 | 在 `AcpSessionOperations.prompt` 的 `options` 中添加 `attachments?: AcpAttachment[]` |
| `src/participant/handler.ts` | 编辑 | 在 `createParticipantHandler` 中解析 `request.references`，构建 `AcpAttachment[]`，传递给 `prompt()` |
| `src/backends/opencode/adapter.ts` | 编辑 | 在 `prompt` 实现中将 `AcpAttachment[]` 转换为 SDK 的 `FilePartInput[]` |
| `src/types/index.ts`（可选） | 编辑 | 可选择性将 `OpenCodeClient.session.prompt` 的 `parts` 参数从 `unknown` 优化为更具体的类型 |
| `src/test/handler.test.ts` | 编辑 | 为附件提取逻辑添加单元测试 |
| `doc/todo-03-image-attachment.md` | 本文件 | 实现后在此记录实际方案与设计差异 |

---

## 10. 实现要点与风险

### 10.1 关键要点

1. **Proposed API 需要运行时检查**:
   ```typescript
   // ChatReferenceBinaryData 可能不存在于所有 VSCode 版本
   if (typeof (ref.value as any)?.data === 'function') {
       // 安全地当作 ChatReferenceBinaryData 处理
   }
   ```

2. **图片数据异步获取**:
   ```typescript
   // data() 返回 Promise，必须 await
   const data = await binary.data();  // Uint8Array
   ```

3. **Base64 体积膨胀**: 原始图片大小 × 1.37 ≈ base64 大小。对于大图片（>10MB），考虑限制或压缩。

4. **SDK parts 数组顺序**:
   ```typescript
   // SDK 接受混合类型的 parts 数组
   parts: [
       { type: 'text', text: '描述这张图片' },
       { type: 'file', mime: 'image/png', url: 'data:image/...' },
   ]
   ```
   SDK 的 `FilePartInput` 类型已确认支持图片的 base64 data URI。

5. **ACP 层协议无关性**: 附件类型应定义在 `src/acp/types.ts` 中，不依赖 VSCode 或 SDK 类型。

### 10.2 风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `chatReferenceBinaryData` 是 proposed API，可能变更或不稳定 | 运行时可能不可用 | 运行时能力检查 + graceful fallback |
| 大图片导致 OOM 或网络延迟 | 用户体验差 | 限制图片大小（如 20MB），或在前端压缩 |
| OpenCode SDK 服务端不支持图片 | 附件被忽略 | 验证模型能力和 SDK 版本 |
| 用户粘贴超大图片（截图工具 4K） | base64 编码后体积巨大 | 限制图片尺寸（maxWidth/maxHeight）或质量压缩 |
| Proposed API 在 VSCode Stable 中不可用 | 图片功能只在 Insiders 可用 | 文档说明，不阻塞其他附件类型 |

### 10.3 质量与安全考量

- **不将附件数据持久化到 VSCode 状态中**（turnMap.metadata 只存轻量元数据）
- **不隐式上传文件**到第三方服务（所有数据通过 data URI 传递给本地 OpenCode 服务端）
- **附件大小限制**在 SDK 或 adapter 层做检查
- **文件附件**应优先传递路径（让 OpenCode 服务端自行读取），而非文件内容（避免大块数据在扩展进程中传输）

---

## 11. 测试策略

### 11.1 单元测试（`src/test/handler.test.ts`）

```typescript
describe('附件处理', () => {
    it('应提取 ChatReferenceBinaryData 附件', async () => {
        // mock request.references 包含 binary data
        // 验证 buildAttachments 返回正确的 AcpAttachment[]
    });

    it('应提取 Uri 文件附件', async () => {
        // mock request.references 包含 Uri
        // 验证文件被读取
    });

    it('应提取 Location 代码选区', async () => {
        // mock request.references 包含 Location
        // 验证代码被提取
    });

    it('空 references 不应影响正常文本 prompt', async () => {
        // 验证空 attachments 场景
    });
});
```

### 11.2 集成测试

- 启动 OpenCode 服务端
- 发送包含 FilePartInput 的 prompt
- 验证事件流中不出现错误

### 11.3 手动测试清单

| 测试场景 | 操作 | 预期结果 |
|---------|------|---------|
| 粘贴截图 | Ctrl+V 粘贴截图 | 图片传递给模型，模型描述图片内容 |
| 拖放图片文件 | 从资源管理器拖放 .png | 同上 |
| 拖放代码文件 | 拖放 .ts 文件 | 文件内容作为上下文 |
| 代码引用 | 输入 `#` 选择代码 | 代码片段作为上下文 |
| 混合输入 | 文本 + 图片 + 文件 | 所有附件按顺序传递 |
| 无附件 | 普通文本输入 | 行为不变 |

---

## 12. 参考资料

### 12.1 VSCode 官方资源

- **Binary Data proposed API**: `vscode.proposed.chatReferenceBinaryData.d.ts`
  - 源码位置: `https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatReferenceBinaryData.d.ts`
- **ChatParticipantAdditions proposed API v3**: `vscode.proposed.chatParticipantAdditions.d.ts`
- **ChatParticipantPrivate proposed API**: `vscode.proposed.chatParticipantPrivate.d.ts`
  - 当前项目在 `src/types/vscode-proposed.d.ts` 中声明

### 12.2 VSCode Copilot 参考实现

VSCode 仓库中的 Claude 集成 `extensions/copilot/src/extension/chatSessions/claude/node/claudePromptResolver.ts` 提供了生产级别的参考：

```typescript
// Claude 集成的图片提取模式
for (const ref of request.references) {
    if (ref.value instanceof ChatReferenceBinaryData) {
        const data = await ref.value.data();
        const base64 = Buffer.from(data).toString('base64');
        // Anthropic API 格式:
        // { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
    }
}
```

### 12.3 项目代码参考

| 文件 | 要点 |
|------|------|
| `src/participant/handler.ts` | 当前 request handler，附件处理的插入点（第 280-317 行） |
| `src/backends/opencode/adapter.ts` | SDK 适配层，`parts` 构造位置（第 249-278 行） |
| `src/acp/backend.ts` | ACP prompt 接口定义（第 47-55 行） |
| `src/acp/types.ts` | ACP 协议类型，附件类型的定义位置 |
| `src/types/index.ts` | OpenCodeClient 接口，`parts: unknown` 需类型化 |
| `src/types/vscode-proposed.d.ts` | 现有 proposed API 类型声明，可参照添加 binary data 声明 |
| `src/opencode/server.ts` | `createOpencode()` 创建 SDK 客户端 |
| `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` | SDK `FilePartInput` 类型定义 |
| `src/test/handler.test.ts` | 现有 handler 测试，附件测试的插入位置 |

### 12.4 SDK v2 关键类型摘要

从 `@opencode-ai/sdk` v2 类型定义确认的 input part 类型结构：

```typescript
// SDK v2 支持的 input parts
type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

interface TextPartInput {
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
}

interface FilePartInput {
    type: "file";
    mime: string;          // MIME 类型
    filename?: string;
    url: string;           // 内容 URL（支持 data: URI scheme）
}
```

附件数据需要通过 `data:<mime>;base64,<base64>` 格式的 URL 传递。

---

## 13. 附录：OpenCodeClient 接口现状

```typescript
// src/types/index.ts — 当前 OpenCodeClient 接口定义
export interface OpenCodeClient {
    session: {
        prompt(parameters: {
            sessionID: string;
            directory?: string;
            parts?: unknown;           // ← 运行时实际为 Array<TextPartInput | FilePartInput | ...>
            model?: unknown;
            agent?: string;
        }): Promise<SdkResponse<unknown>>;
        // ... create, get, revert, abort, list, children, status
    };
    // ... config, event, global, permission, question
}
```

`parts` 的类型标注为 `unknown`，实际运行时 SDK 期望的格式为：

```typescript
parts: Array<{
    type: 'text' | 'file';
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
    synthetic?: boolean;
    ignored?: boolean;
}>
```

实现附件支持后，可以考虑将此处的 `unknown` 替换为更精确的类型定义。

---

## 14. 实现后的验证清单

- [ ] `lsp_diagnostics` 全部通过
- [ ] `npm run build` 通过
- [ ] 单元测试通过（特别是 handler.test.ts）
- [ ] 手动测试：粘贴图片到 VSCode Chat，验证附件被提取
- [ ] 手动测试：拖放文件到 VSCode Chat，验证文件被读取
- [ ] 手动测试：代码引用 `#` 功能，验证选区被提取
- [ ] 确认 OpenCode 服务端日志中有附件相关的记录
- [ ] 检查无附件时文本 prompt 行为不变
- [ ] 检查 VSCode Stable 上 proposed API 不可用时的 graceful fallback
