import type * as vscode from 'vscode';
import type { Backend } from '../backend/backend';
import type { StatusBarManager } from '../statusbar';
import type { SelectionStore } from '../backend/selection-store';
import type { SessionManager } from '../backend/session-manager';
import type { SessionStore } from '../backend/streaming/session-store';
import type { SessionTitleSource } from '../backend/serializable/types';
import type { CopilotModelCatalog } from '../surfaces/vscode/model-catalog';
import type { AppEventBus } from '../backend/app-event-bus';
import type { PermissionMode } from '../backend/types';

/** Info about a conversation session extracted from SDK response */
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: Date;
}

/**
 * Per-backend runtime context.
 *
 * Each registered backend gets its own isolated state: a backend instance,
 * its own selection/session/sessionStore, and the scheme + vendor it owns.
 * Surfaces (participant, session provider, LM provider) are registered
 * per-context and route via closure-captured ctx rather than a global backend.
 */
export interface BackendContext {
  /** Stable backend id, matches package.json chatSessions type suffix (e.g. 'opencode', 'acp') */
  readonly id: string;
  /** Active backend instance identity. Remote ACP targets use `acp:<targetId>`. */
  instanceKey: string;
  /** Incremented before replacing or restarting the active backend runtime. */
  runtimeGeneration: number;
  /** False while the composition root is switching this context's runtime. */
  acceptingRequests: boolean;
  /** Filesystem-safe namespace corresponding to `instanceKey`. */
  storageNamespace: string;
  /** Human-readable backend label used by status/settings surfaces. */
  readonly displayName: string;
  /** Chat session scheme, e.g. 'acpilot.opencode' / 'acpilot.acp' */
  readonly scheme: string;
  /** Agent-session vendor namespace owned by this backend. */
  readonly vendor: string;
  /** The ACP-compatible backend instance */
  readonly backend: Backend;
  /** Centralised agent/model selection state (per-backend, namespaced) */
  selection: SelectionStore;
  /** Centralised session mapping (per-backend) */
  sessions: SessionManager;
  /** Filesystem-backed persistent session store (path namespaced by id) */
  sessionStore: SessionStore;
}

/** Tracks the mapping between VSCode chat turns and backend message IDs */
export interface TurnMapping {
  /** 0-based index of the VSCode user turn */
  vscodeTurn: number;
  /** Corresponding backend message ID */
  messageId: string;
}

/** Per-VSCode-chat session state (one per VSCode chat panel) */
export interface SessionState {
  /** Real backend session id, e.g. an OpenCode session id. */
  backendSessionId: string;
  turnMap: TurnMapping[];
  title?: string;
  createdAt?: Date;
  titleSource?: SessionTitleSource;
  provisionalTitle?: boolean;
}

// ===========================================================================
// Persisted settings state (stored in VS Code globalState)
// ===========================================================================

/** Shape of settings state persisted in VS Code globalState (survives extension reloads) */
export interface PersistedSettingsState {
  /** Persisted agent selection (undefined = use backend default) */
  currentAgent?: string;
  /** Persisted model selection (undefined = use backend default or agent default) */
  currentModel?: { providerID: string; modelID: string };
  /** Persisted model display name for status bar / UI */
  currentModelDisplayName?: string;
  /** Permission scope for the next Agent request. */
  currentPermissionMode?: PermissionMode;
}

/** Global extension state shared across modules */
export interface ExtensionState {
  /** All assembled backend contexts, keyed by backend id (e.g. 'opencode', 'acp') */
  backends: Map<string, BackendContext>;
  /** Copilot model catalog aggregated from backend-owned model providers. */
  modelCatalog: CopilotModelCatalog;
  /** Output channel for logging */
  outputChannel: vscode.OutputChannel;
  /** Status bar controller (shows backend / agent / model) */
  statusBar: StatusBarManager;
  /** Application-level typed event bus (channel-scoped by backendId) */
  bus: AppEventBus;
}
