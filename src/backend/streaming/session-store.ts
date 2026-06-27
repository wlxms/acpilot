/**
 * SessionStore: filesystem-backed session metadata store.
 *
 * Manages the directory layout for persisted ACP session data and provides
 * path helpers used by the stream persistence system.
 *
 * Directory layout:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     turns.jsonl          stream parts/events (JSONL)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { SerializableSessionMeta } from '../serializable/types';

const ACP_DIR = '.acpilot';
const META_FILENAME = '_meta.json';

export interface SessionStoreOptions {
  workspaceRoot: string;
  backendName: string;
}

export class SessionStore {
  private baseDir: string;

  constructor(private readonly options: SessionStoreOptions) {
    this.baseDir = path.join(options.workspaceRoot, ACP_DIR, options.backendName);
  }

  /** Ensure the backend directory exists */
  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  /** Get the session directory path */
  getSessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
  }

  /** Get the turns JSONL file path */
  getTurnsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'turns.jsonl');
  }

  /** Write session metadata to _meta.json */
  async writeMeta(sessionId: string, meta: SerializableSessionMeta): Promise<void> {
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.writeFile(
      path.join(this.getSessionDir(sessionId), META_FILENAME),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  /** Read session metadata from _meta.json, falling back to turns.jsonl meta. */
  async readMeta(sessionId: string): Promise<SerializableSessionMeta | undefined> {
    const sessionDir = this.getSessionDir(sessionId);
    try {
      const metaContent = await fs.readFile(path.join(sessionDir, META_FILENAME), 'utf-8');
      return JSON.parse(metaContent) as SerializableSessionMeta;
    } catch {
      // Fall through to turns.jsonl meta for older persisted sessions.
    }

    try {
      const turnsContent = await fs.readFile(path.join(sessionDir, 'turns.jsonl'), 'utf-8');
      for (const line of turnsContent.split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.t === 'meta') {
            return parsed.d as SerializableSessionMeta;
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  /** Merge a partial metadata update into the current session metadata. */
  async updateMeta(
    sessionId: string,
    update: Partial<SerializableSessionMeta>,
  ): Promise<SerializableSessionMeta> {
    const existing = await this.readMeta(sessionId);
    const next: SerializableSessionMeta = {
      id: sessionId,
      ...existing,
      ...update,
      checkpointCursor: {
        acceptedThroughTurn: existing?.checkpointCursor?.acceptedThroughTurn ?? -1,
        ...existing?.checkpointCursor,
        ...update.checkpointCursor,
      },
    };
    await this.writeMeta(sessionId, next);
    return next;
  }

  /** List all sessions from filesystem (reads _meta.json from each directory) */
  async listSessions(): Promise<SerializableSessionMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: false });
    } catch {
      return [];
    }

    const sessions: SerializableSessionMeta[] = [];
    for (const entry of entries) {
      // Skip non-directory entries (e.g., _relations.json)
      if (entry.startsWith('_')) continue;
      try {
        const stat = await fs.stat(path.join(this.baseDir, entry));
        if (!stat.isDirectory()) continue;
      } catch { continue; }

      // Try to read _meta.json
      try {
        const metaContent = await fs.readFile(
          path.join(this.baseDir, entry, META_FILENAME), 'utf-8',
        );
        const meta = JSON.parse(metaContent) as SerializableSessionMeta;
        sessions.push(meta);
      } catch {
        // No _meta.json — try reading from turns.jsonl meta line
        try {
          const turnsPath = path.join(this.baseDir, entry, 'turns.jsonl');
          const turnsContent = await fs.readFile(turnsPath, 'utf-8');
          for (const line of turnsContent.split('\n')) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.t === 'meta') {
                sessions.push(parsed.d as SerializableSessionMeta);
                break;
              }
            } catch { /* skip malformed lines */ }
          }
        } catch {
          // No turns.jsonl either — skip this directory
        }
      }
    }

    return sessions.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
}
