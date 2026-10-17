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

import { registerBackend } from '../../backend/backend-registry';
import { AcpBackend } from './adapter';

export { AcpBackend } from './adapter';
export { AcpPipeline } from './pipeline';
export type { AcpBackendOptions } from './adapter';

// Side-effect: register the 'acp' backend.
// The factory defers option-reading to activation so config changes between
// register-time and activate-time are respected.
registerBackend('acp', () => {
  return new AcpBackend();
});
