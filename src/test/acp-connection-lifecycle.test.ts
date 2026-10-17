import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import { AcpBackend } from '../backends/acp/adapter';
import { spawnAcpAgent } from '../backends/acp/transport';

vi.mock('../backends/acp/transport', () => ({
  spawnAcpAgent: vi.fn(),
  connectAcpRemote: vi.fn(),
}));

interface InProcessAgent {
  clientStream: Stream;
  connection: AgentConnection;
  dispose(): void;
  deleted: string[];
  closed: string[];
}

interface InProcessAgentOptions {
  onSessionNew?: (sessionId: string) => void | Promise<void>;
}

function createInProcessAgent(options: InProcessAgentOptions = {}): InProcessAgent {
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();
  const clientStream = ndJsonStream(
    clientToAgent.writable,
    agentToClient.readable,
  );
  const agentStream = ndJsonStream(
    agentToClient.writable,
    clientToAgent.readable,
  );
  const deleted: string[] = [];
  const closed: string[] = [];
  let nextSession = 0;

  const app = agent({ name: 'in-process-agent' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: {
          delete: {},
          close: {},
        },
      },
    }))
    .onRequest(methods.agent.session.new, async () => {
      const sessionId = `session-${++nextSession}`;
      await options.onSessionNew?.(sessionId);
      return {
        sessionId,
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'code', name: 'Code' }],
        },
        configOptions: [{
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'fast',
          options: [{ value: 'fast', name: 'Fast' }],
        }],
      };
    })
    .onRequest(methods.agent.session.resume, () => ({
      modes: {
        currentModeId: 'code',
        availableModes: [{ id: 'code', name: 'Code' }],
      },
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'fast',
        options: [{ value: 'fast', name: 'Fast' }],
      }],
    }))
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello from ACP' },
        },
      });
      return { stopReason: 'end_turn' };
    })
    .onRequest(methods.agent.session.delete, ({ params }) => {
      deleted.push(params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      closed.push(params.sessionId);
      return {};
    });

  const connection = app.connect(agentStream);
  return {
    clientStream,
    connection,
    deleted,
    closed,
    dispose: () => connection.close(),
  };
}

