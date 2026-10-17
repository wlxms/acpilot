import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEFAULT_DSH_ARGS,
  DEFAULT_DSH_COMMAND,
  DEFAULT_DSH_PACKAGE_SPEC,
} from './target';

export interface DshInstallOptions {
  installDirectory: string;
  packageSpec?: string;
  /** Exposed for tests and for environments that provide a pinned npm binary. */
  npmCommand?: string;
  platform?: NodeJS.Platform;
}

export interface DshInstallInvocation {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

export interface DshInstallResult {
  installDirectory: string;
  packageSpec: string;
  executable: string;
  output: string;
}

export function createDshInstallInvocation(
  options: DshInstallOptions,
): DshInstallInvocation {
  const installDirectory = options.installDirectory.trim();
  if (!isAbsolute(installDirectory)) {
    throw new Error('DSH install directory must be absolute');
  }
  const packageSpec = options.packageSpec?.trim() || DEFAULT_DSH_PACKAGE_SPEC;
  const platform = options.platform ?? process.platform;
  return {
    // npm publishes a .cmd launcher on Windows. `shell` is limited to this
    // user-requested package-manager call so the DSH transport can still run
    // the configured command without constructing a shell command string.
    command: options.npmCommand?.trim() || (platform === 'win32' ? 'npm.cmd' : 'npm'),
    args: ['install', '--prefix', installDirectory, packageSpec],
    cwd: installDirectory,
    shell: platform === 'win32',
  };
}

export function resolveDshExecutable(
  installDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const directory = installDirectory.trim();
  if (!isAbsolute(directory)) {
    throw new Error('DSH install directory must be absolute');
  }
  const binDirectory = join(directory, 'node_modules', '.bin');
  const candidates = platform === 'win32'
    ? [join(binDirectory, 'dsh.cmd'), join(binDirectory, 'dsh.exe'), join(binDirectory, 'dsh')]
    : [join(binDirectory, 'dsh')];
  return candidates.find(candidate => existsSync(candidate));
}

export async function installDsh(
  options: DshInstallOptions,
): Promise<DshInstallResult> {
  const invocation = createDshInstallInvocation(options);
  const packageSpec = options.packageSpec?.trim() || DEFAULT_DSH_PACKAGE_SPEC;
  await mkdir(invocation.cwd, { recursive: true });

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let collected = '';
    child.stdout?.on('data', chunk => { collected += String(chunk); });
    child.stderr?.on('data', chunk => { collected += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(collected);
        return;
      }
      reject(new Error(
        `DSH package operation failed (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${collected.trim()}`,
      ));
    });
  });

  const executable = resolveDshExecutable(invocation.cwd, options.platform ?? process.platform);
  if (!executable) {
    throw new Error(
      `DSH package operation completed, but no ${DEFAULT_DSH_COMMAND} executable was found in `
        + `${join(invocation.cwd, 'node_modules', '.bin')}.`,
    );
  }
  return {
    installDirectory: invocation.cwd,
    packageSpec,
    executable,
    output,
  };
}

/**
 * Pick the command to persist after an install/update operation.
 *
 * A first-time install starts from the friendly `dsh` placeholder, so use the
 * launcher discovered under the install prefix. Existing targets may point at
 * a user wrapper or a modified checkout; preserve that explicit command.
 */
export function commandAfterDshInstall(
  requestedCommand: string | undefined,
  installedExecutable: string,
  existingTargetId?: string,
): string {
  const requested = requestedCommand?.trim();
  if (requested && (existingTargetId !== undefined || requested !== DEFAULT_DSH_COMMAND)) {
    return requested;
  }
  return installedExecutable;
}

export function defaultDshArgs(): string[] {
  return [...DEFAULT_DSH_ARGS];
}
