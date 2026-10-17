# Copilot、Agent 与 SSS/SSP 阶段一架构设计

## 1. 目的

ACPilot 的核心产品是：在 VS Code Copilot Chat 中接入一个或多个 Agent 后端。
模型提供器是后端能力在 Copilot 模型选择器中的附加入口，不是产品的主领域。

阶段一的目标是先把 Copilot 接入领域与 Agent 后端领域的职责分开，同时保留
SSS/SSP 的既有运行时语义和 v2 JSONL 主格式。阶段一不把 SSS/SSP 重写为新的纯数据
模型，但允许为多后端边界做必要的基座调整。

本设计遵循以下已经确认的约束：

- 不做旧架构兼容层，不保留旧的隐式 fallback。
- 保持多后端抽象。
- 每个 Backend 拥有一个自己的 Copilot Vendor。
- SSP 是统一的 Agent 事件表达，不再为每个后端定义一套 Copilot 专用事件。
- Pipeline 绑定一个 Backend Session；Pipeline 的运行状态由具体 Pipeline 自己管理。
- 普通模型调用使用临时 Backend Session + 对应 Pipeline。
- 特化模型调用由对应 Backend 自己实现，但输出仍使用统一 SSP 事件。
- 保留 `SspStream` 的渲染与特殊交互能力；SSS/SSP 基座只做多后端接入所需的明确调整。
- 持久化统一写入 SSP、snapshot 和 turn envelope，不保留旧 event 序列化兼容层。

## 2. 目标拓扑

```text
                    Copilot 接入领域
       Chat Participant / Chat Session / LM Provider
                              │
                              │ 创建并绑定当前 turn 的 SSS
                              ▼
                        SSS / SSP 基座
                 (统一 Agent 事件、记录、重放)
                              ▲
                              │ push/update SSP
                              │
                    Agent 后端领域
          (Session + Pipeline + Vendor/Model)
```

Copilot 和 Agent 不共享对方的协议实现；SSS/SSP 是两边共同使用的运行时事实边界：
Copilot 提供并消费当前请求的 host stream，Agent Pipeline 把后端事件写入绑定的
`BackendPipelineStream`。这就是 `Copilot ↔ SSS/SSP ↔ Agent` 的关系。

这里不额外引入一层 Host Port。当前产品明确依赖 VS Code/Copilot，现有 `SspStream`
就是由 Copilot 接入层注入的 host capability 集合。SSP 可以在 `render()` 中调用
`externalEdit`、`questionCarousel` 等可选能力；SSS 负责承载其异步状态、snapshot 和
元数据。SSS 不主动发起后端 prompt，Backend Pipeline 也不直接调用 VS Code API。

运行时主链路为：

```text
Copilot request
  → Copilot 应用服务绑定 Copilot Session、Backend Session 和 SSS
  → 打开当前 Backend Session 的事件流
  → 启动绑定该 SSS 的 Backend Pipeline
  → Backend Session prompt
  → Backend Pipeline 解析后端原始流并 push/update SSP
  → SSS 记录、重放并把 SSP 渲染到 Copilot stream
```

这里的箭头表示依赖和数据流。SSP 是统一的 Agent 事件；具体 Pipeline 可以直接持有
当前 `BackendPipelineStream` 并创建/更新 SSP。SSS/SSP 不需要知道具体后端协议，
后端原始事件只存在于对应 Pipeline 的解析过程。Copilot 侧的 VS Code 交互由注入的
`SspStream` 和现有 SSP 的 callback/渲染能力完成，避免把 VS Code API 泄漏进
Backend。

## 3. 三个领域的边界

### 3.1 Copilot 接入领域

Copilot 领域负责把 VS Code API 的请求和交互转换为后端可执行操作，并把统一 SSP
交给当前的 SSS/SSP 管线。它拥有：

- Chat Participant、Chat Session、Native Language Model Provider 注册；
- Copilot Session 到 Backend Session 的绑定；
- turn、request、模型选择和 agent 选择；
- VS Code 权限、问题、外部编辑交互；
- SSP 到 VS Code ChatResponseStream 的现有调用编排；
- 标题、session list、状态栏和设置等 Copilot-facing 行为。

