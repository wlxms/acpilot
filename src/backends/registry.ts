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
import './acp/index'; // side-effect: registers 'acp' backend
import { createBackend } from '../backend/backend-registry';
import type { Backend } from '../backend/backend';

export interface BuiltinBackendDescriptor {
  /** Stable backend id, matches the chatSessions type suffix (e.g. 'opencode', 'acp') */
  readonly id: string;
  /** Chat session scheme, e.g. 'acpilot.opencode' / 'acpilot.acp' */
  readonly scheme: string;
  /** Language-model vendor ids this backend owns */
  readonly vendors: readonly string[];
  /** Factory that creates the backend instance from the registry */
  readonly factory: () => Backend;
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
 * The 'acp' backend (standard Agent Client Protocol) is assembled only when a
 * connection is configured (local command or remote endpoint) — `isEnabled`
 * reads VS Code configuration and skips assembly when unset, so unconfigured
 * users see no ACP participant.
 */
export const BUILTIN_BACKENDS: BuiltinBackendDescriptor[] = [
  {
    id: 'opencode',
    scheme: 'acpilot.opencode',
    vendors: ['opencode-cli', 'opencode-zen'],
    factory: () => createBackend('opencode'),
  },
  {
    id: 'acp',
    scheme: 'acpilot.acp',
    vendors: ['acp'],
    factory: () => createBackend('acp'),
    // Lazy-read to avoid a static import cycle into the config layer.
    isEnabled: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode') as typeof import('vscode');
        const config = vscode.workspace.getConfiguration('acpilot.backends.acp');
        const mode = config.get<'local' | 'remote'>('mode', 'remote');
        if (mode === 'remote') {return Boolean(config.get<string>('endpoint', ''));}
        return Boolean(config.get<string>('command', ''));
      } catch {
        return false;
      }
    },
  },
];
