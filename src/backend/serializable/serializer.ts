/**
 * ACP/SSP stream serializer (JSONL format).
 *
 * Each line is a JSON object of the form:
 *   {"v":2,"t":"<type>","d":<data>}
 *
 * Line types:
 *   version   — format version marker
 *   meta      — session metadata (v1)
 *   event       legacy raw ACP events
 *   stream-part SerializableStreamPart records
 *   snapshot    file snapshot records
 *
 * No VSCode or SDK imports — plain Node.js only.
 */

import { promises as fs } from 'node:fs';
import type { SerializableStreamPart } from './types';

// ===========================================================================
// Line builders / parsers
// ===========================================================================

const LINE_TYPES = {
  VERSION: 'version',
  META: 'meta',
  TURN_START: 'turn-start',
  TURN_END: 'turn-end',
  EVENT: 'event',
  STREAM_PART: 'stream-part',
  SNAPSHOT: 'snapshot',
} as const;

interface ParsedLine {
  v: number;
  t: string;
  d: unknown;
}

/**
 * Build a JSONL line in the v2 format.
 *
 * @param type - The line type discriminator
 * @param data - The payload to serialize
 * @returns A newline-terminated JSON string
 */
export function buildLine(type: string, data: unknown): string {
  return JSON.stringify({ v: 2, t: type, d: data }) + '\n';
}

/**
 * Parse a single JSONL line.
 *
 * @param line - Raw line string
 * @returns The parsed line object, or `null` if the line is empty/invalid
 */
export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as ParsedLine;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.v !== 'number') return null;
    if (typeof parsed.t !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ===========================================================================
// v1 serialization (version header, metadata)
// ===========================================================================

/**
 * Write a version header line to a JSONL file.
 * Overwrites the file (use once at session start).
 *
 * @param filePath - Absolute path to the session file
 */
export async function writeVersionHeader(filePath: string): Promise<void> {
  await fs.writeFile(filePath, buildLine(LINE_TYPES.VERSION, '2.0'), 'utf-8');
}

/**
 * Append a metadata line to a JSONL file.
 *
 * @param filePath - Absolute path to the session file
 * @param meta     - Key-value metadata payload
 */
export async function writeMeta(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await fs.appendFile(filePath, buildLine(LINE_TYPES.META, meta), 'utf-8');
}

/**
 * Read and return all metadata records from a JSONL file.
 *
 * @param filePath - Absolute path to the session file
 * @returns Array of metadata objects
 */
export async function readSessionMeta(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const records: Record<string, unknown>[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.META) {
      records.push(parsed.d as Record<string, unknown>);
    }
  }
  return records;
}

/**
 * Write session metadata to a JSONL file. Alias for writeMeta.
 *
 * @param filePath - Absolute path to the session file
 * @param meta     - Key-value metadata payload
 */
export async function writeSessionMeta(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeMeta(filePath, meta);
}

export async function writeTurnStart(
  filePath: string,
  turn: unknown,
): Promise<void> {
  await fs.appendFile(filePath, buildLine(LINE_TYPES.TURN_START, turn), 'utf-8');
}

export async function writeTurnEnd(
  filePath: string,
  turn: unknown,
): Promise<void> {
  await fs.appendFile(filePath, buildLine(LINE_TYPES.TURN_END, turn), 'utf-8');
}

// ===========================================================================
// v2 serialization (events, snapshots)
// ===========================================================================

/**
 * Write a legacy raw ACP event as a JSONL line (append-mode).
 *
 * @param filePath - Absolute path to the session events file
 * @param event    - The ACP event to persist
 */
export async function writeLegacyEvent(
  filePath: string,
  event: unknown,
): Promise<void> {
  await fs.appendFile(
    filePath,
    buildLine(LINE_TYPES.EVENT, event),
    'utf-8',
  );
}

export async function writeStreamPart(
  filePath: string,
  part: SerializableStreamPart,
): Promise<void> {
  await fs.appendFile(
    filePath,
    buildLine(LINE_TYPES.STREAM_PART, part),
    'utf-8',
  );
}

export async function readSessionStreamParts<T extends SerializableStreamPart = SerializableStreamPart>(
  filePath: string,
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const parts: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.STREAM_PART) {
      parts.push(parsed.d as T);
    }
  }
  return parts;
}

/**
 * Write a file snapshot as a JSONL line (append-mode).
 *
 * @param filePath - Absolute path to the snapshot file
 * @param snapshot - The file snapshot record to persist
 */
