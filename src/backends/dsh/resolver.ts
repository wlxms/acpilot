import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import {
  DEFAULT_DSH_COMMAND,
  type DshTarget,
} from './target';

export const DSH_ENDPOINT_ENV_KEYS = [
  'ACPILOT_DSH_ENDPOINT',
  'DSH_ACP_ENDPOINT',
  'DSH_ACP_URL',
] as const;

export type DshLaunchSource =
  | 'target-endpoint'
  | 'command-endpoint'
  | 'environment-endpoint'
  | 'explicit'
  | 'path'
  | 'install-directory'
  | 'project-bin'
  | 'package-script';

export interface DshLocalLaunchResolution {
  kind: 'local';
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
  source: Exclude<DshLaunchSource, 'target-endpoint' | 'command-endpoint' | 'environment-endpoint'>;
}

export interface DshRemoteLaunchResolution {
  kind: 'remote';
  url: string;
  source: Extract<DshLaunchSource, 'target-endpoint' | 'command-endpoint' | 'environment-endpoint'>;
}

export interface DshUnresolvedLaunchResolution {
  kind: 'unresolved';
  message: string;
  attempted: string[];
}

export type DshLaunchResolution =
  | DshLocalLaunchResolution
  | DshRemoteLaunchResolution
  | DshUnresolvedLaunchResolution;

export interface DshResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Override PATH in tests or when the host has a case-insensitive env map. */
  pathValue?: string;
}

interface PackageManifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

interface PackageScriptLocation {
  directory: string;
  manifest: PackageManifest;
}

interface PackageManager {
  name: 'pnpm' | 'npm' | 'yarn' | 'bun';
  executable: string;
  args: string[];
}

/**
 * Resolve the most useful way to reach a DSH ACP service.
 *
 * The default `dsh` command is intentionally adaptive: it works for a global
 * launcher, an ACPilot-managed install, a checkout with a local launcher, and
 * a source checkout exposing a package-manager `dsh` script. Explicit custom
 * commands remain untouched. A URL or endpoint environment variable selects a
 * running ACP service and avoids spawning a second process.
 */
export function resolveDshLaunch(
  target: Pick<DshTarget, 'command' | 'args' | 'launchCwd' | 'installDirectory' | 'endpoint'>,
  options: DshResolverOptions = {},
): DshLaunchResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? getPathValue(env);
  const commandTokens = tokenizeCommandLine(target.command);
  const command = commandTokens[0]?.trim() ?? '';
  const inlineArgs = commandTokens.slice(1);
  const args = [...inlineArgs, ...target.args];

  if (target.endpoint !== undefined) {
    const endpoint = parseAcpEndpoint(target.endpoint);
    if (endpoint) {
      return { kind: 'remote', url: endpoint, source: 'target-endpoint' };
    }
    return unresolved('Configured DSH endpoint is not a valid ws:// or wss:// URL.', [
      'target.endpoint',
    ]);
  }

  if (!command) {
    return unresolved('DSH command is empty. Configure a DSH command or ACP endpoint.', [
      'target.command',
    ]);
  }

  const commandEndpoint = parseAcpEndpoint(command);
  if (commandEndpoint) {
    return { kind: 'remote', url: commandEndpoint, source: 'command-endpoint' };
  }

  if (!isDefaultDshCommand(command)) {
    return createLocalResolution(command, args, target.launchCwd, platform, 'explicit');
  }

  for (const key of DSH_ENDPOINT_ENV_KEYS) {
    const endpoint = parseAcpEndpoint(env[key]);
    if (endpoint) {
      return { kind: 'remote', url: endpoint, source: 'environment-endpoint' };
    }
  }

  const attempted: string[] = [`PATH:${command}`];
  const pathExecutable = resolveExecutable(command, pathValue, platform);
  if (pathExecutable) {
    return createLocalResolution(pathExecutable, args, target.launchCwd, platform, 'path');
  }

  if (target.installDirectory) {
    attempted.push('install directory node_modules/.bin/dsh');
    const installedExecutable = resolveBinExecutable(target.installDirectory, command, platform);
    if (installedExecutable) {
      return createLocalResolution(
        installedExecutable,
        args,
        target.launchCwd,
        platform,
        'install-directory',
      );
    }
  }

  attempted.push('project node_modules/.bin/dsh');
  const projectExecutable = resolveProjectBinExecutable(target.launchCwd, command, platform);
  if (projectExecutable) {
    return createLocalResolution(projectExecutable, args, target.launchCwd, platform, 'project-bin');
  }

  attempted.push('package.json scripts.dsh');
  const script = findPackageScript(target.launchCwd, 'dsh');
  if (script) {
    const manager = resolvePackageManager(script, pathValue, platform);
    if (manager) {
      return createLocalResolution(
        manager.executable,
        [...manager.args, ...target.args],
        script.directory,
        platform,
        'package-script',
      );
    }
    attempted.push('package manager executable');
  }

  return unresolved(
    `Unable to resolve DSH command "${command}". Configure an explicit command, install DSH, `
      + 'or set an ACP endpoint for an already-running DSH service.',
    attempted,
  );
}