Copilot 领域负责调用后端公开能力和现有 SSS/SSP，不在 VS Code surface 中直接实现
OpenAI、Anthropic、DeepSeek 等具体模型协议。具体协议和模型策略由 Backend 能力拥有。

Copilot Host 交互采用直接注入，而不是独立 Host Port：

- Participant/Chat Session 把真实 `ChatResponseStream` 交给
  `SerializableSessionStream`；
- Native LM surface 把 `LanguageModelResponsePart2` progress 包装成 `SspStream`，
  再交给 `TransientSessionStream`；
- SSP 的 `render()` 可以调用注入 stream 上的 `externalEdit`、`questionCarousel`、
  tool invocation 等能力，并由 SSS 同步异步 metadata/snapshot；
- Backend 只看到 `BackendPipelineStream`，只负责 `push/update` SSP，不拥有 host UI。

这个选择承认 SSS/SSP 的运行时对象包含 Copilot 渲染行为。需要隔离的是 Backend
协议与 VS Code surface，而不是在 SSS/SSP 和固定的 Copilot Host 之间增加无收益的
转发接口。

当前代码中的主要归属：

```text
src/extension.ts
src/participant/**
src/surfaces/vscode/**
src/settings/**
src/statusbar.ts
src/backend/selection-store.ts
src/backend/session-manager.ts       # Copilot Session 与 Backend Session 编排
src/surfaces/vscode/model-catalog.ts # CopilotModelCatalog
```

`extension.ts` 只应是 composition root：装配 Backend、Pipeline 和 Copilot surface，
不应继续承担后端协议解析或 provider API 调用。

### 3.2 Agent 后端领域

Agent 后端领域负责接入一个具体 Agent 后端及其协议。一个后端插件必须提供：

- 生命周期和连接管理；
- Backend Session 的创建、查询、prompt、abort 等操作；
- 后端原始流事件的 Pipeline；
- 后端的模型目录和模型调用能力；
- 该后端的特化模型策略；
- 后端协议对应的权限、问题和子 session 语义转换。

当前代码中的主要归属：

```text
src/backends/opencode/**
src/backends/acp/**
src/backends/reasonix/**
src/opencode/**                         # OpenCode SDK/server 封装
src/backend/backend.ts                  # 重构为 Backend 公共契约
src/backend/backend-registry.ts
```

Agent 后端的唯一平台边界是不得泄漏具体 VS Code surface API。它可以依赖统一的
SSS/SSP 契约，并由 Pipeline 直接使用当前 SSS/SSP。具体后端不得依赖：

- Chat Participant、Chat Session、Language Model Provider 等 VS Code surface API；
- Copilot 模型选择器的 UI 细节；
- 另一个后端的 SDK 类型。

### 3.3 SSS/SSP 持久化基座

SSS/SSP 是 Agent 事件的统一记录、编辑和重放基座。它不是纯数据 DTO 层：SSP 同时
拥有状态、序列化和面向注入 `SspStream` 的渲染行为，SSS 负责调度、持久化、重放和
异步 metadata/snapshot 收敛。

当前归属：

```text
src/ssp/types.ts
src/ssp/impl/**
src/backend/serializable/**
src/backend/streaming/**
src/backend/checkpoint/**
```

阶段一后的 SSS/SSP 拥有以下行为：

- `SSS.push(SSP)` 和 `SSS.update(id, data)`；
- SSP 的当前渲染行为；
- `session.jsonl`、`meta.jsonl` 的追加式写入，以及 file snapshot 记录；
- 子 session 记录；
- 反序列化、重放和 checkpoint 元数据。
- `opaqueEvent` 作为协议无关、无专用 SSP 语义时的受限扩展记录；
- Native LM 使用不落盘的 `TransientSessionStream`，复用同一套 SSP 调度和渲染行为。

`SspStream` 保留较宽的 VS Code-like 能力是有意设计，不应删除或收窄为纯文本 sink。
`ExternalEditSSP`、`QuestionSSP` 等依赖这些可选能力完成 Copilot 特有的交互生命周期。
实际 host 对象由 Copilot 接入层注入；持久化 SSS 使用真实 `ChatResponseStream`，Native
LM 则使用只输出合法 `LanguageModelResponsePart2` 的适配 sink。

SSS/SSP 不知道：

