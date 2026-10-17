/**
 * Filesystem-backed session metadata store.
 *
 * Canonical layout:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     session.jsonl        append-only SSP records
 *     meta.jsonl           append-only session and part metadata
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { SerializableSessionMeta } from '../serializable/types';
import { resolveStorageChild } from '../storage-path';

const STORAGE_DIR = '.acpilot';
const META_FILENAME = 'meta.jsonl';
const SESSION_FILENAME = 'session.jsonl';

export interface SessionStoreOptions {
  workspaceRoot: string;
  backendName: string;
}

export class SessionStore {
  private readonly baseDir: string;

  constructor(options: SessionStoreOptions) {
    this.baseDir = path.join(options.workspaceRoot, STORAGE_DIR, options.backendName);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  getSessionDir(sessionId: string): string {
    return resolveStorageChild(this.baseDir, sessionId, 'Session ID');
  }

  getSessionPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), SESSION_FILENAME);
  }

  getMetaPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), META_FILENAME);
  }

  /** Append a complete session metadata snapshot. */
  async writeMeta(sessionId: string, meta: SerializableSessionMeta): Promise<void> {
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.appendFile(
      this.getMetaPath(sessionId),
      JSON.stringify({ v: 2, type: 'session', ...meta, id: sessionId }) + '\n',
      'utf-8',
    );
  }

  /** Materialize the latest session metadata from meta.jsonl. */
  async readMeta(sessionId: string): Promise<SerializableSessionMeta | undefined> {
    let content: string;
    try {
      content = await fs.readFile(this.getMetaPath(sessionId), 'utf-8');
    } catch {
      return undefined;
    }

    let materialized: SerializableSessionMeta | undefined;
    for (const line of content.split('\n')) {
      if (!line.trim()) {continue;}
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== 'session') {continue;}
        const { v: _version, type: _type, ...patch } = parsed;
        materialized = {
          id: sessionId,
          ...materialized,
          ...patch,
          checkpointCursor: mergeCheckpointCursor(materialized?.checkpointCursor, patch.checkpointCursor),
        } as SerializableSessionMeta;
      } catch {
        // Ignore malformed or partially appended lines.
      }
    }
    return materialized;
  }

  async updateMeta(
    sessionId: string,
    update: Partial<SerializableSessionMeta>,
  ): Promise<SerializableSessionMeta> {
    const existing = await this.readMeta(sessionId);
    const checkpointCursor = update.checkpointCursor
      ? {
          ...existing?.checkpointCursor,
          ...update.checkpointCursor,
          acceptedThroughTurn: update.checkpointCursor.acceptedThroughTurn
            ?? existing?.checkpointCursor?.acceptedThroughTurn
            ?? -1,
        }
      : existing?.checkpointCursor;
    const next: SerializableSessionMeta = {
      id: sessionId,
      ...existing,
      ...update,
      checkpointCursor,
    };
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.appendFile(
      this.getMetaPath(sessionId),
      JSON.stringify({
        v: 2,
        type: 'session',
        id: sessionId,
        ...update,
        ...(update.checkpointCursor ? { checkpointCursor } : {}),
      }) + '\n',
      'utf-8',
    );
    return next;
  }

  async listSessions(): Promise<SerializableSessionMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: false });
    } catch {
      return [];
    }

    const sessions: SerializableSessionMeta[] = [];
    for (const entry of entries) {
      if (entry.startsWith('_')) {continue;}
      try {
        const stat = await fs.stat(path.join(this.baseDir, entry));
        if (!stat.isDirectory()) {continue;}
      } catch {
        continue;
      }
      const meta = await this.readMeta(entry);
      if (meta) {sessions.push(meta);}
    }

    return sessions.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
}

function mergeCheckpointCursor(
  current: SerializableSessionMeta['checkpointCursor'],
  update: unknown,
): SerializableSessionMeta['checkpointCursor'] | undefined {
  if (!update || typeof update !== 'object') {return current;}
  return {
    acceptedThroughTurn: current?.acceptedThroughTurn ?? -1,
    ...current,
    ...(update as SerializableSessionMeta['checkpointCursor']),
  };
}
