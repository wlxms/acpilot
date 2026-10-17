/**
 * Optional ACPilot bridge plugin for DeepSeek Harness.
 *
 * DSH's official ACP profile already speaks ACP directly. This plugin adds a
 * nonce-bound readiness marker and a future service extension point without
 * taking ownership of ACP stdout or changing the user's profile behavior.
 */

export const name = 'acpilot-dsh-bridge';
export const inject = [];
export const ACPILOT_DSH_BRIDGE_SERVICE = 'acpilotDshBridge';
export const ACPILOT_DSH_BRIDGE_PROTOCOL = 1;
export const ACPILOT_DSH_BRIDGE_PLUGIN = '@wlxms/acpilot-dsh-bridge';

export function apply(ctx) {
  const nonce = process.env.ACPILOT_DSH_BRIDGE_NONCE;
  if (!nonce) {
    return;
  }

  const ready = {
    plugin: ACPILOT_DSH_BRIDGE_PLUGIN,
    protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
    nonce,
  };
  // ACP owns stdout. Readiness and diagnostics belong on stderr only.
  process.stderr.write(`ACPILOT_DSH_BRIDGE_READY\t${JSON.stringify(ready)}\n`);

  if (typeof ctx?.provide === 'function') {
    ctx.provide(ACPILOT_DSH_BRIDGE_SERVICE, Object.freeze({
      plugin: ACPILOT_DSH_BRIDGE_PLUGIN,
      protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      nonce,
    }));
  }
}
