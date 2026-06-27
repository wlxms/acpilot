import { describe, expect, it, vi } from 'vitest';
import { applySessionTitle } from '../participant/session-title';
import type { ExtensionState, BackendContext } from '../types';

describe('applySessionTitle', () => {
  it('merges title updates so request details are preserved in session metadata', async () => {
    const updateMeta = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      id: 'opencode',
      scheme: 'acpilot.opencode',
      vendors: ['opencode-cli', 'opencode-zen'],
      backend: { name: 'opencode', sessions: { update: vi.fn() } },
      sessions: {
        get: vi.fn(),
        values: vi.fn(() => []),
      },
      sessionStore: {
        updateMeta,
      },
    } as unknown as BackendContext;
    const state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel: { appendLine: vi.fn() },
      bus: { emit: vi.fn() },
    } as unknown as ExtensionState;

    await applySessionTitle(state, ctx, {
      backendSessionId: 'ses-title-preserve',
      title: 'Real Title',
      source: 'backend',
    });

    expect(updateMeta).toHaveBeenCalledWith(
      'ses-title-preserve',
      expect.objectContaining({
        title: 'Real Title',
        titleSource: 'backend',
        backendName: 'opencode',
      }),
    );
    expect(updateMeta.mock.calls[0]?.[1]).not.toHaveProperty('requestDetails');
  });
});
