import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDshLocalLaunch } from '../backends/dsh/launch';
import type { DshLocalLaunchResolution } from '../backends/dsh/resolver';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function launchFiles() {
  const root = await mkdtemp(join(tmpdir(), 'acpilot-launch-'));
  roots.push(root);
  const modulePath = join(root, 'bridge.mjs');
  const desktopLauncherPath = join(root, 'desktop-launch.mjs');
  await writeFile(modulePath, 'export function apply() {}');
  await writeFile(desktopLauncherPath, 'export {};');
  const patchDirectory = join(root, 'patches');
  return { modulePath, desktopLauncherPath, patchDirectory, nonce: 'new-nonce' };
}

describe('DSH local launch preparation', () => {
  it('launches Desktop through the ACP bootstrap and passes its shared home and bridge nonce', async () => {
    const files = await launchFiles();
    const resolution: DshLocalLaunchResolution = {
      kind: 'local',
      command: 'C:\\Apps\\DSH Desktop\\DSH Desktop.exe',
      args: ['--expose-internals', 'C:\\Apps\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', '--profile', 'acp', '--patch', 'user.yml'],
      cwd: 'D:\\workspace',
      shell: false,
      source: 'desktop',
      dshArgsStart: 2,
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: 'C:\\data\\harness', ACPILOT_DSH_BRIDGE_NONCE: 'old-nonce' },
      desktop: { directory: 'C:\\Apps\\DSH Desktop', home: 'C:\\data\\harness', cliEntry: 'C:\\Apps\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js' },
    };

    const launch = await prepareDshLocalLaunch(resolution, files);
    expect(launch).toMatchObject({
      command: resolution.command,
      cwd: 'D:\\workspace',
      shell: false,
      stderr: 'pipe',
      windowsHide: true,
      shutdownGracePeriodMs: 1_500,
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: 'C:\\data\\harness', ACPILOT_DSH_BRIDGE_NONCE: 'new-nonce' },
    });
    expect(launch.args).toEqual([
      '--expose-internals', files.desktopLauncherPath, resolution.desktop!.cliEntry, files.patchDirectory, '--',
      '--profile', 'acp', '--patch', 'user.yml', '--patch', join(files.patchDirectory, 'acpilot-dsh-bridge.patch.yml'),
    ]);
    expect(await readFile(join(files.patchDirectory, 'acpilot-dsh-bridge.patch.yml'), 'utf8')).toContain('acpilot-dsh-bridge');
  });

  it('keeps ordinary DSH commands and their launcher argument order', async () => {
    const files = await launchFiles();
    const launch = await prepareDshLocalLaunch({
      kind: 'local', command: 'dsh.exe', args: ['--profile', 'acp', '--resume', 'session-1'],
      cwd: 'D:\\workspace', shell: false, source: 'explicit',
    }, files);
    expect(launch.args).toEqual([
      '--profile', 'acp', '--patch', join(files.patchDirectory, 'acpilot-dsh-bridge.patch.yml'), '--resume', 'session-1',
    ]);
    expect(launch.env).toEqual({ ACPILOT_DSH_BRIDGE_NONCE: 'new-nonce' });
    expect(launch.shutdownGracePeriodMs).toBeUndefined();
  });

  it('rejects a missing Desktop bootstrap before producing a launch command', async () => {
    const files = await launchFiles();
    await mkdir(files.patchDirectory, { recursive: true });
    await expect(prepareDshLocalLaunch({
      kind: 'local', command: 'desktop.exe', args: ['--expose-internals', 'bin.js', '--profile', 'acp'],
      cwd: 'D:\\workspace', shell: false, source: 'desktop', dshArgsStart: 2,
      desktop: { directory: 'C:\\Desktop', home: 'C:\\data', cliEntry: 'bin.js' },
    }, { ...files, desktopLauncherPath: join(files.patchDirectory, 'missing.mjs') })).rejects.toThrow(/Desktop.*bootstrap/i);
  });
});
