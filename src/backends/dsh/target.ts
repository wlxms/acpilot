import { isAbsolute } from 'node:path';

export const DEFAULT_DSH_PACKAGE_SPEC = '@deepseek-ai/dsh@latest';
export const DEFAULT_DSH_COMMAND = 'dsh';
export const DEFAULT_DSH_ARGS = ['--profile', 'acp'] as const;

export interface DshTarget {
  id: string;
  name: string;
  command: string;
  args: string[];
  launchCwd: string;
  /** Optional remote ACP endpoint for a DSH instance already running elsewhere. */
  endpoint?: string;
  installDirectory?: string;
  packageSpec: string;
  createdAt: string;
  updatedAt: string;
}

export interface DshTargetInput {
  id?: string;
  name?: string;
  command: string;
  args?: readonly string[];
  launchCwd: string;
  endpoint?: string;
  installDirectory?: string;
  packageSpec?: string;
}

export function normalizeDshTarget(
  input: DshTargetInput,
  existing?: DshTarget,
): DshTarget {
  const command = input.command.trim();
  if (!command) {
    throw new Error('DSH command is required');
  }
  const launchCwd = input.launchCwd.trim();
  if (!isAbsolute(launchCwd)) {
    throw new Error('DSH launch directory must be absolute');
  }
  const endpoint = input.endpoint === undefined
    ? existing?.endpoint
    : input.endpoint.trim() || undefined;
  if (endpoint !== undefined && !isDshEndpoint(endpoint)) {
    throw new Error('DSH endpoint must use ws:// or wss://');
  }
  const installDirectory = input.installDirectory?.trim() || existing?.installDirectory;
  if (installDirectory !== undefined && !isAbsolute(installDirectory)) {
    throw new Error('DSH install directory must be absolute');
  }
  const packageSpec = input.packageSpec?.trim() || existing?.packageSpec || DEFAULT_DSH_PACKAGE_SPEC;
  const now = new Date().toISOString();
  const id = input.id?.trim() || existing?.id || createDshTargetId();
  const name = input.name?.trim() || existing?.name || command;
  return {
    id,
    name,
    command,
    args: [...(input.args ?? existing?.args ?? DEFAULT_DSH_ARGS)],
    launchCwd,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(installDirectory !== undefined ? { installDirectory } : {}),
    packageSpec,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function isDshTarget(value: unknown): value is DshTarget {
  if (!value || typeof value !== 'object') {return false;}
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.command === 'string'
    && Array.isArray(candidate.args)
    && candidate.args.every(arg => typeof arg === 'string')
    && typeof candidate.launchCwd === 'string'
    && typeof candidate.packageSpec === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && (candidate.endpoint === undefined
      || (typeof candidate.endpoint === 'string' && isDshEndpoint(candidate.endpoint)))
    && (candidate.installDirectory === undefined || typeof candidate.installDirectory === 'string');
}

export function isDshEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

function createDshTargetId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return `dsh-${g.crypto.randomUUID()}`;
  }
  return `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
