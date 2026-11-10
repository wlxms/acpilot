import { describe, expect, it } from 'vitest';
import { agent, client, methods } from '@agentclientprotocol/sdk';
import { AcpBackend } from '../backends/acp/adapter';
import { DshBackend } from '../backends/dsh/adapter';

function connectTitlelessAgent(backend: AcpBackend, nativeTitle?: string) {
  const agentApp = agent({ name: 'titleless-dsh-agent' });
  agentApp.onRequest(methods.agent.session.new, () => ({ sessionId: 'dsh-title-session' }));
  agentApp.onRequest(methods.agent.session.list, () => ({
    sessions: [{ sessionId: 'dsh-title-session', cwd: 'D:/workspace', ...(nativeTitle ? { title: nativeTitle } : {}) }],
  }));
  const connection = client({ name: 'title-test-client' }).connect(agentApp);
  const internals = backend as unknown as { clientConnection: typeof connection; status: 'running' };
  internals.clientConnection = connection;
  internals.status = 'running';
  return connection;
}

describe('DSH session title retention', () => {
  it('keeps an explicit creation title when native ACP metadata omits titles', async () => {
    const backend = new DshBackend();
    const connection = connectTitlelessAgent(backend);
    try {
      await backend.sessions.create({ title: 'Pinned project conversation', directory: 'D:/workspace' });

      expect((await backend.sessions.get('dsh-title-session')).data?.title).toBe('Pinned project conversation');
    } finally {
      await backend.stop();
      connection.close();
    }
  });

  it('keeps a generated title through active reads, release, and titleless list refreshes', async () => {
    const backend = new DshBackend();
    const connection = connectTitlelessAgent(backend);
    try {
      await backend.sessions.create({ title: 'New DeepSeek Harness Session', directory: 'D:/workspace' });
      await backend.sessions.update('dsh-title-session', { title: '修复事件驱动 Actor' });

      expect((await backend.sessions.get('dsh-title-session')).data?.title).toBe('修复事件驱动 Actor');
      await backend.sessions.release?.('dsh-title-session');
      expect((await backend.sessions.get('dsh-title-session', 'D:/workspace')).data?.title).toBe('修复事件驱动 Actor');
      expect((await backend.sessions.list('D:/workspace')).data).toEqual([
        expect.objectContaining({ id: 'dsh-title-session', title: '修复事件驱动 Actor' }),
      ]);
    } finally {
      await backend.stop();
      connection.close();
    }
  });

  it('uses a real restored backend title after an initial placeholder', async () => {
    const backend = new DshBackend();
    const connection = connectTitlelessAgent(backend, 'Restored backend title');
    try {
      await backend.sessions.create({ title: 'New DeepSeek Harness Session', directory: 'D:/workspace' });
      await backend.sessions.release?.('dsh-title-session');

      expect((await backend.sessions.get('dsh-title-session', 'D:/workspace')).data?.title).toBe('Restored backend title');
    } finally {
      await backend.stop();
      connection.close();
    }
  });

  it('preserves an explicit local title over stale native list metadata', async () => {
    const backend = new DshBackend();
    const connection = connectTitlelessAgent(backend, 'Old native title');
    try {
      await backend.sessions.update('dsh-title-session', { title: 'Manually renamed conversation' });

      expect((await backend.sessions.list('D:/workspace')).data).toEqual([
        expect.objectContaining({ id: 'dsh-title-session', title: 'Manually renamed conversation' }),
      ]);
    } finally {
      await backend.stop();
      connection.close();
    }
  });

  it('does not change native title handling for other ACP providers', async () => {
    const backend = new AcpBackend();
    const connection = connectTitlelessAgent(backend, 'Native ACP title');
    try {
      await backend.sessions.update('dsh-title-session', { title: 'Unpersisted local title' });

      expect((await backend.sessions.get('dsh-title-session', 'D:/workspace')).data?.title).toBe('Native ACP title');
    } finally {
      await backend.stop();
      connection.close();
    }
  });

  it('drops cached titles when a stopped target is replaced', async () => {
    const backend = new DshBackend();
    const firstConnection = connectTitlelessAgent(backend);
    await backend.sessions.update('dsh-title-session', { title: 'Previous target title' });
    await backend.stop();
    firstConnection.close();
    const nextConnection = connectTitlelessAgent(backend, 'Replacement target title');
    try {
      expect((await backend.sessions.get('dsh-title-session', 'D:/workspace')).data?.title).toBe('Replacement target title');
    } finally {
      await backend.stop();
      nextConnection.close();
    }
  });
});
