/** DeepSeek Harness ACP backend. */

import { registerBackend } from '../../backend/backend-registry';
import { DshBackend } from './adapter';

export { DshBackend } from './adapter';
export type { DshBackendOptions } from './adapter';
export { DshPipeline } from './pipeline';

registerBackend('dsh', () => new DshBackend());
