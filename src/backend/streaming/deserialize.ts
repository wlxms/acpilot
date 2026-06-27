/**
 * Deserialization utilities for session.jsonl + meta.jsonl → SSP reconstruction.
 *
 * Pipeline:
 *   session.jsonl → readAllStreamParts → materializeRecords → finalizeIncompleteStates
 *   meta.jsonl    → readMetaIndex
 *   → createSSPFromRecord → push to SSS (same path as live)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type StreamPartRecord,
  type AnySerializableStreamPart,
  type SerializableToolState,
  isMutableKind,
} from '../../ssp/types';
import type { FileSnapshotRecord } from '../serializable/types';
import { parseLine } from '../serializable/serializer';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { UserPromptSSP } from '../../ssp/impl/user-prompt';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { QuestionSSP } from '../../ssp/impl/question';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { SessionLifecycleSSP, SessionDiffSSP } from '../../ssp/impl/session-lifecycle';
import { RawAcpEventSSP } from '../../ssp/impl/raw-acp-event';

// ===========================================================================
// Read functions
// ===========================================================================

/** Read all stream-part lines from a JSONL file */
export async function readAllStreamParts(filePath: string): Promise<StreamPartRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const records: StreamPartRecord[] = [];
  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (parsed?.t === 'stream-part') {
      records.push(parsed.d as StreamPartRecord);
    }
  }
  return records;
}

/** Read meta.jsonl, group by id, last-write-wins → Map<id, data> */
/** Read all snapshot lines from a JSONL file. */
export async function readAllSnapshots(filePath: string): Promise<FileSnapshotRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const snapshots: FileSnapshotRecord[] = [];
  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (parsed?.t === 'snapshot') {
      snapshots.push(parsed.d as FileSnapshotRecord);
    }
  }
  return snapshots;
}

export interface SubsessionRecordSet {
  subAgentInvocationId: string;
  parentSubAgentInvocationId?: string;
  subAgentPath: string[];
  filePath: string;
  metaPath: string;
  records: StreamPartRecord[];
  snapshots: FileSnapshotRecord[];
  metaIndex: Map<string, Record<string, unknown>>;
}

export async function readSubsessionRecords(sessionDir: string): Promise<SubsessionRecordSet[]> {
  const root = path.join(sessionDir, 'subsessions');
  const result: SubsessionRecordSet[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'subsession.jsonl') {
        continue;
      }

      const rel = path.relative(root, path.dirname(entryPath));
      const subAgentPath = rel.split(path.sep).filter(part => part && part !== 'subsessions');
      const subAgentInvocationId = subAgentPath[subAgentPath.length - 1] ?? rel;
      const parentSubAgentInvocationId = subAgentPath.length > 1
        ? subAgentPath[subAgentPath.length - 2]
        : undefined;
      const metaPath = path.join(path.dirname(entryPath), 'meta.jsonl');
      result.push({
        subAgentInvocationId,
        parentSubAgentInvocationId,
        subAgentPath,
        filePath: entryPath,
        metaPath,
        records: (await readAllStreamParts(entryPath)).map(record =>
          withSubsessionMeta(record, subAgentInvocationId, parentSubAgentInvocationId, subAgentPath),
        ),
        snapshots: await readAllSnapshots(entryPath),
        metaIndex: await readMetaIndex(metaPath),
      });
    }
  }

  await walk(root);
  return result.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function withSubsessionMeta(
  record: StreamPartRecord,
  subAgentInvocationId: string,
  parentSubAgentInvocationId: string | undefined,
  subAgentPath: string[],
): StreamPartRecord {
  const payload = record.payload;
  const nextPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? {
        ...(payload as Record<string, unknown>),
        subAgentInvocationId: (payload as Record<string, unknown>).subAgentInvocationId ?? subAgentInvocationId,
      }
    : payload;

  return {
    ...record,
    payload: nextPayload,
    meta: {
      ...record.meta,
      subAgentInvocationId: record.meta.subAgentInvocationId ?? subAgentInvocationId,
      parentSubAgentInvocationId: record.meta.parentSubAgentInvocationId ?? parentSubAgentInvocationId,
      subAgentPath: record.meta.subAgentPath ?? subAgentPath,
    },
  };
}

