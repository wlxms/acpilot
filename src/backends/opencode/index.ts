/**
 * OpenCode backend — self-registration entry point.
 *
 * Importing this module registers the OpenCode backend with the
 * backend registry as a side effect:
 * ```ts
 * import '../../backends/opencode'; // registers 'opencode'
 * ```
 */

import { registerBackend } from '../../backend/backend-registry';
import { OpenCodeBackend } from './adapter';

registerBackend('opencode', () => new OpenCodeBackend());
