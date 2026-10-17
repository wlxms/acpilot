import { describe, expect, it, vi } from 'vitest';
import { agent, client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { AcpBackend } from '../backends/acp/adapter';

describe('AcpBackend session capabilities', () => {
  it('discovers models over one in-process persistent ACP connection and cleans up', async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    const agentApp = agent({ name: 'test-agent' });
    agentApp.onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { delete: {} } },
    }));
    agentApp.onRequest(methods.agent.session.new, () => {
      const sessionId = `discovery-${created.length + 1}`;
      created.push(sessionId);
      return {
        sessionId,
        configOptions: [{
          id: 'model',
          name: 'Model',
          category: 'model' as const,
          type: 'select' as const,
          currentValue: 'agent-fast',
          options: [{ value: 'agent-fast', name: 'Agent Fast' }],
        }],
      };
    });
    agentApp.onRequest(methods.agent.session.delete, (ctx) => {
      deleted.push(ctx.params.sessionId);
      return {};
    });

    const clientApp = client({ name: 'test-client' });
    const connection = clientApp.connect(agentApp);
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      clientConnection: typeof connection;
      status: 'running';
      initializeResponse: { agentCapabilities: { sessionCapabilities: { delete: Record<string, never> } } };
    };
    internals.clientConnection = connection;
    internals.status = 'running';
    internals.initializeResponse = {
      agentCapabilities: { sessionCapabilities: { delete: {} } },
    };

    await expect(backend.config.models('D:/workspace')).resolves.toEqual({
      data: [{ id: 'agent-fast', name: 'Agent Fast', provider: 'acp' }],
    });
    await expect(backend.config.models('D:/workspace')).resolves.toEqual({
      data: [{ id: 'agent-fast', name: 'Agent Fast', provider: 'acp' }],
    });
    expect(created).toEqual(['discovery-1']);
    expect(deleted).toEqual(['discovery-1']);

    await backend.stop();
    expect(backend.getStatus()).toBe('stopped');
    expect(backend.isRunning()).toBe(false);
  });

  it('falls back to session/close when discovery session deletion fails', async () => {
    const deleted: string[] = [];
    const closed: string[] = [];
    const agentApp = agent({ name: 'test-agent' });
    agentApp.onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { delete: {}, close: {} } },
    }));
    agentApp.onRequest(methods.agent.session.new, () => ({
      sessionId: 'discovery-fallback',
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model' as const,
        type: 'select' as const,
        currentValue: 'agent-fast',
        options: [{ value: 'agent-fast', name: 'Agent Fast' }],
      }],
    }));
    agentApp.onRequest(methods.agent.session.delete, ({ params }) => {
      deleted.push(params.sessionId);
      throw new Error('delete unsupported at runtime');
    });
    agentApp.onRequest(methods.agent.session.close, ({ params }) => {
      closed.push(params.sessionId);
      return {};
    });

    const clientApp = client({ name: 'test-client' });
    const connection = clientApp.connect(agentApp);
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      clientConnection: typeof connection;
      status: 'running';
      initializeResponse: {
        agentCapabilities: { sessionCapabilities: { delete: Record<string, never>; close: Record<string, never> } };
      };
    };
    internals.clientConnection = connection;
    internals.status = 'running';
    internals.initializeResponse = {
      agentCapabilities: { sessionCapabilities: { delete: {}, close: {} } },
    };

    await expect(backend.config.models('D:/workspace')).resolves.toEqual({
      data: [{ id: 'agent-fast', name: 'Agent Fast', provider: 'acp' }],
    });
    expect(deleted).toEqual(['discovery-fallback']);
    expect(closed).toEqual(['discovery-fallback']);

    connection.close();
  });

  it('enumerates backend-scoped models from ACP session config options', async () => {
    const backend = new AcpBackend({ name: 'reasonix' });
    const internals = backend as unknown as {
      sessionConfigOptions: Map<string, unknown[]>;
    };
    internals.sessionConfigOptions.set('session-1', [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'reasonix-fast',
        options: [
          { value: 'reasonix-fast', name: 'Reasonix Fast' },
          {
            group: 'advanced',
            name: 'Advanced',
            options: [{ value: 'reasonix-deep', name: 'Reasonix Deep' }],
          },
        ],
      },
    ]);

    await expect(backend.config.models()).resolves.toEqual({
      data: [
        { id: 'reasonix-fast', name: 'Reasonix Fast', provider: 'reasonix' },
        { id: 'reasonix-deep', name: 'Reasonix Deep', provider: 'reasonix' },
      ],
    });
  });

  it('enumerates ACP modes as backend agents', async () => {
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      activeSessions: Map<string, { modes?: { availableModes: unknown[] } }>;
    };
    internals.activeSessions.set('session-1', {
      modes: {
        availableModes: [
          { id: 'code', name: 'Code', description: 'Modify files' },
          { id: 'ask', name: 'Ask' },
        ],
      },
    });

    await expect(backend.config.agents()).resolves.toEqual({
      data: [
        { id: 'code', name: 'Code', description: 'Modify files', mode: 'primary' },
        { id: 'ask', name: 'Ask', description: undefined, mode: 'primary' },
      ],
    });
  });

  it('forwards backend attachments as ACP prompt content blocks', async () => {
    const backend = new AcpBackend({ name: 'acp' });
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
    const internals = backend as unknown as {
      activeSessions: Map<string, { prompt: typeof prompt }>;
      initializeResponse: {
        agentCapabilities: { promptCapabilities: { image: boolean } };
      };
      status: 'running';
    };
    internals.activeSessions.set('session-1', { prompt });
    internals.status = 'running';
    internals.initializeResponse = {
      agentCapabilities: { promptCapabilities: { image: true } },
    };

    await expect(backend.sessions.prompt('session-1', 'describe these files', 'D:/workspace', {
      attachments: [
        { mime: 'image/png', filename: 'screen.png', url: 'data:image/png;base64,AQID' },
        { mime: 'image/jpeg', filename: 'photo.jpg', url: 'file:///D:/workspace/photo.jpg' },
      ],
    })).resolves.toEqual({ data: true });

    expect(prompt).toHaveBeenCalledWith([
      { type: 'image', mimeType: 'image/png', data: 'AQID' },
      {
        type: 'resource_link',
        uri: 'file:///D:/workspace/photo.jpg',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
      },
      { type: 'text', text: 'describe these files' },
    ]);
  });

  it('returns an ACP prompt rejection to the caller', async () => {
    const backend = new AcpBackend({ name: 'acp' });
    const prompt = vi.fn(async () => {
      throw new Error('agent rejected prompt');
    });
    const internals = backend as unknown as {
      activeSessions: Map<string, { prompt: typeof prompt }>;
      status: 'running';
    };
    internals.activeSessions.set('session-1', { prompt });
    internals.status = 'running';

    await expect(backend.sessions.prompt('session-1', 'hello', 'D:/workspace'))
      .resolves.toEqual({ error: 'agent rejected prompt' });
  });

  it('does not report a prompt from a stale connection as successful', async () => {
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    const prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(resolve => {
      resolvePrompt = resolve;
    }));
    const connection = { agent: {} } as never;
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      activeSessions: Map<string, { prompt: typeof prompt }>;
      clientConnection: typeof connection;
      startGeneration: number;
      status: 'running';
    };
    internals.activeSessions.set('session-1', { prompt });
    internals.clientConnection = connection;
    internals.startGeneration = 1;
    internals.status = 'running';

    const pending = backend.sessions.prompt('session-1', 'hello', 'D:/workspace');
    expect(prompt).toHaveBeenCalledOnce();

    // Simulate stop()/target replacement while the ACP prompt request is in
    // flight, then let the old connection return its response.
    internals.startGeneration = 2;
    resolvePrompt({ stopReason: 'end_turn' });

    await expect(pending).resolves.toEqual({
      error: 'ACP backend changed while prompt was running',
    });
  });

  it('releases local ActiveSession resources without deleting the remote session', async () => {
    const backend = new AcpBackend({ name: 'acp' });
    const dispose = vi.fn();
    const internals = backend as unknown as {
      activeSessions: Map<string, { dispose: () => void }>;
      sessionDirectories: Map<string, string>;
      sessionConfigOptions: Map<string, unknown[]>;
      permissionResolvers: Map<string, unknown>;
      openStreams: Map<string, Set<{ dispose: () => void }>>;
    };
    const streamDispose = vi.fn();
    internals.activeSessions.set('temporary', { dispose });
    internals.sessionDirectories.set('temporary', 'D:/workspace');
    internals.sessionConfigOptions.set('temporary', []);
    internals.permissionResolvers.set('temporary', vi.fn());
    internals.openStreams.set('temporary', new Set([{ dispose: streamDispose }]));

    await expect(backend.sessions.release?.('temporary', 'D:/workspace')).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(streamDispose).toHaveBeenCalledOnce();
    expect(internals.activeSessions.has('temporary')).toBe(false);
    expect(internals.sessionDirectories.has('temporary')).toBe(false);
    expect(internals.sessionConfigOptions.has('temporary')).toBe(false);
    expect(internals.permissionResolvers.has('temporary')).toBe(false);
    expect(internals.openStreams.has('temporary')).toBe(false);
  });

  it('does not report session/close as a durable delete', async () => {
    const backend = new AcpBackend({ name: 'acp' });
    const request = vi.fn();
    const internals = backend as unknown as {
      clientConnection: { agent: { request: typeof request } };
      initializeResponse: { agentCapabilities: { sessionCapabilities: { close: Record<string, never> } } };
    };
    internals.clientConnection = { agent: { request } };
    internals.initializeResponse = {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    };

    await expect(backend.sessions.delete?.('durable-session')).resolves.toEqual({ data: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses session/close to release active remote resources when delete is unsupported', async () => {
    const backend = new AcpBackend({ name: 'acp' });
    const request = vi.fn(async (_method: string) => ({}));
    const dispose = vi.fn();
    const internals = backend as unknown as {
      activeSessions: Map<string, { dispose: () => void }>;
      clientConnection: { agent: { request: typeof request } };
      initializeResponse: { agentCapabilities: { sessionCapabilities: { close: Record<string, never> } } };
    };
    internals.activeSessions.set('active-session', { dispose });
    internals.clientConnection = { agent: { request } };
    internals.initializeResponse = {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    };

    await backend.sessions.release('active-session');

    expect(dispose).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(methods.agent.session.close, {
      sessionId: 'active-session',
    });
  });

  it('falls back to session/close after a transient session delete fails', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === methods.agent.session.delete) {
        throw new Error('delete failed');
      }
      return {};
    });
    const dispose = vi.fn();
    const connection = { agent: { request } };
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      activeSessions: Map<string, { dispose: () => void }>;
      transientSessions: Set<{ id: string; connection: typeof connection }>;
      clientConnection: typeof connection;
      initializeResponse: {
        agentCapabilities: { sessionCapabilities: { delete: Record<string, never>; close: Record<string, never> } };
      };
    };
    internals.activeSessions.set('transient-session', { dispose });
    internals.transientSessions.add({ id: 'transient-session', connection });
    internals.clientConnection = connection;
    internals.initializeResponse = {
      agentCapabilities: { sessionCapabilities: { delete: {}, close: {} } },
    };

    await expect(backend.sessions.delete!('transient-session')).resolves.toEqual({
      error: 'delete failed',
    });
    await backend.sessions.release('transient-session');

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      methods.agent.session.delete,
      methods.agent.session.close,
    ]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.transientSessions.size).toBe(0);
  });

  it('shares transient cleanup across delete, release, and stop races', async () => {
    let rejectDelete!: (error: unknown) => void;
    const deletePending = new Promise<never>((_, reject) => {
      rejectDelete = reject;
    });
    const request = vi.fn((method: string) => {
      if (method === methods.agent.session.delete) {
        return deletePending;
      }
      return Promise.resolve({});
    });
    const connection = {
      agent: { request },
      close: vi.fn(),
    };
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      activeSessions: Map<string, { dispose: () => void }>;
      transientSessions: Set<{ id: string; connection: typeof connection; cleanupClaimed: boolean }>;
      clientConnection: typeof connection;
      initializeResponse: {
        agentCapabilities: { sessionCapabilities: { delete: Record<string, never>; close: Record<string, never> } };
      };
    };
    internals.activeSessions.set('racing-session', { dispose: vi.fn() });
    internals.transientSessions.add({
      id: 'racing-session',
      connection,
      cleanupClaimed: false,
    });
    internals.clientConnection = connection;
    internals.initializeResponse = {
      agentCapabilities: { sessionCapabilities: { delete: {}, close: {} } },
    };

    const deleting = backend.sessions.delete!('racing-session');
    await Promise.resolve();
    const releasing = backend.sessions.release('racing-session');
    const stopping = backend.stop();
    await Promise.resolve();
    expect(request.mock.calls.map(([method]) => method)).toEqual([methods.agent.session.delete]);

    rejectDelete(new Error('delete failed'));
    await expect(deleting).resolves.toMatchObject({ error: 'delete failed' });
    await Promise.all([releasing, stopping]);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      methods.agent.session.delete,
      methods.agent.session.close,
    ]);
    expect(request.mock.calls.filter(([method]) => method === methods.agent.session.delete)).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === methods.agent.session.close)).toHaveLength(1);
  });

  it('bounds a hung transient cleanup request and still performs one close fallback', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn((method: string) => {
        if (method === methods.agent.session.delete) {
          return new Promise<never>(() => {});
        }
        return Promise.resolve({});
      });
      const connection = {
        agent: { request },
        close: vi.fn(),
      };
      const backend = new AcpBackend({ name: 'acp' });
      const internals = backend as unknown as {
        transientSessions: Set<{ id: string; connection: typeof connection; cleanupClaimed: boolean }>;
        clientConnection: typeof connection;
        status: 'running';
        initializeResponse: {
          agentCapabilities: { sessionCapabilities: { delete: Record<string, never>; close: Record<string, never> } };
        };
      };
      internals.transientSessions.add({
        id: 'hung-session',
        connection,
        cleanupClaimed: false,
      });
      internals.clientConnection = connection;
      internals.status = 'running';
      internals.initializeResponse = {
        agentCapabilities: { sessionCapabilities: { delete: {}, close: {} } },
      };

      const deleting = backend.sessions.delete!('hung-session');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(deleting).resolves.toMatchObject({
        error: expect.stringContaining('Operation timed out after 2000ms'),
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        methods.agent.session.delete,
        methods.agent.session.close,
      ]);
      await backend.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a recycled transient session id to acquire fresh cleanup state', async () => {
    const request = vi.fn(async (_method: string) => ({}));
    type TestConnection = {
      agent: { request: (...args: any[]) => Promise<unknown> };
      close: () => void;
    };
    const connection = {
      agent: { request: request as (...args: any[]) => Promise<unknown> },
      close: vi.fn(),
    } as TestConnection;
    const backend = new AcpBackend({ name: 'acp' });
    const internals = backend as unknown as {
      registerTransientSession: (
        connection: TestConnection,
        id: string,
        record: { id: string; connection: TestConnection; cleanupClaimed: boolean },
      ) => void;
      cleanupTransientSessions: (
        connection: TestConnection,
        ids: readonly string[],
        capabilities: { delete: Record<string, never>; close: Record<string, never> },
      ) => Promise<void>;
    };
    const capabilities = { delete: {}, close: {} };

    internals.registerTransientSession(connection, 'recycled-session', {
      id: 'recycled-session', connection, cleanupClaimed: false,
    });
    await internals.cleanupTransientSessions(connection, ['recycled-session'], capabilities);
    await internals.cleanupTransientSessions(connection, ['recycled-session'], capabilities);
    expect(request).toHaveBeenCalledTimes(1);

    internals.registerTransientSession(connection, 'recycled-session', {
      id: 'recycled-session', connection, cleanupClaimed: false,
    });
    await internals.cleanupTransientSessions(connection, ['recycled-session'], capabilities);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(call => call[0])).toEqual([
      methods.agent.session.delete,
      methods.agent.session.delete,
    ]);
  });
});
