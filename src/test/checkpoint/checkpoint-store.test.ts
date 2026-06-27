/**
 * Tests for the ACP checkpoint store.
 *
 * Uses temporary directories via os.tmpdir() + mkdtemp() to isolate
 * each test case. All directories are cleaned up in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeSnapshot,
  readCheckpoints,
  getLastSnapshot,
} from '../../backend/checkpoint/checkpoint-store';
import type { FileSnapshotRecord } from '../../backend/serializable/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal FileSnapshotRecord for testing. */
function makeSnapshot(
  uri: string,
  content: string,
  editIndex: number = 1,
  toolCallId: string = 'tc_001',
): FileSnapshotRecord {
  return {
    uri,
    content,
    editIndex,
    toolCallId,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('checkpoint-store', () => {
  /** Temporary directory for the current test. */
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  // -----------------------------------------------------------------------
  // write + read roundtrip
  // -----------------------------------------------------------------------

  it('writes a snapshot and reads it back', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));

    const snapshot = makeSnapshot('file:///test.ts', 'console.log("hello");');
    await writeSnapshot(tmpDir, snapshot);

    const snapshots = await readCheckpoints(tmpDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(snapshot);
  });

  // -----------------------------------------------------------------------
  // multiple snapshots for different URIs
  // -----------------------------------------------------------------------

  it('returns all snapshots when multiple are written', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));

    const a = makeSnapshot('file:///a.ts', '// a');
    const b = makeSnapshot('file:///b.ts', '// b');
    const c = makeSnapshot('file:///c.ts', '// c');

    await writeSnapshot(tmpDir, a);
    await writeSnapshot(tmpDir, b);
    await writeSnapshot(tmpDir, c);

    const snapshots = await readCheckpoints(tmpDir);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toEqual(a);
    expect(snapshots[1]).toEqual(b);
    expect(snapshots[2]).toEqual(c);
  });

  // -----------------------------------------------------------------------
  // getLastSnapshot returns the latest for a given URI
  // -----------------------------------------------------------------------

  it('getLastSnapshot returns the most recent snapshot for a URI', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));

    const uri = 'file:///edit.ts';

    const first = makeSnapshot(uri, 'version 1', 1, 'tc_001');
    const second = makeSnapshot(uri, 'version 2', 2, 'tc_002');
    const other = makeSnapshot('file:///other.ts', 'other', 1, 'tc_003');

    await writeSnapshot(tmpDir, first);
    await writeSnapshot(tmpDir, second);
    await writeSnapshot(tmpDir, other);

    const latest = await getLastSnapshot(tmpDir, uri);
    expect(latest).not.toBeNull();
    expect(latest!.content).toBe('version 2');
    expect(latest!.editIndex).toBe(2);
    expect(latest!.toolCallId).toBe('tc_002');
  });

  // -----------------------------------------------------------------------
  // empty directory → empty array
  // -----------------------------------------------------------------------

  it('readCheckpoints returns empty array for an empty directory', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));

    const snapshots = await readCheckpoints(tmpDir);
    expect(snapshots).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // getLastSnapshot returns null for unknown URI
  // -----------------------------------------------------------------------

  it('getLastSnapshot returns null when no snapshot matches', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));

    // Write a snapshot for a different URI
    await writeSnapshot(
      tmpDir,
      makeSnapshot('file:///existing.ts', 'content'),
    );

    const result = await getLastSnapshot(tmpDir, 'file:///missing.ts');
    expect(result).toBeNull();
  });
});
