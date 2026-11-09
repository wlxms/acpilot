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
  | 'desktop'
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
  /** Environment overrides required by a specialized launcher. */
  env?: NodeJS.ProcessEnv;
  /** Number of runtime arguments before DSH receives its launcher arguments. */
  dshArgsStart?: number;
  /** Desktop installation and shared configuration used by this launch. */
  desktop?: { directory: string; home: string; cliEntry: string };
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
  if (target.endpoint !== undefined) {
    const endpoint = parseAcpEndpoint(target.endpoint);
    if (endpoint) {
      return { kind: 'remote', url: endpoint, source: 'target-endpoint' };
    }
    return unresolved('Configured DSH endpoint is not a valid ws:// or wss:// URL.', [
      'target.endpoint',
    ]);
  }

  // A pasted Desktop path may contain spaces without command-line quotes.
  // Resolve the complete selection before treating whitespace as arguments.
  const desktopSelection = resolveDshDesktopLaunch(target.command.trim(), target.args, target.launchCwd, env, platform);
  if (desktopSelection) { return desktopSelection; }

  const commandTokens = tokenizeCommandLine(target.command);
  const command = commandTokens[0]?.trim() ?? '';
  const inlineArgs = commandTokens.slice(1);
  const args = [...inlineArgs, ...target.args];

  if (!command) {
    return unresolved('DSH command is empty. Configure a DSH command or ACP endpoint.', [
      'target.command',
    ]);
  }

  const commandEndpoint = parseAcpEndpoint(command);
  if (commandEndpoint) {
    return { kind: 'remote', url: commandEndpoint, source: 'command-endpoint' };
  }

  const desktopCommand = resolveDshDesktopLaunch(command, args, target.launchCwd, env, platform);
  if (desktopCommand) { return desktopCommand; }

  if (isPathLike(command)) {
    return createLocalResolution(command, args, target.launchCwd, platform, 'explicit');
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

  const attempted: string[] = ['project node_modules/.bin/dsh'];
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

  attempted.push(`PATH:${command}`);
  const pathExecutable = resolveExecutable(command, pathValue, platform);
  if (pathExecutable) {
    return createLocalResolution(pathExecutable, args, target.launchCwd, platform, 'path');
  }
  return unresolved(
    `Unable to resolve DSH command "${command}". Configure an explicit command, install DSH, `
      + 'or set an ACP endpoint for an already-running DSH service.',
    attempted,
  );
}

function resolveDshDesktopLaunch(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): DshLocalLaunchResolution | DshUnresolvedLaunchResolution | undefined {
  if (platform !== 'win32' || !isAbsolute(command)) { return undefined; }
  const name = parse(command).base.toLowerCase();
  let directory: string;
  if (name === 'dsh desktop.exe') {
    directory = dirname(command);
  } else if (isDirectory(command)
    && (name === 'dsh desktop' || isFile(join(command, 'DSH Desktop.exe')))) {
    directory = command;
  } else {
    return undefined;
  }

  const executable = join(directory, 'DSH Desktop.exe');
  const archive = join(directory, 'resources', 'app.asar');
  if (!isFile(executable)) {
    return unresolved('DSH Desktop executable was not found: ' + executable, [executable]);
  }
  // Electron exposes ASAR archives as virtual directories to extension hosts.
  if (!isFile(archive) && !isDirectory(archive)) {
    return unresolved('DSH Desktop bundled app.asar was not found: ' + archive, [archive]);
  }
  const appData = env.APPDATA?.trim();
  const home = env.DSH_HOME?.trim() || (appData ? join(appData, 'dsh-desktop', 'harness') : undefined);
  if (!home) {
    return unresolved('DSH Desktop configuration home is unavailable. Set DSH_HOME or APPDATA.', ['DSH_HOME', 'APPDATA']);
  }

  // Electron can read this virtual path; the extension host's native fs cannot
  // stat individual files inside app.asar.
  const cliEntry = join(archive, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return {
    kind: 'local',
    source: 'desktop',
    command: executable,
    args: ['--expose-internals', cliEntry, ...args],
    cwd,
    shell: false,
    env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
    dshArgsStart: 2,
    desktop: { directory, home, cliEntry },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
    shell: shouldUseWindowsShell(command, platform),
    source,
  };
}

function shouldUseWindowsShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(command);
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
