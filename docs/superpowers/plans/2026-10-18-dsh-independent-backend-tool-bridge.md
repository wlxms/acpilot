---
name: dsh-independent-backend-tool-bridge

description: Add an independent DSH backend with an OpenCode-style tool presentation bridge and External Edit integration.
---

# Independent DSH Backend and Tool Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current DSH-as-ACP-alias registration with a first-class `DshBackend` and `DshPipeline` that consume standard ACP events plus an optional DSH bridge presentation channel. The bridge must expose DSH's structured tool presentation (`presentCall` / `presentResult`) without taking over ACP stdout, so ACPilot can render terminal, read, search, diff, custom-tool, and External Edit behavior through the same SSP path used by OpenCode.

**Spec:** `docs/superpowers/specs/2026-10-17-dsh-agent-bridge.md`

**Acceptance criteria:**

- The registry creates a concrete DSH backend from `src/backends/dsh/adapter.ts` and `src/backends/dsh/pipeline.ts`; `src/backends/dsh/index.ts` no longer aliases the ACP backend class.
- A normal user-owned `dsh --profile acp` process still works without installing the bridge plugin.
- An installed `@wlxms/acpilot-dsh-bridge` plugin emits only versioned stderr bridge messages and never writes to ACP stdout.
- DSH tool calls use structured VS Code tool rendering similar to OpenCode: command cards, file links, search resources, custom tool titles, and result output.
- File mutations correlate with DSH permission requests even when the ACP request contains only `toolCallId`, and use the existing `ExternalEditSSP` baseline/after snapshot and undo metadata path.
- Already-running DSH endpoints continue to work through standard ACP fallback analysis.

## File map

- `src/backends/acp/adapter.ts`: add protected local-stderr and pipeline-construction hooks so a specialized ACP-speaking backend can own its pipeline and side channel without duplicating connection/session lifecycle code.
- `src/backends/acp/transport.ts`: keep piped stderr alive after readiness and continue forwarding later lines to the callback; readiness remains a one-time promise.
- `src/backends/acp/pipeline.ts`: expose the tool lifecycle hooks needed by the DSH specialization and accept normalized presentation patches while preserving the generic ACP fallback.
- `src/backends/dsh/adapter.ts`: concrete `DshBackend` subclass with DSH bridge-message routing and DSH pipeline creation.
- `src/backends/dsh/pipeline.ts`: DSH-specific pipeline that merges ACP tool updates with bridge presentations, correlates permission requests, and maps DSH presentations to existing SSPs.
- `src/backends/dsh/bridge-protocol.ts`: versioned ready/tool message schema, serialization, strict parsing, and safe message discriminators.
- `src/backends/dsh/index.ts`: register/export the concrete DSH backend.
- `dsh-bridge/index.mjs`: optional DSH plugin that observes `tools/pre-execute` and `tools/result`, calls the active tool's presentation functions, and emits bridge messages to stderr.
- `dsh-bridge/README.md`, `dsh-bridge/package.json`, `dsh-bridge/cordis.patch.yml`: document and package the bridge contract.
- `src/extension.ts`: pass the DSH bridge nonce and keep ordinary stderr diagnostics separate from structured bridge messages.
- `src/test/acp-transport.test.ts`: prove stderr remains available after readiness.
- `src/test/dsh-bridge-protocol.test.ts`: parser/serializer and malformed-message coverage.
- `src/test/dsh-pipeline.test.ts`: presentation merge, out-of-order delivery, terminal/read/search/diff mapping, and permission correlation.
- `src/test/dsh-backend.test.ts`: concrete backend registration and pipeline type behavior.
- `src/test/ssp/tool-invocation.test.ts`: any new presentation metadata mapping needed by DSH cards.
- `scripts/runtime-smoke.cjs` or a DSH-specific runtime smoke script: verify the concrete backend and optional bridge path against `D:\dsh-mydsh\deepseek-harness` when the local DSH checkout is available.

## Execution steps

### Step 1: Lock the bridge protocol and stderr lifecycle with failing tests

