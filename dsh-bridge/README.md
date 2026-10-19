# ACPilot DSH bridge

`@wlxms/acpilot-dsh-bridge` is an optional DeepSeek Harness bundle plugin for ACPilot.

The official DSH `acp` profile remains the owner of stdout and ACP JSON-RPC. The bridge observes DSH's `tools/pre-execute` and `tools/result` events and writes versioned presentation messages to stderr. ACPilot merges those messages with the standard ACP tool lifecycle, so user-owned DSH tools can expose the same VS Code rendering path used by OpenCode:

- terminal cards for `bash`, `pwsh`, and other command tools;
- file links and line locations for reads and searches;
- search path and match resources;
- custom tool titles, categories, inputs, and outputs;
- diff presentations and the `ExternalEditSSP` baseline, after snapshot, and undo metadata flow.

Diff presentations use DSH's permission lifecycle. The bridge observes the
`tools/pre-execute` gate, emits the tool presentation, switches a `never` policy
to `ask` when ACPilot is attached, and delegates downstream policy listeners
before converting an allowed decision into `ask`. DSH then runs its normal
approval service before `tools/execute`; ACPilot's `full-edit` mode answers that
request automatically only after `ExternalEditSSP` has captured the baseline.
The bridge never writes the file and never replaces DSH's approval service.

When ACPilot starts a local DSH process, it generates a launcher patch that
imports this bridge by an absolute file URL. That works with a user-owned DSH
checkout, wrapper, custom command, and custom startup directory without changing
the profile's package list. Installing the package into a profile remains useful
for DSH processes started outside ACPilot. Already-running or remote ACP
endpoints expose standard ACP events without receiving this local stderr
bridge.

Install it into the user's DSH profile when the same presentation bridge should
also be active for DSH launches outside ACPilot:

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