export function tokenizeCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.trim().length; index += 1) {
    const character = value.trim()[index];
    const next = value.trim()[index + 1];
    if (quote === '"' && character === '\\' && next === '"') {
      token += '"';
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token.length > 0) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    token += character;
  }

  if (token.length > 0) {
    tokens.push(token);
  }
  return tokens;
}

function unresolved(message: string, attempted: string[]): DshUnresolvedLaunchResolution {
  return { kind: 'unresolved', message, attempted };
}

function createLocalResolution(
  command: string,
  args: string[],
  cwd: string,
  platform: NodeJS.Platform,
  source: DshLocalLaunchResolution['source'],
): DshLocalLaunchResolution {
  return {
    kind: 'local',
    command,
    args,
    cwd,
    shell: platform === 'win32',
    source,
  };
}

function isDefaultDshCommand(command: string): boolean {
  const basename = parse(command).base.toLowerCase();
  return basename === DEFAULT_DSH_COMMAND
    || basename === `${DEFAULT_DSH_COMMAND}.cmd`
    || basename === `${DEFAULT_DSH_COMMAND}.exe`
    || basename === `${DEFAULT_DSH_COMMAND}.bat`;
}

function parseAcpEndpoint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

function getPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? '';
}

function resolveExecutable(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform,
): string | undefined {
  const directories = pathValue
    .split(platform === 'win32' ? ';' : ':')
    .map(value => value.trim())
    .filter(Boolean);
  if (isPathLike(command)) {
    return findExistingExecutable(command, platform);
  }
  for (const directory of directories) {
    const candidate = findExistingExecutable(join(directory, command), platform);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function findExistingExecutable(base: string, platform: NodeJS.Platform): string | undefined {
  const candidates = platform === 'win32'
    ? getWindowsCandidates(base)
    : [base];
  return candidates.find(candidate => isFile(candidate));
}

function getWindowsCandidates(base: string): string[] {
  const extension = parse(base).ext.toLowerCase();
  if (extension) {
    return [base];
  }
  return [`${base}.cmd`, `${base}.exe`, `${base}.bat`, base];
}

function isPathLike(command: string): boolean {
  return isAbsolute(command) || command.includes('\\') || command.includes('/') || command.startsWith('.');
}

function resolveBinExecutable(
  directory: string,
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  const binDirectory = join(directory, 'node_modules', '.bin');
  return findExistingExecutable(join(binDirectory, parse(command).base), platform);
}

function resolveProjectBinExecutable(
  launchCwd: string,
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  for (const directory of ancestorDirectories(launchCwd)) {
    const executable = resolveBinExecutable(directory, command, platform);
    if (executable) {
      return executable;
    }
  }
  return undefined;
}

function findPackageScript(directory: string, scriptName: string): PackageScriptLocation | undefined {
  for (const candidateDirectory of ancestorDirectories(directory)) {
    const packagePath = join(candidateDirectory, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageManifest;
      if (typeof manifest.scripts?.[scriptName] === 'string') {
        return { directory: candidateDirectory, manifest };
      }
    } catch {
      // Keep walking when a directory has no readable package manifest.
    }
  }
  return undefined;
}

function resolvePackageManager(
  script: PackageScriptLocation,
  pathValue: string,
  platform: NodeJS.Platform,
): PackageManager | undefined {
  const preferred = packageManagerName(script.manifest.packageManager)
    ?? inferPackageManagerFromFiles(script.directory);
  const allNames: Array<PackageManager['name']> = ['pnpm', 'npm', 'yarn', 'bun'];
  const names: Array<PackageManager['name']> = preferred
    ? [preferred, ...allNames.filter(name => name !== preferred)]
    : allNames;

  for (const name of names) {
    const executable = resolveExecutable(name, pathValue, platform);
    if (!executable) {
      continue;
    }
    return {
      name,
      executable,
      args: name === 'npm'
        ? ['run', 'dsh', '--']
        : name === 'bun'
          ? ['run', 'dsh']
          : ['dsh'],
    };
  }
  return undefined;
}

function packageManagerName(value: unknown): PackageManager['name'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim().split('@', 1)[0].toLowerCase();
  return isPackageManagerName(name) ? name : undefined;
}

function inferPackageManagerFromFiles(directory: string): PackageManager['name'] | undefined {
  if (isFile(join(directory, 'pnpm-lock.yaml'))) {return 'pnpm';}
  if (isFile(join(directory, 'yarn.lock'))) {return 'yarn';}
  if (isFile(join(directory, 'package-lock.json'))) {return 'npm';}
  if (isFile(join(directory, 'bun.lockb')) || isFile(join(directory, 'bun.lock'))) {return 'bun';}
  return undefined;
}

function isPackageManagerName(value: string): value is PackageManager['name'] {
  return value === 'pnpm' || value === 'npm' || value === 'yarn' || value === 'bun';
}

function ancestorDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return directories;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
