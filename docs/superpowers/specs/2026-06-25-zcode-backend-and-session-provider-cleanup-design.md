# ZCode Backend 接入 + Session Provider 设置清理

> **历史文档（已被当前架构替代）**：本文是 2026-06-25 的早期 ZCode 双 backend
> 设计草案。当前实现已经统一为 `Copilot ↔ SSS/SSP ↔ Agent`，每个 Backend 拥有
> 独立 Vendor，并通过 `BackendPipeline` 与 `BackendModelProvider` 接入；本文中的
> `BackendHost`、复用 `OpenCodeBridge` 以及保留单一 `ExtensionState.backend` 等方案
> 不再是实施依据。请以 [阶段一架构设计](../../refactor/copilot-agent-sss-phase1-design.md)
> 和当前代码为准。

**日期**: 2026-06-25
**状态**: 历史草案（已被阶段一多 Backend 架构取代）

## 背景与目标

ACPilot 当前只内置一个 OpenCode backend。本设计解决两件事:

1. **移除死开关 `acpilot.experimental.sessionProvider`**:该设置只存在于声明(`package.json` / `extension.ts` / README),代码中**从未被读取**。session provider 的注册完全由运行时能力检测 `hasRegisterChatSessionContentProvider()` 门控。该方案已被验证成熟可靠,实验性标记应移除。

2. **接入 ZCode backend(智谱 Z.AI,基于 OpenCode 变体,支持 ACP 协议)**:与 OpenCode **双 backend 并存**,用户可在 `@opencode` 和 `@zcode` 两个 chat participant 之间切换。核心复用 ACP/SSP/Bridge 语义层,只在 SDK/Server 启动层独立。

---

## 第一部分:移除 Session Provider (Experimental) 设置

### 现状

`acpilot.experimental.sessionProvider` 出现在 3 处,**零消费方**:

| 位置 | 内容 |
|------|------|
| `package.json:65-69` | `contributes.configuration` 中的布尔配置项 |
| `src/extension.ts:53-59` | `GLOBAL_SETTINGS_DESCRIPTOR` 数组里的 toggle 条目 |
| `README.md:18, 125-141` | 功能列表行 + "实验性 Session Provider" 整节 |

`grep` 确认:除声明外,无任何 `cfg.get('experimental.sessionProvider')` 读取。session provider 注册路径在 `extension.ts:338` 仅由 `hasRegisterChatSessionContentProvider()` 门控。

### 改动

1. **`package.json`**:删除 `acpilot.experimental.sessionProvider` 配置项(properties 数组中的该对象)。
2. **`src/extension.ts`**:从 `GLOBAL_SETTINGS_DESCRIPTOR` 删除 `key: 'sessionProvider'` 的条目。
3. **`README.md`**:
   - 删除功能列表中 `- **实验性 Session Provider 开关**...` 这一行
   - 删除 `### 实验性 Session Provider` 整节(含代码块与说明)

### 风险

零风险。配置项被删除后,已设置过该值的用户的 `globalState` 里会残留一个未读的布尔值,无功能影响。

---

## 第二部分:ZCode Backend 接入(双 backend 并存)

### 关键事实(来自探索)

- **`OpenCodeClient`(`src/backends/opencode/sdk-types.ts:143`)是我们自定义的、与 SDK 解耦的接口契约**,不是直接用 `@opencode-ai/sdk` 类型。转换只在 `server.ts:137` 的边界处用 `as unknown as OpenCodeClient` 完成。
- **`OpenCodeBridge` / `AcpProtocolBridge` 是基于 ACP 事件语义的**,与具体 SDK 无关。ZCode 作为 OpenCode 变体,事件流形态一致(`message.part.updated` / `session.idle` / `permission.asked` 等),**bridge 可完整复用**。
- **`ExtensionState`(`src/types/index.ts:46`)和 `extension.ts` 当前是单 backend 写死**:只有一个 `backend` 字段、一个 selection/sessionManager。
- **`participant/handler.ts` 依赖 `ExtensionState` 中的单 backend 字段**(`state.backend`、`state.selection`、`state.sessions` 等),不是 backend 参数化的。

### 设计决策:抽 BackendHost 栈

**核心抽象**:定义 `BackendHost` 接口,把"一个 backend 的完整运行栈"封装起来。每个 host 持有自己的:

- `AcpBackend` 实例(opencode / zcode)
- `SelectionStore`(每个 backend 各自的 agent/model 选择)
- `SessionManager`(VSCode chat → backend session 映射,按 backend 隔离)
- `SessionStore`(各自目录 `.acpilot/{backend}/{sessionId}/`)
- 注册的 `ChatParticipant` + scheme + session content provider

**复用的部分**(不重复):
- `AcpProtocolBridge` / `OpenCodeBridge`(完全复用)
- `OpenCodeClient` 接口契约(ZCode adapter 复用同一客户端契约)
- `SerializableSessionStream` / SSP 层 / checkpoint 层
- `participant/handler.ts` 的编排逻辑(改为接收 `BackendHost` 参数而非读全局 `state`)
- 设置面板(`SettingsPanel`)——通过 nav 区分 backend

