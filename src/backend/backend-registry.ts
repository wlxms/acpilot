/**
 * Backend registry — maps backend IDs to factory functions.
 *
 * New backends register themselves via `registerBackend()`.
 * The extension entry point calls `createBackend(id)` to instantiate.
 *
 * @module
 */

import type { Backend } from './backend';

type BackendFactory = () => Backend;

const registry = new Map<string, BackendFactory>();

/**
 * Register a backend factory under the given ID.
 * Typically called as a side-effect import:
 * ```ts
 * import './backends/opencode'; // registers 'opencode'
 * ```
 */
export function registerBackend(id: string, factory: BackendFactory): void {
  registry.set(id, factory);
}

/**
 * Create a backend instance by ID.
 * Falls back to the first registered backend if `id` is not found.
 * Throws if no backends are registered.
 */
export function createBackend(id: string): Backend {
  const factory = registry.get(id);
  if (factory) {
    return factory();
  }

  // Fallback: use the first registered backend
  const first = registry.values().next();
  if (first.done) {
    throw new Error(`No backends registered (requested: "${id}")`);
  }
  return first.value();
}

/**
 * List all registered backend IDs.
 */
export function listBackendIds(): string[] {
  return Array.from(registry.keys());
}
