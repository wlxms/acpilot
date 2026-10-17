/**
 * Session directory setup for the backend stream persistence system.
 *
 * Directory layout:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     session.jsonl        SSP records and snapshots (JSONL)
 *     meta.jsonl           session and part metadata (JSONL)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveStorageChild } from '../storage-path';

const STORAGE_DIR = '.acpilot';

export async function ensureAcpilotDir(workspaceRoot: string): Promise<string> {
  const storageDir = path.join(workspaceRoot, STORAGE_DIR);
  await fs.mkdir(storageDir, { recursive: true });
  return storageDir;
}

export async function ensureBackendDir(workspaceRoot: string, backendName: string): Promise<string> {
  const dir = path.join(workspaceRoot, STORAGE_DIR, backendName);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureSessionDir(
  workspaceRoot: string,
  backendName: string,
  sessionId: string,
): Promise<string> {
  await ensureAcpilotDir(workspaceRoot);
  await ensureBackendDir(workspaceRoot, backendName);
  const backendDir = path.join(workspaceRoot, STORAGE_DIR, backendName);
  const dir = resolveStorageChild(backendDir, sessionId, 'Session ID');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
