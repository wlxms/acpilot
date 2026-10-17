# DeepSeek Harness Agent and User-Owned Runtime Specification

**Date:** 2026-10-17

**Goal:** Add a first-class DeepSeek Harness Agent to ACPilot while always launching the user's own DSH command and startup directory, with explicit DSH installation from Settings and an optional bridge extension point.

## User-visible behavior

ACPilot exposes a `DeepSeek Harness` chat session and a dedicated `dsh` language-model vendor. DSH targets are named, persisted configurations. Each target stores the executable command, raw argument list, DSH process startup directory, and optional package installation directory/specification.

The DSH runtime is never selected from ACPilot's bundled dependencies. A target launches exactly the configured command. The target's `launchCwd` controls DSH's own source tree, dependencies, profile files, and installed plugins. The VS Code workspace directory remains a separate ACP session `cwd`.

Settings provides explicit actions:

- Install DSH: install `@deepseek-ai/dsh@latest` into the selected installation directory using the user's local npm executable.
- Update DSH: repeat the same package install operation so the selected package spec is resolved again.

After a successful DSH install, ACPilot can populate the target command with the local executable path (`node_modules/.bin/dsh.cmd` on Windows or `node_modules/.bin/dsh` elsewhere). Users can replace it with a modified executable or script at any time.

## Architecture

ACPilot owns a `dsh` backend that reuses the existing ACP session adapter. The backend creates a local ACP process using the target's command, args, and launchCwd. The optional DSH bridge plugin runs inside the user's DSH process and exposes a small future extension point. It emits a nonce-bound readiness marker on stderr when enabled; stdout remains exclusively ACP JSON-RPC.

The ACPilot process continues to accept a normal DSH ACP profile without requiring the bridge marker. If the optional marker appears, ACPilot recognizes its plugin and protocol identity while ordinary DSH stderr remains out-of-band. It does not inspect DSH internals, import DSH packages, or assume a package-manager command. The current data plane stays standard ACP.

## Stable identifiers

- Backend id: `dsh`
- Vendor: `dsh`
- Chat session type: `acpilot.dsh`
- Bridge plugin name: `@wlxms/acpilot-dsh-bridge`
- Bridge protocol: `acpilot-dsh-bridge/1`
- Readiness line prefix: `ACPILOT_DSH_BRIDGE_READY\t`

## Bridge contract

The plugin emits its optional readiness payload only when `ACPILOT_DSH_BRIDGE_NONCE` is present. It writes exactly one JSON payload to stderr after ACP handlers are installed:

```json
{"plugin":"@wlxms/acpilot-dsh-bridge","protocol":1,"nonce":"<launch nonce>"}
```

ACPilot does not require this marker for startup. When present, the marker is parsed as an optional extension signal; missing, malformed, or mismatched markers do not prevent a standard DSH ACP profile from starting. ACP stdout is not interpreted as a DSH event stream; it is parsed only by the existing ACP JSON-RPC client.

## Installation rules

The DSH installer executes the user's local npm command (`npm.cmd` on Windows, `npm` elsewhere) with an absolute `--prefix` directory. No install action runs on activation or backend start; Install and Update are explicit Settings actions. A first-time install can fill the target command with the discovered local launcher, while an existing target keeps its configured command.

The optional bridge package does not modify DSH profile files. Users can install and enable it in their own DSH profile when they need the future extension point.

## Error behavior

- Empty command or non-absolute `launchCwd` is rejected before saving a target.
- A missing executable or wrong profile reports the captured startup error in the Settings notification and output channel.
- DSH install/update failures preserve the target configuration and show npm's stderr in the output channel.
- Stopping or replacing a DSH target terminates only the process owned by that target runtime.

## Scope boundaries

This feature does not add a second DSH-specific model protocol. Model discovery, model selection, prompts, streaming, permissions, cancellation, session persistence, and image attachments use the current ACP adapter. The feature does not automatically modify user DSH source, profiles, plugins, or credentials.

## Verification

The implementation must include unit tests for target persistence/validation, install command construction, local spawn cwd/env propagation, optional bridge readiness parsing, vendor/backend registration, and DSH settings message handling. Runtime smoke must verify the `dsh` backend is registered, remains scoped to vendor `dsh`, and stays unconfigured without starting a user process until a target is selected.