### 架构图

```
extension.ts (activate)
  ├── OpenCodeHost.create('opencode')
  │     ├── OpenCodeBackend (现有, spawn @opencode-ai/sdk server)
  │     ├── SelectionStore / SessionManager / SessionStore (各一份)
  │     └── register participant('acpilot.opencode') + scheme + session provider
  └── ZCodeHost.create('zcode')
        ├── ZCodeBackend (新, 继承 OpenCodeBackend, 复用 adapter 全部逻辑)
        │     ├── ZCodeServerManager (新, spawn zcode CLI/server — 细节待补充)
        │     └── createBridge() → 复用 OpenCodeBridge (ACP 事件语义一致)
        ├── SelectionStore / SessionManager / SessionStore (各一份, .acpilot/zcode/)
        └── register participant('acpilot.zcode') + scheme + session provider

ExtensionState
  ├── backends: Map<string, BackendHost>   ← 新增, 替代单一 backend 字段
  ├── acpModels (共享)
  ├── bus (共享)
  ├── outputChannel (共享)
  └── statusBar (共享, 显示当前活跃 host)
```

### 组件清单

#### 1. `BackendHost` 接口(新)— `src/backends/backend-host.ts`

```typescript
export interface BackendHost {
  readonly id: string;                    // 'opencode' | 'zcode'
  readonly backend: AcpBackend;
  readonly selection: SelectionStore;
  readonly sessions: SessionManager;
  readonly sessionStore: SessionStore;
  /** 注册该 host 的 chat participant + scheme + session provider */
  register(context: vscode.ExtensionContext): vscode.Disposable[];
  /** 启动 backend server */
  start(directory?: string): Promise<void>;
  /** 该 host 是否为用户当前活跃使用的(用于状态栏) */
  isActive(): boolean;
}
```

#### 2. `BaseBackendHost` 抽象基类(新)

封装通用注册逻辑(participant 创建、scheme、session content provider、status bar 订阅)。`OpenCodeHost` / `ZCodeHost` 继承它,只提供差异:`id`、`backend` 工厂、scheme、participant id、icon。

#### 3. `OpenCodeHost`(新/重构)

把现有 `extension.ts:323-361` 的 participant + session provider 注册逻辑搬进来,绑定到自己的 selection/sessionManager/sessionStore。`ACP_SESSION_SCHEME = 'acpilot.opencode'` 保持不变。

#### 4. `ZCodeHost`(新)

- `id: 'zcode'`,`scheme: 'acpilot.zcode'`,`participantId: 'acpilot.zcode'`
- 持有 `ZCodeBackend` 实例
- icon:复用或新增 zcode 图标(暂用现有 opencode-logo 占位)

#### 5. `ZCodeBackend`(新)— `src/backends/zcode/adapter.ts`

```typescript
export class ZCodeBackend extends OpenCodeBackend {
  override readonly name = 'zcode';

  constructor() {
    super();  // 复用全部 sessions/config/events/permissions/questions/auth 逻辑
    // 覆写 serverManager 为 ZCodeServerManager — 见下
  }
}
```

由于 `OpenCodeBackend` 把 `serverManager` 声明为 `private readonly`(adapter.ts:102),无法直接覆写。**两种处理方式**:

- **(A) 小重构 OpenCodeBackend**:把 `serverManager` 和 `eventBroker` 改为 `protected`,并提供构造注入点:`constructor(serverManager?: OpenCodeServerController)`。ZCodeBackend 传入 `ZCodeServerManager`。**推荐**,改动可控且不改 OpenCode 行为。
- **(B) ZCodeBackend 独立实现**:不继承,从零实现 `AcpBackend` 接口,大量复制 adapter.ts。不推荐,违反 DRY。

采用 **(A)**:`OpenCodeBackend` 构造函数接收可选的 `serverManager` 与 `name`,默认值维持现状;`ZCodeBackend` 注入 `ZCodeServerManager`。

#### 6. `ZCodeServerManager`(新)— `src/backends/zcode/server.ts`

参照 `OpenCodeServerManager`(`src/opencode/server.ts`),但启动 ZCode CLI/server。**具体启动方式(独立 SDK 包名 / CLI 二进制名 / 端口策略)待补充** —— 当前设计先以骨架形式提供,接入细节在实现阶段根据 ZCode SDK 实际形态填充。

```typescript
export class ZCodeServerManager implements OpenCodeServerController {
  // 与 OpenCodeServerManager 同构,但 createZcode() 启动逻辑待定
  // getClient() 返回的 client 形态须兼容 OpenCodeClient 契约(ZCode 作为 OpenCode 变体应一致)
}
```

#### 7. `createBridge` 复用

