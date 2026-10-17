/**
 * Application-level typed event bus for cross-module communication.
 *
 * Replaces optional function fields on ExtensionState (onBackendReady,
 * refreshSessionItems, etc.) with a clean pub/sub pattern.
 *
 * No external dependencies — purely a TypeScript generic event emitter.
 */

import type { BackendSessionStatus, PermissionMode } from './types';

// ===========================================================================
// Shared selection-state type (also re-exported from selection-store.ts)
// ===========================================================================

export interface SelectionState {
  agent?: string;
  model?: { providerID: string; modelID: string };
  modelDisplayName?: string;
  permissionMode?: PermissionMode;
}

// ===========================================================================
// Event map — every event name maps to its payload type
// ===========================================================================

export interface AppEventMap {
  /** Fired before a backend runtime is replaced or the extension deactivates. */
  'backend-runtime-changing': {
    backendId: string;
    runtimeGeneration: number;
    instanceKey: string;
  };
  /** Fired when a backend has completed startup and is ready for use */
  'backend-ready': { backendId: string };
  /** Fired when a backend's session list has changed (created, deleted, etc.) */
  'session-list-changed': { backendId: string };
  /** Fired when the user changes agent or model selection for a backend */
  'selection-changed': SelectionState & { backendId: string };
  /** Fired after the shared model catalog has been rebuilt for a backend. */
  'models-changed': { backendId: string };
  /** Fired when a specific session's status transitions (idle → busy → retry → idle) */
  'session-status-changed': { sessionId: string; status: BackendSessionStatus; backendId: string };
}

// ===========================================================================
// Typed event bus
// ===========================================================================

export class AppEventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  /**
   * Subscribe to an event.
   * Returns a dispose function that removes this specific handler.
   */
  on<K extends keyof AppEventMap>(
    event: K,
    handler: (payload: AppEventMap[K]) => void,
  ): () => void {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    const storedHandler = handler as (payload: unknown) => void;
    set.add(storedHandler);
    return () => {
      set?.delete(storedHandler);
    };
  }

  /**
   * Emit an event to all subscribed handlers.
   */
  emit<K extends keyof AppEventMap>(event: K, payload: AppEventMap[K]): void {
    const set = this.handlers.get(event as string);
    if (set) {
      for (const handler of set) {
        handler(payload);
      }
    }
  }

  /**
   * Remove all handlers.
   * Call on extension deactivate to prevent memory leaks.
   */
  dispose(): void {
    this.handlers.clear();
  }
}
