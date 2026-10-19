import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DSH_BRIDGE_PATCH_FILENAME = 'acpilot-dsh-bridge.patch.yml';

export interface DshBridgePatchOptions {
  /** Absolute path to the bundled bridge module. */
  modulePath: string;
  /** Absolute writable directory owned by ACPilot for generated launch overlays. */
  patchDirectory: string;
}

/**
 * Materialize a launcher-local DSH patch that imports the bridge by file URL.
 *
 * The patch is generated instead of installing into the user's DSH profile so
 * an ACPilot launch can use the bridge with a custom DSH checkout, wrapper, or
 * modified package while leaving that user's profile-owned plugin tree intact.
 */
export async function ensureDshBridgePatch(options: DshBridgePatchOptions): Promise<string> {
  const modulePath = options.modulePath.trim();
  const patchDirectory = options.patchDirectory.trim();
  if (!isAbsolute(modulePath)) {
    throw new Error('DSH bridge module path must be absolute');
  }
  if (!isAbsolute(patchDirectory)) {
    throw new Error('DSH bridge patch directory must be absolute');
  }
  try {
    await access(modulePath);
  } catch {
    throw new Error(`ACPilot DSH bridge module was not found: ${modulePath}`);
  }

  await mkdir(patchDirectory, { recursive: true });
  const patchPath = join(patchDirectory, DSH_BRIDGE_PATCH_FILENAME);
  const moduleUrl = pathToFileURL(modulePath).href;
  const source = [
    '- insert:',
    '    - id: acpilot-dsh-bridge',
    `      name: ${JSON.stringify(moduleUrl)}`,
    '',
  ].join('\n');
  await writeFile(patchPath, source, 'utf8');
  return patchPath;
}

/**
 * Insert the ACPilot overlay before DSH hands the remaining arguments to the
 * selected app. DSH launcher options must stay before an app-owned flag such as
 * `--resume`; otherwise Commander passes a later `--patch` through untouched.
 */
export function appendDshBridgePatch(
  command: string,
  args: readonly string[],
  patchPath: string,
): string[] {
  const insertionIndex = dshLauncherPrefixLength(command, args);
  return [
    ...args.slice(0, insertionIndex),
    '--patch',
    patchPath,
    ...args.slice(insertionIndex),
  ];
}

/**
 * Locate the first argument owned by the DSH launcher. Package managers and
 * Node wrappers have their own arguments before DSH sees `--patch`; inserting
 * earlier makes the wrapper consume ACPilot's flag and silently skips the
 * bridge.
 */
function dshLauncherPrefixLength(command: string, args: readonly string[]): number {
  const executable = basename(command).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/i, '');
  if (executable === 'npm') {
    const dshIndex = findDshScriptIndex(args);
    const separatorIndex = dshIndex >= 0
      ? args.findIndex((value, index) => index > dshIndex && value === '--')
      : -1;
    return separatorIndex >= 0 ? separatorIndex + 1 : dshIndex >= 0 ? dshIndex + 1 : 0;
  }
  if (executable === 'pnpm' || executable === 'yarn' || executable === 'bun') {
    const dshIndex = findDshScriptIndex(args);
    return dshIndex >= 0 ? dshIndex + 1 : 0;
  }
  if (executable === 'node' || executable === 'nodejs' || executable === 'tsx' || executable === 'ts-node') {
    const scriptIndex = args.findIndex(value => /\.(?:c|m)?js$|\.(?:c|m)?ts$|\.tsx$/i.test(value));
    return scriptIndex >= 0 ? scriptIndex + 1 : 0;
  }
  return directDshArgumentIndex(args);
}

function directDshArgumentIndex(args: readonly string[]): number {
  const optionsWithValue = new Set(['--profile', '--from-default-profile', '--patch']);
  const booleanOptions = new Set(['--dump-config', '--dump-default-config']);
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === '--') {return index;}
    if (optionsWithValue.has(value)) {
      index += 2;
      continue;
    }
    if ([...optionsWithValue].some(option => value.startsWith(`${option}=`))
      || booleanOptions.has(value)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function findDshScriptIndex(args: readonly string[]): number {
  return args.findIndex((value, index) => value === 'dsh' && (index === 0 || args[index - 1] === 'run' || args[index - 1] === 'exec'));
}