export async function readMetaIndex(
  filePath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const index = new Map<string, Record<string, unknown>>();
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return index;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const id = parsed.type === 'session' ? 'session' : (parsed.id ?? 'unknown');
      const prev = index.get(id) ?? {};
      index.set(id, { ...prev, ...parsed });
    } catch {
      // skip malformed lines
    }
  }
  return index;
}

// ===========================================================================
// materializeRecords: read-time merge
// ===========================================================================

/**
 * Merge raw records into materialized parts.
 *
 * Rules:
 * - Mutable kinds (toolInvocation, question, externalEdit, sessionLifecycle):
 *   Global aggregate by id — latest payload wins. Records can be non-consecutive.
 * - Append-only kinds (reasoning, assistantText, etc.):
 *   Consecutive same-id merge — concatenate delta text.
 *   Non-consecutive (interrupted by different id) → new part.
 */
export function materializeRecords(records: StreamPartRecord[]): StreamPartRecord[] {
  const result: StreamPartRecord[] = [];
  const mutableIndex = new Map<string, number>(); // id → index in result

  for (const record of records) {
    if (isMutableKind(record.kind)) {
      // Mutable: global aggregate by id
      const existingIdx = mutableIndex.get(record.id);
      if (existingIdx !== undefined) {
        result[existingIdx].payload = mergePayload(
          result[existingIdx].payload,
          record.payload,
          record.kind,
        );
        result[existingIdx].meta = record.meta; // latest meta
      } else {
        mutableIndex.set(record.id, result.length);
        result.push({ ...record });
      }
    } else {
      // Append-only: consecutive same-id merge
      const last = result[result.length - 1];
      if (last && last.id === record.id && !isMutableKind(last.kind)) {
        last.payload = mergePayload(last.payload, record.payload, record.kind);
      } else {
        result.push({ ...record });
      }
    }
  }

  return result;
}

/** Merge two payloads based on SSP kind */
function mergePayload(
  prev: unknown,
  curr: unknown,
  kind: string,
): unknown {
  const p = prev as Record<string, unknown>;
  const c = curr as Record<string, unknown>;
  if (kind === 'toolInvocation') {
    return {
      ...c,
      state: mergeToolState(
        p.state as SerializableToolState | undefined,
        c.state as SerializableToolState | undefined,
      ),
    };
  }

  // Text-based append-only: concatenate delta/text
  if (kind === 'reasoning' || kind === 'assistantText') {
    const prevText = (p.text as string) ?? '';
    const currText = (c.text as string) ?? '';
    return { ...c, text: prevText + currText };
  }

  // Default: latest wins
  return c;
}

/**
 * Merge tool states. Error is terminal — once a tool errors,
 * subsequent states cannot overwrite the error.
 */
function mergeToolState(
  prev: SerializableToolState | undefined,
  curr: SerializableToolState | undefined,
): SerializableToolState {
  if (!curr) return prev ?? { status: 'pending', input: {} };
  if (!prev) return curr;

  // Error terminal: previous error is not overwritten
  if (prev.status === 'error') {
    return {
      ...curr,
      status: 'error',
      error: prev.error ?? curr.error,
    };
  }

  // Deep merge state
  return { ...prev, ...curr };
}

// ===========================================================================
// finalizeIncompleteStates: detect interrupted tools
// ===========================================================================

/**
 * Detect mutable parts that never reached a terminal state (completed/error)
 * and mark them as interrupted. Only applies to non-inProgress sessions.
 */
