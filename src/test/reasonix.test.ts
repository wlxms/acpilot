import { describe, expect, it } from 'vitest';
import { createReasonixBackendOptions } from '../backends/reasonix';

describe('Reasonix backend options', () => {
  it('provides deterministic ACP defaults without reading host APIs', () => {
    expect(createReasonixBackendOptions()).toMatchObject({
      name: 'reasonix',
      clientName: 'acpilot-reasonix-backend',
      local: { command: 'npx', args: ['-y', 'reasonix', 'acp'] },
    });
  });

  it('preserves host-supplied command and argument configuration', () => {
    expect(createReasonixBackendOptions({
      command: 'reasonix-bin',
      args: ['acp', '--stdio'],
    }).local).toEqual({
      command: 'reasonix-bin',
      args: ['acp', '--stdio'],
    });
  });

  it('falls back to the default command when the configured command is blank', () => {
    expect(createReasonixBackendOptions({ command: '  ' }).local?.command).toBe('npx');
  });
});
