# ACPilot DSH bridge

`@wlxms/acpilot-dsh-bridge` is an optional DeepSeek Harness bundle plugin for ACPilot.

The official DSH `acp` profile remains the owner of stdout and ACP JSON-RPC. The bridge observes DSH's `tools/pre-execute` and `tools/result` events and writes versioned presentation messages to stderr. ACPilot merges those messages with the standard ACP tool lifecycle, so user-owned DSH tools can expose the same VS Code rendering path used by OpenCode:

- terminal cards for `bash`, `pwsh`, and other command tools;
- file links and line locations for reads and searches;
- search path and match resources;
- custom tool titles, categories, inputs, and outputs;
- diff presentations and the `ExternalEditSSP` baseline, after snapshot, and undo metadata flow.

The plugin is optional. A normal user-owned `dsh --profile acp` process works without it, and ACPilot still accepts an already-running DSH ACP endpoint through the standard ACP fallback path. Structured stderr bridge messages are available when ACPilot starts the local process; a remote or already-running endpoint exposes standard ACP events only.

Install it into the user's DSH profile when structured tool presentation is needed:

```text
dsh plugin --profile acp add @wlxms/acpilot-dsh-bridge
```

Restart the profile after changing the bundle list when HMR is disabled. ACPilot passes `ACPILOT_DSH_BRIDGE_NONCE` for local launches; when present, the plugin emits one readiness marker:

```text
ACPILOT_DSH_BRIDGE_READY\t{"plugin":"@wlxms/acpilot-dsh-bridge","protocol":1,"nonce":"..."}
```

Tool messages use the separate stderr prefix `ACPILOT_DSH_BRIDGE_TOOL\t` and have this shape:

```json
{
  "type": "tool_call",
  "protocol": 1,
  "sessionId": "...",
  "toolCallId": "...",
  "rootToolCallId": "...",
  "toolName": "read",
  "rawInput": {"path":"src/index.ts"},
  "presentation": {"card":"generic","title":"Read src/index.ts","kind":"read"}
}
```

`ToolDefinition.presentCall` and `ToolDefinition.presentResult` remain DSH-owned. The bridge forwards their JSON-safe return values without importing or modifying the user's tools. Unknown presentation fields are preserved by ACPilot for forward compatibility, while unsupported card types fall back to the normal ACP tool card.
