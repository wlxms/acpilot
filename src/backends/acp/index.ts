/**
 * ACP backend module — registers the standard-Agent-Client-Protocol backend.
 *
 * On import, this registers the 'acp' backend factory with the backend
 * registry. The factory reads connection options from VS Code configuration
 * (acpilot.backends.acp.*) and constructs an AcpBackend for either a local
 * spawned agent or a remote WebSocket endpoint.
 *
 * @module
 */

import * as vscode from 'vscode';
import { registerBackend } from '../../backend/backend-registry';
import { AcpBackend, type AcpBackendOptions } from './adapter';

export { AcpBackend } from './adapter';
export { AcpBridge } from './bridge';
export type { AcpBackendOptions } from './adapter';

/**
 * Build AcpBackendOptions from VS Code configuration for the 'acp' backend.
 * Returns undefined when the backend is not configured (skipping assembly).
 */
export function readAcpBackendOptions(): AcpBackendOptions | undefined {
  const config = vscode.workspace.getConfiguration('acpilot.backends.acp');
  const mode = config.get<'local' | 'remote'>('mode', 'remote');
  const endpoint = config.get<string>('endpoint', '');
  const authToken = config.get<string>('authToken', '');
  const command = config.get<string>('command', '');
  const args = config.get<string[]>('args', []);

  if (mode === 'remote') {
    if (!endpoint) {return undefined;}
    return { remote: { url: endpoint, authToken: authToken || undefined } };
  }

  // local mode
  if (!command) {return undefined;}
  return { local: { command, args } };
}

// Side-effect: register the 'acp' backend.
// The factory defers option-reading to activation so config changes between
// register-time and activate-time are respected.
registerBackend('acp', () => {
  const options = readAcpBackendOptions() ?? { remote: { url: '' } };
  return new AcpBackend(options);
});
