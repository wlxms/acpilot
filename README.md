# ACPilot

在 VSCode Copilot Chat 中使用任意 [ACP (Agent Client Protocol)](https://github.com/zcovex/acp) 兼容的 AI 编码助手后端。

`@opencode`、`@acp`、`@dsh` 或 `@reasonix` → 实时推理过程 → 工具调用 → AI 流式输出

ACPilot 以 ACP 语义为核心，将 Copilot 接入层与可插拔 Agent 后端解耦。当前内置
OpenCode、标准 ACP、DeepSeek Harness 和 Reasonix 后端；每个后端独立管理自己的会话、Pipeline 和
Copilot Vendor。

## 功能

- **聊天集成**: 在 Copilot Chat 输入 `@opencode`、`@acp`、`@dsh` 或 `@reasonix` 即可对话（对应后端需已配置）
- **实时推理显示**: AI 思考过程实时流式展示（thinkingProgress API）
- **原生工具调用卡片**: 文件读取、Shell 命令等以原生 UI 渲染，可点击展开
- **子代理支持**: 子代理/子任务自动以可展开卡片展示
- **流式输出**: AI 回复 token-by-token 实时显示
- **斜杠命令**: `/new` 新会话, `/help` 帮助, `/model` 模型列表
- **多后端架构**: Copilot ↔ SSS/SSP ↔ Agent；后端协议和 Pipeline 独立，模型提供是后端的附加能力
- **多后端 Session Provider**: OpenCode、标准 ACP 与 Reasonix 共用同一会话恢复管线

## 工具调用 UI 展示

```typescript
read / list / grep   → 可折叠的 Input/Output 区块
bash / shell         → 终端样式 + 执行耗时
write / edit         → 文件引用列表（可点击跳转）
task / subagent      → 点击展开子代理完整对话
```

## 安装

1. 按需安装并配置后端。使用 OpenCode 时请先安装 [OpenCode CLI](https://opencode-ai.com) 并完成认证；标准 ACP 和 DeepSeek Harness 目标可在 ACP 设置中配置，Reasonix 后端使用扩展设置中的命令配置
2. 克隆仓库
   ```bash
   git clone https://github.com/wlxms/acpilot.git
   cd acpilot
   npm install
   ```
3. 构建
   ```bash
   npm run compile
   ```
4. 在 VSCode 中按 `F5` 启动扩展开发主机

## 使用

在 Copilot Chat 中输入：

| 输入 | 效果 |
|------|------|
| `@opencode read package.json` | 调用 read 工具读取文件，展示 AI 回复 |
| `@opencode /model` | 显示可用 AI 模型列表 |
| `@opencode /new` | 开始新对话会话 |
| `@opencode /help` | 显示帮助 |
| `@acp read package.json` | 通过当前配置的标准 ACP 后端对话 |
| `@reasonix read package.json` | 通过 Reasonix ACP 后端对话 |
| `@dsh read package.json` | 通过当前配置的 DeepSeek Harness 命令对话 |
| `@dsh /model` | 显示 DeepSeek Harness 提供的模型列表 |


### DeepSeek Harness 配置

在 `ACP: Open Settings` 的 **DeepSeek Harness** 页面中可以保存自己的 DSH target：

- `DSH command`：用户自己的 `dsh` 可执行文件、脚本或 wrapper 命令
- `DSH launch directory`：启动 DSH 进程时使用的工作目录，可指向用户魔改后的 DSH 源码目录
- `Arguments`：逐行填写启动参数，默认使用 `--profile` 和 `acp`
- `Install DSH` / `Update DSH`：使用用户本机的 npm，把 `@deepseek-ai/dsh@latest` 安装或更新到指定目录

安装 DSH 后，首次安装会自动填入安装目录下的 launcher；已有 target 的更新操作会保留用户设置的 command，因此可以继续使用自己的 DSH server。DSH 进程启动目录和 ACP `session/new` 使用的 VS Code workspace 目录分别配置，互不覆盖。

ACPilot 也附带了可选的 `dsh-bridge` 插件。普通 DSH ACP profile 不需要安装 bridge；安装后，DSH 工具可以通过 `presentCall` / `presentResult` 把终端、文件读取、搜索、diff 和 External Edit 信息交给 VS Code 渲染。插件安装到用户自己的 DSH profile，不会替换用户的 DSH 命令或启动目录。

## 开发

```bash
# 类型检查
npm run lint

# 测试（618 个单元测试）
npm test

# VS Code Extension Host + loopback 控制端点 smoke/e2e
npm run test:runtime
```

### 技术栈

| 层 | 技术 |
|---|------|
| 聊天 UI | VSCode Chat Participant API (稳定 + `chatParticipantAdditions` proposal) |
| 流式处理 | BackendPipeline 解析事件 → SSP/SSS → Copilot 渲染 |
| 工具渲染 | `ChatToolInvocationPart` + 6 种 `toolSpecificData` |
| SDK | `@opencode-ai/sdk` ^1.16.0、`@agentclientprotocol/sdk` ^1.0.0 |
| 构建 | esbuild (ESM→CJS) |
| 测试 | vitest + 自定义 vscode mock |

### 三领域架构

当前代码库采用 **SSP-first / SSS-owned-stream** 分层架构：后端协议解析与 Copilot
编排分开，SSP 自身保留状态、序列化和面向注入 host stream 的渲染行为：

```txt
src/
├── backend/              # 多后端共享契约、会话与持久化
│   ├── backend.ts        #   Backend / BackendPipeline / BackendModelProvider 契约
│   ├── streaming/        #   SSS/SessionStreamNode（拥有 host stream，push/update API）
│   ├── serializable/     #   JSONL 序列化（session.jsonl / meta.jsonl）
│   └── checkpoint/       #   Checkpoint 审批状态与持久化
├── ssp/                  # 可序列化流部件层（SSP 自洽：状态 + 渲染 + 序列化）
│   ├── types.ts          #   SerializableStreamPart 基类 + IMutableStreamPart
│   └── impl/             #   10+ 具体 SSP（AssistantText / Reasoning / Tool / Edit / Question …）
├── backends/opencode/    # OpenCode Backend Pipeline 与协议解析
├── backends/acp/         # 标准 ACP Backend、transport 与 Pipeline
├── backends/reasonix/    # Reasonix 的 ACP preset Backend
├── backends/dsh/         # DeepSeek Harness 独立 ACP Backend
├── surfaces/vscode/model-catalog.ts # CopilotModelCatalog 与模型路由
├── surfaces/vscode/      # VS Code participant、session provider 与模型 surface
├── participant/          # ChatRequestHandler 编排层（handler + checkpoint + title）
├── settings/             # Webview 设置面板
├── opencode/             # OpenCode SDK 封装（server + client）
├── test-control/         # 本机 Extension Host e2e 控制 API
└── extension.ts          # 入口：backend + surface 装配
```

**数据流**：

```
Copilot request
  → Copilot integration 绑定 Chat Session / Backend Session
  → 打开 Backend Session event stream
  → 启动绑定 SSS 的 BackendPipeline
  → Backend Session prompt
  → BackendPipeline.run() 解析后端流式事件
  → Pipeline 将统一 SSP 写入绑定的 SSS
  → SSS 持久化、重放并渲染到 VS Code
```

- `src/backend/*`：定义统一会话、配置、权限与持久化契约
- `src/ssp/*`：每个 SSP 自洽——拥有自身状态、渲染逻辑、序列化契约，直接 import vscode 类型
- `src/backend/streaming/*`：`SerializableSessionStream` 拥有注入的 VS Code 流；
  Pipeline 只调 `push()/update()`，永不直接触达 VS Code API。Native LM 使用同一基类的
  `TransientSessionStream`，不创建持久化文件
- `src/backends/opencode/*`：OpenCode Pipeline 解析 OpenCode raw 事件并映射到统一 SSP

Copilot 模型链路：

```text
Copilot model selection
  → CopilotModelCatalog.list()/resolve()
  → BackendModelProvider.invoke()
  → 创建临时 Backend Session
  → 打开 event stream → ensureStarted
  → 创建并启动绑定 TransientSessionStream 的 BackendPipeline
  → prompt(providerID/modelID)
  → SSP → native LM response sink（不落盘）
  → close/release；Backend 支持时 delete
```

每个 Backend 只拥有一个 Copilot Vendor。模型提供是 Backend 的附加能力；ACPilot 的
核心仍是通过 Copilot 接入层调用可插拔的 ACP/Agent 后端。

JSONL 持久化（中断安全）：

```
{workspaceRoot}/.acpilot/{backend}/{sessionId}/
├── meta.jsonl                  # 会话元数据（快速索引）
├── session.jsonl               # 流部件（append-only）
└── subsessions/{subId}/        # 子代理独立文件（递归嵌套）
    └── subsession.jsonl
```

### Session Provider

每个已注册后端都使用同一套 Chat Session Provider、participant handler 和
SSP 恢复管线；Backend instance、session namespace 和 model catalog 由各后端隔离。
运行环境缺少所需 VS Code API 时仅保留 participant surface，不存在单后端恢复路径
或独立的兼容存储格式。

### 项目结构

```
src/
├── extension.ts              # 入口: activate/deactivate，注册 ChatParticipant
├── statusbar.ts              # 状态栏管理
├── backend/                  # 多后端共享契约与会话流
│   ├── backend.ts            #   Backend / BackendPipeline / BackendModelProvider 契约
│   ├── streaming/            #   SSS 会话流（push/update，JSONL 持久化）
│   ├── serializable/         #   JSONL 序列化器
│   ├── checkpoint/           #   Checkpoint 状态存储
│   └── ...                   #   事件总线 / 会话映射 / 选择存储
├── ssp/                      # 可序列化流部件层（自洽状态 + 渲染）
│   ├── types.ts              #   SerializableStreamPart 基类
│   └── impl/                 #   10+ 具体 SSP（Text/Reasoning/Tool/Edit/…）
├── backends/opencode/        # OpenCode Backend Pipeline + raw 事件解析
├── backends/acp/             # 标准 ACP Backend + Pipeline
├── backends/reasonix/        # Reasonix ACP preset
├── backends/dsh/             # DeepSeek Harness ACP preset
├── backend/transient-session-stream.ts # Native LM 的不落盘 stream
├── surfaces/vscode/model-catalog.ts # CopilotModelCatalog
├── surfaces/vscode/          # VS Code surfaces 与能力检测
├── participant/              # ChatRequestHandler 编排（handler/commands/checkpoint）
├── settings/                 # Webview 设置面板
├── opencode/                 # SDK 封装（server + client）
├── types/                    # 共享类型（ExtensionState + vscode proposed API 声明）
└── test/                     # vitest 测试（555 个用例）
```

详细技术文档见 [阶段一架构设计](docs/refactor/copilot-agent-sss-phase1-design.md)。
Extension Host 端点与本机 e2e 用法见 [Runtime Test Control](docs/runtime-test-control.md)。

## 许可证

MIT