- [ ] **Write failing tests first.** Extend `src/test/dsh-bridge-protocol.test.ts` with fixtures for:
  - a versioned `tool_call` presentation containing `sessionId`, `toolCallId`, original tool name, `card`, `kind`, locations, and a terminal/diff view;
  - a versioned `tool_result` presentation containing result output and an error flag;
  - malformed JSON, unsupported protocol versions, wrong message kinds, empty IDs, and unrelated stderr lines returning `undefined`;
  - round-trip serialization preserving JSON-safe values.
- [ ] Add a failing `src/test/acp-transport.test.ts` case where a child writes a valid readiness marker, then writes a bridge tool line after readiness; assert the callback receives the later line and `ready` still resolves once.
- [ ] Run only the new protocol and transport tests and verify they fail for the intended missing parser/lifecycle behavior.
- [ ] **Implement the minimum protocol.** Add strict bridge message types and `serializeDshBridgeToolMessage` / `parseDshBridgeToolLine` in `bridge-protocol.ts`. Keep the readiness marker unchanged for compatibility.
- [ ] Change `spawnAcpAgent` so readiness settlement stops the readiness timer but does not close the stderr reader when continued stderr callbacks are requested. Continue sending non-readiness lines to `onStderrLine` after the process is ready; close the reader only in `dispose` or process exit.
- [ ] Re-run the targeted tests and then `npm run lint` for the changed files.

### Step 2: Make DSH a concrete backend while preserving shared ACP lifecycle code

- [ ] **Write failing tests first.** Add `src/test/dsh-backend.test.ts` asserting that:
  - the DSH registry entry constructs an instance whose `name` is `dsh`;
  - `createPipeline()` returns the DSH pipeline type/behavior rather than the generic ACP pipeline;
  - the DSH backend accepts the same dynamic target options provider used by the settings panel;
  - a bridge message is routed to the pipeline bound to its session ID.
- [ ] Run the focused test and confirm the current alias implementation fails these assertions.
- [ ] Add protected extension hooks to `AcpBackend` for local stderr lines and pipeline creation/registration without changing generic ACP behavior.
- [ ] Implement `DshBackend` in `src/backends/dsh/adapter.ts` as the concrete registered backend. Reuse ACP connection/session/permission primitives, but own DSH bridge parsing, session-scoped pipeline routing, and DSH pipeline construction.
- [ ] Replace the alias export in `src/backends/dsh/index.ts` with the concrete class and keep the backend id/vendor scoped to `dsh`.
- [ ] Re-run the focused backend tests and the existing backend registry/transition tests.

### Step 3: Build the optional DSH bridge plugin against DSH's presentation APIs

- [ ] **Write failing bridge contract tests or a Node-level fixture first.** Cover a mock Cordis context with `tools/pre-execute` and `tools/result` listeners, a tool definition exposing `presentCall` / `presentResult`, and assertions that the plugin emits exactly one structured stderr line per lifecycle event. Also cover presenter exceptions and tools without presenters, which must degrade to no bridge presentation without breaking the tool.
- [ ] Run the bridge fixture and confirm it fails because `dsh-bridge/index.mjs` currently emits only readiness.
- [ ] Implement the plugin listeners using DSH's public tool runtime shape:
  - `tools/pre-execute`: resolve the current tool definition and call `presentCall(exec.arguments)`;
  - `tools/result`: call `presentResult(exec.arguments, result)`;
  - include only JSON-safe fields (`sessionId`, `callId`, `rootCallId`, tool name, presentation view, error state);
  - emit through a single stderr writer with the versioned bridge prefix;
  - never emit to stdout and never block or change the tool decision/result.
- [ ] Update README and package metadata with installation, supported presentation cards, optional behavior, and the no-stdout guarantee.
- [ ] Run the bridge fixture and package inspection before connecting it to the ACPilot pipeline.

### Step 4: Add DSH presentation normalization and OpenCode-style SSP rendering

- [ ] **Write failing pipeline tests first.** In `src/test/dsh-pipeline.test.ts`, feed standard ACP events plus bridge messages for:
  - `pwsh` / terminal presentation with command, cwd, output, and exit code;
  - `read` presentation with a file location and line window;
  - `write` / `edit` diff presentation with one or more locations;
  - search presentation with file paths/results;
  - a custom generic card with a custom title and raw input;
  - bridge presentation arriving before or after the ACP `tool_call` update.
  Assert that the persisted `ToolInvocationSSP` state contains the stable original tool name, normalized input/output, presentation metadata, and correct terminal/resource data on render.
