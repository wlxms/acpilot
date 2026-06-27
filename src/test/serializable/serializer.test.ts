/**
 * Tests for the ACP event-stream serializer (v2 JSONL format).
 *
 * Covers both v1 (version header, metadata) and v2 (events, snapshots)
 * serialization functions. Uses temporary directories for file I/O isolation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildLine,
  parseLine,
  writeVersionHeader,
  writeMeta,
  readSessionMeta,
  writeSessionMeta,
  writeTurnStart,
  writeTurnEnd,
  writeLegacyEvent,
  writeStreamPart,
  writeSnapshotLine,
  readLegacySessionEvents,
  readLegacySessionTurnEvents,
  readSessionStreamParts,
  readSessionTurnStreamParts,
  readSessionSnapshots,
} from '../../backend/serializable/serializer';
import type { FileSnapshotRecord, SerializableStreamPart } from '../../backend/serializable/types';

// ===========================================================================
// Helpers
// ===========================================================================

/** A temp directory path shared within a test. */
let tmpDir: string;

/**
 * Create a fresh temp directory before each test.
 * We use afterEach for cleanup so the directory lives through the test.
 */
async function getTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ser-test-'));
  tmpDir = dir;
  return dir;
}

/**
 * Full path to a test file within the current temp directory.
 */
function testFile(name = 'session.jsonl'): string {
  return path.join(tmpDir, name);
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  }
});

// ===========================================================================
// buildLine / parseLine
// ===========================================================================

describe('buildLine / parseLine', () => {
  it('buildLine produces a newline-terminated JSON string', () => {
    const line = buildLine('event', { foo: 'bar' });
    expect(line).toMatch(/\n$/);
    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({ v: 2, t: 'event', d: { foo: 'bar' } });
  });

  it('buildLine handles null data', () => {
    const line = buildLine('version', '2.0');
    expect(line).toMatch(/\n$/);
    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({ v: 2, t: 'version', d: '2.0' });
  });

  it('parseLine returns null for empty input', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('parseLine returns null for invalid JSON', () => {
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('{broken}')).toBeNull();
  });

  it('parseLine returns null for malformed structure (no v field)', () => {
    expect(parseLine('{"t":"event","d":{}}')).toBeNull();
  });

  it('parseLine returns null for non-object JSON', () => {
    expect(parseLine('"string"')).toBeNull();
  });

  it('parseLine roundtrips a valid line', () => {
    const original = { v: 2, t: 'event', d: { key: 'value' } };
    const line = JSON.stringify(original);
    const parsed = parseLine(line);
    expect(parsed).toEqual(original);
  });

  it('parseLine handles lines with surrounding whitespace', () => {
    const line = '  {"v":2,"t":"meta","d":{}}  ';
    const parsed = parseLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe('meta');
  });
});

// ===========================================================================
// v1: Version header
// ===========================================================================

describe('writeVersionHeader', () => {
  it('writes a version line to a new file', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    await writeVersionHeader(fp);

    const content = await fs.readFile(fp, 'utf-8');
    expect(content).toMatch(/\n$/);

    const parsed = parseLine(content.trim());
    expect(parsed).not.toBeNull();
    expect(parsed!.v).toBe(2);
    expect(parsed!.t).toBe('version');
    expect(parsed!.d).toBe('2.0');
  });

  it('overwrites an existing file', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    // Write some garbage first
    await fs.writeFile(fp, 'garbage\n', 'utf-8');
    await writeVersionHeader(fp);

    const content = await fs.readFile(fp, 'utf-8');
    // Should only have the version line, no garbage
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = parseLine(lines[0]);
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe('version');
  });
});

// ===========================================================================
// v1: Metadata
// ===========================================================================

