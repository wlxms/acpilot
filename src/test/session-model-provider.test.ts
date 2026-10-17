import { describe, expect, it, vi } from 'vitest';
import type {
  Backend,
  BackendModelInvocationRequest,
} from '../backend/backend';
import type { BackendModel } from '../backend/types';
import {
  createSessionModelProvider,
  SESSION_MODEL_CLEANUP_TIMEOUT_MS,
} from '../backend/session-model-provider';

function request(overrides: Partial<BackendModelInvocationRequest> = {}): BackendModelInvocationRequest {
  return {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    prompt: { text: 'hello', attachments: [{ mime: 'image/png', url: 'data:image/png;base64,x' }] },
    directory: 'D:/workspace',
    title: 'test request',
    stream: {} as BackendModelInvocationRequest['stream'],
    token: { isCancellationRequested: false },
    ...overrides,
  };
}

function backend(overrides: Record<string, unknown> = {}): Backend {
  return {
    name: 'opencode',
    isRunning: () => true,
    start: vi.fn(async () => ({ data: { url: 'http://localhost', status: 'running' as const } })),
    stop: vi.fn(async () => undefined),
    getStatus: () => 'running',
    getUrl: () => 'http://localhost',
    sessions: {
      create: vi.fn(async () => ({ data: { id: 'temporary', title: 'test', createdAt: new Date() } })),
      get: vi.fn(), update: vi.fn(), list: vi.fn(), children: vi.fn(), status: vi.fn(),
      descendants: vi.fn(), findAncestor: vi.fn(), parent: vi.fn(), messages: vi.fn(),
      prompt: vi.fn(async () => ({ data: true })),
      abort: vi.fn(async () => ({ data: true })),
      delete: vi.fn(async () => ({ data: true })),
    },
    config: {
      models: vi.fn(async () => ({ data: [] as BackendModel[] })),
      agents: vi.fn(), get: vi.fn(), update: vi.fn(), updateGlobal: vi.fn(),
    },
    events: {
      openSessionStream: vi.fn(() => ({ stream: (async function* () {})() })),
      openGlobalStream: vi.fn(), closeSessionStream: vi.fn(), ensureStarted: vi.fn(async () => undefined),
    },
    permissions: { reply: vi.fn() },
    questions: { reply: vi.fn(), reject: vi.fn() },
    auth: { setKey: vi.fn(), removeKey: vi.fn() },
    createPipeline: vi.fn(() => ({ run: vi.fn(async () => ({
      completed: true,
      userMessageId: 'user-1',
      sessionTitle: null,
      sessionTitleSource: null,
      hadSubagentTasks: false,
    })) })),
    ...overrides,
  } as unknown as Backend;
}

