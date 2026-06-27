/**
 * Static declaration of built-in backends.
 *
 * VS Code's `chatSessions` and `languageModelChatProviders` are static
 * `contributes` in package.json — session types cannot be added at runtime.
 * So the set of backends is a fixed list declared here, consumed by
 * extension.ts at activation to loop-assemble per-backend BackendContexts.
 *
 * Adding a third backend requires:
 *   1. registerBackend(id, factory) side-effect import in this file
 *   2. a new entry in BUILTIN_BACKENDS
 *   3. matching chatSessions / languageModelChatProviders entries in package.json
 */

import './opencode/index'; // side-effect: registers 'opencode' backend
import { createBackend } from '../acp/backend-registry';
import type { AcpBackend } from '../acp/backend';

export interface BuiltinBackendDescriptor {
  /** Stable backend id, matches the chatSessions type suffix (e.g. 'opencode', 'acp') */
  readonly id: string;
  /** Chat session scheme, e.g. 'acpilot.opencode' / 'acpilot.acp' */
  readonly scheme: string;
  /** Language-model vendor ids this backend owns */
  readonly vendors: readonly string[];
  /** Factory that creates the backend instance from the registry */
  readonly factory: () => AcpBackend;
  /**
   * Whether this backend should be assembled given the current configuration.
   * Returns true by default; optional backends (e.g. remote ACP with no
   * configured endpoint) can skip registration.
   */
  readonly isEnabled?: () => boolean;
}

/**
 * The fixed set of built-in backends.
 *
 * NOTE: the 'acp' backend is declared here so the structure is in place, but
 * Phase 1 only assembles 'opencode'. The 'acp' entry is added once the ACP
 * backend implementation lands (Phase 5). Its presence here documents the
 * intended shape and keeps the loop generic.
 */
export const BUILTIN_BACKENDS: BuiltinBackendDescriptor[] = [
  {
    id: 'opencode',
    scheme: 'acpilot.opencode',
    vendors: ['opencode-cli', 'opencode-zen'],
    factory: () => createBackend('opencode'),
  },
];
