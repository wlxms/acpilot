/** DeepSeek Harness ACP backend. */

import { registerBackend } from '../../backend/backend-registry';
import { AcpBackend } from '../acp/adapter';

export { AcpBackend as DshBackend } from '../acp/adapter';
export type { AcpBackendOptions as DshBackendOptions } from '../acp/adapter';

registerBackend('dsh', () => new AcpBackend({
  name: 'dsh',
  clientName: 'acpilot-dsh-backend',
  sessionTitlePrefix: 'DSH Session',
  missingOptionsMessage: 'No DSH target selected. Configure a DSH command in ACP Settings.',
}));
