import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandAfterDshInstall,
  createDshInstallInvocation,
  defaultDshArgs,
  resolveDshExecutable,
} from '../backends/dsh/installer';

const temporaryDirectories: string[] = [];

afterEach(() => {
  // The tests only create empty marker files. Vitest's isolated temp folder is
  // cleaned by the runner; retaining the paths avoids recursive cleanup here.
  temporaryDirectories.length = 0;
});

describe('DSH installer helpers', () => {
  it('builds a Windows npm invocation without embedding user arguments in a command string', () => {
    const invocation = createDshInstallInvocation({
      installDirectory: 'C:\\Users\\me\\dsh',
      packageSpec: '@deepseek-ai/dsh@latest',
      platform: 'win32',
    });
    expect(invocation).toEqual({
      command: 'npm.cmd',
      args: ['install', '--prefix', 'C:\\Users\\me\\dsh', '@deepseek-ai/dsh@latest'],
      cwd: 'C:\\Users\\me\\dsh',
      shell: true,
    });
  });

  it('resolves the installed launcher for both Windows and Unix layouts', () => {
    const winDirectory = join(process.cwd(), '.vitest-dsh-win');
    const unixDirectory = join(process.cwd(), '.vitest-dsh-unix');
    temporaryDirectories.push(winDirectory, unixDirectory);
    mkdirSync(join(winDirectory, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(unixDirectory, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(winDirectory, 'node_modules', '.bin', 'dsh.cmd'), '');
    writeFileSync(join(unixDirectory, 'node_modules', '.bin', 'dsh'), '');
    expect(resolveDshExecutable(winDirectory, 'win32')).toBe(
      join(winDirectory, 'node_modules', '.bin', 'dsh.cmd'),
    );
    expect(resolveDshExecutable(unixDirectory, 'linux')).toBe(
      join(unixDirectory, 'node_modules', '.bin', 'dsh'),
    );
  });

  it('keeps the official ACP profile as the default DSH entrypoint', () => {
    expect(defaultDshArgs()).toEqual(['--profile', 'acp']);
  });

  it('uses the installed launcher for a first-time install but preserves an existing custom command', () => {
    expect(commandAfterDshInstall('dsh', 'C:\\acpilot-dsh\\node_modules\\.bin\\dsh.cmd'))
      .toBe('C:\\acpilot-dsh\\node_modules\\.bin\\dsh.cmd');
    expect(commandAfterDshInstall('D:\\my-dsh\\start.cmd', 'C:\\acpilot-dsh\\node_modules\\.bin\\dsh.cmd', 'custom-target'))
      .toBe('D:\\my-dsh\\start.cmd');
  });
});