- [ ] Run the focused pipeline tests and confirm they fail while DSH messages are ignored.
- [ ] Implement `DshPipeline` as a concrete `AcpPipeline` specialization. Add a session-scoped pending presentation map keyed by tool call ID, merge pending bridge data when the ACP tool call appears, and apply result patches when either side arrives first.
- [ ] Normalize DSH presentation cards to the existing SSP vocabulary without hard-coding every user tool name:
  - terminal cards map to terminal tool-specific data and retain the original DSH name;
  - diff cards map to file-edit metadata and preserve all target paths/diffs;
  - read/search/resource cards map to VS Code links/resources;
  - generic cards retain title, kind, raw input, and output.
- [ ] Extend only the shared rendering seam needed by `ToolInvocationSSP` so the DSH metadata reaches VS Code's proposed `ChatToolInvocationPart`, with the current fallback rendering preserved when proposed APIs are unavailable.
- [ ] Re-run DSH pipeline and SSP tests, then the existing OpenCode and ACP pipeline tests to ensure the shared renderer has no regressions.

### Step 5: Wire DSH permission correlation into External Edit

- [ ] **Write failing tests first.** Add cases where:
  - DSH sends `tool_call` with `rawInput` and a bridge diff/location, then sends `request_permission` with only `toolCallId`;
  - the permission request arrives before the bridge presentation;
  - multiple file locations are present;
  - full-edit and non-interactive modes still wait for the baseline before auto-allowing;
  - completion/error updates close the external edit and retain output/error state.
  Assert that no approval UI bypasses the baseline and that the `ExternalEditSSP` receives all applicable URIs.
- [ ] Run the focused tests and verify the current generic ACP pipeline cannot resolve the DSH-only permission shape.
- [ ] Add DSH pipeline call-state correlation for title, kind, raw input, locations, and bridge presentation. Resolve edit paths from locations first, then normalized presentation diffs, then the existing generic path resolver.
- [ ] Route DSH file mutations through the existing `ExternalEditSSP` callbacks. Keep the DSH tool card hidden or marked as an external edit while the VS Code external edit lifecycle owns the visible edit/undo operation, matching OpenCode behavior.
- [ ] Re-run DSH pipeline, checkpoint/replay, streaming, and External Edit restore tests.

### Step 6: Integrate the extension target path and real DSH verification

- [ ] **Write failing integration assertions first.** Add a runtime/config test proving the DSH options provider still passes the configured command, args, launch directory, and bridge nonce, while a configured endpoint uses remote mode and does not require the local plugin.
- [ ] Route DSH stderr through the concrete backend hook; keep ordinary diagnostics in the output channel and structured messages in the bridge parser.
- [ ] Verify the real local command in `D:\dsh-mydsh\deepseek-harness` with the configured default arguments (`pnpm.cmd dsh --profile acp`) and the optional bridge installed/enabled. Run a prompt that invokes `pwsh` and a file edit. Capture the ACP and bridge traces and verify:
  - the model/tool card uses terminal/file/diff presentation;
  - permission waits for the External Edit baseline;
  - before/after snapshots and undo metadata are recorded;
  - the same target works without the bridge through ACP fallback.
- [ ] Verify an already-running endpoint path without spawning a new DSH process.
- [ ] Run the full validation suite: `npm test`, `npm run lint`, `npm run compile`, and `npm run test:runtime`.
- [ ] Inspect `git diff` and ensure `vscode-test-cli-0.0.15.tgz` and `vscode-test-electron-3.1.0.tgz` remain untracked and are not added.

### Step 7: Documentation and completion checks

- [ ] Update the DSH bridge README/spec notes with the concrete event schema, fallback behavior, and custom-tool presenter contract.
- [ ] Re-read this plan and check every acceptance criterion against code and test output.
- [ ] Run `git status --short`, `git diff --check`, and the complete tests again if any final documentation or protocol changes were made.
- [ ] Use the finishing-a-development-branch workflow only after verification confirms the implementation is complete.