- OpenCode、标准 ACP、Reasonix 等协议；
- 后端原始事件类型；
- 模型供应商 API；
- Copilot 的模型 picker 或 Participant 注册方式。

它们可以直接使用注入 stream 提供的 Copilot 交互能力；这与“不知道 Backend 协议”
并不冲突。

## 4. SSP 作为统一 Agent 事件

阶段一不再设计独立于 SSP 之外的第二套事件模型。统一事件就是 SSP：具体
Backend Pipeline 将原始协议转换为现有 SSP 类型和 payload，并直接调用绑定的 SSS。

事件语义至少覆盖：

```text
userPrompt
assistantText
reasoning
toolInvocation
question
externalEdit
interactionRequest
interactionResponse
sessionLifecycle
sessionDiff
```

不同后端的原始事件只能在自己的 Pipeline 内存在：

```text
OpenCode SSE / ACP JSON-RPC / Reasonix event
  → 对应 Backend Pipeline 的临时状态
  → 统一 SSP（直接写入绑定的 SSS）
```

`opaqueEvent` 只能用于确实需要保存的、协议无关的扩展信息，不能作为绕过统一 SSP
语义的原始事件逃生通道。新功能必须先定义对应的 SSP 语义。

## 5. Pipeline 与 Backend Session

### 5.1 绑定关系

Pipeline 是一次 Backend Session 事件流的解释器。Pipeline 创建时绑定完整的
Backend Session 上下文和当前 `BackendPipelineStream`；它直接产生/更新 SSP，不通过
另一套事件转发层抽象。

这里的绑定是具体 Pipeline 的构造责任。公共构造参数是 `sessionId`、`directory`、
`logger` 和当前 `BackendPipelineStream`；Copilot 编排层另外持有 `backendId`、
`backendInstanceKey`、`turnIndex`、`requestId` 等绑定事实，不把它们强制塞入统一的
Pipeline 状态对象。

Pipeline 可以直接调用 `BackendPipelineStream` 的 `push/update/writeMeta/flush`，并
直接实例化现有 SSP。Participant/Chat Session 传入持久化的
`SerializableSessionStream`；Native LM 传入不落盘的 `TransientSessionStream`。
阶段一不要求所有后端共享同一种 Pipeline 状态结构。

```text
Backend Session → Backend Pipeline(绑定 BackendPipelineStream) → SSP
  → SerializableSessionStream（Chat Session，持久化）
  或 TransientSessionStream（Native LM，不持久化）
```

Pipeline 的 SSS 绑定在构造函数中明确完成；不引入旧式的类型擦除和隐式注入方式。

### 5.2 Pipeline 自主状态

Pipeline 是否有状态、状态放在 Pipeline、Backend Session 还是当前 turn，都由具体
后端自行决定。公共框架不限制具体 Pipeline 的状态结构，也不规定它的持久化策略。
公共框架只要求 Pipeline 绑定 Backend Session，并能把后端事件转化为 SSP。

典型 ephemeral state 包括：

- 增量文本拼接和 part role 判定；
- 未决 child event 缓冲；
- tool call 到 SSP part 的映射；
- 子 session 的乱序等待和 idle 延迟计时器；
- permission/question 的当前等待器；
- 当前事件流的取消监听器和网络连接句柄。

这些状态通常只服务于当前 Pipeline run，但某个后端也可以根据自身协议需要把部分
状态放入 Backend Session 或 turn。框架不替具体后端做这个决定；需要持久化时，具体
Pipeline 可以使用现有 SSS/SSP 记录或后端自己的存储。

### 5.3 Pipeline 结果

Pipeline 可以返回当前 turn 所需的完成信息，例如 backend message ID、标题候选、
子 agent 是否活动以及完成/取消/失败状态。具体返回形态由 Backend 自己决定，不形成
新的公共状态或恢复协议。Copilot 只消费当前 Backend 已公开的结果，并把必要的
message ID 写入 turn mapping；标题候选由 Copilot 应用服务更新 backend session
和 SSS meta。

## 6. Backend 插件与 Vendor

### 6.1 一对一归属

每个 Backend 对应一个自己的 Copilot Vendor：

```text
opencode Backend → opencode vendor
acp Backend      → acp vendor
reasonix Backend → reasonix vendor
```

