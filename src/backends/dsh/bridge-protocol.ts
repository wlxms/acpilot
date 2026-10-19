import { randomUUID } from 'node:crypto';

export const DSH_BRIDGE_PLUGIN_NAME = '@wlxms/acpilot-dsh-bridge';
export const DSH_BRIDGE_PROTOCOL = 1;
export const DSH_BRIDGE_MARKER_PREFIX = 'ACPILOT_DSH_BRIDGE_READY\t';
export const DSH_BRIDGE_TOOL_PREFIX = 'ACPILOT_DSH_BRIDGE_TOOL\t';

export interface DshBridgeReady {
  plugin: typeof DSH_BRIDGE_PLUGIN_NAME;
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  nonce: string;
}

/**
 * DSH deliberately keeps the presentation vocabulary extensible. ACPilot only
 * interprets the cards it knows, while preserving unknown fields for future
 * bridge versions and custom user tools.
 */
export interface DshBridgePresentation {
  card: string;
  [key: string]: unknown;
}

export interface DshBridgeToolCallMessage {
  type: 'tool_call';
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  sessionId: string;
  toolCallId: string;
  rootToolCallId: string;
  toolName: string;
  rawInput?: unknown;
  presentation: DshBridgePresentation;
}

export interface DshBridgeToolResultMessage {
  type: 'tool_result';
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  sessionId: string;
  toolCallId: string;
  rootToolCallId: string;
  toolName: string;
  isError: boolean;
  output?: unknown;
  presentation?: DshBridgePresentation;
}

export type DshBridgeToolMessage = DshBridgeToolCallMessage | DshBridgeToolResultMessage;

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

/** Serialize one structured tool presentation to stderr's line protocol. */
export function serializeDshBridgeToolMessage(message: DshBridgeToolMessage): string {
  return `${DSH_BRIDGE_TOOL_PREFIX}${JSON.stringify(message)}`;
}

/** Parse only versioned, complete ACPilot DSH tool messages. */
export function parseDshBridgeToolLine(line: string): DshBridgeToolMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DSH_BRIDGE_TOOL_PREFIX)) {return undefined;}
  try {
    const value = JSON.parse(trimmed.slice(DSH_BRIDGE_TOOL_PREFIX.length)) as unknown;
    if (!isRecord(value)
      || value.protocol !== DSH_BRIDGE_PROTOCOL
      || (value.type !== 'tool_call' && value.type !== 'tool_result')
      || !nonEmptyString(value.sessionId)
      || !nonEmptyString(value.toolCallId)
      || !nonEmptyString(value.rootToolCallId)
      || !nonEmptyString(value.toolName)) {
      return undefined;
    }

    if (value.type === 'tool_call') {
      if (!isPresentation(value.presentation)) {return undefined;}
      return value as unknown as DshBridgeToolCallMessage;
    }

    if (typeof value.isError !== 'boolean') {return undefined;}
    if (value.presentation !== undefined && !isPresentation(value.presentation)) {return undefined;}
    return value as unknown as DshBridgeToolResultMessage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPresentation(value: unknown): value is DshBridgePresentation {
  return isRecord(value) && nonEmptyString(value.card);
}
