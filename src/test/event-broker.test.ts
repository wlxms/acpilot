import { describe, it, expect, vi } from 'vitest';
import { GlobalEventBroker } from '../backends/opencode/event-broker';
import type { OpenCodeEvent, OpenCodeGlobalEventEnvelope } from '../backends/opencode/sdk-events';

function globalEvent(directory: string, payload: OpenCodeEvent): OpenCodeGlobalEventEnvelope {
  return { directory, payload };
}

function eventStream(events: OpenCodeGlobalEventEnvelope[]) {
  async function* gen(): AsyncIterable<OpenCodeGlobalEventEnvelope> {
    for (const event of events) {
      yield event;
    }
  }

  return { stream: gen() };
}

function mockClient(events: OpenCodeGlobalEventEnvelope[]) {
  let callCount = 0;
  return {
    global: {
      event: async () => {
        callCount++;
        if (callCount === 1) {
          return eventStream(events);
        }
        // On reconnect: throw to stop the pumpWithReconnect loop
        throw new Error('test: no reconnect');
      },
    },
  };
}

async function collectTypes(stream: AsyncIterable<OpenCodeGlobalEventEnvelope>, timeoutMs = 1000): Promise<string[]> {
  const types: string[] = [];
  const timer = setTimeout(() => stream[Symbol.asyncIterator]().return?.(), timeoutMs);
  try {
    for await (const event of stream) {
      types.push(event.payload.type);
    }
  } finally {
    clearTimeout(timer);
  }
  return types;
}