export async function writeSnapshotLine(
  filePath: string,
  snapshot: unknown,
): Promise<void> {
  await fs.appendFile(
    filePath,
    buildLine(LINE_TYPES.SNAPSHOT, snapshot),
    'utf-8',
  );
}

/**
 * Read all legacy raw ACP events from a JSONL file.
 *
 * @param filePath - Absolute path to the session events file
 * @returns Array of deserialized ACP events
 */
export async function readLegacySessionEvents<T = unknown>(
  filePath: string,
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const events: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.EVENT) {
      events.push(parsed.d as T);
    }
  }
  return events;
}

export interface LegacySessionTurnEvents<T = unknown> {
  turnIndex: number;
  start?: unknown;
  events: T[];
  end?: unknown;
}

export interface SessionTurnStreamParts<T extends SerializableStreamPart = SerializableStreamPart> {
  turnIndex: number;
  start?: unknown;
  parts: T[];
  end?: unknown;
}

export async function readLegacySessionTurnEvents<T = unknown>(
  filePath: string,
): Promise<LegacySessionTurnEvents<T>[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const turns: LegacySessionTurnEvents<T>[] = [];
  let current: LegacySessionTurnEvents<T> | undefined;

  const ensureTurn = (turnIndex: number): LegacySessionTurnEvents<T> => {
    if (!current || current.turnIndex !== turnIndex) {
      current = { turnIndex, events: [] };
      turns.push(current);
    }
    return current;
  };

  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;

    if (parsed.t === LINE_TYPES.TURN_START) {
      const data = parsed.d as { turnIndex?: unknown };
      const turnIndex = typeof data.turnIndex === 'number' && Number.isFinite(data.turnIndex)
        ? data.turnIndex
        : turns.length;
      current = { turnIndex, start: parsed.d, events: [] };
      turns.push(current);
      continue;
    }

    if (parsed.t === LINE_TYPES.EVENT) {
      ensureTurn(current?.turnIndex ?? 0).events.push(parsed.d as T);
      continue;
    }

    if (parsed.t === LINE_TYPES.TURN_END) {
      const data = parsed.d as { turnIndex?: unknown };
      const turnIndex = typeof data.turnIndex === 'number' && Number.isFinite(data.turnIndex)
        ? data.turnIndex
        : current?.turnIndex ?? 0;
      ensureTurn(turnIndex).end = parsed.d;
      current = undefined;
    }
  }

  return turns.filter(turn => turn.events.length > 0 || turn.start || turn.end);
}

export async function readSessionTurnStreamParts<
  T extends SerializableStreamPart = SerializableStreamPart,
>(
  filePath: string,
): Promise<SessionTurnStreamParts<T>[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const turns: SessionTurnStreamParts<T>[] = [];
  let current: SessionTurnStreamParts<T> | undefined;

  const ensureTurn = (turnIndex: number): SessionTurnStreamParts<T> => {
    if (!current || current.turnIndex !== turnIndex) {
      current = { turnIndex, parts: [] };
      turns.push(current);
    }
    return current;
  };

  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;

    if (parsed.t === LINE_TYPES.TURN_START) {
      const data = parsed.d as { turnIndex?: unknown };
      const turnIndex = typeof data.turnIndex === 'number' && Number.isFinite(data.turnIndex)
        ? data.turnIndex
        : turns.length;
      current = { turnIndex, start: parsed.d, parts: [] };
      turns.push(current);
      continue;
    }

    if (parsed.t === LINE_TYPES.STREAM_PART) {
      const part = parsed.d as T;
      const turnIndex = typeof part?.meta?.turnIndex === 'number' && Number.isFinite(part.meta.turnIndex)
        ? part.meta.turnIndex
        : current?.turnIndex ?? 0;
      ensureTurn(turnIndex).parts.push(part);
      continue;
    }

    if (parsed.t === LINE_TYPES.TURN_END) {
      const data = parsed.d as { turnIndex?: unknown };
      const turnIndex = typeof data.turnIndex === 'number' && Number.isFinite(data.turnIndex)
        ? data.turnIndex
        : current?.turnIndex ?? 0;
      ensureTurn(turnIndex).end = parsed.d;
      current = undefined;
    }
  }

  return turns.filter(turn => turn.parts.length > 0 || turn.start || turn.end);
}

/**
 * Read all FileSnapshotRecords from a JSONL file.
 *
 * @param filePath - Absolute path to the snapshot file
 * @returns Array of deserialized file snapshot records
 */
export async function readSessionSnapshots<T = unknown>(
  filePath: string,
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const snapshots: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.SNAPSHOT) {
      snapshots.push(parsed.d as T);
    }
  }
  return snapshots;
}
