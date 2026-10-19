import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  getActiveDshTarget,
  loadDshTargetState,
  removeDshTarget,
  saveDshTargetState,
  setActiveDshTarget,
  upsertDshTarget,
} from '../settings/state-persistence';
import { normalizeDshTarget, type DshTarget } from '../backends/dsh/target';

class TestMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.store.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? this.store.get(key) as T : defaultValue;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  setKeysForSync(_keys: readonly string[]): void {}
}

function context(): vscode.ExtensionContext {
  return {
    globalState: new TestMemento(),
    workspaceState: new TestMemento(),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event },
  } as unknown as vscode.ExtensionContext;
}

const base = {
  name: 'Local DSH',
  command: 'dsh.cmd',
  args: ['--profile', 'acpilot'],
  launchCwd: 'D:\\dsh',
};

describe('DeepSeek Harness target state', () => {
  it('normalizes a target without changing the user command or args', () => {
    expect(normalizeDshTarget({ ...base, name: '  Local DSH  ', command: '  dsh.cmd  ', args: ['--profile', 'acpilot'] })).toMatchObject({
      name: 'Local DSH',
      command: 'dsh.cmd',
      args: ['--profile', 'acpilot'],
      launchCwd: 'D:\\dsh',
      packageSpec: '@deepseek-ai/dsh@latest',
    });
  });

  it('rejects a blank command and relative startup directory', () => {
    expect(() => normalizeDshTarget({ ...base, command: '  ' })).toThrow('DSH command is required');
    expect(() => normalizeDshTarget({ ...base, launchCwd: 'relative-dsh' })).toThrow('DSH launch directory must be absolute');
  });

  it('round-trips named targets and repairs an unknown active target', async () => {
    const ctx = context();
    const target: DshTarget = normalizeDshTarget({ ...base, id: 'dsh-one' });
    await saveDshTargetState(ctx, { activeTargetId: 'missing', targets: [target] });

    const loaded = loadDshTargetState(ctx);
    expect(loaded.activeTargetId).toBeUndefined();
    expect(loaded.targets).toHaveLength(1);
    expect(loaded.targets[0]).toMatchObject({
      id: target.id,
      name: target.name,
      command: target.command,
      args: target.args,
      launchCwd: target.launchCwd,
      packageSpec: target.packageSpec,
    });
    expect(loaded.targets[0].createdAt).toEqual(expect.any(String));
    expect(loaded.targets[0].updatedAt).toEqual(expect.any(String));
    expect(getActiveDshTarget(ctx)).toBeUndefined();
  });

  it('upserts, activates, switches, and removes targets', async () => {
    const ctx = context();
    const first = await upsertDshTarget(ctx, { id: 'first', ...base }, { makeActive: true });
    const second = await upsertDshTarget(ctx, { id: 'second', ...base, name: 'Second', command: 'custom-dsh' }, { makeActive: false });

    expect(getActiveDshTarget(ctx)?.id).toBe(first.id);
    await setActiveDshTarget(ctx, second.id);
    expect(getActiveDshTarget(ctx)?.id).toBe(second.id);
    const next = await removeDshTarget(ctx, second.id);
    expect(next.activeTargetId).toBe(first.id);
    expect(next.targets).toHaveLength(1);
  });

  it('preserves a configured running ACP endpoint', () => {
    expect(normalizeDshTarget({ ...base, endpoint: 'ws://127.0.0.1:4318' })).toMatchObject({
      endpoint: 'ws://127.0.0.1:4318',
    });
  });

  it('rejects an endpoint that is not a WebSocket URL', () => {
    expect(() => normalizeDshTarget({ ...base, endpoint: 'http://127.0.0.1:4318' }))
      .toThrow('DSH endpoint must use ws:// or wss://');
  });

  it('clears an existing endpoint when the settings field is emptied', () => {
    const existing = normalizeDshTarget({ ...base, id: 'dsh-existing', endpoint: 'ws://127.0.0.1:4318' });
    expect(normalizeDshTarget({ ...base, id: existing.id, endpoint: '' }, existing).endpoint).toBeUndefined();
  });

  it('uses the official ACP profile when args are omitted', () => {
    expect(normalizeDshTarget({ ...base, args: undefined }).args).toEqual(['--profile', 'acp']);
  });
});