async function collectEvents(stream: AsyncIterable<OpenCodeGlobalEventEnvelope>, timeoutMs = 1000): Promise<OpenCodeGlobalEventEnvelope[]> {
  const events: OpenCodeGlobalEventEnvelope[] = [];
  const timer = setTimeout(() => stream[Symbol.asyncIterator]().return?.(), timeoutMs);
  try {
    for await (const event of stream) {
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe('GlobalEventBroker', () => {
  it('should route only matching session events to a session stream', async () => {
    const broker = new GlobalEventBroker();
    const client = mockClient([
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 'prt_a', text: '', messageID: 'msg_a', sessionID: 'ses_a' },
        },
      }),
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 'prt_b', text: '', messageID: 'msg_b', sessionID: 'ses_b' },
        },
      }),
      globalEvent('dir', {
        type: 'message.part.delta',
        properties: { partID: 'prt_a', delta: 'A', field: 'text' },
      }),
      globalEvent('dir', {
        type: 'session.idle',
        properties: { sessionID: 'ses_a' },
      }),
      // Events after idle should still be delivered (channel stays open)
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' }, messageID: 'msg_c', sessionID: 'ses_a' },
        },
      }),
    ]);

    const sessionStream = broker.openSessionStream('ses_a');
    const started = broker.ensureStarted(client as never);
    started.catch(() => {}); // suppress unhandled rejection from reconnect error
    await started;
    const routed = await collectEvents(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);
    const types = routed.map(event => event.payload.type);

    // session.idle is delivered but does NOT close the stream
    // Subsequent tool event should also be delivered
    expect(types).toEqual([
      'message.part.updated',
      'message.part.delta',
      'session.idle',
      'message.part.updated',
    ]);
  });

  it('should resolve delta events to a session via tracked part ids', async () => {
    const broker = new GlobalEventBroker();
    const client = mockClient([
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'prt_reason', text: '', messageID: 'msg_a', sessionID: 'ses_a' },
        },
      }),
      globalEvent('dir', {
        type: 'message.part.delta',
        properties: { partID: 'prt_reason', delta: 'think', field: 'text' },
      }),
      globalEvent('dir', {
        type: 'session.idle',
        properties: { sessionID: 'ses_a' },
      }),
    ]);

    const sessionStream = broker.openSessionStream('ses_a');
    const started = broker.ensureStarted(client as never);
    started.catch(() => {}); // suppress unhandled rejection from reconnect error
    await started;
    const routed = await collectEvents(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);
    const types = routed.map(event => event.payload.type);

    expect(types).toEqual([
      'message.part.updated',
      'message.part.delta',
      'session.idle',
    ]);
    expect((routed[1].payload as any).properties.sessionID).toBe('ses_a');
  });

  it.each(['sessionID', 'sessionId'] as const)(
    'should route message.part.updated when the session is on properties.%s',
    async (sessionField) => {
      const broker = new GlobalEventBroker();
      const client = mockClient([
        globalEvent('dir', {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', id: 'prt_top_level', text: '', messageID: 'msg_top_level' },
            [sessionField]: 'ses_top_level',
          },
        }),
        globalEvent('dir', {
          type: 'message.part.delta',
          properties: { partID: 'prt_top_level', delta: 'answer', field: 'text' },
        }),
        globalEvent('dir', {
          type: 'session.idle',
          properties: { sessionID: 'ses_top_level' },
        }),
      ]);

      const sessionStream = broker.openSessionStream('ses_top_level');
      const started = broker.ensureStarted(client as never);
      started.catch(() => {}); // suppress unhandled rejection from reconnect error
      await started;
      const routed = await collectEvents(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);

      expect(routed.map(event => event.payload.type)).toEqual([
        'message.part.updated',
        'message.part.delta',
        'session.idle',
      ]);
      expect((routed[1].payload as any).properties.sessionID).toBe('ses_top_level');
    },
  );

  it('routes a session.error without sessionID to the only active channel', async () => {
    const broker = new GlobalEventBroker();
    const internals = broker as unknown as {
      dispatch(event: OpenCodeGlobalEventEnvelope): void;
    };
    const stream = broker.openSessionStream('ses_only');

    internals.dispatch(globalEvent('dir', {
      type: 'session.error',
      properties: { error: { name: 'ApiError', data: { message: 'request failed' } } },
    } as never));

    const first = await (stream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>)[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value?.payload.type).toBe('session.error');
    expect((first.value?.payload as any).properties.sessionID).toBeUndefined();
    broker.closeSessionStream('ses_only');
  });

  it('broadcasts a session.error without sessionID when multiple channels are active', async () => {
    const broker = new GlobalEventBroker();
    const internals = broker as unknown as {
      dispatch(event: OpenCodeGlobalEventEnvelope): void;
    };
    const firstStream = broker.openSessionStream('ses_a');
    const secondStream = broker.openSessionStream('ses_b');

    internals.dispatch(globalEvent('dir', {
      type: 'session.error',
      properties: { error: { name: 'ApiError', data: { message: 'backend failed' } } },
    } as never));

    const first = await (firstStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>)[Symbol.asyncIterator]().next();
    const second = await (secondStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>)[Symbol.asyncIterator]().next();
    expect(first.value?.payload.type).toBe('session.error');
    expect(second.value?.payload.type).toBe('session.error');
    broker.closeSessionStream('ses_a');
    broker.closeSessionStream('ses_b');
  });

  it('clears stale child and pending-delta indexes when all streams close', async () => {
    const broker = new GlobalEventBroker();
    const internals = broker as unknown as {
      dispatch(event: OpenCodeGlobalEventEnvelope): void;
      closeAllSessionStreams(): void;
    };

    // Seed both correlation indexes belonging to an old connection.
    const oldStream = broker.openSessionStream('root-old');
    internals.dispatch(globalEvent('dir', {
      type: 'session.created',
      properties: {
        sessionID: 'child-old',
        info: { id: 'child-old', parentID: 'root-old' },
      },
    } as never));
    internals.dispatch(globalEvent('dir', {
      type: 'message.part.delta',
      properties: { partID: 'part-old', delta: 'stale', field: 'text' },
    }));
    // Keep the old iterator referenced so TypeScript does not optimize away
    // the stream construction; closeAllSessionStreams closes its channel.
    void oldStream;
    internals.closeAllSessionStreams();

    const fresh = broker.openSessionStream('root-new');
    // A reused child ID must not be routed through the old parent mapping.
    internals.dispatch(globalEvent('dir', {
      type: 'message.part.updated',
      properties: {
        part: { type: 'text', id: 'part-child', text: '', messageID: 'msg-child', sessionID: 'child-old' },
      },
    }));
    // A reused part ID must not receive the old no-session delta first.
    internals.dispatch(globalEvent('dir', {
      type: 'message.part.updated',
      properties: {
        part: { type: 'text', id: 'part-old', text: '', messageID: 'msg-new', sessionID: 'root-new' },
      },
    }));
    internals.dispatch(globalEvent('dir', {
      type: 'session.idle',
      properties: { sessionID: 'root-new' },
    }));

    const iterator = (fresh.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.payload.type).toBe('message.part.updated');
    expect((first.value?.payload as any).properties.part.id).toBe('part-old');
    const second = await iterator.next();
    expect(second.value?.payload.type).toBe('session.idle');
    broker.closeSessionStream('root-new');
  });

  it('does not dispatch an event that resolves after the broker is stopped', async () => {
    const broker = new GlobalEventBroker();
    let resolveNext!: (result: IteratorResult<OpenCodeGlobalEventEnvelope>) => void;
    const pendingNext = new Promise<IteratorResult<OpenCodeGlobalEventEnvelope>>(resolve => {
      resolveNext = resolve;
    });
    const iterator = {
      next: vi.fn(() => pendingNext),
      return: vi.fn(async () => ({ value: undefined, done: true } as const)),
    };
    const client = {
      global: {
        event: vi.fn(async () => ({
          stream: {
            [Symbol.asyncIterator]: () => iterator,
          },
        })),
      },
    };

    broker.openSessionStream('root');
    const started = broker.ensureStarted(client as never);
    await started;

    const internals = broker as unknown as {
      pumpPromise: Promise<void> | null;
      pendingPartDeltas: Map<string, unknown>;
    };
    const pump = internals.pumpPromise;
    expect(pump).toBeTruthy();

    await broker.stop();
    resolveNext({
      value: globalEvent('dir', {
        type: 'message.part.delta',
        properties: { partID: 'late-part', delta: 'late', field: 'text' },
      }),
      done: false,
    });
    await pump;

    expect(internals.pendingPartDeltas.size).toBe(0);
  });

  it('does not wait for a pending SSE iterator return during stop', async () => {
    const broker = new GlobalEventBroker();
    let resolveNext!: (result: IteratorResult<OpenCodeGlobalEventEnvelope>) => void;
    const pendingNext = new Promise<IteratorResult<OpenCodeGlobalEventEnvelope>>(resolve => {
      resolveNext = resolve;
    });
    let resolveReturn!: (result: IteratorResult<OpenCodeGlobalEventEnvelope>) => void;
    const pendingReturn = new Promise<IteratorResult<OpenCodeGlobalEventEnvelope>>(resolve => {
      resolveReturn = resolve;
    });
    const iterator = {
      next: vi.fn(() => pendingNext),
      return: vi.fn(() => pendingReturn),
    };
    const client = {
      global: {
        event: vi.fn(async () => ({
          stream: { [Symbol.asyncIterator]: () => iterator },
        })),
      },
    };

    broker.openSessionStream('root');
    await broker.ensureStarted(client as never);
    const internals = broker as unknown as { pumpPromise: Promise<void> | null };
    const pump = internals.pumpPromise;
    expect(pump).toBeTruthy();

    let stopFinished = false;
    const stop = broker.stop().then(() => {
      stopFinished = true;
    });
    await Promise.resolve();
    expect(stopFinished).toBe(true);
    expect(iterator.return).toHaveBeenCalledOnce();

    // Release the pending read so the pump can finish; return() itself may
    // remain pending because the transport owns its eventual completion.
    resolveNext({ done: true, value: undefined });
    resolveReturn({ done: true, value: undefined });
    await pump;
  });
});
