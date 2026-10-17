import { describe, expect, it } from 'vitest';
import { evictTerminalOperations } from '../runtime/operation-eviction';

interface Operation {
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  active?: boolean;
  startedAt: string;
  finishedAt?: string;
}

function operation(status: Operation['status'], minute: number): Operation {
  return {
    status,
    startedAt: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    finishedAt: status === 'starting' || status === 'running'
      ? undefined
      : `2026-01-01T00:${String(minute).padStart(2, '0')}:30.000Z`,
  };
}

describe('terminal operation eviction', () => {
  it('keeps active operations and removes the oldest terminal operations', () => {
    const operations = new Map<string, Operation>([
      ['old', operation('completed', 1)],
      ['new', operation('failed', 2)],
      ['active', operation('running', 3)],
    ]);

    evictTerminalOperations(operations, 2);

    expect([...operations.keys()]).toEqual(['new', 'active']);
    expect(operations.get('active')?.status).toBe('running');
  });

  it('does not evict active work when it alone exceeds capacity', () => {
    const operations = new Map<string, Operation>([
      ['active-1', operation('starting', 1)],
      ['active-2', operation('running', 2)],
    ]);

    evictTerminalOperations(operations, 1);

    expect([...operations.keys()]).toEqual(['active-1', 'active-2']);
  });

  it('does not evict cancelled work until its underlying task has settled', () => {
    const operations = new Map<string, Operation>([
      ['cancelled-active', { ...operation('cancelled', 1), active: true }],
      ['completed', operation('completed', 2)],
    ]);

    evictTerminalOperations(operations, 1);

    expect([...operations.keys()]).toEqual(['cancelled-active']);
  });
});
