import { randomUUID } from 'node:crypto';

export const DSH_BRIDGE_PLUGIN_NAME = '@wlxms/acpilot-dsh-bridge';
export const DSH_BRIDGE_PROTOCOL = 1;
export const DSH_BRIDGE_MARKER_PREFIX = 'ACPILOT_DSH_BRIDGE_READY\t';

export interface DshBridgeReady {
  plugin: typeof DSH_BRIDGE_PLUGIN_NAME;
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  nonce: string;
}

export function createDshBridgeLaunchNonce(): string {
  return randomUUID().replace(/-/g, '');
}

export function serializeDshBridgeReady(nonce: string): string {
  return `${DSH_BRIDGE_MARKER_PREFIX}${JSON.stringify({
    plugin: DSH_BRIDGE_PLUGIN_NAME,
    protocol: DSH_BRIDGE_PROTOCOL,
    nonce,
  })}`;
}

export function parseDshBridgeReadyLine(line: string, expectedNonce?: string): DshBridgeReady | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DSH_BRIDGE_MARKER_PREFIX)) {return undefined;}
  try {
    const value = JSON.parse(trimmed.slice(DSH_BRIDGE_MARKER_PREFIX.length)) as Record<string, unknown>;
    if (value.plugin !== DSH_BRIDGE_PLUGIN_NAME
        || value.protocol !== DSH_BRIDGE_PROTOCOL
        || typeof value.nonce !== 'string'
        || value.nonce.length === 0
        || (expectedNonce !== undefined && value.nonce !== expectedNonce)) {
      return undefined;
    }
    return {
      plugin: DSH_BRIDGE_PLUGIN_NAME,
      protocol: DSH_BRIDGE_PROTOCOL,
      nonce: value.nonce,
    };
  } catch {
    return undefined;
  }
}