describe('writeMeta / readSessionMeta / writeSessionMeta', () => {
  it('writeMeta appends a meta line', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    await writeVersionHeader(fp);
    await writeMeta(fp, { key: 'value', count: 42 });

    const content = await fs.readFile(fp, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed = parseLine(lines[1]);
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe('meta');
    expect(parsed!.d).toEqual({ key: 'value', count: 42 });
  });

  it('writeSessionMeta delegates to writeMeta', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    await writeVersionHeader(fp);
    await writeSessionMeta(fp, { sessionId: 'ses_001' });

    const meta = await readSessionMeta(fp);
    expect(meta).toHaveLength(1);
    expect(meta[0]).toEqual({ sessionId: 'ses_001' });
  });

  it('readSessionMeta returns all meta records', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    await writeVersionHeader(fp);
    await writeMeta(fp, { step: 1 });
    await writeMeta(fp, { step: 2 });
    await writeMeta(fp, { step: 3 });

    const meta = await readSessionMeta(fp);
    expect(meta).toHaveLength(3);
    expect(meta[0]).toEqual({ step: 1 });
    expect(meta[1]).toEqual({ step: 2 });
    expect(meta[2]).toEqual({ step: 3 });
  });

  it('readSessionMeta ignores non-meta lines', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    await writeVersionHeader(fp);
    await writeMeta(fp, { only: 'meta' });
    // Manually append an event line to test filtering
    await fs.appendFile(
      fp,
      buildLine('event', { type: 'test' }),
      'utf-8',
    );

    const meta = await readSessionMeta(fp);
    expect(meta).toHaveLength(1);
    expect(meta[0]).toEqual({ only: 'meta' });
  });

  it('readSessionMeta returns empty array for missing file', async () => {
    const dir = await getTmpDir();
    const fp = testFile('nonexistent.jsonl');

    const meta = await readSessionMeta(fp);
    expect(meta).toEqual([]);
  });

  it('readSessionMeta returns empty array for empty file', async () => {
    const dir = await getTmpDir();
    const fp = testFile();

    await fs.writeFile(fp, '', 'utf-8');

    const meta = await readSessionMeta(fp);
    expect(meta).toEqual([]);
  });
});

// ===========================================================================
// v2: Events
// ===========================================================================

describe('writeLegacyEvent / readLegacySessionEvents', () => {
  it('writes an event and reads it back', async () => {
    const dir = await getTmpDir();
    const fp = testFile('events.jsonl');

    const event = { type: 'session.created', sessionId: 'ses_001', title: 'Test' };
    await writeLegacyEvent(fp, event);

    const events = await readLegacySessionEvents(fp);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('reads multiple events in order', async () => {
    const dir = await getTmpDir();
    const fp = testFile('events.jsonl');

    const e1 = { type: 'session.created', sessionId: 'ses_001' };
    const e2 = { type: 'session.idle', sessionId: 'ses_001' };
    const e3 = { type: 'session.diff', sessionId: 'ses_001', diffs: [] };

    await writeLegacyEvent(fp, e1);
    await writeLegacyEvent(fp, e2);
    await writeLegacyEvent(fp, e3);

    const events = await readLegacySessionEvents(fp);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(e1);
    expect(events[1]).toEqual(e2);
    expect(events[2]).toEqual(e3);
  });

  it('returns empty array for missing file', async () => {
    const dir = await getTmpDir();
    const fp = testFile('nonexistent.jsonl');

    const events = await readLegacySessionEvents(fp);
    expect(events).toEqual([]);
  });

  it('returns empty array for empty file', async () => {
    const dir = await getTmpDir();
    const fp = testFile('events.jsonl');

    await fs.writeFile(fp, '', 'utf-8');

    const events = await readLegacySessionEvents(fp);
    expect(events).toEqual([]);
  });

  it('filters out non-event lines', async () => {
    const dir = await getTmpDir();
    const fp = testFile('events.jsonl');

    // Write a version header, then events, then meta — only events returned
    await writeVersionHeader(fp);
    await writeLegacyEvent(fp, { type: 'part.updated' });
    await writeMeta(fp, { info: 'test' });
    await writeLegacyEvent(fp, { type: 'session.idle' });

    const events = await readLegacySessionEvents(fp);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'part.updated' });
    expect(events[1]).toEqual({ type: 'session.idle' });
  });
});

