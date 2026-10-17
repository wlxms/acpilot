import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../backend/streaming/session-store';

const roots: string[] = [];

async function createStore(backendName = 'opencode'): Promise<SessionStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acpilot-session-store-'));
  roots.push(root);
  const store = new SessionStore({ workspaceRoot: root, backendName });
  await store.initialize();
  return store;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('SessionStore canonical layout', () => {
  it('uses only session.jsonl and meta.jsonl paths', async () => {
    const store = await createStore('reasonix');
    expect(store.getSessionPath('session-1')).toMatch(/[\\/]reasonix[\\/]session-1[\\/]session\.jsonl$/);
    expect(store.getMetaPath('session-1')).toMatch(/[\\/]reasonix[\\/]session-1[\\/]meta\.jsonl$/);
  });

  it('rejects session ids that could escape the backend namespace', async () => {
    const store = await createStore('acp/target-a');
    expect(() => store.getSessionDir('..')).toThrow(/Session ID/);
    expect(() => store.getSessionDir('..\\..\\escape')).toThrow(/Session ID/);
    expect(() => store.getSessionDir('../escape')).toThrow(/Session ID/);
    expect(() => store.getSessionDir('CON')).toThrow(/reserved Windows device name/);
  });

  it('materializes append-only session metadata patches', async () => {
    const store = await createStore();
    await store.writeMeta('session-1', {
      id: 'session-1',
      title: 'Initial',
      backendName: 'opencode',
      checkpointCursor: { acceptedThroughTurn: -1 },
    });
    await store.updateMeta('session-1', {
      title: 'Final',
      checkpointCursor: { acceptedThroughTurn: 2, replayedThroughTurn: 2 },
    });

    await expect(store.readMeta('session-1')).resolves.toEqual(expect.objectContaining({
      id: 'session-1',
      title: 'Final',
      backendName: 'opencode',
      checkpointCursor: { acceptedThroughTurn: 2, replayedThroughTurn: 2 },
    }));

    const lines = (await fs.readFile(store.getMetaPath('session-1'), 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every(line => JSON.parse(line).type === 'session')).toBe(true);
  });

  it('lists only sessions with canonical session metadata', async () => {
    const store = await createStore();
    await store.writeMeta('older', { id: 'older', title: 'Older', createdAt: '2026-01-01T00:00:00Z' });
    await store.writeMeta('newer', { id: 'newer', title: 'Newer', createdAt: '2026-02-01T00:00:00Z' });
    await fs.mkdir(store.getSessionDir('no-meta'), { recursive: true });

    const sessions = await store.listSessions();
    expect(sessions.map(session => session.id)).toEqual(['newer', 'older']);
  });
});