Vendor 是 Copilot 暴露和路由的命名空间，不是一个全局 provider API 执行器。Vendor
下暴露的每个模型必须能解析到一个具体 Backend instance 和一个可执行的模型调用
策略。

### 6.2 Backend 能力接口

模型能力属于 Backend 插件，而不是 `surfaces/vscode`。当前公共契约为
`BackendModelProvider`，由每个 Backend 实例提供：

```ts
interface BackendModelProvider {
  readonly vendor: string;
  listModels(directory?: string): Promise<BackendResult<BackendModel[]>>;
  invoke(request: BackendModelInvocationRequest): Promise<BackendModelInvocationResult>;
}

interface BackendModelInvocationRequest {
  model: BackendModelReference;
  /** Backend-specific options copied from the native model request. */
  modelOptions?: BackendModelOptions;
  prompt: BackendModelPrompt;
  directory?: string;
  agent?: string;
  title?: string;
  stream: BackendPipelineStream;
  token: BackendPipelineToken;
  logger?: { appendLine(message: string): void };
}

// `BackendModelOptions` is intentionally opaque at the common boundary. Each
// Backend decides which keys it accepts and maps them to its native request;
// unknown or unsupported keys must be ignored or rejected by that Backend,
// never blindly spread into a protocol call.

interface BackendModelInvocationResult {
  completed: boolean;
  sessionId?: string;
  pipeline: BackendPipelineResult;
}
```

`invoke()` 的输出必须进入该 Backend 的 Pipeline，最终产生统一 SSP。Copilot LM
接入代码只负责 VS Code 消息转换和 SSP 到 `Progress` 的渲染。

### 6.3 普通模型与特化模型

默认模型调用路线：

```text
Copilot native LM request
  → resolve vendor/model 到 Backend
  → 创建绑定 native LM progress 的 TransientSessionStream（不写 JSONL）
  → BackendModelProvider.invoke()
  → 按需启动 Backend 并创建临时 Backend Session
  → 打开 Backend Session event stream 并 ensureStarted
  → 创建绑定 TransientSessionStream 的 Backend Pipeline
  → 启动 pipeline.run(events, token)
  → 使用 providerID/modelID 执行 Backend Session prompt
  → 同时等待 prompt admission 与 Pipeline 完成
  → Pipeline 解析事件并把 SSP 写入 TransientSessionStream
  → Copilot native renderer 输出 SSP
  → flush 并关闭 TransientSessionStream
  → finally 关闭 event stream、release 临时 session，并在 Backend 支持时 delete
```

临时 session 的 SSP 默认不进入长期 Chat Session 持久化，因为 native LM 请求没有
稳定的 Copilot Chat Session 身份。它仍然必须经过同一套 Backend Pipeline，保证
文本、reasoning、tool、错误和取消语义一致。

清理语义按 Backend 能力分级，而不是假定所有协议都能永久删除 session：

- 取消、失败或 Pipeline 未完成时先 `abort`，成功路径不额外取消已经完成的 turn；
- 所有路径都关闭本次 event stream，并调用 `release` 释放活动句柄；
- `sessions.delete` 是可选能力，只有 Backend 支持时才永久删除临时 session；
- OpenCode 提供 durable delete；标准 ACP 仅在 agent 声明 `session/delete` 时删除，
  否则 `release` 会释放 `ActiveSession`，并在支持时调用 `session/close` 保留持久记录。

特化模型可以由 Backend 自行实现专用调用策略，例如 DeepSeek 或其他官方渠道：

```text
Backend-specific Model Provider
  → 官方渠道 / 特殊 wire format
  → Backend-specific parser
  → 统一 SSP
```

特化实现不能被放回 Copilot 的 `language-model-provider.ts`，也不能因为走 direct
API 就跳过统一 SSP 事件语义。

### 6.4 Vendor 暴露规则

以下条件全部满足时，模型才能出现在 Copilot 模型选择列表：

- Backend instance 当前可用，或能在请求时可靠启动；
- Vendor/model 能解析到明确的 Backend instance；
- Backend 存在普通或特化的 `invoke()` 实现；
- 模型所需凭据或后端授权可解析；
- 取消、错误和临时 session 清理路径已实现。

