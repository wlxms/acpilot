/**
 * Reasonix backend module.
 *
 * Reasonix v2 exposes a standard Agent Client Protocol stdio agent through
 * `reasonix acp`. This backend is therefore a branded local ACP preset rather
 * than a separate protocol implementation.
 *
 * @module
 */

import { registerBackend } from '../../backend/backend-registry';
import { AcpBackend, type AcpBackendOptions } from '../acp';

export interface ReasonixBackendOptionsInput {
  command?: string;
  args?: readonly string[];
}

/** Build backend options from values supplied by the host composition root. */
export function createReasonixBackendOptions(
  input: ReasonixBackendOptionsInput = {},
): AcpBackendOptions {
  const command = input.command?.trim() || 'npx';
  const args = [...(input.args ?? ['-y', 'reasonix', 'acp'])];
  return {
    name: 'reasonix',
    clientName: 'acpilot-reasonix-backend',
    sessionTitlePrefix: 'Reasonix Session',
    missingOptionsMessage: 'Reasonix backend is disabled or missing a command. Configure acpilot.backends.reasonix.command.',
    local: command ? { command, args } : undefined,
  };
}

registerBackend('reasonix', () => new AcpBackend(createReasonixBackendOptions()));
