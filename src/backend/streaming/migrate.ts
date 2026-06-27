/**
 * On-disk migration: convert legacy session.jsonl line formats to the
 * SSP-only persistence model.
 *
 * Older ACPilot versions persisted `event` lines and `rawAcpEvent` stream-part
 * wrappers. After Phase 4 the persistence layer only understands standard SSP
 * stream-part records. This module rewrites legacy files in place (backed up
 * first, idempotent via a marker line) so restored sessions remain readable.
 *
 * Invoked from extension.ts activate() once per workspace (guarded by a
 * globalState flag so it only runs once). The standalone CLI mirror lives at
 * scripts/migrate-session-jsonl.cjs.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ExtensionState } from '../../types';
import type * as vscode from 'vscode';

const ACP_DIR = '.acpilot';
const FILE_NAMES = ['session.jsonl', 'turns.jsonl'];
const MIGRATION_MARKER = 'v2-migrated';
const GLOBAL_STATE_FLAG = 'acpilot.migration.sessionJsonlV2.done';

// ---------------------------------------------------------------------------
// AcpEvent → SSP record conversion (best-effort, lossy for noisy events)
// ---------------------------------------------------------------------------

let sequenceCounter = 0;

interface LegacyMeta {
  turnIndex: number;
  requestId: string;
  sequence: number;
  createdAt: string;
  source: 'acp-event';
  sourceType?: string;
  sessionId?: string;
}

function freshMeta(event: { type?: string; sessionId?: string }): LegacyMeta {
  sequenceCounter += 1;
  return {
    turnIndex: 0,
    requestId: 'migrated',
    sequence: sequenceCounter,
    createdAt: new Date().toISOString(),
    source: 'acp-event',
    sourceType: event?.type,
    sessionId: event?.sessionId,
  };
}

function record(kind: string, payload: Record<string, unknown>, meta: LegacyMeta) {
  return {
    kind,
    version: 1,
    id: `migrated-${sequenceCounter}-${kind}`,
    payload,
    meta,
  };
}

/** Map a single legacy event object to zero or more SSP records. */
export function convertEvent(event: Record<string, any> | null | undefined): Record<string, unknown>[] {
  if (!event || typeof event !== 'object' || !event.type) {
    return [];
  }
  const meta = freshMeta(event);

  switch (event.type) {
    case 'part.updated': {
      const part = event.part;
      if (!part || typeof part !== 'object' || !part.type) {
        return [];
      }
      const sessionId = event.sessionId ?? part.sessionId;
      if (part.type === 'text') {
        return [record('assistantText', {
          partId: String(part.id ?? ''),
          text: String(part.text ?? ''),
          messageId: part.messageId,
          sessionId,
        }, meta)];
      }
      if (part.type === 'reasoning') {
        return [record('reasoning', {
          partId: String(part.id ?? ''),
          text: String(part.text ?? ''),
          messageId: part.messageId,
          sessionId,
        }, meta)];
      }
      if (part.type === 'tool') {
        const state = part.state || {};
        return [record('toolInvocation', {
          partId: String(part.id ?? ''),
          toolName: String(part.toolName ?? ''),
          callId: part.callId,
          state: {
            status: typeof state.status === 'string' ? state.status : 'completed',
            input: state.input && typeof state.input === 'object' ? state.input : {},
            output: typeof state.output === 'string' ? state.output : undefined,
            title: typeof state.title === 'string' ? state.title : undefined,
            startTime: typeof state.startTime === 'number' ? state.startTime : undefined,
            endTime: typeof state.endTime === 'number' ? state.endTime : undefined,
          },
          messageId: part.messageId,
          sessionId,
        }, meta)];
      }
      if (part.type === 'step-start' || part.type === 'step-finish') {
        return [record('sessionLifecycle', { eventType: 'session.idle', sessionId }, meta)];
      }
      return [];
    }

    case 'part.delta': {
      const field = event.field;
      if (field === 'reasoning') {
        return [record('reasoningDelta', {
          partId: String(event.partId ?? ''), delta: String(event.delta ?? ''), field, sessionId: event.sessionId,
        }, meta)];
      }
      return [record('assistantTextDelta', {
        partId: String(event.partId ?? ''), delta: String(event.delta ?? ''), field, sessionId: event.sessionId,
      }, meta)];
    }

    case 'session.diff':
      return [record('sessionDiff', {
        sessionId: String(event.sessionId ?? ''),
        diffs: Array.isArray(event.diffs) ? event.diffs : [],
      }, meta)];

    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
    case 'session.error':
    case 'session.idle':
    case 'session.status':
      return [record('sessionLifecycle', {
        eventType: event.type, sessionId: event.sessionId, parentId: event.parentId,
        title: event.title, error: event.error, status: event.status,
      }, meta)];

    case 'permission.asked': {
      const filepath = event.metadata && typeof event.metadata === 'object'
        ? event.metadata.filepath : undefined;
      const callId = event.tool ? event.tool.callId : undefined;
      if (!filepath || !callId) {
        return [];
      }
      return [record('externalEdit', {
        toolCallId: String(callId), uri: filepath, status: 'completed',
      }, meta)];
    }

    case 'question.asked':
      return [record('question', {
        questionId: String(event.questionId ?? ''),
        questions: Array.isArray(event.questions) ? event.questions : [],
        status: 'asked',
      }, meta)];

    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected':
    case 'server.connected':
    case 'server.heartbeat':
      return [];

    default:
      return [];
  }
}

