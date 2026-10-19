import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  appendDshBridgePatch,
  ensureDshBridgePatch,
} from '../backends/dsh/bridge-launch';

describe('DSH bridge launch overlay', () => {
  it('writes a file-url patch that loads the bundled bridge plugin', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'acpilot-dsh-bridge-'));
    const modulePath = path.join(root, 'dsh-bridge', 'index.mjs');
    const patchDirectory = path.join(root, 'storage');
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(modulePath, 'export function apply() {}', 'utf8');

    const patchPath = await ensureDshBridgePatch({
      modulePath,
      patchDirectory,
    });

    const source = await readFile(patchPath, 'utf8');
    expect(source).toContain('id: acpilot-dsh-bridge');
    expect(source).toContain(`name: ${JSON.stringify(pathToFileURL(modulePath).href)}`);
  });

  it('appends the ACPilot overlay before app-owned DSH arguments', () => {
    const args = ['--profile', 'acp', '--patch', 'user.patch.yml', '--resume', 'session-1'];
    const result = appendDshBridgePatch('dsh.exe', args, 'C:\\acpilot\\bridge.patch.yml');

    expect(result).toEqual([
      '--profile', 'acp', '--patch', 'user.patch.yml',
      '--patch', 'C:\\acpilot\\bridge.patch.yml',
      '--resume', 'session-1',
    ]);
    expect(args).toEqual(['--profile', 'acp', '--patch', 'user.patch.yml', '--resume', 'session-1']);
  });

  it('keeps pnpm dsh wrapper arguments before the DSH launcher overlay', () => {
    const args = ['dsh', '--profile', 'acp'];
    const result = appendDshBridgePatch('C:\\Users\\Administrator\\AppData\\Roaming\\npm\\pnpm.cmd', args, 'C:\\acpilot\\bridge.patch.yml');

    expect(result).toEqual([
      'dsh', '--patch', 'C:\\acpilot\\bridge.patch.yml', '--profile', 'acp',
    ]);
    expect(args).toEqual(['dsh', '--profile', 'acp']);
  });

  it('keeps node script wrappers before the DSH launcher overlay', () => {
    const args = ['apps/cli/lib/bin.js', '--profile', 'acp'];
    const result = appendDshBridgePatch('node.exe', args, 'C:\\acpilot\\bridge.patch.yml');

    expect(result).toEqual([
      'apps/cli/lib/bin.js', '--patch', 'C:\\acpilot\\bridge.patch.yml', '--profile', 'acp',
    ]);
  });
});