describe('session model provider', () => {
  it('filters models that cannot be addressed by a backend session', async () => {
    const models: BackendModel[] = [
      { id: 'valid', provider: 'opencode' },
      { id: 'missing-provider' },
      { id: '', provider: 'opencode' },
    ];
    const modelBackend = backend({ config: {
      models: vi.fn(async () => ({ data: models })),
      agents: vi.fn(), get: vi.fn(), update: vi.fn(), updateGlobal: vi.fn(),
    } });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.listModels('D:/workspace')).resolves.toEqual({
      data: [{ ...models[0], capabilitiesRaw: { toolCalling: true } }],
    });
    expect(modelBackend.config.models).toHaveBeenCalledWith('D:/workspace');
  });

  it('fills a missing tool capability when a backend sends an undefined alias', async () => {
    const modelBackend = backend({ config: {
      models: vi.fn(async () => ({
        data: [{
          id: 'undefined-capability',
          provider: 'opencode',
          capabilitiesRaw: { toolCalling: undefined },
        } satisfies BackendModel],
      })),
      agents: vi.fn(), get: vi.fn(), update: vi.fn(), updateGlobal: vi.fn(),
    } });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.listModels('D:/workspace')).resolves.toEqual({
      data: [{
        id: 'undefined-capability',
        provider: 'opencode',
        capabilitiesRaw: { toolCalling: true },
      }],
    });
  });

  it('preserves an explicit false tool capability', async () => {
    const modelBackend = backend({ config: {
      models: vi.fn(async () => ({
        data: [{
          id: 'no-tools',
          provider: 'opencode',
          capabilitiesRaw: { toolcall: false },
        } satisfies BackendModel],
      })),
      agents: vi.fn(), get: vi.fn(), update: vi.fn(), updateGlobal: vi.fn(),
    } });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.listModels('D:/workspace')).resolves.toEqual({
      data: [{
        id: 'no-tools',
        provider: 'opencode',
        capabilitiesRaw: { toolcall: false },
      }],
    });
  });

  it('opens the stream before prompting and runs pipeline and prompt concurrently', async () => {
    const order: string[] = [];
    let releaseEvent!: () => void;
    const event = new Promise<void>(resolve => { releaseEvent = resolve; });
    const stream = (async function* () {
      await event;
      yield { type: 'done' };
    })();
    const requestWithOptions = request({ modelOptions: { variant: 'fast', temperature: 0.2 } });
    const prompt = vi.fn(async (_id, _text, _directory, options) => {
      order.push('prompt');
      expect(options.model).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
      expect(options.modelOptions).toEqual({ variant: 'fast', temperature: 0.2 });
      expect(options.modelOptions).not.toBe(requestWithOptions.modelOptions);
      expect(options.attachments).toEqual([{ mime: 'image/png', url: 'data:image/png;base64,x' }]);
      expect(options.attachments).not.toBe(request().prompt.attachments);
      releaseEvent();
      return { data: true };
    });
    const run = vi.fn(async (events: AsyncIterable<unknown>) => {
      order.push('pipeline');
      for await (const item of events) {
        expect(item).toEqual({ type: 'done' });
      }
      return {
        completed: true, userMessageId: 'user-1', sessionTitle: 'test',
        sessionTitleSource: null, hadSubagentTasks: false,
      };
    });
    const modelBackend = backend({
      sessions: {
        ...backend().sessions,
        prompt,
      },
      events: {
        ...backend().events,
        openSessionStream: vi.fn(() => { order.push('open'); return { stream }; }),
        ensureStarted: vi.fn(async () => { order.push('ensure'); }),
      },
      createPipeline: vi.fn(() => ({ run })),
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    const result = await provider.invoke(requestWithOptions);

    expect(order).toEqual(['open', 'ensure', 'pipeline', 'prompt']);
    expect(run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ completed: true, sessionId: 'temporary' });
    expect(modelBackend.events.closeSessionStream).toHaveBeenCalledWith('temporary');
    expect(modelBackend.sessions.delete).toHaveBeenCalledWith('temporary', 'D:/workspace');
  });

  it('passes the non-interactive permission context to the backend pipeline', async () => {
    const createPipeline = vi.fn(() => ({
      run: vi.fn(async () => ({
        completed: true,
        userMessageId: null,
        sessionTitle: null,
        sessionTitleSource: null,
        hadSubagentTasks: false,
      })),
    }));
    const modelBackend = backend({ createPipeline });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await provider.invoke(request({ allowUserInteraction: false }));

    expect(createPipeline).toHaveBeenCalledWith(expect.objectContaining({
      allowUserInteraction: false,
    }));
  });

  it('aborts and converges when the pipeline ends incomplete while prompt hangs', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const abort = vi.fn(async () => ({ data: true }));
      const modelBackend = backend({
        sessions: {
          ...backend().sessions,
          prompt: vi.fn(() => never),
          abort,
        },
        createPipeline: vi.fn(() => ({
          run: vi.fn(async () => ({
            completed: false,
            userMessageId: null,
            sessionTitle: null,
            sessionTitleSource: null,
            hadSubagentTasks: false,
          })),
        })),
      });
      const provider = createSessionModelProvider(modelBackend, 'opencode');
      const invocation = provider.invoke(request());

      // Let session creation, stream setup, and both operations start. The
      // provider crosses several asynchronous boundaries before invoking the
      // pipeline, so wait on the observable backend calls rather than relying
      // on a fixed number of microtask turns.
      await vi.waitFor(() => {
        expect(modelBackend.sessions.prompt).toHaveBeenCalledWith(
          'temporary',
          'hello',
          'D:/workspace',
          expect.anything(),
        );
      }, { timeout: 1000 });
      await vi.waitFor(() => {
        expect(abort).toHaveBeenCalledWith('temporary', 'D:/workspace');
      }, { timeout: 1000 });

      // The prompt remains unresolved; bounded invocation draining must still
      // let the provider return its incomplete result.
      await vi.advanceTimersByTimeAsync(SESSION_MODEL_CLEANUP_TIMEOUT_MS * 2 + 100);
      await expect(invocation).resolves.toMatchObject({
        completed: false,
        sessionId: 'temporary',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not block the request on hung session cleanup operations', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const appendLine = vi.fn();
      const modelBackend = backend({
        sessions: {
          ...backend().sessions,
          prompt: vi.fn(async () => ({ error: 'prompt failed' })),
          abort: vi.fn(() => never),
          delete: vi.fn(() => never),
          release: vi.fn(() => never),
        },
      });
      const provider = createSessionModelProvider(modelBackend, 'opencode');
      const invocation = provider.invoke(request({ logger: { appendLine } }));
      const rejection = invocation.then(
        () => undefined,
        error => error,
      );

      // Let the invocation reach cleanup, then advance all bounded cleanup and
      // drain timers in one deterministic step.
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(SESSION_MODEL_CLEANUP_TIMEOUT_MS * 4 + 100);

      await expect(rejection).resolves.toEqual(expect.objectContaining({
        message: 'Backend prompt failed: prompt failed',
      }));
      expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      expect(modelBackend.sessions.delete).toHaveBeenCalledWith('temporary', 'D:/workspace');
      expect(modelBackend.sessions.release).toHaveBeenCalledWith('temporary', 'D:/workspace');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and cleans up when cancellation is observed after session creation', async () => {
    let cancelled = false;
    const abort = vi.fn(async () => ({ data: true }));
    const modelBackend = backend({
      sessions: {
        ...backend().sessions,
        create: vi.fn(async () => {
          cancelled = true;
          return { data: { id: 'temporary', title: 'test', createdAt: new Date() } };
        }),
        abort,
      },
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.invoke(request({ token: { get isCancellationRequested() { return cancelled; } } })))
      .rejects.toThrow('cancelled');
    expect(abort).toHaveBeenCalledWith('temporary', 'D:/workspace');
    expect(modelBackend.sessions.delete).toHaveBeenCalledWith('temporary', 'D:/workspace');
  });
});