function parseLine(line: string): { v?: number; t?: string; d?: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed) {return null;}
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && typeof obj.t === 'string') {
      return obj;
    }
  } catch {
    // not JSON
  }
  return null;
}

/** Convert one session JSONL file's contents. Returns new content or null if unchanged. */
export function convertFileLines(text: string): { changed: boolean; content: string | null } {
  sequenceCounter = 0;
  const rawLines = text.split(/\r?\n/);
  const out: string[] = [];
  let changed = false;
  let alreadyMigrated = false;

  for (const raw of rawLines) {
    if (raw.trim() === '') {continue;}

    const marker = parseLine(raw);
    if (marker && marker.t === 'migration') {
      if (marker.d === MIGRATION_MARKER) {alreadyMigrated = true;}
      continue;
    }

    const parsed = parseLine(raw);
    if (!parsed) {
      changed = true;
      continue;
    }

    if (parsed.t === 'event' && parsed.d) {
      for (const r of convertEvent(parsed.d as Record<string, any>)) {
        out.push(JSON.stringify({ v: 2, t: 'stream-part', d: r }));
      }
      changed = true;
      continue;
    }

    if (parsed.t === 'stream-part' && parsed.d) {
      const d = parsed.d as { kind?: string; payload?: { event?: unknown } };
      if (d.kind === 'rawAcpEvent' && d.payload && d.payload.event) {
        for (const r of convertEvent(d.payload.event as Record<string, any>)) {
          out.push(JSON.stringify({ v: 2, t: 'stream-part', d: r }));
        }
        changed = true;
        continue;
      }
      out.push(JSON.stringify(parsed));
      continue;
    }

    out.push(JSON.stringify(parsed));
  }

  if (alreadyMigrated && !changed) {
    return { changed: false, content: null };
  }

  const header = JSON.stringify({ v: 2, t: 'migration', d: MIGRATION_MARKER });
  return { changed: true, content: [header, ...out].join('\n') + '\n' };
}

async function migrateFile(filePath: string, log: (m: string) => void): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return false;
  }
  const result = convertFileLines(text);
  if (!result.changed) {return false;}
  try {
    await fs.copyFile(filePath, filePath + '.bak-v2migrate');
  } catch (err) {
    log(`[migrate] backup failed ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  try {
    await fs.writeFile(filePath, result.content!, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function migrateSessionDir(dir: string, log: (m: string) => void): Promise<number> {
  let count = 0;
  for (const name of FILE_NAMES) {
    const p = path.join(dir, name);
    try {
      await fs.access(p);
    } catch {
      continue;
    }
    if (await migrateFile(p, log)) {count += 1;}
  }
  return count;
}

async function migrateBackendDir(backendDir: string, log: (m: string) => void): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(backendDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    count += await migrateSessionDir(path.join(backendDir, entry.name), log);
  }
  return count;
}

async function migrateWorkspace(workspaceRoot: string, log: (m: string) => void): Promise<number> {
  const acpRoot = path.join(workspaceRoot, ACP_DIR);
  let backends;
  try {
    backends = await fs.readdir(acpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of backends) {
    if (!entry.isDirectory()) {continue;}
    total += await migrateBackendDir(path.join(acpRoot, entry.name), log);
  }
  return total;
}

/**
 * Run the one-time workspace migration, guarded by a globalState flag so it
 * only executes once per machine. Safe to call on every activation.
 */
export async function runActivationMigration(
  context: vscode.ExtensionContext,
  state: ExtensionState | undefined,
  workspaceRoot: string | undefined,
): Promise<void> {
  const log = (m: string) => state?.outputChannel.appendLine(m);
  if (!workspaceRoot) {return;}
  if (context.globalState.get<boolean>(GLOBAL_STATE_FLAG)) {return;}
  try {
    const n = await migrateWorkspace(workspaceRoot, log);
    if (n > 0) {
      log(`[migrate] migrated ${n} session file(s) to SSP-only format`);
    }
    await context.globalState.update(GLOBAL_STATE_FLAG, true);
  } catch (err) {
    log(`[migrate] error: ${err instanceof Error ? err.message : String(err)}`);
    // Do not set the flag on failure — retry next activation.
  }
}