describe('turn envelope serialization', () => {
  it('groups events by persisted turn-start and turn-end records', async () => {
    const dir = await getTmpDir();
    const fp = testFile('turn-events.jsonl');

    await writeVersionHeader(fp);
    await writeTurnStart(fp, { turnIndex: 0, prompt: 'first', timestamp: '2026-06-07T00:00:00.000Z' });
    await writeLegacyEvent(fp, { type: 'part.updated', part: { type: 'text', id: 'u1', text: 'first' } });
    await writeLegacyEvent(fp, { type: 'part.updated', part: { type: 'text', id: 'a1', text: '' } });
    await writeTurnEnd(fp, { turnIndex: 0, timestamp: '2026-06-07T00:00:01.000Z' });
    await writeTurnStart(fp, { turnIndex: 1, prompt: 'second', timestamp: '2026-06-07T00:00:02.000Z' });
    await writeLegacyEvent(fp, { type: 'part.updated', part: { type: 'text', id: 'u2', text: 'second' } });
    await writeTurnEnd(fp, { turnIndex: 1, timestamp: '2026-06-07T00:00:03.000Z' });

    const turns = await readLegacySessionTurnEvents(fp);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnIndex).toBe(0);
    expect((turns[0].start as any).prompt).toBe('first');
    expect(turns[0].events).toHaveLength(2);
    expect(turns[1].turnIndex).toBe(1);
    expect((turns[1].start as any).prompt).toBe('second');
    expect(turns[1].events).toHaveLength(1);
  });

  it('groups stream parts by persisted turn-start and part metadata', async () => {
    const dir = await getTmpDir();
    const fp = testFile('turn-stream-parts.jsonl');
    const part0: SerializableStreamPart = {
      kind: 'rawAcpEvent',
      version: 1,
      id: 'ssp-0-0',
      payload: { event: { type: 'part.updated' } },
      meta: {
        turnIndex: 0,
        requestId: 'req-0',
        sequence: 0,
        createdAt: '2026-06-13T00:00:00.000Z',
        source: 'acp-event',
        sourceType: 'part.updated',
      },
    };
    const part1: SerializableStreamPart = {
      kind: 'rawAcpEvent',
      version: 1,
      id: 'ssp-1-0',
      payload: { event: { type: 'session.idle' } },
      meta: {
        turnIndex: 1,
        requestId: 'req-1',
        sequence: 0,
        createdAt: '2026-06-13T00:00:01.000Z',
        source: 'acp-event',
        sourceType: 'session.idle',
      },
    };

    await writeVersionHeader(fp);
    await writeTurnStart(fp, { turnIndex: 0, prompt: 'first' });
    await writeStreamPart(fp, part0);
    await writeTurnEnd(fp, { turnIndex: 0 });
    await writeTurnStart(fp, { turnIndex: 1, prompt: 'second' });
    await writeStreamPart(fp, part1);
    await writeTurnEnd(fp, { turnIndex: 1 });

    const allParts = await readSessionStreamParts(fp);
    expect(allParts).toEqual([part0, part1]);

    const turns = await readSessionTurnStreamParts(fp);
    expect(turns).toHaveLength(2);
    expect(turns[0].parts).toEqual([part0]);
    expect(turns[1].parts).toEqual([part1]);
  });
});

// ===========================================================================
// v2: Snapshots
// ===========================================================================

describe('writeSnapshotLine / readSessionSnapshots', () => {
  function makeSnapshot(
    uri: string,
    content: string,
    editIndex = 1,
  ): FileSnapshotRecord {
    return {
      uri,
      content,
      editIndex,
      toolCallId: 'tc_001',
      timestamp: new Date().toISOString(),
    };
  }

  it('writes a snapshot and reads it back', async () => {
    const dir = await getTmpDir();
    const fp = testFile('snapshots.jsonl');

    const snapshot = makeSnapshot('file:///test.ts', 'console.log("hello");');
    await writeSnapshotLine(fp, snapshot);

    const snapshots = await readSessionSnapshots<FileSnapshotRecord>(fp);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(snapshot);
  });

  it('reads multiple snapshots in order', async () => {
    const dir = await getTmpDir();
    const fp = testFile('snapshots.jsonl');

    const a = makeSnapshot('file:///a.ts', '// a', 1);
    const b = makeSnapshot('file:///b.ts', '// b', 2);
    const c = makeSnapshot('file:///c.ts', '// c', 3);

    await writeSnapshotLine(fp, a);
    await writeSnapshotLine(fp, b);
    await writeSnapshotLine(fp, c);

    const snapshots = await readSessionSnapshots<FileSnapshotRecord>(fp);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toEqual(a);
    expect(snapshots[1]).toEqual(b);
    expect(snapshots[2]).toEqual(c);
  });

  it('returns empty array for missing file', async () => {
    const dir = await getTmpDir();
    const fp = testFile('nonexistent.jsonl');

    const snapshots = await readSessionSnapshots(fp);
    expect(snapshots).toEqual([]);
  });

  it('returns empty array for empty file', async () => {
    const dir = await getTmpDir();
    const fp = testFile('snapshots.jsonl');

    await fs.writeFile(fp, '', 'utf-8');

    const snapshots = await readSessionSnapshots(fp);
    expect(snapshots).toEqual([]);
  });

  it('filters out non-snapshot lines', async () => {
    const dir = await getTmpDir();
    const fp = testFile('mixed.jsonl');

    // Write version, snapshot, event, snapshot, meta — only snapshots returned
    await writeVersionHeader(fp);
    await writeSnapshotLine(fp, makeSnapshot('file:///a.ts', '// a'));
    await writeLegacyEvent(fp, { type: 'session.created' });
    await writeSnapshotLine(fp, makeSnapshot('file:///b.ts', '// b'));
    await writeMeta(fp, { info: 'test' });

    const snapshots = await readSessionSnapshots<FileSnapshotRecord>(fp);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].uri).toBe('file:///a.ts');
    expect(snapshots[1].uri).toBe('file:///b.ts');
  });
});
