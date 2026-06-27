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

import * as vscode from 'vscode';
import type { SelectionState } from '../backend/app-event-bus';
import type { PersistedSettingsState } from '../types';

/**
 * Settings state key, namespaced per backend so that each backend's
 * agent/model selection is persisted independently (no last-write-wins).
 */
const SETTINGS_STATE_KEY_PREFIX = 'acp.settingsState';

function settingsStateKey(backendId: string): string {
  return `${SETTINGS_STATE_KEY_PREFIX}.${backendId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read persisted settings state from VS Code globalState for a given backend
 * (returns empty SelectionState if none).
 *
 * Falls back to the legacy un-namespaced key on first read so that selections
 * persisted before per-backend namespacing are not lost.
 */
export function loadPersistedSettingsState(
  context: vscode.ExtensionContext,
  backendId: string,
): SelectionState {
  const key = settingsStateKey(backendId);
  let persisted = context.globalState.get<PersistedSettingsState>(key);
  // Backwards-compat: fall back to the legacy single-backend key once.
  if (persisted === undefined) {
    persisted = context.globalState.get<PersistedSettingsState>(SETTINGS_STATE_KEY_PREFIX) ?? {};
  } else {
    persisted = persisted ?? {};
  }
  // Map from stored field names (currentAgent/currentModel/currentModelDisplayName)
  // to SelectionState field names (agent/model/modelDisplayName)
  return {
    agent: persisted.currentAgent,
    model: persisted.currentModel,
    modelDisplayName: persisted.currentModelDisplayName,
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
  };
  context.globalState.update(settingsStateKey(backendId), persisted);
}
