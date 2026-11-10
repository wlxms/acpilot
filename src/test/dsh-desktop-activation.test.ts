import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_BACKENDS } from '../backends/registry';
import { DshBackend } from '../backends/dsh/adapter';
import { activate, deactivate } from '../extension';
import { DSH_TARGET_STATE_KEY, getActiveDshTarget } from '../settings/state-persistence';
import { OutputChannel } from './vscode-mock';

vi.mock('vscode', async importOriginal => {
  const original = await importOriginal<typeof import('./vscode-mock')>();
  const path = await import('node:path');
  return {
    ...original,
    Uri: class extends original.Uri {
      static joinPath(base: vscode.Uri, ...parts: string[]) { return original.Uri.file(path.join(base.fsPath, ...parts)); }
    },
    LanguageModelChatToolMode: undefined,
    commands: { registerCommand: () => ({ dispose() {} }) },
  };
});
vi.mock('../statusbar', () => ({
  StatusBarManager: class { setActiveBackend() {} dispose() {} },
}));

const originalBackends = [...BUILTIN_BACKENDS];
const roots: string[] = [];
const testWorkspace = vscode.workspace as { workspaceFolders: typeof vscode.workspace.workspaceFolders };
afterEach(async () => {
  await deactivate();
  BUILTIN_BACKENDS.splice(0, BUILTIN_BACKENDS.length, ...originalBackends);
  testWorkspace.workspaceFolders = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

function fixture(write: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'acpilot-desktop-activation-'));
  roots.push(root);
  // Desktop detection needs a configuration home. Keep this fixture independent
  // of the host's APPDATA availability and any real Desktop profile selection.
  vi.stubEnv('APPDATA', join(root, 'Roaming'));
  vi.stubEnv('DSH_HOME', undefined);
  const desktop = join(root, 'DSH Desktop');
  const workspace = join(root, 'workspace');
  mkdirSync(join(desktop, 'resources'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(desktop, 'DSH Desktop.exe'), '');
  writeFileSync(join(desktop, 'resources', 'app.asar'), '');
  const values = new Map<string, unknown>([[DSH_TARGET_STATE_KEY, {
    activeTargetId: 'legacy',
    targets: [{ id: 'legacy', name: 'My DSH', command: 'dsh', args: ['--profile', 'acp'],
      launchCwd: desktop, packageSpec: '@deepseek-ai/dsh@latest',
      createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' }],
  }]]);
  const memento = {
    get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    update: (key: string, value: unknown) => { values.set(key, structuredClone(value)); return write(); },
  };
  const context = {
    subscriptions: [], globalState: memento, workspaceState: memento,
    extensionUri: vscode.Uri.file(resolve(__dirname, '../..')),
    globalStorageUri: vscode.Uri.file(join(root, 'storage')),
  } as unknown as vscode.ExtensionContext;
  testWorkspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'workspace', index: 0 }];
  const backend = new DshBackend();
  BUILTIN_BACKENDS.splice(0, BUILTIN_BACKENDS.length, {
    ...originalBackends.find(descriptor => descriptor.id === 'dsh')!,
    factory: () => backend, autoStart: false, contributesToChat: false,
  });
  const optionsSpy = vi.spyOn(backend, 'setOptionsProvider');
  const output = new OutputChannel('ACPilot');
  vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue(output as unknown as vscode.LogOutputChannel);
  return { context, desktop, workspace, optionsSpy, output };
}

describe.skipIf(process.platform !== 'win32')('Desktop target repair during activation', () => {
  it('waits for persistence before producing launch options from the repaired Desktop target', async () => {
    let finishWrite!: () => void;
    const input = fixture(() => new Promise<void>(done => { finishWrite = done; }));
    expect(activate(input.context)).toBeUndefined();
    expect(getActiveDshTarget(input.context)).toMatchObject({ command: input.desktop, launchCwd: input.workspace });
    const provider = input.optionsSpy.mock.calls[0][0]!;
    let completed = false;
    const preparing = Promise.resolve(provider()).then(options => { completed = true; return options; });
    await new Promise<void>(done => setImmediate(done));
    expect(completed).toBe(false);
    finishWrite();
    const options = await preparing;
    expect(options?.local).toMatchObject({ command: join(input.desktop, 'DSH Desktop.exe'), cwd: input.workspace,
      shell: false, windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(options?.local?.args).toContain(join(resolve(__dirname, '../..'), 'dsh-bridge', 'desktop-launch.mjs'));
    expect(input.output.lines.some(line => line.includes('DSH Desktop selected'))).toBe(true);
  });

  it('handles persistence failure safely while retaining the repaired live Desktop launch', async () => {
    const input = fixture(() => Promise.reject(new Error('fixture-secret-must-not-be-logged')));
    activate(input.context);
    const options = await input.optionsSpy.mock.calls[0][0]!();
    expect(options?.local?.command).toBe(join(input.desktop, 'DSH Desktop.exe'));
    expect(input.output.lines.some(line => line.includes('DSH Desktop target repair could not be saved'))).toBe(true);
    expect(input.output.lines.join('\n')).not.toContain('fixture-secret-must-not-be-logged');
  });
});