`ZCodeBackend.createBridge()` 直接返回 `new OpenCodeBridge(this, sessionId, directory)` —— bridge 完全复用,**无需新建 ZCodeBridge**。前提:ZCode 的事件流形态与 OpenCode 一致(`OpenCodeStreamEvent` 可兼容解析)。若 ZCode 事件字段有差异,在实现阶段用 adapter 层补一个薄投影函数。

#### 8. `extension.ts` 重构

```typescript
export function activate(context) {
  const hosts = new Map<string, BackendHost>();
  const opencodeHost = new OpenCodeHost(sharedDeps);
  const zcodeHost = new ZCodeHost(sharedDeps);
  hosts.set('opencode', opencodeHost);
  hosts.set('zcode', zcodeHost);

  for (const host of hosts.values()) {
    context.subscriptions.push(...host.register(context));
    host.start(directory).catch(...);
  }

  state = { backends: hosts, acpModels, bus, outputChannel, statusBar };
  // 设置面板、ACPModels sync、status bar 订阅多 host 事件
}
```

`ExtensionState` 改动:保留 `backend`(指向默认/活跃 host,向后兼容 handler),新增 `backends: Map<string, BackendHost>`。

#### 9. `participant/handler.ts` 改造

当前 `createParticipantHandler(state: ExtensionState)` 读 `state.backend` 等单字段。改为 `createParticipantHandler(host: BackendHost, sharedState)` —— 从 host 取各自的 selection/sessions/backend。`resolvePromptModel` 等函数签名相应调整。

#### 10. `package.json` 新增

```json
"chatSessions": [
  { "type": "acpilot.opencode", ... },   // 现有
  { "type": "acpilot.zcode", "name": "zcode", "displayName": "ZCode", ... }  // 新增
]
```

#### 11. 设置面板

`SettingsPanel` 的 TOC 已支持多 nav(`Global` / `OpenCode`)。新增 `ZCode` nav,渲染 `ZCodeHost` 的 backend settings。`SettingsData` 增加 `backends: Array<{id, name, ...}>` 或分多次 push。

### 数据流(双 host 各自独立)

```
@opencode 消息 → OpenCodeHost.handler → OpenCode selection/sessions
  → SerializableSessionStream → OpenCodeBackend.sessions.prompt
  → OpenCodeBridge.run() → SSS.push(SSP) → 渲染 + .acpilot/opencode/{sid}/

@zcode 消息 → ZCodeHost.handler → ZCode selection/sessions
  → SerializableSessionStream → ZCodeBackend.sessions.prompt
  → OpenCodeBridge.run() (复用) → SSS.push(SSP) → 渲染 + .acpilot/zcode/{sid}/
```

### 待补充的实现细节(标 TODO,不阻塞设计定稿)

1. **ZCode SDK 包名 / CLI 命令**:ZCode 用独立 SDK,具体是 `@zcode/sdk` 还是 `zcode-ai` 等,待确认。`ZCodeServerManager` 的 import 与启动命令占位。
2. **ZCode 事件流兼容性验证**:实现阶段需对比 ZCode SSE 事件与 `OpenCodeStreamEvent`,若有差异补投影层。
3. **ZCode 图标**:暂复用 `opencode-logo`,后续替换为 zcode 专属图标。

### 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| ZCode SDK 形态与 OpenCodeClient 契约不兼容 | adapter 无法直接复用 | ZCode 是 OpenCode 变体,事件形态大概率一致;若不一致,adapter 层补投影(代价中等) |
| 重构 `OpenCodeBackend` 为可注入 serverManager | 可能影响现有 OpenCode 行为 | 默认参数维持现状,新增可选注入点,现有 OpenCodeHost 零行为变化 |
| `handler.ts` 改造范围 | 涉及 participant 编排核心 | 逐函数迁移,保持现有单测可适配;先让 OpenCodeHost 跑通再接 ZCodeHost |
| 双 host 共享 status bar | 状态栏只显示一个 host 的 agent/model | status bar 显示活跃 host(id + agent/model),或扩展为可切换 |

### 不在本设计范围内(YAGNI)

- 后端动态热插拔 / 运行时增删 backend(当前只两个固定 host)
- 后端间会话迁移
- ZCode 专属的 settings 字段(若 ZCode config 与 OpenCode 一致,复用 `OpenCodeSettingsProvider`)

### 实施顺序(供后续 plan 参考)

1. 第一部分:移除 sessionProvider 设置(独立可提交)
2. 抽 `BackendHost` 接口 + `BaseBackendHost`,把现有 OpenCode 逻辑搬入 `OpenCodeHost`(单 host,行为不变)
3. 重构 `ExtensionState` + `extension.ts` 用 host map(此时仍只 opencode 一个)
4. `OpenCodeBackend` 改为可注入 serverManager
5. 新增 `ZCodeBackend` + `ZCodeServerManager`(骨架,启动逻辑占位)
6. 新增 `ZCodeHost`,注册第二个 participant/scheme/provider
7. `package.json` 加 `acpilot.zcode` chatSession
8. 设置面板加 ZCode nav
9. 补 ZCode SDK 实际接入细节(待用户提供 SDK 信息)
