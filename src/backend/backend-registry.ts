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
 * import './backends/example'; // registers 'example'
 * ```
 */
export function registerBackend(id: string, factory: BackendFactory): void {
  registry.set(id, factory);
}

/**
 * Create a backend instance by ID.
 * Unknown IDs are configuration errors and must never route to another backend.
 */
export function createBackend(id: string): Backend {
  const factory = registry.get(id);
  if (factory) {
    return factory();
  }
  throw new Error(`Backend not registered: "${id}"`);
}

/**
 * List all registered backend IDs.
 */
export function listBackendIds(): string[] {
  return Array.from(registry.keys());
}
