import { randomUUID } from 'node:crypto';

export const DSH_BRIDGE_PLUGIN_NAME = '@wlxms/acpilot-dsh-bridge';
export const DSH_BRIDGE_PROTOCOL = 1;
export const DSH_BRIDGE_MARKER_PREFIX = 'ACPILOT_DSH_BRIDGE_READY\t';
export const DSH_BRIDGE_TOOL_PREFIX = 'ACPILOT_DSH_BRIDGE_TOOL\t';
export const DSH_BRIDGE_DIAGNOSTIC_PREFIX = 'ACPILOT_DSH_BRIDGE_DIAGNOSTIC\t';
/** One-shot model metadata emitted by the bridge after the DSH LLM service is ready. */
export const DSH_BRIDGE_CATALOG_PREFIX = 'ACPILOT_DSH_BRIDGE_CATALOG\t';
/** Desktop's saved selection is separate from model capability defaults. */
export const DSH_DESKTOP_SAVED_SELECTION_PREFIX = 'ACPILOT_DSH_DESKTOP_SAVED_SELECTION\t';

export interface DshDesktopSavedSelection {
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  nonce: string;
  provider: string;
  model: string;
  reasoningEffort: string;
}

export interface DshBridgeReady {
  plugin: typeof DSH_BRIDGE_PLUGIN_NAME;
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  nonce: string;
}

/** Best-effort bridge diagnostics; never part of the ACP or tool protocol. */
export interface DshBridgeCatalogModel {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: Array<{ value: string; name: string; description?: string }>;
  defaultReasoningEffort?: string;
}

export interface DshBridgeCatalog {
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  models: DshBridgeCatalogModel[];
}
export interface DshBridgeDiagnostic {
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  event: string;
  [key: string]: unknown;
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

/** Actual event owner and Copilot scope when a managed child emits a tool. */
export interface DshBridgeAgentScope {
  agentSessionId?: string;
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
}

export interface DshBridgeToolCallMessage extends DshBridgeAgentScope {
  type: 'tool_call';
  protocol: typeof DSH_BRIDGE_PROTOCOL;
  sessionId: string;
  toolCallId: string;
  rootToolCallId: string;
  toolName: string;
  rawInput?: unknown;
  presentation: DshBridgePresentation;
}

export interface DshBridgeToolResultMessage extends DshBridgeAgentScope {
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

/** Accept only bounded saved-selection fields from this exact local launch. */
export function parseDshDesktopSavedSelectionLine(line: string, expectedNonce: string): DshDesktopSavedSelection | undefined {
  if (!boundedSelectionField(expectedNonce, 128) || line.length > 4096 || !line.startsWith(DSH_DESKTOP_SAVED_SELECTION_PREFIX)) {return undefined;}
  try {
    const value = JSON.parse(line.slice(DSH_DESKTOP_SAVED_SELECTION_PREFIX.length)) as unknown;
    if (!isRecord(value) || value.protocol !== DSH_BRIDGE_PROTOCOL || value.nonce !== expectedNonce
      || !boundedSelectionField(value.provider, 1024) || !boundedSelectionField(value.model, 1024)
      || !boundedSelectionField(value.reasoningEffort, 128)) {return undefined;}
    return { protocol: DSH_BRIDGE_PROTOCOL, nonce: expectedNonce, provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort };
  } catch {
    return undefined;
  }
}

function boundedSelectionField(value: unknown, maximum: number): value is string {
  return nonEmptyString(value) && value.length <= maximum && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
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
      || !nonEmptyString(value.toolName)
      || (value.agentSessionId !== undefined && !nonEmptyString(value.agentSessionId))
      || (value.subAgentInvocationId !== undefined && !nonEmptyString(value.subAgentInvocationId))
      || (value.parentSubAgentInvocationId !== undefined && (!nonEmptyString(value.parentSubAgentInvocationId)
        || value.parentSubAgentInvocationId === value.subAgentInvocationId))) {
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

export function serializeDshBridgeCatalog(catalog: DshBridgeCatalog): string {
  return `${DSH_BRIDGE_CATALOG_PREFIX}${JSON.stringify(catalog)}`;
}

/** Parse only a complete model-capability catalog from the bridge. */
export function parseDshBridgeCatalogLine(line: string): DshBridgeCatalog | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DSH_BRIDGE_CATALOG_PREFIX)) {return undefined;}
  try {
    const value = JSON.parse(trimmed.slice(DSH_BRIDGE_CATALOG_PREFIX.length)) as unknown;
    if (!isRecord(value) || value.protocol !== DSH_BRIDGE_PROTOCOL || !Array.isArray(value.models)) {
      return undefined;
    }
    const models: DshBridgeCatalogModel[] = [];
    for (const item of value.models) {
      if (!isRecord(item)
          || !nonEmptyString(item.provider)
          || !nonEmptyString(item.model)
          || !nonEmptyString(item.name)) {
        return undefined;
      }
      const efforts = Array.isArray(item.reasoningEfforts)
        ? item.reasoningEfforts.filter((effort): effort is { value: string; name: string; description?: string } =>
            isRecord(effort) && nonEmptyString(effort.value) && nonEmptyString(effort.name))
        : undefined;
      models.push({
        provider: item.provider,
        model: item.model,
        name: item.name,
        ...(positiveInteger(item.contextWindow) ? { contextWindow: item.contextWindow } : {}),
        ...(positiveInteger(item.maxOutputTokens) ? { maxOutputTokens: item.maxOutputTokens } : {}),
        ...(efforts?.length ? { reasoningEfforts: efforts } : {}),
        ...(nonEmptyString(item.defaultReasoningEffort)
          ? { defaultReasoningEffort: item.defaultReasoningEffort }
          : {}),
      });
    }
    return { protocol: DSH_BRIDGE_PROTOCOL, models };
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
/** Parse one bridge diagnostic line for the backend log. */
export function parseDshBridgeDiagnosticLine(line: string): DshBridgeDiagnostic | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DSH_BRIDGE_DIAGNOSTIC_PREFIX)) {return undefined;}
  try {
    const value = JSON.parse(trimmed.slice(DSH_BRIDGE_DIAGNOSTIC_PREFIX.length)) as unknown;
    if (!isRecord(value)
      || value.protocol !== DSH_BRIDGE_PROTOCOL
      || !nonEmptyString(value.event)) {
      return undefined;
    }
    return value as unknown as DshBridgeDiagnostic;
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
