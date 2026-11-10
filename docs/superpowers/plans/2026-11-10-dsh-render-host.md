# DSH Render Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Implement task-by-task with regression tests and review.

**Goal:** Render complete GenUI in Copilot and route actions to the originating ACPilot session through a generic view protocol.

**Architecture:** A RichViewSSP persists a versioned renderer envelope. A session-bound ChatOutputRenderer host serves the original GenUI embed runtime in a Webview and routes action messages; bridge metadata is preserved and source specs are normalized conservatively.

**Tech Stack:** TypeScript, VS Code proposed chatOutputRenderer, GenUI 0.15.0 embed, React18, esbuild, Vitest.

**Spec:** docs/superpowers/specs/2026-11-10-dsh-render-host.md

## Global Constraints

- Existing branch and PR #21. Background commands only; no VS Code open/reload.
- Renderer envelope {protocol:1,renderer:{id:"dsh.genui",version:1},viewId:string,data:unknown}.
- Webview ready/render/action/action-result messages use protocol1; host closure owns session identity.
- Treat spec/renderer payload as data; no model-supplied script/asset URLs. Use bundled renderer/assets and preserve MIT notices.

### Task 1: Complete renderer bundle

**Files:** webviews/dsh-renderer/*, scripts/build-dsh-renderer.cjs, package.json/package-lock.json devDependencies and compile scripts, resources/dsh-renderer output/notices.
**Interface:** render message and action reply contract above; outputs renderer.js/renderer.css plus local assets and version manifest.
- [x] Write failing browser/renderer tests for row/badge/chart/tabs/button and invalid spec.
- [x] Install pinned GenUI/react build dependencies without DSH peer host installation.
- [x] Bundle GenUI embed with standalone primitive alias and CSS modules; wire action Provider and state.
- [x] Validate built complete runtime and assets against source package and licenses.

### Task 2: DSH rich view bridge and pipeline

**Files:** dsh-bridge/index.mjs, src/backends/dsh/bridge-protocol.ts, pipeline.ts, new regression tests.
**Interface:** result.richView={protocol:1,renderer:{id:"dsh.genui",version:1},viewId:toolCallId,data:spec}; pipeline pushes new RichViewSSP using source session metadata.
- [x] Red tests for missing rich metadata, error results and screenshot field aliases.
- [x] Preserve successful output.presentationMeta; normalize only recognized GenUI args before execution.
- [x] Emit one replayable view per successful result; preserve ordinary tools, initial terminal calls and child scope.

### Task 3: Generic host, serialization and session routing

**Files:** src/chat-rendering/*, src/ssp/impl/rich-view.ts, SSP types/deserialize, extension.ts, participant/handler.ts, surfaces/vscode/experimental-session.ts, tests.
**Interface:** wrapDshRenderStream(raw,route) returns ChatResponseStream-compatible proxy with richView(view); route.submit(action,payload) targets bound backend/VSCode session.
- [x] Red tests for split fenced payloads, envelope validation, unavailable API fallback and replay.
- [x] Register renderer and trusted local resources; wire ready/render/action lifecycle.
- [x] Bind live and restored sessions; prove cross-session isolation and stale/busy handling.

### Task 4: Integration, package and review

- [x] Run focused and full unit tests, type/lint/build and bridge syntax.
- [x] Validate packaged renderer/assets and background install; no user-window operation.
- [x] Independent review of data, rendering and action lifecycle; fix material findings.
- [x] Commit/push existing branch and update/read back PR #21 with final scope and UI limits.
