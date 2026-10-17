# 知识储备: 自定义 Agent / 模型选择器集成

> **历史调研归档**：该 TODO 的路径与模型架构已经被多 Backend 重构取代。当前每个
> Backend 拥有独立 Vendor，模型目录和调用由 `BackendModelProvider` 提供；不要按
> 正文中的 `src/acp/*` 路径新增代码。现行设计见
> [阶段一架构设计](../docs/refactor/copilot-agent-sss-phase1-design.md)。
>
> **完成状态（2026-09）**：模型目录、独立 Vendor、模型选择解析和原生 LM 路由已
> 落地；下文保留为早期 API 调研，不再是待实现清单。

> 对应 TODO: **切换到 OpenCode Session Target 后，支持自定义 Agent 和模型选择**
>
> 编写日期: 2026-05-27
> 状态: `✅ 已由多 Backend 模型架构落地`

---

## 1. TODO 目标描述

### 1.1 要解决的问题

用户在 VSCode Chat 中切换到 **OpenCode Session Target**（即底部的 Session Target 下拉选择了"OpenCode"）后，VSCode Chat Input Toolbar **没有** Agent 和 Model 的切换按钮。用户无法在聊天界面直接切换使用哪个 Agent（如 Architect / Coder / Debugger）或哪个 Model（如 GPT-4o / Claude Sonnet）。

### 1.2 预期效果

当用户选择了 OpenCode Session Target 后，Chat Input Toolbar 出现两个下拉按钮：

- **Agent 下拉**: 列出 OpenCode 后端返回的所有可用 Agent（过滤掉 `hidden` 的），默认选中当前配置的 agent
- **Model 下拉**: 列出所有可用 Provider 下的 Model，默认选中当前配置的 model

用户选择后，后续的 Prompt 请求会携带选中的 agent/model 参数发送给 OpenCode 后端。

### 1.3 验收标准

1. Agent 下拉按钮可见，列表项与 `backend.config.agents()` 返回一致
2. Model 下拉按钮可见，列表项与 `backend.config.models()` 返回一致
3. 切换后，后续 prompt 请求正确携带 `options.agent` 和 `options.model`
4. Agent/Model 列表在 OpenCode 后端启动完成后动态加载（延迟初始化）
5. 后端重启 / 配置变更后列表可刷新

---

## 2. VSCode Proposed API 参考

### 2.1 核心接口: `ChatSessionProviderOptionGroup`

VSCode 的 `chatSessionsProvider` proposed API 提供了 Option Group 机制，允许 ChatSessionContentProvider 在 Chat Input Toolbar 上渲染自定义下拉选择器。

#### 2.1.1 本地类型声明

项目中的类型声明位于 `src/types/vscode-proposed.d.ts`（基于 `vscode.proposed.chatSessionsProvider.d.ts` v3）：

```typescript
// ===== Option Item =====
interface ChatSessionProviderOptionItem {
    readonly id: string;            // 唯一标识
    readonly name: string;          // 显示标签
    readonly description?: string;  // 次要描述文本
    readonly detail?: string;       // 第三级详情文本
    readonly icon?: ThemeIcon;      // 图标
    readonly default?: boolean;     // 是否默认选中
}

// ===== Option Group =====
interface ChatSessionProviderOptionGroup {
    readonly id: string;           // 分组唯一标识（如 'agents', 'models'）
    readonly name: string;         // 下拉按钮显示的标签
    readonly description?: string;
    readonly detail?: string;
    readonly items: readonly ChatSessionProviderOptionItem[];  // 选项列表
    readonly selected?: ChatSessionProviderOptionItem;         // 当前选中项
    readonly when?: string;        // VSCode context key 表达式，控制可见性
    readonly icon?: ThemeIcon;
}
```

#### 2.1.2 VSCode 源码中的额外字段

在 VSCode 源码 `chatSessionsService.ts`（L41-L68）中，OptionGroup 和 OptionItem 有更多的字段，但**尚未出现在 VSCode 的公开 proposed API 类型声明中**：

| 字段 | 所在接口 | 说明 | 本地类型中是否存在 |
|------|---------|------|:---:|
| `locked?: boolean` | `OptionItem` | 锁定选项，阻止用户切换 | ❌ |
| `slashCommand?: string` | `OptionItem` | 选中后自动注入的 slash command | ❌ |
| `commands?: Command[]` | `OptionGroup` | 下拉按钮的附加命令菜单 | ❌ |

