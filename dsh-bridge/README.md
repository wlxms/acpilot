# ACPilot DSH bridge

`@wlxms/acpilot-dsh-bridge` is an optional DeepSeek Harness bundle plugin for ACPilot.

The official DSH `acp` profile already provides the ACP JSON-RPC server, so ACPilot does not require this package to start a DSH target. When the plugin is present and `ACPILOT_DSH_BRIDGE_NONCE` is set, it writes a nonce-bound readiness marker to stderr and exposes a small Cordis service for future extensions.

The plugin never writes readiness data to stdout. DSH stdout stays reserved for ACP JSON-RPC messages.

Install it into a user-owned profile when you want the bridge extension point:

```text
dsh plugin --profile acp add @wlxms/acpilot-dsh-bridge
```

Restart the profile after changing the bundle list when HMR is disabled.
