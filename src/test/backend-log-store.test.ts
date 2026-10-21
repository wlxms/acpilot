import { describe, expect, it, vi } from 'vitest';
import { BackendLogStore } from '../backend/log-store';

describe('BackendLogStore', () => {
  it('preserves multiline installer output as separate log lines', () => {
    const store = new BackendLogStore();

    store.append('dsh', 'installing\nadded 42 packages\ncompletion: ok');

    expect(store.snapshot()).toEqual({
      dsh: ['installing', 'added 42 packages', 'completion: ok'],
    });
  });
  it('keeps bounded per-backend lines and notifies listeners', () => {
    const store = new BackendLogStore(2);
    const listener = vi.fn();
    const dispose = store.onChange(listener);

    store.append('dsh', 'first');
    store.append('dsh', 'second');
    store.append('dsh', 'third');
    store.append('opencode', 'server started');

    expect(store.snapshot()).toEqual({
      dsh: ['second', 'third'],
      opencode: ['server started'],
    });
    expect(listener).toHaveBeenCalledTimes(4);

    store.append('dsh', 'installation output', false);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.snapshot().dsh).toEqual(['third', 'installation output']);

    dispose();
    store.append('dsh', 'after dispose');
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('keeps multiline operation output readable and can snapshot one backend', () => {
    const store = new BackendLogStore(10);

    store.append('dsh', 'npm WARN old\nadded 1 package\n');
    store.append('opencode', 'server started');

    expect(store.snapshot()).toEqual({
      dsh: ['npm WARN old', 'added 1 package'],
      opencode: ['server started'],
    });
    expect(store.snapshot('dsh')).toEqual({
      dsh: ['npm WARN old', 'added 1 package'],
    });
    expect(store.snapshot('opencode')).toEqual({
      opencode: ['server started'],
    });
  });
});