> **注意**: 这些字段属于 VSCode 内部实现，可能在未来版本才会暴露到 proposed API 中。当前实现**不应依赖它们**，仅作为参考。

#### 2.1.3 `ChatSessionContentProvider` 接口

```typescript
interface ChatSessionContentProvider {
    provideChatSessionContent(
        resource: Uri,
        token: CancellationToken,
        context: { readonly inputState: ChatSessionInputState },
    ): Thenable<ChatSession> | ChatSession;

    // 可选: provider 级别的选项组
    readonly optionGroups?: readonly ChatSessionProviderOptionGroup[];

    // 可选: 选项变更事件
    readonly onDidChangeChatSessionProviderOptions?: Event<void>;
}
```

关键要点：

- `optionGroups` 是 **属性（property）** 而非方法。VSCode 在注册 Provider 和收到 `onDidChange` 事件时读取它。
- `onDidChangeChatSessionProviderOptions` 是 `Event<void>` 类型，需要用 `EventEmitter` 实现。触发后 VSCode 重新读取 `optionGroups`。
- 这意味着 optionGroups 可以在运行时动态更新。

#### 2.1.4 `ChatSessionInputState` 传递选项

```typescript
interface ChatSessionInputState {
    sessionResource?: Uri;
    sessionOptions?: ReadonlyArray<{
        optionId: string;
        value: string | ChatSessionProviderOptionItem;
    }>;
}
```

- 用户选择 Option 后，VSCode 通过 `inputState.sessionOptions` 传给 `provideChatSessionContent`。
- 每个 Option 以 `{ optionId, value }` 形式传递，其中 `optionId` 是 `OptionGroup.id`（如 `'agents'` 或 `'models'`），`value` 是选中项的 `ChatSessionProviderOptionItem`。
- **注意**: `inputState` 只在 `provideChatSessionContent` 的 `context` 参数中可用。`requestHandler` 中不直接传递 sessionOptions，需要通过 `ChatSession.options` 间接获取。

#### 2.1.5 `ChatSession` 接口中的 options 传递

```typescript
interface ChatSession {
    readonly title?: string;
    readonly history: (ChatRequestTurn | ChatResponseTurn)[];
    readonly options?: ChatSessionInputState;  // 这里携带 sessionOptions
    readonly activeResponseCallback?: ...;
    readonly requestHandler: ChatRequestHandler | undefined;
    readonly forkHandler?: ...;
}
```

`ChatSession.options` 接收用户在 OptionGroup 中选择的值。在 `requestHandler` 中可以通过 `request` 对象**无法直接访问** sessionOptions，必须在创建 ChatSession 时将 options 注入。

### 2.2 注册流程

完整的注册链路如下：

```typescript
// 1. 创建 Provider
const provider = createSessionContentProvider(state, context);

// 2. 设置 optionGroups（可在 provider 对象上直接赋值）
provider.optionGroups = [
    {
        id: 'agents',
        name: 'Agent',
        items: [...],
        selected: ...,
    },
    {
        id: 'models',
        name: 'Model',
        items: [...],
        selected: ...,
    },
];

// 3. 创建 ChatParticipant
const participant = vscode.chat.createChatParticipant(
    'acpilot.opencode',
    handler,
);

// 4. 注册 Session Content Provider
vscode.chat.registerChatSessionContentProvider(
    OPENCODE_SESSION_SCHEME,          // 'acpilot.opencode'
    provider,                         // ChatSessionContentProvider
    participant,                      // ChatParticipant
    { supportsChangingSessionType: true }
);
```

---

## 3. 现有代码架构分析

### 3.1 数据层已完整实现

（历史判断）当时认为只需要补齐 `optionGroups` 这一层映射；现行实现由
`src/surfaces/vscode/model-catalog.ts` 和各 Backend Vendor 提供模型目录：

```
OpenCode SDK ──→ Backend Adapter ──→ Backend Model Catalog ──→ Copilot Vendor
                                                              ↓
                                                    ChatSessionProviderOptionGroup
                                                              ↓
                                                    VSCode Chat Input Toolbar
```

#### 3.1.1 `AcpAgent` 类型（`src/acp/types.ts:281-288`）

