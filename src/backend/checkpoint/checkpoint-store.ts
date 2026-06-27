/**
 * File snapshot storage for the event-stream persistence system.
 *
 * Writes snapshots via append-mode JSONL so each write is crash-safe
 * (atomic append on most OS filesystems). Reads all snapshots back on
 * restore by parsing the newline-delimited JSON file.
 *
 * No VSCode or SDK imports — plain Node.js only.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileSnapshotRecord } from '../serializable/types';

const CHECKPOINT_FILE = '_checkpoints.jsonl';

/**
 * Append a snapshot record to the checkpoint file.
 * Uses `appendFile` for crash-safe writes — each record is a single line.
 *
 * @param sessionDir - Absolute path to the session directory
 * @param snapshot   - The file snapshot to persist
 */
export async function writeSnapshot(
  sessionDir: string,
  snapshot: FileSnapshotRecord,
): Promise<void> {
  const filePath = path.join(sessionDir, CHECKPOINT_FILE);
  await fs.appendFile(filePath, JSON.stringify(snapshot) + '\n', 'utf-8');
}

/**
 * Read all snapshot records from the checkpoint file, in append order.
 * Returns an empty array if the file does not exist or is empty.
 *
 * @param sessionDir - Absolute path to the session directory
 */
export async function readCheckpoints(
  sessionDir: string,
): Promise<FileSnapshotRecord[]> {
  const filePath = path.join(sessionDir, CHECKPOINT_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    if (!content.trim()) {
      return [];
    }
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FileSnapshotRecord);
  } catch {
    // File doesn't exist → no snapshots yet
    return [];
  }
}

/**
 * Get the latest (last written) snapshot for a specific file URI.
 *
 * Because checkpoints are append-only, the last matching entry by
 * file position is the most recent snapshot for that URI.
 *
 * @param sessionDir - Absolute path to the session directory
 * @param uri        - The file URI to look up
 * @returns The latest snapshot, or `null` if none found
 */
export async function getLastSnapshot(
  sessionDir: string,
  uri: string,
): Promise<FileSnapshotRecord | null> {
  const snapshots = await readCheckpoints(sessionDir);
  // Walk backwards — last match wins
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].uri === uri) {
      return snapshots[i];
    }
  }
  return null;
}
