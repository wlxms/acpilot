/**
 * Session directory setup for the ACP stream persistence system.
 *
 * Directory layout:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     turns.jsonl          stream parts/events (JSONL)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const ACP_DIR = '.acpilot';

export async function ensureAcpilotDir(workspaceRoot: string): Promise<string> {
  const acpDir = path.join(workspaceRoot, ACP_DIR);
  await fs.mkdir(acpDir, { recursive: true });
  return acpDir;
}

export async function ensureBackendDir(workspaceRoot: string, backendName: string): Promise<string> {
  const dir = path.join(workspaceRoot, ACP_DIR, backendName);
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
  const dir = path.join(workspaceRoot, ACP_DIR, backendName, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
