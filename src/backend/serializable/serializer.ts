/**
 * Backend/SSP stream serializer (JSONL format).
 *
 * Each line is a JSON object of the form:
 *   {"v":2,"t":"<type>","d":<data>}
 *
 * Line types:
 *   version   — format version marker
 *   turn-start / turn-end turn envelopes
 *   stream-part SSP records
 *   snapshot    file snapshot records
 *
 * No VSCode or SDK imports — plain Node.js only.
 */

import { promises as fs } from 'node:fs';
import type { StreamPartRecord } from '../../ssp/types';

// ===========================================================================
// Line builders / parsers
// ===========================================================================

const LINE_TYPES = {
  VERSION: 'version',
  TURN_START: 'turn-start',
  TURN_END: 'turn-end',
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
  if (!trimmed) {return null;}

  try {
    const parsed = JSON.parse(trimmed) as ParsedLine;
    if (typeof parsed !== 'object' || parsed === null) {return null;}
    if (typeof parsed.v !== 'number') {return null;}
    if (typeof parsed.t !== 'string') {return null;}
    return parsed;
  } catch {
    return null;
  }
}

// ===========================================================================
// Canonical stream envelope
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
// SSP records and snapshots
// ===========================================================================

export async function writeStreamPart(
  filePath: string,
  part: StreamPartRecord,
): Promise<void> {
  await fs.appendFile(
    filePath,
    buildLine(LINE_TYPES.STREAM_PART, part),
    'utf-8',
  );
}

export async function readSessionStreamParts<T extends StreamPartRecord = StreamPartRecord>(
  filePath: string,
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) {return [];}

  const parts: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) {continue;}
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

export interface SessionTurnStreamParts<T extends StreamPartRecord = StreamPartRecord> {
  turnIndex: number;
  start?: unknown;
  parts: T[];
  end?: unknown;
}

export async function readSessionTurnStreamParts<
  T extends StreamPartRecord = StreamPartRecord,
>(
  filePath: string,
): Promise<SessionTurnStreamParts<T>[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) {return [];}

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
    if (!parsed) {continue;}

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
  if (!content.trim()) {return [];}

  const snapshots: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) {continue;}
    if (parsed.t === LINE_TYPES.SNAPSHOT) {
      snapshots.push(parsed.d as T);
    }
  }
  return snapshots;
}
