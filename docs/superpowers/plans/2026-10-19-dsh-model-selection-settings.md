# DSH Model Selection and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DSH vendor visible before startup, start and discover it only after `Auto` is selected, and simplify the DSH settings panel around an explicit launch action.

**Architecture:** Keep backend-owned model discovery and the existing DSH target resolver. Add a host-level automatic model sentinel that is safe to list while stopped; resolve it at request time by starting the captured backend runtime and refreshing the central catalog. Reuse the same start-and-refresh operation for the settings model picker and DSH Start button.

**Tech Stack:** TypeScript, VS Code Language Model Chat Provider API, VS Code webview settings panel, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-dsh-model-selection-settings.md`

## Global Constraints

- Do not create a new worktree; continue in `C:\Users\Administrator\.codex\worktrees\dsh-agent-bridge\acpilot`.
- Preserve the existing DSH bridge permission and external-edit timing behavior.
- Preserve custom DSH command, startup directory, arguments, endpoint, install directory, package spec, and install/update actions.
- Model-information queries must not start stopped backends.

---

### Task 1: Automatic model sentinel and lazy request routing

**Files:**
- Modify: `src/surfaces/vscode/model-catalog.ts`
- Modify: `src/surfaces/vscode/language-model-provider.ts`
- Modify: `src/surfaces/vscode/model-types.ts` only if the public registration shape needs a sentinel marker
- Test: `src/test/language-model-provider.test.ts`
- Test: `src/test/language-model-provider-backend-route.test.ts`

- [ ] **Step 1: Write failing tests** for a stopped backend returning `Auto` without calling `start` or `listModels`, and for an Auto response starting the backend, refreshing the catalog, and invoking the resolved first model.
- [ ] **Step 2: Run the focused tests** and confirm they fail because the current provider starts during information lookup and cannot resolve the automatic model.
- [ ] **Step 3: Add exported automatic-model constants and helpers** with a vendor-scoped canonical ID.
- [ ] **Step 4: Change provider information lookup** to return `Auto` first, skip startup while stopped, and append discovered models only when the backend is already running.
- [ ] **Step 5: Add request-time automatic resolution** that starts the captured backend, refreshes the catalog, resolves the first current model for that backend instance, and reports startup/discovery failures clearly.
- [ ] **Step 6: Run the focused tests** and then the full model-provider test set.

### Task 2: Settings model fallback and DSH runtime actions

**Files:**
- Modify: `src/settings/panel.ts`
- Modify: `src/extension.ts`
- Modify: `src/settings/state-persistence.ts` only if the single active DSH configuration needs a compatibility helper
- Test: `src/test/settings-panel-readiness.test.ts`
- Test: `src/test/extension.test.ts` or a new focused settings/model test

- [ ] **Step 1: Write failing tests** asserting the settings source has no DSH Delete target control/message, includes Start DSH, and always renders an Auto model entry.
- [ ] **Step 2: Run the focused tests** and confirm they fail against the current panel and message union.
- [ ] **Step 3: Add shared settings data for DSH runtime status** and an extension-side start/refresh helper.
- [ ] **Step 4: Add `startDsh`/`stopDsh` handling** and make the settings model Auto path start the selected backend before selecting the discovered default model.
- [ ] **Step 5: Simplify the DSH panel** into status/basic launch fields/advanced fields, keep both directory selectors and install/update buttons, and remove the DSH Delete target control and handler.
- [ ] **Step 6: Run settings, extension, DSH, and model tests.

### Task 3: Integration verification and cleanup

**Files:**
- Modify: only files required by failing verification or type/lint errors
- Test: existing DSH bridge and runtime tests

- [ ] **Step 1: Run `npm test`.
- [ ] **Step 2: Run `npm run compile`, `npm run lint`, and `git diff --check`.
- [ ] **Step 3: Run the runtime smoke/listing path and verify the DSH vendor returns `Auto` while stopped and real models after startup.
- [ ] **Step 4: Review the diff for accidental changes to bridge permission, external edit, or custom DSH launch behavior.