describe('ACP persistent connection lifecycle', () => {
  const backends: AcpBackend[] = [];
  const agents: InProcessAgent[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) {
      await backend.stop();
    }
    for (const testAgent of agents.splice(0)) {
      testAgent.dispose();
    }
  });

  it('keeps ActiveSession updates alive after initialize', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });

    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await expect(backend.start('D:/workspace')).resolves.toMatchObject({
      data: { status: 'running' },
    });
    const created = await backend.sessions.create({ directory: 'D:/workspace' });
    expect(created.data?.id).toBe('session-1');

    const stream = backend.events.openSessionStream(created.data!.id);
    await expect(backend.sessions.prompt(created.data!.id, 'hello', 'D:/workspace'))
      .resolves.toEqual({ data: true });

    const events = [];
    for await (const event of stream.stream) {
      events.push(event);
      if (event.kind === 'stop') {break;}
    }
    expect(events.map(event => event.kind)).toEqual(['session_update', 'stop']);
    expect(events[0]).toMatchObject({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'hello from ACP' },
      },
    });
  });

  it('discovers models on a cold backend and deletes the discovery session', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    await expect(backend.config.models('D:/workspace')).resolves.toEqual({
      data: [{ id: 'fast', name: 'Fast', provider: 'acp' }],
    });
    expect(testAgent.deleted).toEqual(['session-1']);
    expect(testAgent.closed).toEqual([]);
    await expect(backend.config.models('D:/workspace')).resolves.toEqual({
      data: [{ id: 'fast', name: 'Fast', provider: 'acp' }],
    });
    expect(testAgent.deleted).toHaveLength(1);
  });

  it('drains an in-flight discovery create before closing the old connection', async () => {
    let signalSessionNewStarted!: () => void;
    const sessionNewStarted = new Promise<void>(resolve => {
      signalSessionNewStarted = resolve;
    });
    let releaseSessionNew!: () => void;
    const sessionNewGate = new Promise<void>(resolve => {
      releaseSessionNew = resolve;
    });
    const testAgent = createInProcessAgent({
      onSessionNew: async () => {
        signalSessionNewStarted();
        await sessionNewGate;
      },
    });
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const discovery = backend.config.models('D:/workspace');
    await sessionNewStarted;

    const stopping = backend.stop();
    await Promise.resolve();
    expect(testAgent.deleted).toEqual([]);

    releaseSessionNew();
    await discovery;
    await stopping;

    expect(testAgent.deleted).toEqual(['session-1']);
  });

  it('cleans transient model sessions on stop without deleting participant sessions', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const transient = await backend.sessions.create({
      directory: 'D:/workspace',
      transient: true,
    });
    const participant = await backend.sessions.create({
      directory: 'D:/workspace',
    });
    expect(transient.data?.id).toBe('session-1');
    expect(participant.data?.id).toBe('session-2');

    await backend.stop();

    expect(testAgent.deleted).toEqual(['session-1']);
    expect(testAgent.closed).toEqual([]);
  });

  it('reclaims transient cleanup state after an unexpected connection close', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const created = await backend.sessions.create({
      directory: 'D:/workspace',
      transient: true,
    });
    expect(created.data?.id).toBe('session-1');

    const internals = backend as unknown as {
      clientConnection: { close: (error?: unknown) => void };
      transientCleanupStates: Map<unknown, unknown>;
      transientCleanupResults: Map<unknown, unknown>;
      closedTransientConnections: WeakSet<object>;
    };
    expect(internals.transientCleanupStates.size).toBe(1);

    const closedConnection = internals.clientConnection;
    closedConnection.close(new Error('simulated transport close'));
    // The client-side closed callback is scheduled from the connection turn.
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(backend.getStatus()).toBe('error');
    expect(internals.transientCleanupStates.size).toBe(0);
    expect(internals.transientCleanupResults.size).toBe(0);
    expect(internals.closedTransientConnections.has(closedConnection)).toBe(true);
  });

  it('resumes a restored session when the stream opens before prompt', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const created = await backend.sessions.create({ directory: 'D:/workspace' });
    const sessionId = created.data!.id;
    // Simulate a backend restart/reload where the remote session survives but
    // its local ActiveSession update router has been released.
    await backend.sessions.release(sessionId, 'D:/workspace');

    const stream = backend.events.openSessionStream(sessionId);
    await expect(backend.sessions.prompt(sessionId, 'hello', 'D:/workspace'))
      .resolves.toEqual({ data: true });

    const events = [];
    for await (const event of stream.stream) {
      events.push(event);
      if (event.kind === 'stop') {break;}
    }
    expect(events.map(event => event.kind)).toEqual(['session_update', 'stop']);
    expect(events[0]).toMatchObject({
      update: { sessionUpdate: 'agent_message_chunk' },
    });
  });

  it('wakes a pending stream read when the session stream is closed', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const created = await backend.sessions.create({ directory: 'D:/workspace' });
    const stream = backend.events.openSessionStream(created.data!.id);
    const iterator = stream.stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    backend.events.closeSessionStream(created.data!.id);

    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it('does not let a closed stream consume the next turn update', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const created = await backend.sessions.create({ directory: 'D:/workspace' });
    const sessionId = created.data!.id;

    // Closing while nextUpdate() is pending must detach that SDK queue waiter.
    // Otherwise it remains registered and consumes the first event of the next
    // stream opened for this durable session.
    const abandonedStream = backend.events.openSessionStream(sessionId);
    const abandonedIterator = abandonedStream.stream[Symbol.asyncIterator]();
    const abandonedRead = abandonedIterator.next();
    // Let the wrapper pass its activation turn and enter nextUpdate().
    await Promise.resolve();
    backend.events.closeSessionStream(sessionId);
    await expect(abandonedRead).resolves.toMatchObject({ done: true });

    const stream = backend.events.openSessionStream(sessionId);
    const iterator = stream.stream[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    await expect(backend.sessions.prompt(sessionId, 'hello', 'D:/workspace'))
      .resolves.toEqual({ data: true });

    await expect(Promise.race([
      firstEvent,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for next-turn update')), 100);
      }),
    ])).resolves.toMatchObject({
      done: false,
      value: { kind: 'session_update' },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'stop' },
    });
    backend.events.closeSessionStream(sessionId);
  });

  it('does not let a closed stream leave a queued stop for the next turn', async () => {
    const testAgent = createInProcessAgent();
    agents.push(testAgent);
    vi.mocked(spawnAcpAgent).mockReturnValueOnce({
      stream: testAgent.clientStream,
      process: { kill: vi.fn() } as never,
    });
    const backend = new AcpBackend({
      name: 'acp',
      local: { command: 'in-process-agent' },
    });
    backends.push(backend);

    await backend.start('D:/workspace');
    const created = await backend.sessions.create({ directory: 'D:/workspace' });
    const sessionId = created.data!.id;

    // Consume the ordinary update, but deliberately leave the stop queued by
    // ActiveSession.prompt(). Closing at this point has pendingReads === 0;
    // the stream wrapper must still rebind its local helper.
    const firstStream = backend.events.openSessionStream(sessionId);
    const firstIterator = firstStream.stream[Symbol.asyncIterator]();
    const firstRead = firstIterator.next();
    const firstPrompt = backend.sessions.prompt(sessionId, 'first', 'D:/workspace');
    await expect(firstRead).resolves.toMatchObject({
      done: false,
      value: { kind: 'session_update' },
    });
    await expect(firstPrompt).resolves.toEqual({ data: true });
    backend.events.closeSessionStream(sessionId);

    const secondStream = backend.events.openSessionStream(sessionId);
    const secondIterator = secondStream.stream[Symbol.asyncIterator]();
    const secondRead = secondIterator.next();
    await expect(backend.sessions.prompt(sessionId, 'second', 'D:/workspace'))
      .resolves.toEqual({ data: true });

    await expect(Promise.race([
      secondRead,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for second-turn update')), 100);
      }),
    ])).resolves.toMatchObject({
      done: false,
      value: { kind: 'session_update' },
    });
    await expect(secondIterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'stop' },
    });
    backend.events.closeSessionStream(sessionId);
  });
});