```typescript
interface AcpAgent {
    id: string;
    name?: string;
    description?: string;
    model?: string | { modelID: string; providerID: string };
    mode?: 'subagent' | 'primary' | 'all';
    hidden?: boolean;
}
```

**映射为 OptionItem**:
```
AcpAgent.id          → ChatSessionProviderOptionItem.id    (前缀 'agent-')
AcpAgent.name        → ChatSessionProviderOptionItem.name
AcpAgent.description → ChatSessionProviderOptionItem.description
AcpAgent.hidden      → 过滤条件（hidden === true 的不显示）
```

#### 3.1.2 `AcpModel` 类型（`src/acp/types.ts:23-31`）

```typescript
interface AcpModel {
    id: string;
    name?: string;
    provider?: string;
    providerName?: string;
    capabilities?: string[];
}
```

**映射为 OptionItem**:
```
AcpModel.id           → ChatSessionProviderOptionItem.id    (前缀 'model-')
AcpModel.name         → ChatSessionProviderOptionItem.name
AcpModel.providerName → ChatSessionProviderOptionItem.description
```

#### 3.1.3 数据获取实现（`src/backends/opencode/adapter.ts:343-396`）

**models()**:
```typescript
// adapter.ts:344-371
models: async (directory?: string) => {
    const result = await this.sdk.config.providers({ directory });
    const providers = result.data?.providers ?? [];
    const models: AcpModel[] = [];
    for (const provider of providers) {
        for (const m of Object.values(provider.models ?? {})) {
            models.push({
                id: m.id,
                name: m.name ?? m.id,
                provider: provider.id,
                providerName: provider.name,
                capabilities: ...,
            });
        }
    }
    return { data: models };
}
```

**agents()**:
```typescript
// adapter.ts:373-396
agents: async (directory?: string) => {
    const result = await this.sdk.app.agents({ directory });
    const agents: AcpAgent[] = (result.data ?? []).map(a => ({
        id: a.id ?? a.name ?? '',
        name: a.name ?? a.id,
        description: a.description,
        model: ...,
        mode: a.mode as AcpAgent['mode'],
        hidden: a.hidden,
    }));
    return { data: agents };
}
```

### 3.2 prompt 调用已支持传递 agent/model

在 `AcpSessionOperations.prompt()` 接口中（`src/acp/backend.ts:47-55`）：

```typescript
prompt(
    id: string,
    text: string,
    directory?: string,
    options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
    },
): Promise<AcpResult<unknown>>;
```

### 3.3 `ExtensionState` 中已有 agent/model 状态

`src/types/index.ts:182-206`:

```typescript
interface ExtensionState {
    // ...
    currentAgent?: string;
    currentModel?: AcpModelSelection;
    currentModelDisplayName?: string;
    selectedAgentOverride?: string;     // 接收来自 OptionGroup 的选择
    selectedModelOverride?: AcpModelSelection;  // 接收来自 OptionGroup 的选择
}
```

### 3.4 两个 handler 中已经读取 `selectedAgentOverride` / `selectedModelOverride`

- `src/participant/handler.ts:290-300`: 在 prompt 时构建 options 对象
- `src/surfaces/vscode/experimental-session.ts:423-430`: 同样的逻辑

```typescript
const promptOptions = {};
if (state.selectedAgentOverride) {
    promptOptions.agent = state.selectedAgentOverride;
}
if (state.selectedModelOverride) {
    promptOptions.model = state.selectedModelOverride;
}
```

### 3.5 历史 `experimental-session.ts` 的问题

`createSessionContentProvider()` 当时返回的 provider 对象**没有设置 `optionGroups` 属性和 `onDidChangeChatSessionProviderOptions` 事件**。这是历史分析，不代表现行模型目录实现。

---

## 4. 实现方案设计

### 4.1 架构决策: 延迟初始化 + 事件驱动更新

```
时序图:

Extension 激活
    │
    ▼
createSessionContentProvider(state, context)
    │
    ├─→ provider.optionGroups = []          (初始为空)
    ├─→ provider.onDidChangeChatSessionProviderOptions = emitter.event
    │
    ▼
OpenCode Backend 启动完成
    │
    ▼
fetchAgents() → fetchModels()
    │
    ▼
buildOptionGroups() → emitter.fire()       (通知 VSCode 重新读取)
    │
    ▼
VSCode 调用 provider.optionGroups getter    (返回完整的 optionGroups)
    │
    ▼
Toolbar 渲染 Agent / Model 下拉按钮
```

