/**
 * Settings state persistence — stores current agent/model selection in
 * VS Code globalState so that preferences survive extension reloads.
 *
 * Each backend's selection is persisted under a per-backend key so that
 * multiple backends can coexist without overwriting each other's choice.
 *
 * == Usage ==
 * ```
 * // On activation — hydrate selection store from persisted values
 * const persisted = loadPersistedSettingsState(context, backendId);
 * selection.hydrate(persisted);
 *
 * // After every user-initiated agent/model change — persist
 * savePersistedSettingsState(context, backendId, selection.get());
 * ```
 *
 * @module
 */

import type * as vscode from 'vscode';
import type { SelectionState } from '../backend/app-event-bus';
import type { PersistedSettingsState } from '../types';
import {
  isDshTarget,
  normalizeDshTarget,
  type DshTarget,
  type DshTargetInput,
} from '../backends/dsh/target';

/**
 * Settings state key, namespaced per backend so that each backend's
 * agent/model selection is persisted independently (no last-write-wins).
 */
const SETTINGS_STATE_KEY_PREFIX = 'acp.settingsState';
const ACP_TARGET_STATE_KEY = 'acp.remoteTargets.v1';
const ACP_TARGET_SECRET_PREFIX = 'acp.remoteTargetToken';
const DSH_TARGET_STATE_KEY = 'dsh.targets.v1';

function settingsStateKey(backendId: string): string {
  return `${SETTINGS_STATE_KEY_PREFIX}.${backendId}`;
}

