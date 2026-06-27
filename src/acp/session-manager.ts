/**
 * Unified session mapping between VSCode chat sessions and backend sessions.
 *
 * Consolidates the `sessionMap` and session create/rewind/migrate logic
 * from handler.ts and stable-participant.ts into a single class.
 *
 * Phase 1 provides basic session CRUD and creation. Phase 2 will integrate
 * the full rewind/recovery logic from handler.ts.
 */

import type { AcpBackend } from './backend';
import type { AppEventBus } from './app-event-bus';
import type { TurnMapping } from '../types';

// ===========================================================================
// Session state (per VSCode chat panel)
// ===========================================================================

export interface SessionState {
  /** Real backend session ID, e.g. an OpenCode session ID. */
  backendSessionId: string;
  /** Mapping of VSCode chat turns to backend message IDs */
  turnMap: TurnMapping[];
  /** Optional human-readable title */
  title?: string;
  /** When the session was created */
  createdAt?: Date;
  /** Where the current title came from. */
  titleSource?: import('./serializable/types').SessionTitleSource;
  /** True when the title is only a UI placeholder derived before generation. */
  provisionalTitle?: boolean;
}

// ===========================================================================
// Session manager
// ===========================================================================

export class SessionManager {
  /** Maps VSCode chat session ID → backend session state */
  private sessionMap = new Map<string, SessionState>();

  constructor(
    private readonly backend: AcpBackend,
    private readonly bus: AppEventBus,
    private readonly backendId: string,
  ) {}

  // -- read ---------------------------------------------------------------

  /**
   * Get the session state for a VSCode chat session.
   * Returns `undefined` if no mapping exists.
   */
  get(vscodeSessionId: string): SessionState | undefined {
    return this.sessionMap.get(vscodeSessionId);
  }

  /**
   * Check if a VSCode chat session has a mapped backend session.
   */
  has(vscodeSessionId: string): boolean {
    return this.sessionMap.has(vscodeSessionId);
  }

  /**
   * Iterate over all session states.
   */
  values(): IterableIterator<SessionState> {
    return this.sessionMap.values();
  }

  /**
   * Iterate over all session mappings.
   * Used when a provider resource needs to be reconciled with an already-live
   * VS Code chat resource for the same backend session.
   */
  entries(): IterableIterator<[string, SessionState]> {
    return this.sessionMap.entries();
  }

  // -- write --------------------------------------------------------------

  /**
   * Set the session state for a VSCode chat session.
   * Used for restore operations (e.g., from chat history metadata).
   */
  set(vscodeSessionId: string, state: SessionState): void {
    this.sessionMap.set(vscodeSessionId, state);
  }

  /**
   * Bind a second VS Code/resource key to an existing session state.
   * This keeps target switches from creating detached backend sessions.
   */
  bindAlias(sourceKey: string | undefined, targetKey: string | undefined): void {
    if (!sourceKey || !targetKey || sourceKey === targetKey) {
      return;
    }

    const existing = this.sessionMap.get(sourceKey);
    if (existing && !this.sessionMap.has(targetKey)) {
      this.sessionMap.set(targetKey, existing);
    }
  }

  /** Find a live state by real backend session id. */
  findByBackendSessionId(backendSessionId: string): { key: string; state: SessionState } | undefined {
    for (const [key, state] of this.sessionMap.entries()) {
      if (state.backendSessionId === backendSessionId) {
        return { key, state };
      }
    }
    return undefined;
  }

  /**
   * Get or create a backend session for a VSCode chat session.
   *
   * Returns the backend session ID, or `null` if creation failed.
   *
   * Handles:
   *  - Return existing mapping if one already exists
   *  - Creating a new backend session via `backend.sessions.create()`
   *  - Optional recovery from chat history metadata
   *  - Rewind/revert when chat history indicates a rewind
   *
   * @param vscodeSessionId  The VSCode chat session identifier.
   * @param directory        Optional working directory for the session.
   * @param recoveredState   Optional state recovered from chat history metadata.
   * @param currentTurnIndex Optional current turn index (used for rewind detection).
   */
  async getOrCreate(
    vscodeSessionId: string,
    directory?: string,
    recoveredState?: {
      backendSessionId: string | null;
      turnMap: TurnMapping[];
    },
    currentTurnIndex?: number,
  ): Promise<string | null> {
    // 1. If we already have a mapping for this VSCode session, return it.
    const existing = this.sessionMap.get(vscodeSessionId);
    if (existing && !recoveredState) {
      return existing.backendSessionId;
    }

    // 2. Recovery from chat history metadata
    if (recoveredState?.backendSessionId) {
      const state: SessionState = {
        backendSessionId: recoveredState.backendSessionId,
        turnMap: recoveredState.turnMap ?? [],
      };
      this.sessionMap.set(vscodeSessionId, state);
      this.bus.emit('session-list-changed', { backendId: this.backendId });
      return state.backendSessionId;
    }

    // 3. Create a new backend session
    const result = await this.backend.sessions.create({ directory });
    if (!result.data) {
      return null;
    }

    const state: SessionState = {
      backendSessionId: result.data.id,
      turnMap: [],
      title: result.data.title,
      createdAt: result.data.createdAt,
    };
    this.sessionMap.set(vscodeSessionId, state);
    this.bus.emit('session-list-changed', { backendId: this.backendId });
    return state.backendSessionId;
  }

  /**
   * Migrate a session mapping from one VSCode session ID to another.
   * Used when the session target changes (e.g., a new chat panel takes over).
   * The source key is removed after migration.
   */
  migrate(fromKey: string, toKey: string): void {
    const state = this.sessionMap.get(fromKey);
    if (state) {
      this.sessionMap.set(toKey, state);
      this.sessionMap.delete(fromKey);
      this.bus.emit('session-list-changed', { backendId: this.backendId });
    }
  }
}
