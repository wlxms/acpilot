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
import './reasonix/index'; // side-effect: registers 'reasonix' backend
import './dsh/index'; // side-effect: registers 'dsh' backend
import { createBackend } from '../backend/backend-registry';
import type { Backend } from '../backend/backend';

/** Host-side settings port supplied by the extension composition root. */
export interface BackendAssemblyContext {
  getBooleanSetting(section: string, key: string, defaultValue: boolean): boolean;
}

export interface BuiltinBackendDescriptor {
  /** Stable backend id, matches the chatSessions type suffix (e.g. 'opencode', 'acp') */
  readonly id: string;
  /** Human-readable display name shared by status/settings surfaces. */
  readonly displayName: string;
  /** Chat session scheme, e.g. 'acpilot.opencode' / 'acpilot.acp' */
  readonly scheme: string;
  /** Agent-session Language Model vendor owned by this backend. */
  readonly vendor: string;
  /** Factory that creates the backend instance from the registry */
  readonly factory: () => Backend;
  /** Whether activation should start this backend immediately. Defaults to true. */
  readonly autoStart?: boolean;
  /**
   * Whether this backend should be assembled given the current configuration.
   * Returns true by default; optional backends (e.g. remote ACP with no
   * configured endpoint) can skip registration.
   */
  readonly isEnabled?: (context: BackendAssemblyContext) => boolean;
}

/**
 * Validate the composition-root identity of a built-in backend.
 *
 * The descriptor is the source of the public Copilot vendor name while the
 * backend model provider is the source of the implementation capability. A
 * mismatch would publish models under one vendor and route them through a
 * different provider, so it is a startup configuration error rather than a
 * catalog refresh warning.
 */
export function assertBuiltinBackendAssembly(
  descriptor: BuiltinBackendDescriptor,
  backend: Backend,
): void {
  const providerVendor = backend.modelProvider?.vendor;
  if (providerVendor !== undefined && providerVendor !== descriptor.vendor) {
    throw new Error(
      `Backend "${descriptor.id}" vendor mismatch: descriptor="${descriptor.vendor}", `
        + `modelProvider="${providerVendor}".`,
    );
  }
}

/**
 * The fixed set of built-in backends.
 *
 * The 'acp' backend (standard Agent Client Protocol) is always assembled so
 * Settings can create the first user-managed remote ACP target. Starting it
 * without a selected target fails gracefully at the backend boundary.
 */
export const BUILTIN_BACKENDS: BuiltinBackendDescriptor[] = [
  {
    id: 'opencode',
    displayName: 'OpenCode',
    scheme: 'acpilot.opencode',
    vendor: 'opencode',
    factory: () => createBackend('opencode'),
  },
  {
    id: 'acp',
    displayName: 'ACP Agent',
    scheme: 'acpilot.acp',
    vendor: 'acp',
    factory: () => createBackend('acp'),
  },
  {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    scheme: 'acpilot.dsh',
    vendor: 'dsh',
    factory: () => createBackend('dsh'),
  },
  {
    id: 'reasonix',
    displayName: 'Reasonix',
    scheme: 'acpilot.reasonix',
    vendor: 'reasonix',
    factory: () => createBackend('reasonix'),
    autoStart: false,
    isEnabled: (context) => context.getBooleanSetting(
      'acpilot.backends.reasonix',
      'enabled',
      true,
    ),
  },
];