export function finalizeIncompleteStates(
  records: StreamPartRecord[],
  sessionStatus: string,
): StreamPartRecord[] {
  // In-progress sessions may have legitimately pending tools
  if (sessionStatus === 'inProgress') return records;

  return records.map(record => {
    if (record.kind === 'toolInvocation') {
      const status = (record.payload as { state?: { status?: string } })?.state?.status;
      if (status === 'pending' || status === 'running') {
        const payload = record.payload as Record<string, unknown>;
        return {
          ...record,
          payload: {
            ...payload,
            state: {
              ...(record.payload as { state?: Record<string, unknown> }).state,
              status: 'error',
              error: 'Interrupted — session ended before completion',
            },
          },
        };
      }
    }

    if (record.kind === 'question') {
      const status = (record.payload as { status?: string })?.status;
      if (status === 'asked') {
        const payload = record.payload as Record<string, unknown>;
        return {
          ...record,
          payload: { ...payload, status: 'skipped' },
        };
      }
    }

    if (record.kind === 'externalEdit') {
      const status = (record.payload as { status?: string })?.status;
      if (status === 'pending') {
        const payload = record.payload as Record<string, unknown>;
        return {
          ...record,
          payload: { ...payload, status: 'completed' },
        };
      }
    }

    return record;
  });
}

// ===========================================================================
// createSSPFromRecord: factory
// ===========================================================================

/**
 * Create an SSP instance from a serialized record.
 * For replay/restore — SSPs are created without live callbacks (no-op callbacks).
 */
export function createSSPFromRecord(
  record: StreamPartRecord,
  metaIndex?: ReadonlyMap<string, Record<string, unknown>>,
): AnySerializableStreamPart {
  // For externalEdit, inject undoStopId from meta if available
  if (record.kind === 'externalEdit' && metaIndex) {
    const meta = metaIndex.get(record.id);
    const undoStopId = meta?.undoStopId as string | undefined;
    if (undoStopId) {
      record = {
        ...record,
        payload: { ...(record.payload as Record<string, unknown>), undoStopId, editId: undoStopId },
      };
    }
  }

  const payload = record.payload as Record<string, unknown>;

  switch (record.kind) {
    case 'userPrompt':
      return new UserPromptSSP(payload as never, record.meta, record.id);

    case 'assistantText': {
      const p = payload as { partId: string; text: string; messageId?: string; sessionId?: string };
      return new AssistantTextSSP({
        partId: p.partId,
        delta: p.text,
        messageId: p.messageId,
        sessionId: p.sessionId ?? record.meta.sessionId,
      }, record.meta, record.id);
    }

    case 'reasoning': {
      const p = payload as {
        partId: string;
        text: string;
        messageId?: string;
        sessionId?: string;
        thinkingId?: string;
        metadata?: Record<string, unknown>;
      };
      return new ReasoningSSP({
        partId: p.partId,
        delta: p.text,
        messageId: p.messageId,
        sessionId: p.sessionId ?? record.meta.sessionId,
        thinkingId: p.thinkingId,
        metadata: p.metadata,
      }, record.meta, record.id);
    }

    case 'toolInvocation':
      return new ToolInvocationSSP(payload as never, record.meta, record.id);

    case 'question':
      return new QuestionSSP(payload as never, undefined, record.meta, record.id);

    case 'externalEdit':
      return new ExternalEditSSP(payload as never, {
        onBaselineCaptured: () => {},
        onSnapshot: () => {},
      }, record.meta, record.id);

    case 'sessionLifecycle':
      return new SessionLifecycleSSP(payload as never, record.meta, record.id);

    case 'sessionDiff':
      return new SessionDiffSSP(payload as never, record.meta, record.id);

    case 'rawAcpEvent':
      return new RawAcpEventSSP(payload as never, record.meta, record.id);

    default:
      // Unknown kind → wrap payload as raw event
      return new RawAcpEventSSP({ event: record.payload }, record.meta, record.id);
  }
}