**为什么不静态构造？**

- OpenCode Backend 可能在扩展激活时尚未启动（lazy start）
- Agent/Model 列表依赖后端返回，无法在 `activate()` 时同步获取
- 后端运行后配置可能变化（用户修改 `opencode.json`），需要刷新

### 4.2 Agent Group 构建函数

```typescript
async function buildAgentOptionGroup(
    state: ExtensionState,
): Promise<ChatSessionProviderOptionGroup> {
    const result = await state.backend.config.agents();
    const agents = result.data ?? [];

    // 过滤 hidden agent，映射为 OptionItem
    const items = agents
        .filter(a => !a.hidden)
        .map(a => ({
            id: `agent-${a.id}`,
            name: a.name ?? a.id,
            description: a.description,
            // 如果当前没有 Override，使用 currentAgent 作为默认
            default: a.id === (state.selectedAgentOverride ?? state.currentAgent),
        }));

    // 找到当前选中的 item（优先使用 Override）
    const selectedId = state.selectedAgentOverride ?? state.currentAgent;
    const selected = items.find(i =>
        i.id === `agent-${selectedId}`
    ) ?? items[0];

    return {
        id: 'agents',
        name: 'Agent',
        items,
        selected,
    };
}
```

### 4.3 Model Group 构建函数

```typescript
async function buildModelOptionGroup(
    state: ExtensionState,
): Promise<ChatSessionProviderOptionGroup> {
    const result = await state.backend.config.models();
    const models = result.data ?? [];

    // 映射为 OptionItem
    const items = models.map(m => ({
        id: `model-${m.provider}/${m.id}`,
        name: m.name ?? m.id,
        description: m.providerName,
        default: m.id === (state.selectedModelOverride?.modelID ?? state.currentModel?.modelID),
    }));

    // 找到当前选中的 item
    const currentModelId = state.selectedModelOverride?.modelID
        ?? state.currentModel?.modelID;
    const selected = items.find(i => {
        const [, modelId] = i.id.split('/');
        return modelId === currentModelId;
    }) ?? items[0];

    return {
        id: 'models',
        name: 'Model',
        items,
        selected,
    };
}
```

### 4.4 Provider 实现要点

```typescript
export function createSessionContentProvider(
    state: ExtensionState,
    context: vscode.ExtensionContext,
): vscode.ChatSessionContentProvider {
    const logger = state.outputChannel;

    // 创建 EventEmitter 用于通知 VSCode 选项变更
    const onDidChangeEmitter = new vscode.EventEmitter<void>();

    // 存储 optionGroups 的内部变量
    let optionGroups: vscode.ChatSessionProviderOptionGroup[] = [];

    // 启动后立即开始加载 optionGroups
    initializeOptionGroups(state, context, onDidChangeEmitter)
        .then(groups => {
            optionGroups = groups;
            onDidChangeEmitter.fire();  // 通知 VSCode 重新读取
        })
        .catch(err => {
            logger.appendLine(`[session-provider] Failed to init optionGroups: ${err}`);
        });

    return {
        // 提供 optionGroups getter（延迟初始化完成后才包含实际数据）
        get optionGroups() {
            return optionGroups;
        },

        // 选项变更事件
        onDidChangeChatSessionProviderOptions: onDidChangeEmitter.event,

        provideChatSessionContent(
            resource: vscode.Uri,
            token: vscode.CancellationToken,
            context: { readonly inputState: vscode.ChatSessionInputState },
        ): vscode.ChatSession {
            // 解析 sessionOptions 中的 agent/model 选择
            const sessionOptions = context.inputState?.sessionOptions ?? [];
            const selectedAgent = sessionOptions.find(o => o.optionId === 'agents')?.value;
            const selectedModel = sessionOptions.find(o => o.optionId === 'models')?.value;

            // 更新状态中的 Override 值
            if (selectedAgent && typeof selectedAgent === 'object') {
                state.selectedAgentOverride = (selectedAgent as any).id.replace('agent-', '');
            }
            if (selectedModel && typeof selectedModel === 'object') {
                const id = (selectedModel as any).id;
                const match = id.match(/^model-(.+?)\/(.+)$/);
                if (match) {
                    state.selectedModelOverride = {
                        providerID: match[1],
                        modelID: match[2],
                    };
                }
            }

            // ... 其余现有逻辑不变 ...
        },
    };
}
```

