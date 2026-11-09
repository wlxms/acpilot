import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDshLaunch, type DshResolverOptions } from '../backends/dsh/resolver';
import type { DshTarget } from '../backends/dsh/target';
import { repairMisplacedDshDesktopTarget } from '../settings/dsh-target-repair';
import { DSH_TARGET_STATE_KEY, loadDshTargetState } from '../settings/state-persistence';

class TestMemento implements vscode.Memento {
  readonly writes: Array<{ key: string; value: unknown }> = [];
  readonly values = new Map<string, unknown>();
  waitForWrite: () => Promise<void> = () => Promise.resolve();

  keys(): readonly string[] { return [...this.values.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }
  update(key: string, value: unknown): Thenable<void> {
    const saved = JSON.parse(JSON.stringify(value));
    this.writes.push({ key, value: saved });
    this.values.set(key, saved);
    return this.waitForWrite();
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(options: { active?: Partial<DshTarget>; missing?: 'executable' | 'archive'; noActive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acpilot-dsh-target-repair-'));
  roots.push(root);
  const desktop = join(root, 'DSH Desktop');
  const workspace = join(root, 'workspace');
  mkdirSync(join(desktop, 'resources'), { recursive: true });
  mkdirSync(workspace);
  if (options.missing !== 'executable') { writeFileSync(join(desktop, 'DSH Desktop.exe'), ''); }
  if (options.missing !== 'archive') { writeFileSync(join(desktop, 'resources', 'app.asar'), ''); }
  const active: DshTarget = {
    id: 'old-dsh-target', name: 'My DSH', command: 'dsh', args: ['--profile', 'acp'],
    launchCwd: desktop, installDirectory: join(root, 'managed-install'),
    packageSpec: '@deepseek-ai/dsh@1.2.3',
    createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
    ...options.active,
  };
  const inactive: DshTarget = {
    ...active, id: 'other-dsh-target', name: 'Keep my DSH', command: 'custom-dsh.cmd',
    args: ['--profile', 'custom'], launchCwd: join(root, 'other-workspace'),
    createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
  };
  const memento = new TestMemento();
  memento.values.set(DSH_TARGET_STATE_KEY, structuredClone({
    activeTargetId: options.noActive ? undefined : active.id, targets: [inactive, active],
  }));
  const context = { globalState: memento } as unknown as vscode.ExtensionContext;
  const resolverOptions: DshResolverOptions = {
    env: { APPDATA: join(root, 'Roaming') }, platform: 'win32', pathValue: '',
  };
  return { root, desktop, workspace, active, inactive, memento, context, resolverOptions };
}

describe('misplaced DSH Desktop target repair', () => {
  it('moves a verified Desktop path to Command and preserves target identity and all other targets', async () => {
    const input = fixture();
    const repaired = await repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions);

    expect(repaired).toMatchObject({
      id: 'old-dsh-target', name: 'My DSH', command: input.desktop,
      args: ['--profile', 'acp'], launchCwd: input.workspace,
      installDirectory: input.active.installDirectory, packageSpec: '@deepseek-ai/dsh@1.2.3',
      createdAt: '2026-10-18T00:00:00.000Z',
    });
    const saved = loadDshTargetState(input.context);
    expect(saved.activeTargetId).toBe('old-dsh-target');
    expect(saved.targets[0]).toEqual(input.inactive);
    expect(saved.targets[1]).toEqual(repaired);
    expect(input.memento.writes).toHaveLength(1);
    expect(input.memento.writes[0].key).toBe(DSH_TARGET_STATE_KEY);
    expect(resolveDshLaunch(saved.targets[1], input.resolverOptions)).toMatchObject({
      kind: 'local', source: 'desktop', command: join(input.desktop, 'DSH Desktop.exe'),
      cwd: input.workspace, shell: false,
      env: {
        ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(input.root, 'Roaming', 'dsh-desktop', 'harness'),
      },
    });
  });

  it('updates the live Memento before its first await and waits for persistence completion', async () => {
    const input = fixture();
    let finishWrite: (() => void) | undefined;
    input.memento.waitForWrite = () => new Promise<void>(resolve => { finishWrite = resolve; });
    const repairing = repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions);

    expect(input.memento.writes).toHaveLength(1);
    expect(loadDshTargetState(input.context).targets[1].command).toBe(input.desktop);
    finishWrite!();
    await expect(repairing).resolves.toMatchObject({ command: input.desktop, launchCwd: input.workspace });
  });

  it('does not rewrite an already corrected target on repeated activation', async () => {
    const input = fixture();
    await repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions);
    const saved = structuredClone(loadDshTargetState(input.context));

    await expect(repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions)).resolves.toBeUndefined();
    expect(input.memento.writes).toHaveLength(1);
    expect(loadDshTargetState(input.context)).toEqual(saved);
  });

  it.each([
    { label: 'a custom command', active: { command: 'custom-dsh.cmd' } },
    { label: 'an explicit dsh launcher', active: { command: 'dsh.cmd' } },
    { label: 'another profile', active: { args: ['--profile', 'custom'] } },
    { label: 'extra launcher arguments', active: { args: ['--profile', 'acp', '--patch', 'custom.yml'] } },
    { label: 'an ACP endpoint', active: { endpoint: 'ws://127.0.0.1:4318' } },
  ])('preserves $label', async ({ active }) => {
    const input = fixture({ active });
    const before = structuredClone(loadDshTargetState(input.context));

    await expect(repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions)).resolves.toBeUndefined();
    expect(input.memento.writes).toHaveLength(0);
    expect(loadDshTargetState(input.context)).toEqual(before);
  });

  it.each([undefined, '', 'relative-workspace'])('skips an unavailable or non-absolute workspace: %s', async workspace => {
    const input = fixture();
    const before = structuredClone(loadDshTargetState(input.context));

    await expect(repairMisplacedDshDesktopTarget(input.context, workspace, input.resolverOptions)).resolves.toBeUndefined();
    expect(input.memento.writes).toHaveLength(0);
    expect(loadDshTargetState(input.context)).toEqual(before);
  });

  it.each(['executable', 'archive'] as const)('skips a Desktop installation missing its %s', async missing => {
    const input = fixture({ missing });
    const before = structuredClone(loadDshTargetState(input.context));

    await expect(repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions)).resolves.toBeUndefined();
    expect(input.memento.writes).toHaveLength(0);
    expect(loadDshTargetState(input.context)).toEqual(before);
  });

  it('does not repair inactive targets when no active target is selected', async () => {
    const input = fixture({ noActive: true });
    const before = structuredClone(loadDshTargetState(input.context));

    await expect(repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions)).resolves.toBeUndefined();
    expect(input.memento.writes).toHaveLength(0);
    expect(loadDshTargetState(input.context)).toEqual(before);
  });

  it('skips a correctly configured Desktop target', async () => {
    const input = fixture();
    input.memento.values.set(DSH_TARGET_STATE_KEY, structuredClone({
      activeTargetId: input.active.id,
      targets: [input.inactive, { ...input.active, command: input.desktop, launchCwd: input.workspace }],
    }));
    const before = structuredClone(loadDshTargetState(input.context));

    await expect(repairMisplacedDshDesktopTarget(input.context, input.workspace, input.resolverOptions)).resolves.toBeUndefined();
    expect(input.memento.writes).toHaveLength(0);
    expect(loadDshTargetState(input.context)).toEqual(before);
  });
});