不可调用的模型不得先暴露再在请求时返回 `Unknown provider`。静态
`package.json` contribution 只声明 Vendor 的存在；实际模型列表由 Backend 能力
返回。运行时 registry 不能动态新增 VS Code contribution，因此新增内置 Backend
仍需同步静态 contribution。

## 7. Session state 与恢复

### 7.1 可恢复状态

可恢复状态由三部分组成：

```text
Copilot binding
  Copilot Session ID → Backend instance/session ID → turn mapping

Agent session identity
  backendId / backendInstanceKey / backendSessionId / parent relationship

SSS facts
  prompt、assistant、reasoning、tool、edit、snapshot、checkpoint、meta
```

这些状态分别由 Copilot session metadata、Backend Session API 和现有 SSS 记录提供。
不得用 Pipeline 内存对象代替它们。

### 7.2 不可恢复状态

以下状态明确是 ephemeral parser state：

- pending delta buffer；
- message role 推断结果；
- child event reorder buffer；
- deferred idle timer；
- tool/part 的内存映射；
- `SubagentScope` 运行对象；
- permission/question Promise 和 UI callback；
- 当前网络 stream、AbortController、logger 引用。

进程重启时，应用服务应重新查询 Backend Session 和 SSS 记录，重新创建 Pipeline。
如果 backend 仍 busy，则重新订阅；如果已 idle，则根据 SSS 最后记录收敛 turn；如果
存在未完成交互，则重新建立 Copilot UI waiter，不能恢复原 Promise。

## 8. 当前实现审计

阶段一已落地。当前实现已经把 Copilot 接入、Agent 后端和 SSS/SSP 基座的职责落实
到代码中；本节记录实际契约，作为后续扩展 Backend 插件的边界，而不是待执行的
迁移清单。

### 8.1 `BackendPipeline`

`src/backend/backend.ts` 定义 `BackendPipeline`、`BackendPipelineOptions` 和
`BackendPipelineResult`。Backend 通过 `createPipeline(options)` 创建一次性、绑定
单个 Backend Session 和当前 `BackendPipelineStream` 的 Pipeline：

```text
创建/恢复 Backend Session
  → 创建当前 `BackendPipelineStream`
  → 打开 Backend Session event stream
  → backend.createPipeline({ sessionId, directory, stream, logger })
  → pipeline.run(events, token)
  → backend.sessions.prompt(...)
  → pipeline 直接 push/update SSP
  → SSS flush、持久化并渲染
```

Pipeline 自己解析后端流式事件并维护 parser state。公共契约不再包含
`BackendBridge`、`createBridge` 或 `setSSS`，也不使用类型擦除的 SSS 注入。
Participant turn 使用 `SerializableSessionStream`，Native LM 使用
`TransientSessionStream`；后者只复用 SSP 调度/渲染，不创建 session JSONL。

### 8.2 Backend 插件

`src/backends/opencode/**`、`src/backends/acp/**` 和 `src/backends/reasonix/**` 分别
实现各自的 Backend、事件 Pipeline、权限/问题语义和会话操作。OpenCode 的协议字段
解析、子 session 路由、增量文本合并和 tool 状态都属于 OpenCode Pipeline；其他后端
不依赖 OpenCode 的私有事件类型。

Pipeline 输出统一 SSP，并通过构造时绑定的 `BackendPipelineStream` 写入当前 stream。
SSS/SSP 不需要知道具体后端协议，后端也不直接调用 VS Code surface API；需要
`externalEdit`/`questionCarousel` 时由 Copilot 注入的 `SspStream` 提供能力。

### 8.3 Copilot 模型目录与模型提供

`src/surfaces/vscode/model-catalog.ts` 的 `CopilotModelCatalog` 聚合所有 Backend
的 `modelProvider.listModels()` 结果，记录 `backendId`、Vendor、provider ID 和
model ID，并负责刷新、列举和解析。`language-model-provider.ts` 只负责 VS Code
Language Model 注册、消息转换、路由和 SSP 到 `Progress` 的输出。

每个 Backend 只有一个 Vendor 命名空间。模型调用统一进入该 Backend 的
`BackendModelProvider.invoke()`：普通模型由 Backend 创建临时 Backend Session 并
通过自己的 Pipeline 输出 SSP；需要特殊 wire format 或官方渠道的模型由 Backend
内部实现特化策略。Copilot 接入层不再直连 AI SDK、OpenAI/Anthropic/DeepSeek 等
provider API，也不维护全局 `directModelInvocation` 分支。

