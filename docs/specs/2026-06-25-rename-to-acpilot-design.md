# 项目重命名为 ACPilot — 设计文档

**日期**: 2026-06-25
**状态**: 历史设计（已由阶段一多后端架构取代）
**分支**: master（历史记录）

> 本文记录项目从 OpenCode Copilot 更名为 ACPilot 的早期方案。重命名和多后端
> 接入已经落地；当前领域边界、Vendor 规则和运行时契约以
> [阶段一架构设计](../refactor/copilot-agent-sss-phase1-design.md) 及 README 为准。
> 文中的旧路径、旧 Vendor 和提交步骤仅供历史追溯，不是当前实施清单。

## 1. 背景与动机

当前项目名为 `opencode-copilot`,设计上以 [OpenCode](https://opencode-ai.com) 为唯一 backend。
但代码已经引入了 ACP(Agent Client Protocol)语义层(`src/acp/`),将 backend 与 VS Code surface 解耦,
OpenCode 只是 `src/backends/opencode/` 下的一个 backend 实现。

下一步目标是**拓展到支持所有 ACP 协议的 backend**,因此项目名 `opencode-copilot` 已不再准确。
重命名为 **ACPilot** 以反映其作为「ACP 协议多 backend 适配器」的新定位。

## 2. 范围决策(已与用户确认)

| 决策点 | 选择 |
|--------|------|
| 标识符处理 | **彻底重命名**(package/命令前缀/session scheme/目录/文档全部改) |
| GitHub 远程 | **重命名现有仓库** `wlxms/opencode-copilot` → `wlxms/acpilot`(GitHub 自动保留重定向) |
| 本地目录 | `D:\opencode-copilot` → `D:\acpilot` |
| 命名约定 | `acpilot` 命令前缀 + **动态 vendor**(vendor 名按具体 backend 保留) |
| 提交策略 | master 上单次 commit + push |

## 3. 命名映射表

### 3.1 必须改

| 类别 | 旧值 | 新值 | 出现位置 |
|------|------|------|----------|
| package name | `opencode-copilot` | `acpilot` | package.json |
| displayName | `OpenCode Copilot` | `ACPilot` | package.json |
| description | `AI coding assistant powered by OpenCode` | `ACP coding assistant powered by ACP backends` | package.json |
| repo url | `github.com/wlxms/opencode-copilot.git` | `github.com/wlxms/acpilot.git` | package.json, README |
| 命令 id | `opencode.openSettings` | `acpilot.openSettings` | package.json, extension.ts, statusbar.ts |
| 命令 title/category | `ACP` / `ACP: Open Settings`(已是 ACP) | 保持 `ACP` | package.json |
| 配置 section | `opencode.experimental.*` | `acpilot.experimental.*` | package.json |
| 配置 title | `OpenCode` | `ACPilot` | package.json |
| session scheme/type | `opencode-copilot.opencode` | `acpilot.opencode` | package.json, extension.ts, experimental-session.ts, collector-stream.ts, 多处测试 |
| 常量名 | `OPENCODE_SESSION_SCHEME` | `ACP_SESSION_SCHEME` | experimental-session.ts, extension.ts |
| output channel 名 | `OpenCode Copilot` | `ACPilot` | extension.ts |
| 日志文案 | `[extension] OpenCode Copilot ...` | `[extension] ACPilot ...` | extension.ts |
| 图标 id | `opencode-logo` | `acpilot-logo` | package.json, experimental-session.ts |
| font 文件 | `opencode-icon.woff` | `acpilot-icon.woff` | package.json, generate-font.cjs, resources/font-icons/ |
| svg 图标 | `opencode-icon-light.svg`/`-dark.svg` | `acpilot-icon-light.svg`/`-dark.svg` | resources/, extension.ts |
| font codepoint key | `{ opencode: 0xE001 }` | `{ acpilot: 0xE001 }` | generate-font.cjs |
| `getConfiguration()` 参数 | `'opencode'` | `'acpilot'` | extension.ts, session-stream.ts |
| README | 通篇 `OpenCode Copilot` / `opencode-copilot` | `ACPilot` / `acpilot` | README.md |

### 3.2 **保留不改**(关键)

以下标识符语义上是「OpenCode 这个具体 backend」,符合「动态 vendor / 多 backend」定位,**不动**:

- `src/backends/opencode/` 目录及内部所有文件(`OpenCodeBackend` 类、`opencode-bridge.ts` 等)
- `registerBackend('opencode', ...)` / `createBackend('opencode')` — backend 注册名
- `languageModelChatProviders` 里的 backend Vendor — 早期方案曾使用多个 OpenCode Vendor；
  当前每个 Backend 只注册一个 Vendor（例如 `opencode`、`acp`、`reasonix`）
- session type 里的 `opencode` 部分:`acpilot.opencode`(前缀改 acpilot,backend 名 opencode 保留)
- npm 依赖 `@opencode-ai/sdk`、`opencode-ai` — 上游包,非本项目
- `.omo`、`.codex`、`.agents`、`.sisyphus`、`.vscode` 等工具配置目录

### 3.3 文档处理

- `README.md`:通篇更新为 ACPilot,补充「支持所有 ACP 协议 backend」的新定位说明
- `doc/*.md`(tech-summary、permission-analysis、todo-* 等):更新项目名引用,保留技术内容
- `docs/*.md`(架构分析文档):更新项目名引用

## 4. git 操作顺序

1. **GitHub 重命名**:`gh repo rename acpilot` (GitHub 自动保留旧名 301 重定向,不丢 issues/PR/star)
2. **更新 remote**:`git remote set-url origin https://github.com/wlxms/acpilot.git`
3. **资源文件重命名**(用 `git mv` 保留历史):
   - `resources/font-icons/opencode-icon.woff` → `acpilot-icon.woff`
   - `resources/opencode-icon-light.svg` → `acpilot-icon-light.svg`
   - `resources/opencode-icon-dark.svg` → `acpilot-icon-dark.svg`
4. **代码/配置改动**:按映射表逐一修改
5. **验证**:`npm run compile` + `npm run lint` + `npm test`
6. **提交**:`git add -A && git commit -m "refactor: rename project to ACPilot"`
7. **推送**:`git push origin master`
8. **本地目录改名**:`D:\opencode-copilot` → `D:\acpilot`(需重启会话,因为当前 shell 工作目录在其中)

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 已安装用户配置项失效(旧 `opencode.experimental.*`) | 本次不写迁移逻辑;GitHub 重命名保留重定向,但配置 key 变更是 breaking change,在 commit message 注明 |
| session scheme 变更导致已有持久化 session 失效 | 同上,breaking change,版本未正式发布,影响可控 |
| `git mv` 在 Windows 上的大小写问题 | 全小写命名,无大小写冲突 |
| 本地目录改名后当前会话工作目录失效 | 改名作为最后一步,需重启会话;改完前 commit/push 已完成 |
| 测试里大量 scheme 字符串硬编码 | 统一替换,测试会验证 |

## 6. 不在本次范围

- 配置迁移逻辑(用户选了「彻底重命名」而非「+配置迁移」)
- 新 backend 的实际接入(本次只改名,不动架构)
- VS Code Marketplace 发布(如有发布需另行处理 publisher/版本)
