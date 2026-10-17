import { describe, expect, it, vi } from 'vitest';
import { AppEventBus } from '../backend/app-event-bus';
import { beginBackendRuntimeTransition } from '../runtime/backend-transition';
import type { BackendContext } from '../types';

describe('backend runtime transition', () => {
  it('invalidates synchronously and advances every queued transition', () => {
    const ctx = {
      id: 'acp',
      instanceKey: 'acp:target-a',
      runtimeGeneration: 4,
      acceptingRequests: true,
    } as BackendContext;
    const bus = new AppEventBus();
    const changing = vi.fn();
    bus.on('backend-runtime-changing', changing);

    const first = beginBackendRuntimeTransition(ctx, bus);
    const second = beginBackendRuntimeTransition(ctx, bus);

    expect(first).toBe(5);
    expect(second).toBe(6);
    expect(ctx.runtimeGeneration).toBe(6);
    expect(ctx.acceptingRequests).toBe(false);
    expect(changing.mock.calls).toEqual([
      [{ backendId: 'acp', runtimeGeneration: 5, instanceKey: 'acp:target-a' }],
      [{ backendId: 'acp', runtimeGeneration: 6, instanceKey: 'acp:target-a' }],
    ]);
  });
});