### 4.5 选项值传递到 requestHandler

**关键设计决策**: sessionOptions 通过 `ChatSession.options.sessionOptions` 传递到 `requestHandler`，但 VSCode 的 proposed API 行为需要验证。

更可靠的做法是在 `provideChatSessionContent` 中**提前解析 options** 并更新到 `ExtensionState`：

```typescript
provideChatSessionContent(resource, token, context) {
    // 在创建 ChatSession 之前解析选项
    parseSessionOptions(context.inputState, state);

    return {
        // 设置 options 使得 requestHandler 可以访问
        options: context.inputState,

        requestHandler: async (request, chatContext, stream, token) => {
            // 直接读取 state.selectedAgentOverride / state.selectedModelOverride
            // 这些已经在 parseSessionOptions 中更新
            // ...
        },
    };
}
```

### 4.6 刷新机制

当 OpenCode 后端重启或配置变更时，需要刷新 optionGroups：

```typescript
// 在 server.connected 或 config change 事件中触发刷新
async function refreshOptionGroups(
    state: ExtensionState,
    emitter: vscode.EventEmitter<void>,
): Promise<void> {
    const [agentGroup, modelGroup] = await Promise.all([
        buildAgentOptionGroup(state),
        buildModelOptionGroup(state),
    ]);
    optionGroups = [agentGroup, modelGroup];
    emitter.fire();  // VSCode 重新读取 optionGroups
}
```

---

## 5. 需要修改的文件清单

| 文件 | 修改内容 | 风险等级 |
|------|---------|:-------:|
| `src/surfaces/vscode/experimental-session.ts` | 添加 `optionGroups` 属性、`onDidChangeChatSessionProviderOptions` EventEmitter、构造逻辑、解析 sessionOptions | 🔴 核心修改 |
| `src/types/vscode-proposed.d.ts` | 确认所有类型定义完整（特别是 `ChatSession.options` 字段是否存在） | 🟡 可能需要补充 |
| `src/participant/handler.ts` | 在 requestHandler 中补充从 ChatSession.options 读取 sessionOptions 的逻辑（如果使用该路径） | 🟡 可选 |
| `src/extension.ts` | 可能需要传递 `context` 到 `createSessionContentProvider`，或在 backend 启动后触发刷新 | 🟢 轻微 |

---

## 6. 实现步骤（推荐顺序）

```
Step 1  ── 确认类型定义
          └─ 检查 vscode-proposed.d.ts 中 ChatSession 是否有 options 字段
          └─ 检查 ChatSessionProviderOptionItem/Group 类型是否完整

Step 2  ── 实现构造函数
          └─ buildAgentOptionGroup(state)
          └─ buildModelOptionGroup(state)

Step 3  ── 修改 createSessionContentProvider
          └─ 添加 EventEmitter
          └─ 添加 optionGroups getter
          └─ 添加初始化逻辑（延迟加载）
          └─ 解析 sessionOptions 并更新 state

Step 4  ── 注册刷新钩子
          └─ backend 启动完成后触发刷新
          └─ (可选) 配置变更后触发刷新

Step 5  ── 验证
          └─ Agent 下拉显示正确
          └─ Model 下拉显示正确
          └─ 切换后 prompt 正确携带参数
          └─ 后端重启后列表刷新
```

---

## 7. 风险与注意事项

### 7.1 API 稳定性风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `ChatSession.options` 字段在 proposed API 中可用性不确定 | 无法通过 ChatSession 传递 sessionOptions 到 requestHandler | 在 `provideChatSessionContent` 中提前解析并写入 ExtensionState |
| `onDidChangeChatSessionProviderOptions` 事件触发后可能不立即更新 UI | 用户感知到延迟 | 确保选项加载完成后立即 fire 事件 |
| VSCode 更新后 API 签名变化 | 编译错误或运行时异常 | 在 `capabilities.ts` 中添加运行时检测 |

### 7.2 实现风险

| 风险 | 说明 |
|------|------|
| Model 列表可能很大（100+） | OptionGroup picker 是大列表，VSCode 原生 picker 对大量选项的滚动性能需验证。考虑按 provider 分组显示 |
| Backend 未启动时 optionGroups 为空 | 需要优雅降级 — 显示占位符或禁用按钮 |
| Agent 切换后 Model 列表可能需要联动 | 如果某个 Agent 绑定了特定 Model，切换 Agent 后 Model 选中的项可能需要跟随变化 |
| `sessionOptions` 中的 `value` 类型为 `string \| ChatSessionProviderOptionItem` | 解析时需要类型判断 |