## 9. 阶段一修改边界（以当前实现为准）

### 已保留的稳定契约

- `SspStream` 的 host capability 形状及 SSP 的 `push/update/flush` 语义；
- v2 `session.jsonl`、`meta.jsonl` 的主格式和 turn envelope；
- 现有 SSP 的构造、渲染、反序列化和 replay 语义。

为完成多后端边界，阶段一已经对以下基座做了必要的实现调整：

- `src/ssp/types.ts`：统一 `opaqueEvent` 与 source 元数据；
- `src/ssp/impl/**`：保留 ExternalEdit/Question 等 host 交互生命周期；
- `src/backend/serializable/**`：移除旧 event 读写入口并支持 snapshot；
- `src/backend/streaming/**`：共享 SessionStreamNode 调度，增加 snapshot 与
  `TransientSessionStream` 所需的无持久化路径；
- 对应的 serializer、restore、checkpoint 测试同步更新。

这些调整不构成新的 SSS/SSP 领域拆分，也不引入第二种持久化格式。

### 可以重构

- `src/backends/opencode/**`、`src/backends/acp/**`、`src/backends/reasonix/**`；
- `src/backend/backend.ts` 和 `src/backend/types.ts` 的 Backend 公共契约；
- `src/participant/**` 和 `src/surfaces/vscode/**` 的应用编排；
- `src/surfaces/vscode/model-catalog.ts` 的 CopilotModelCatalog 和 vendor 路由；
- `src/extension.ts`、`src/backends/registry.ts` 的装配代码；
- `package.json` 的静态 Vendor/session contribution；
- 后端、Pipeline、Vendor 和 Copilot 接入测试。

### 阶段一禁止的临时方案

- 在 `language-model-provider.ts` 中继续写具体 provider SDK 调用；
- 用 `directModelInvocation` 字符串代替 Backend 模型能力；
- 恢复旧的 Bridge 工厂或通过类型擦除隐式注入 SSS；
- 让 Backend Pipeline 直接调用 VS Code `questionCarousel` 或 `externalEdit` API；
  这些能力必须经由绑定 stream 上的现有 SSP 触发；
- 为 parser state 增加新的持久化文件；
- 为同一个 Backend 暴露多个没有独立调用语义的 Vendor 别名；
- 注册无法调用的模型，让失败延迟到用户发送请求之后。

## 10. 阶段一验收标准

- Copilot 领域是唯一的 VS Code API 编排者。
- Backend 插件是唯一的后端协议和模型调用实现者。
- SSP 是 Backend Pipeline 输出的统一 Agent 事件。
- `SspStream` 的 host capability 与 SSS/SSP 核心语义保持稳定；必要的
  `opaqueEvent`、snapshot 和 transient-stream 基础调整已纳入阶段一。
- Backend Pipeline 在创建时绑定当前 `BackendPipelineStream`，直接产生/更新 SSP。
- 每个 Backend 只有一个 Vendor，Vendor 下的每个模型都有可执行路由。
- 普通模型走临时 Backend Session + Backend Pipeline。
- 特化模型由具体 Backend 实现，仍产生统一 SSP。
- Pipeline 是否持有状态、状态存放在哪里以及是否持久化，由具体 Pipeline 自行决定，公共框架不作规定。
- Native LM 的成功、取消、失败路径都执行 stream close/release，并在 Backend
  支持时删除临时 Backend Session；ACP 不支持 delete 时保留 durable record 是合法结果。
- Participant/Chat Session 主链路仍能把统一 SSP 写入并渲染到现有 SSS。

阶段一完成后，三领域的稳定关系是：

```text
Copilot 接入领域：请求、绑定、交互、渲染编排
Agent 后端领域：Backend Session、Pipeline、Vendor、模型策略
SSS/SSP 基座：统一 Agent 事件的记录、编辑、持久化和重放
```

SSS 内部重构、SSP 纯数据化、渲染与持久化拆分，以及更细的 checkpoint/replay
领域化，留到后续阶段单独进行。
