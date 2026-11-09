import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDshLaunch } from '../backends/dsh/resolver';
import type { DshTarget } from '../backends/dsh/target';

const temporaryDirectories: string[] = [];

function createTarget(overrides: Partial<DshTarget> = {}): DshTarget {
  return {
    id: 'dsh-test',
    name: 'Test DSH',
    command: 'dsh',
    args: ['--profile', 'acp'],
    launchCwd: 'C:\\workspace',
    packageSpec: '@deepseek-ai/dsh@latest',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DSH launch resolver', () => {
  it('uses a configured ACP endpoint without spawning DSH', () => {
    const result = resolveDshLaunch(createTarget({ endpoint: 'ws://127.0.0.1:4318' }), {
      env: {},
      platform: 'win32',
      pathValue: '',
    });

    expect(result).toEqual({
      kind: 'remote',
      url: 'ws://127.0.0.1:4318',
      source: 'target-endpoint',
    });
  });

  it('discovers an already-running endpoint from an explicit environment variable', () => {
    const result = resolveDshLaunch(createTarget(), {
      env: { ACPILOT_DSH_ENDPOINT: 'wss://localhost:9000/acp' },
      platform: 'win32',
      pathValue: '',
    });

    expect(result).toEqual({
      kind: 'remote',
      url: 'wss://localhost:9000/acp',
      source: 'environment-endpoint',
    });
  });

  it('resolves the DSH launcher from PATH on Windows', () => {
    const root = tempDirectory('acpilot-dsh-path-');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, 'dsh.cmd');
    writeFileSync(launcher, '');

    const result = resolveDshLaunch(createTarget({ launchCwd: root }), {
      env: {},
      platform: 'win32',
      pathValue: bin,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: launcher,
      args: ['--profile', 'acp'],
      cwd: root,
      source: 'path',
      shell: true,
    });
  });

  it('keeps an absolute launcher path explicit instead of substituting one from PATH', () => {
    const root = tempDirectory('acpilot-dsh-explicit-');
    const requestedDirectory = join(root, 'installed');
    const pathDirectory = join(root, 'path');
    mkdirSync(requestedDirectory, { recursive: true });
    mkdirSync(pathDirectory, { recursive: true });
    const requested = join(requestedDirectory, 'dsh.cmd');
    writeFileSync(requested, '');
    writeFileSync(join(pathDirectory, 'dsh.cmd'), '');

    const result = resolveDshLaunch(createTarget({
      command: requested,
      launchCwd: root,
    }), {
      env: {},
      platform: 'win32',
      pathValue: pathDirectory,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: requested,
      source: 'explicit',
    });
  });

  it('prefers the launch directory launcher over an installed or PATH launcher', () => {
    const root = tempDirectory('acpilot-dsh-project-bin-');
    const projectBin = join(root, 'node_modules', '.bin');
    const installDirectory = join(root, 'managed-install');
    const installBin = join(installDirectory, 'node_modules', '.bin');
    const pathDirectory = join(root, 'path');
    mkdirSync(projectBin, { recursive: true });
    mkdirSync(installBin, { recursive: true });
    mkdirSync(pathDirectory, { recursive: true });
    const projectLauncher = join(projectBin, 'dsh.cmd');
    writeFileSync(projectLauncher, '');
    writeFileSync(join(installBin, 'dsh.cmd'), '');
    writeFileSync(join(pathDirectory, 'dsh.cmd'), '');

    const result = resolveDshLaunch(createTarget({
      launchCwd: root,
      installDirectory,
    }), {
      env: {},
      platform: 'win32',
      pathValue: pathDirectory,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: projectLauncher,
      source: 'project-bin',
    });
  });

  it('prefers a launch directory package script over an installed or PATH launcher', () => {
    const root = tempDirectory('acpilot-dsh-project-script-priority-');
    const bin = join(root, 'bin');
    const installDirectory = join(root, 'managed-install');
    const installBin = join(installDirectory, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(installBin, { recursive: true });
    const pnpm = join(bin, 'pnpm.cmd');
    writeFileSync(pnpm, '');
    writeFileSync(join(bin, 'dsh.cmd'), '');
    writeFileSync(join(installBin, 'dsh.cmd'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.7.0',
      scripts: { dsh: 'node apps/cli/src/bin.ts' },
    }));

    const result = resolveDshLaunch(createTarget({
      launchCwd: root,
      installDirectory,
    }), {
      env: {},
      platform: 'win32',
      pathValue: bin,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: pnpm,
      args: ['dsh', '--profile', 'acp'],
      cwd: root,
      source: 'package-script',
    });
  });

  it('prefers the managed install launcher over PATH when the launch directory has no local entrypoint', () => {
    const root = tempDirectory('acpilot-dsh-install-priority-');
    const launchCwd = join(root, 'workspace');
    const installDirectory = join(root, 'managed-install');
    const installBin = join(installDirectory, 'node_modules', '.bin');
    const pathDirectory = join(root, 'path');
    mkdirSync(launchCwd, { recursive: true });
    mkdirSync(installBin, { recursive: true });
    mkdirSync(pathDirectory, { recursive: true });
    const installed = join(installBin, 'dsh.cmd');
    writeFileSync(installed, '');
    writeFileSync(join(pathDirectory, 'dsh.cmd'), '');

    const result = resolveDshLaunch(createTarget({
      launchCwd,
      installDirectory,
    }), {
      env: {},
      platform: 'win32',
      pathValue: pathDirectory,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: installed,
      source: 'install-directory',
    });
  });
  it('resolves a project package script when the source checkout has no dsh launcher', () => {
    const root = tempDirectory('acpilot-dsh-project-');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const pnpm = join(bin, 'pnpm.cmd');
    writeFileSync(pnpm, '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.7.0',
      scripts: { dsh: 'node apps/cli/src/bin.ts' },
    }));

    const result = resolveDshLaunch(createTarget({ launchCwd: root }), {
      env: {},
      platform: 'win32',
      pathValue: bin,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: pnpm,
      args: ['dsh', '--profile', 'acp'],
      cwd: root,
      source: 'package-script',
      shell: true,
    });
  });

  it('falls back to another available package manager when packageManager is unavailable', () => {
    const root = tempDirectory('acpilot-dsh-manager-fallback-');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const npm = join(bin, 'npm.cmd');
    writeFileSync(npm, '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.7.0',
      scripts: { dsh: 'node apps/cli/src/bin.ts' },
    }));

    const result = resolveDshLaunch(createTarget({ launchCwd: root }), {
      env: {},
      platform: 'win32',
      pathValue: bin,
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: npm,
      args: ['run', 'dsh', '--', '--profile', 'acp'],
      source: 'package-script',
    });
  });

  it('preserves an explicit wrapper command and prepends its inline arguments', () => {
    const result = resolveDshLaunch(createTarget({
      command: '"C:\\Program Files\\my-dsh\\start.cmd" --profile custom',
      args: ['--workspace', 'repo'],
    }), {
      env: {},
      platform: 'win32',
      pathValue: '',
    });

    expect(result).toEqual({
      kind: 'local',
      command: 'C:\\Program Files\\my-dsh\\start.cmd',
      args: ['--profile', 'custom', '--workspace', 'repo'],
      cwd: 'C:\\workspace',
      source: 'explicit',
      shell: true,
    });
  });

  it('does not route direct Node commands through a Windows shell', () => {
    const result = resolveDshLaunch(createTarget({
      command: 'node',
      args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'],
    }), {
      env: {},
      platform: 'win32',
      pathValue: '',
    });

    expect(result).toMatchObject({
      kind: 'local',
      command: 'node',
      shell: false,
      args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'],
    });
  });

  it('returns an actionable unresolved result when no default entrypoint is available', () => {
    const result = resolveDshLaunch(createTarget({ launchCwd: 'C:\\missing-dsh' }), {
      env: {},
      platform: 'win32',
      pathValue: '',
    });

    expect(result.kind).toBe('unresolved');
    if (result.kind !== 'unresolved') { throw new Error('expected unresolved DSH launch'); }
    expect(result).toMatchObject({
      attempted: expect.arrayContaining([
        'PATH:dsh',
        'project node_modules/.bin/dsh',
        'package.json scripts.dsh',
      ]),
    });
    expect(result.message).toContain('DSH');
  });
});
