/**
 * Tests for the SSP stream serializer (v2 JSONL format).
 *
 * Covers the v2 stream contract (version header, turn envelopes, SSPs, and snapshots)
 * serialization functions. Uses temporary directories for file I/O isolation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildLine,
  parseLine,
  writeVersionHeader,  writeTurnStart,
  writeTurnEnd,
  writeStreamPart,
  writeSnapshotLine,
  readSessionStreamParts,
  readSessionTurnStreamParts,
  readSessionSnapshots,
} from '../../backend/serializable/serializer';
import type { FileSnapshotRecord, StreamPartRecord as SerializableStreamPart } from '../../ssp/types';

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

describe('turn envelope serialization', () => {
  it('groups stream parts by persisted turn-start and part metadata', async () => {
    const dir = await getTmpDir();
    const fp = testFile('turn-stream-parts.jsonl');
    const part0: SerializableStreamPart = {
      kind: 'opaqueEvent',
      version: 1,
      id: 'ssp-0-0',
      payload: { event: { type: 'part.updated' } },
      meta: {
        turnIndex: 0,
        requestId: 'req-0',
        sequence: 0,
        createdAt: '2026-06-13T00:00:00.000Z',
        source: 'backend-event',
        sourceType: 'part.updated',
      },
    };
    const part1: SerializableStreamPart = {
      kind: 'opaqueEvent',
      version: 1,
      id: 'ssp-1-0',
      payload: { event: { type: 'session.idle' } },
      meta: {
        turnIndex: 1,
        requestId: 'req-1',
        sequence: 0,
        createdAt: '2026-06-13T00:00:01.000Z',
        source: 'backend-event',
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
    await writeStreamPart(fp, {
      kind: 'opaqueEvent',
      version: 1,
      id: 'opaque-1',
      payload: { event: { type: 'session.created' } },
      meta: {
        turnIndex: 0,
        requestId: 'request-1',
        sequence: 0,
        createdAt: '2026-06-07T00:00:00.000Z',
        source: 'synthetic',
      },
    });
    await writeSnapshotLine(fp, makeSnapshot('file:///b.ts', '// b'));
    const snapshots = await readSessionSnapshots<FileSnapshotRecord>(fp);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].uri).toBe('file:///a.ts');
    expect(snapshots[1].uri).toBe('file:///b.ts');
  });
});