export interface AcpRemoteTarget {
  id: string;
  name: string;
  endpoint: string;
  authToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcpTargetState {
  activeTargetId?: string;
  targets: AcpRemoteTarget[];
}

export interface AcpTargetInput {
  id?: string;
  name?: string;
  endpoint: string;
  authToken?: string;
}

export interface DshTargetState {
  activeTargetId?: string;
  targets: DshTarget[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read persisted settings state from VS Code globalState for a given backend
 * (returns empty SelectionState if none).
 *
 * There is deliberately no unscoped fallback: assigning one historical value
 * to multiple backends would violate backend isolation.
 */
export function loadPersistedSettingsState(
  context: vscode.ExtensionContext,
  backendId: string,
): SelectionState {
  const key = settingsStateKey(backendId);
  const persisted = context.globalState.get<PersistedSettingsState>(key) ?? {};
  // Map persisted selection fields to the backend-local selection state.
  return {
    agent: persisted.currentAgent,
    model: persisted.currentModel,
    modelDisplayName: persisted.currentModelDisplayName,
    permissionMode: persisted.currentPermissionMode,
  };
}

/**
 * Persist settings state to VS Code globalState (only defined fields are stored),
 * namespaced by backend id. Accepts SelectionState (from selection.get()) and
 * maps to stored field names.
 */
export function savePersistedSettingsState(
  context: vscode.ExtensionContext,
  backendId: string,
  state: SelectionState,
): void {
  const persisted: PersistedSettingsState = {
    currentAgent: state.agent,
    currentModel: state.model,
    currentModelDisplayName: state.modelDisplayName,
    currentPermissionMode: state.permissionMode,
  };
  context.globalState.update(settingsStateKey(backendId), persisted);
}

// ---------------------------------------------------------------------------
// ACP remote target persistence
// ---------------------------------------------------------------------------

export function loadAcpTargetState(context: vscode.ExtensionContext): AcpTargetState {
  const raw = context.globalState.get<Partial<AcpTargetState>>(ACP_TARGET_STATE_KEY);
  const targets = Array.isArray(raw?.targets)
    ? raw.targets
        .filter(isAcpRemoteTarget)
        .map(target => ({
          ...target,
          endpoint: target.endpoint.trim(),
          name: target.name.trim() || target.endpoint.trim(),
          authToken: undefined,
        }))
    : [];
  const activeTargetId = typeof raw?.activeTargetId === 'string'
    && targets.some(target => target.id === raw.activeTargetId)
    ? raw.activeTargetId
    : undefined;

  return { activeTargetId, targets };
}

export async function saveAcpTargetState(
  context: vscode.ExtensionContext,
  state: AcpTargetState,
): Promise<void> {
  const normalized: AcpTargetState = {
    activeTargetId: state.activeTargetId && state.targets.some(t => t.id === state.activeTargetId)
      ? state.activeTargetId
      : undefined,
    targets: state.targets.map(normalizeTarget),
  };
  await context.globalState.update(ACP_TARGET_STATE_KEY, normalized);
}

export function getActiveAcpTarget(context: vscode.ExtensionContext): AcpRemoteTarget | undefined {
  const state = loadAcpTargetState(context);
  return state.targets.find(target => target.id === state.activeTargetId);
}

export async function getActiveAcpTargetWithAuth(
  context: vscode.ExtensionContext,
): Promise<AcpRemoteTarget | undefined> {
  const target = getActiveAcpTarget(context);
  if (!target) {return undefined;}
  const authToken = await context.secrets.get(acpTargetSecretKey(target.id));
  return { ...target, authToken: authToken || undefined };
}

export async function upsertAcpTarget(
  context: vscode.ExtensionContext,
  input: AcpTargetInput,
  options?: { makeActive?: boolean },
): Promise<AcpRemoteTarget> {
  const state = loadAcpTargetState(context);
  const endpoint = normalizeEndpoint(input.endpoint);
  const now = new Date().toISOString();
  const existing = input.id
    ? state.targets.find(target => target.id === input.id)
    : undefined;
  const target: AcpRemoteTarget = {
    id: existing?.id ?? createTargetId(),
    name: (input.name ?? existing?.name ?? endpoint).trim() || endpoint,
    endpoint,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const index = state.targets.findIndex(item => item.id === target.id);
  if (index >= 0) {
    state.targets[index] = target;
  } else {
    state.targets.push(target);
  }
  if (options?.makeActive ?? !state.activeTargetId) {
    state.activeTargetId = target.id;
  }
  await saveAcpTargetState(context, state);
  if (input.authToken !== undefined) {
    const token = input.authToken.trim();
    if (token) {
      await context.secrets.store(acpTargetSecretKey(target.id), token);
    } else {
      await context.secrets.delete(acpTargetSecretKey(target.id));
    }
  }
  return target;
}

export async function removeAcpTarget(
  context: vscode.ExtensionContext,
  targetId: string,
): Promise<AcpTargetState> {
  const state = loadAcpTargetState(context);
  const targets = state.targets.filter(target => target.id !== targetId);
  const activeTargetId = state.activeTargetId === targetId
    ? targets[0]?.id
    : state.activeTargetId;
  const next = { activeTargetId, targets };
  await saveAcpTargetState(context, next);
  await context.secrets.delete(acpTargetSecretKey(targetId));
  return next;
}

export async function setActiveAcpTarget(
  context: vscode.ExtensionContext,
  targetId: string | undefined,
): Promise<AcpTargetState> {
  const state = loadAcpTargetState(context);
  if (targetId && !state.targets.some(target => target.id === targetId)) {
    throw new Error(`Unknown ACP target: ${targetId}`);
  }
  const next = { ...state, activeTargetId: targetId };
  await saveAcpTargetState(context, next);
  return next;
}

function isAcpRemoteTarget(value: unknown): value is AcpRemoteTarget {
  if (!value || typeof value !== 'object') {return false;}
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.endpoint === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string';
}

function normalizeTarget(target: AcpRemoteTarget): AcpRemoteTarget {
  const endpoint = normalizeEndpoint(target.endpoint);
  return {
    ...target,
    endpoint,
    name: target.name.trim() || endpoint,
  };
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new Error('ACP endpoint is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('ACP endpoint must be a valid WebSocket URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('ACP endpoint must use ws:// or wss://');
  }
  return trimmed;
}

function createTargetId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return `acp-${g.crypto.randomUUID()}`;
  }
  return `acp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function acpTargetSecretKey(targetId: string): string {
  return `${ACP_TARGET_SECRET_PREFIX}.${targetId}`;
}
// ---------------------------------------------------------------------------
// DeepSeek Harness target persistence
// ---------------------------------------------------------------------------

export function loadDshTargetState(context: vscode.ExtensionContext): DshTargetState {
  const raw = context.globalState.get<Partial<DshTargetState>>(DSH_TARGET_STATE_KEY);
  const targets = Array.isArray(raw?.targets)
    ? raw.targets.flatMap(target => {
      if (!isDshTarget(target)) {return [];}
      // Targets were normalized before persistence. Keep their timestamps
      // stable while loading; normalizing here would rewrite updatedAt on every
      // settings panel refresh.
      return [target];
    })
    : [];
  const activeTargetId = typeof raw?.activeTargetId === 'string'
    && targets.some(target => target.id === raw.activeTargetId)
    ? raw.activeTargetId
    : undefined;
  return { activeTargetId, targets };
}

export async function saveDshTargetState(
  context: vscode.ExtensionContext,
  state: DshTargetState,
): Promise<void> {
  const targets = state.targets.map(target => normalizeDshTarget(target));
  const normalized: DshTargetState = {
    activeTargetId: state.activeTargetId && targets.some(target => target.id === state.activeTargetId)
      ? state.activeTargetId
      : undefined,
    targets,
  };
  await context.globalState.update(DSH_TARGET_STATE_KEY, normalized);
}

export function getActiveDshTarget(context: vscode.ExtensionContext): DshTarget | undefined {
  const state = loadDshTargetState(context);
  return state.targets.find(target => target.id === state.activeTargetId);
}

export async function upsertDshTarget(
  context: vscode.ExtensionContext,
  input: DshTargetInput,
  options?: { makeActive?: boolean },
): Promise<DshTarget> {
  const state = loadDshTargetState(context);
  const existing = input.id ? state.targets.find(target => target.id === input.id) : undefined;
  const target = normalizeDshTarget(input, existing);
  const index = state.targets.findIndex(item => item.id === target.id);
  if (index >= 0) {
    state.targets[index] = target;
  } else {
    state.targets.push(target);
  }
  if (options?.makeActive ?? !state.activeTargetId) {
    state.activeTargetId = target.id;
  }
  await saveDshTargetState(context, state);
  return target;
}

export async function removeDshTarget(
  context: vscode.ExtensionContext,
  targetId: string,
): Promise<DshTargetState> {
  const state = loadDshTargetState(context);
  const targets = state.targets.filter(target => target.id !== targetId);
  const activeTargetId = state.activeTargetId === targetId
    ? targets[0]?.id
    : state.activeTargetId;
  const next = { activeTargetId, targets };
  await saveDshTargetState(context, next);
  return next;
}

export async function setActiveDshTarget(
  context: vscode.ExtensionContext,
  targetId: string | undefined,
): Promise<DshTargetState> {
  const state = loadDshTargetState(context);
  if (targetId && !state.targets.some(target => target.id === targetId)) {
    throw new Error('Unknown DSH target: ' + targetId);
  }
  const next = { ...state, activeTargetId: targetId };
  await saveDshTargetState(context, next);
  return next;
}