### 7.3 关键注意事项

1. **`optionGroups` 是属性而非方法**: 不能使用 method 返回，必须用 property 或 getter
2. **use `get` accessor**: 如果使用 class 实现 provider，需要用 `get optionGroups()`；如果使用对象字面量，直接赋值或使用 `Object.defineProperty`
3. **不要阻塞 `provideChatSessionContent`**: 不要在 provider 方法中 await 选项加载，选项应提前在后台加载
4. **事件不能重复注册**: `onDidChangeChatSessionProviderOptions` 应该只由一个 EventEmitter 提供

---

## 8. 参考代码片段

### 8.1 主动刷新 OptionGroups

```typescript
// 在 backend 启动完成的 promise chain 中
const backendStartResult = await state.backend.start(workspacePath);
if (backendStartResult.data) {
    // 后端启动后加载 agents/models 并刷新 optionGroups
    refreshOptionGroups(state, onDidChangeEmitter);
}
```

### 8.2 从 inputState 解析选项的工具函数

```typescript
function parseSessionOptions(
    inputState: vscode.ChatSessionInputState,
    state: ExtensionState,
): void {
    const options = inputState?.sessionOptions ?? [];
    for (const opt of options) {
        if (opt.optionId === 'agents' && typeof opt.value === 'object') {
            const item = opt.value as ChatSessionProviderOptionItem;
            state.selectedAgentOverride = item.id.replace(/^agent-/, '');
        }
        if (opt.optionId === 'models' && typeof opt.value === 'object') {
            const item = opt.value as ChatSessionProviderOptionItem;
            const match = item.id.match(/^model-(.+?)\/(.+)$/);
            if (match) {
                state.selectedModelOverride = {
                    providerID: match[1],
                    modelID: match[2],
                };
            }
        }
    }
}
```

### 8.3 处理空列表的降级方案

```typescript
async function buildModelOptionGroup(state: ExtensionState): Promise<...> {
    const result = await state.backend.config.models();
    const models = result.data ?? [];

    if (models.length === 0) {
        // Backend 未启动或无模型配置 — 显示 disabled 状态
        return {
            id: 'models',
            name: 'Model',
            items: [{
                id: 'model-none',
                name: 'No models available',
                description: 'Start OpenCode server to load models',
            }],
        };
    }

    // ... 正常构造 ...
}
```

---

## 9. 参考资料

### 文件路径索引

| 参考内容 | 文件路径 |
|---------|---------|
| VSCode Proposed API 类型声明（本地） | `src/types/vscode-proposed.d.ts` |
| Session Content Provider 当前实现 | `src/surfaces/vscode/experimental-session.ts` |
| ACP 抽象层类型定义 | `src/acp/types.ts` |
| ACP Backend 接口定义 | `src/acp/backend.ts` |
| OpenCode Backend Adapter（数据获取实现） | `src/backends/opencode/adapter.ts` |
| 扩展入口 + 状态管理 | `src/extension.ts` |
| 全局 ExtensionState 类型 | `src/types/index.ts` |
| 标准 Participant Handler（读取 Override） | `src/participant/handler.ts` |
| /model 命令实现（模型列表渲染参考） | `src/participant/commands.ts` (L119-L150) |
| Capabilities 检测（feature gating） | `src/surfaces/vscode/capabilities.ts` |

### VSCode 源码参考

- `src/vs/workbench/contrib/chat/common/chatSessionsService.ts` (L41-L68) — OptionGroup 内部实现
- `src/vs/workbench/api/common/extHost.protocol.ts` (L3795-L3800) — 协议层定义
- `src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts` — 官方 proposed API 声明

### 数据映射关系速查

```
SdkProviderModel ──→ AcpModel ──→ ChatSessionProviderOptionItem
                    id              id (prefix: "model-{provider}/")
                    name            name
                    providerName    description

SdkAgentData ──→ AcpAgent ──→ ChatSessionProviderOptionItem
                    id              id (prefix: "agent-")
                    name            name
                    description     description
                    hidden          filter out
```
