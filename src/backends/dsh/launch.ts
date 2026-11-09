import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { LocalSpawnOptions } from '../acp/transport';
import { appendDshBridgePatch, ensureDshBridgePatch } from './bridge-launch';
import type { DshLocalLaunchResolution } from './resolver';

export interface DshLocalLaunchFiles {
  modulePath: string;
  patchDirectory: string;
  desktopLauncherPath: string;
  nonce: string;
}

/** Prepare the bridge and, for Desktop, an isolated ACP profile bootstrap. */
export async function prepareDshLocalLaunch(
  resolution: DshLocalLaunchResolution,
  files: DshLocalLaunchFiles,
): Promise<LocalSpawnOptions> {
  let args = resolution.args;
  let dshArgsStart = resolution.dshArgsStart;
  if (resolution.desktop) {
    try {
      if (!isAbsolute(files.desktopLauncherPath)) { throw new Error('absolute path required'); }
      await access(files.desktopLauncherPath);
    } catch {
      throw new Error(`ACPilot DSH Desktop bootstrap was not found: ${files.desktopLauncherPath}`);
    }
    args = [
      '--expose-internals', files.desktopLauncherPath,
      resolution.desktop.cliEntry, files.patchDirectory, '--',
      ...resolution.args.slice(resolution.dshArgsStart ?? 2),
    ];
    dshArgsStart = 5;
  }
  const patchPath = await ensureDshBridgePatch(files);
  return {
    command: resolution.command,
    args: appendDshBridgePatch(resolution.command, args, patchPath, {
      shell: resolution.shell, dshArgsStart,
    }),
    cwd: resolution.cwd,
    env: { ...resolution.env, ACPILOT_DSH_BRIDGE_NONCE: files.nonce },
    stderr: 'pipe',
    shell: resolution.shell,
    ...(resolution.desktop ? { windowsHide: true, shutdownGracePeriodMs: 1_500 } : {}),
  };
}
