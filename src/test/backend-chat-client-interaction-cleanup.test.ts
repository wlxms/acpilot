import { describe, expect, it, vi } from 'vitest';
import type {
  Backend,
  BackendModelInvocationRequest,
  BackendPipelineResult,
} from '../backend/backend';
import { createSessionModelProvider } from '../backend/session-model-provider';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const completedPipeline: BackendPipelineResult = {
  completed: true,
  userMessageId: 'user-1',
  sessionTitle: null,
  sessionTitleSource: null,
  hadSubagentTasks: false,
};

function makeBackend(overrides: {
  create?: Backend['sessions']['create'];
  prompt?: Backend['sessions']['prompt'];
  abort?: Backend['sessions']['abort'];
  delete?: Backend['sessions']['delete'];
  release?: Backend['sessions']['release'];
  openSessionStream?: Backend['events']['openSessionStream'];
  run?: (events: AsyncIterable<unknown>, token: BackendModelInvocationRequest['token']) => Promise<BackendPipelineResult>;
} = {}): Backend {
  const create = overrides.create ?? vi.fn(async () => ({
    data: { id: 'lm-session', title: 'LM Provider Chat', createdAt: new Date() },
  }));
  const prompt = overrides.prompt ?? vi.fn(async () => ({ data: true }));
  const abort = overrides.abort ?? vi.fn(async () => ({ data: true }));
  const remove = overrides.delete ?? vi.fn(async () => ({ data: true }));
  const release = overrides.release ?? vi.fn(async () => undefined);
  const run = overrides.run ?? (async () => completedPipeline);
  const events = overrides.openSessionStream ?? vi.fn(() => ({
    stream: (async function* () {})(),
  }));

  return {
    name: 'opencode',
    isRunning: () => true,
    start: vi.fn(async () => ({ data: { url: 'http://localhost', status: 'running' as const } })),
    stop: vi.fn(async () => undefined),
    getStatus: () => 'running',
    getUrl: () => 'http://localhost',
    sessions: {
      create, prompt, abort, delete: remove, release,
      get: vi.fn(), update: vi.fn(), list: vi.fn(), children: vi.fn(), status: vi.fn(),
      descendants: vi.fn(), findAncestor: vi.fn(), parent: vi.fn(), messages: vi.fn(),
    },
    config: { models: vi.fn(async () => ({ data: [] })), agents: vi.fn(), get: vi.fn(), update: vi.fn(), updateGlobal: vi.fn() },
    events: {
      openSessionStream: events,
      openGlobalStream: vi.fn(),
      closeSessionStream: vi.fn(),
      ensureStarted: vi.fn(async () => undefined),
    },
    permissions: { reply: vi.fn() },
    questions: { reply: vi.fn(), reject: vi.fn() },
    auth: { setKey: vi.fn(), removeKey: vi.fn() },
    createPipeline: vi.fn(() => ({
      run: (rawEvents: AsyncIterable<unknown>, token: BackendModelInvocationRequest['token']) => run(rawEvents, token),
    })),
  } as unknown as Backend;
}

function makeRequest(
  token: BackendModelInvocationRequest['token'] = { isCancellationRequested: false },
  overrides: Partial<BackendModelInvocationRequest> = {},
): BackendModelInvocationRequest {
  return {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    prompt: { text: 'run edit' },
    directory: 'D:/workspace',
    stream: {} as BackendModelInvocationRequest['stream'],
    token,
    ...overrides,
  };
}

describe('backend model provider interaction cleanup', () => {
  it('stops before prompt when the runtime lease is invalidated after session creation', async () => {
    let invalidate!: () => void;
    let disposed = false;
    const runtime = {
      generation: 1,
      instanceKey: 'acp:target-a',
      isCurrent: () => !disposed,
      onInvalidated: (listener: () => void) => {
        invalidate = listener;
        return () => { disposed = true; };
      },
    };
    const prompt = vi.fn(async () => ({ data: true }));
    const modelBackend = makeBackend({ prompt });
    modelBackend.events.ensureStarted = vi.fn(async () => {
      // The backend target changes while transport setup is settling. The
      // shared backend object may already be pointing at the replacement by
      // the time the old request resumes, so prompt must never be scheduled.
      invalidate();
    });
    const provider = createSessionModelProvider(modelBackend, 'acp');

    await expect(provider.invoke(makeRequest(undefined, { runtime })))
      .rejects.toThrow('Backend runtime changed');
    expect(prompt).not.toHaveBeenCalled();
    expect(modelBackend.sessions.abort).not.toHaveBeenCalled();
    expect(modelBackend.sessions.delete).not.toHaveBeenCalled();
    expect(modelBackend.sessions.release).not.toHaveBeenCalled();
    expect(modelBackend.events.closeSessionStream).not.toHaveBeenCalled();
  });

  it('does not abort or delete through a replacement runtime after an in-flight prompt is invalidated', async () => {
    let invalidate!: () => void;
    let current = true;
    const runtime = {
      generation: 7,
      instanceKey: 'acp:target-a',
      isCurrent: () => current,
      onInvalidated: (listener: () => void) => {
        invalidate = listener;
        return () => {};
      },
    };
    let resolvePrompt!: (value: { data: true }) => void;
    const promptResult = new Promise<{ data: true }>(resolve => { resolvePrompt = resolve; });
    const prompt = vi.fn(() => promptResult);
    const modelBackend = makeBackend({ prompt });
    const provider = createSessionModelProvider(modelBackend, 'acp');
    const invocation = provider.invoke(makeRequest(undefined, { runtime }));

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    current = false;
    invalidate();
    resolvePrompt({ data: true });

    await expect(invocation).rejects.toThrow('Backend runtime changed');
    expect(modelBackend.sessions.abort).not.toHaveBeenCalled();
    expect(modelBackend.sessions.delete).not.toHaveBeenCalled();
    expect(modelBackend.sessions.release).not.toHaveBeenCalled();
    expect(modelBackend.events.closeSessionStream).not.toHaveBeenCalled();
  });

  it('does not create a session when cancellation occurs while starting the backend', async () => {
    const start = deferred<{ data: { url: string; status: 'running' } }>();
    let cancelled = false;
    const create = vi.fn(async () => ({
      data: { id: 'must-not-be-created', title: 'unused', createdAt: new Date() },
    }));
    const modelBackend = makeBackend({ create });
    modelBackend.isRunning = () => false;
    modelBackend.start = vi.fn(() => start.promise);
    const stop = vi.spyOn(modelBackend, 'stop');
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    const response = provider.invoke(makeRequest({ get isCancellationRequested() { return cancelled; } }));
    await vi.waitFor(() => expect(modelBackend.start).toHaveBeenCalledOnce());
    cancelled = true;
    await expect(response).rejects.toThrow('Model invocation cancelled');
    expect(create).not.toHaveBeenCalled();
    start.resolve({ data: { url: 'http://localhost', status: 'running' } });
    await start.promise;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it('keeps a shared lazy start alive while another invocation creates a session', async () => {
    const start = deferred<{ data: { url: string; status: 'running' } }>();
    const firstCreate = deferred<Awaited<ReturnType<Backend['sessions']['create']>>>();
    let firstCancelled = false;
    let createCount = 0;
    const create = vi.fn(() => {
      createCount += 1;
      if (createCount === 1) {
        return firstCreate.promise;
      }
      return Promise.resolve({
        data: { id: 'second-session', title: 'second', createdAt: new Date() },
      });
    });
    const modelBackend = makeBackend({ create });
    modelBackend.isRunning = () => false;
    modelBackend.start = vi.fn(() => start.promise);
    const stop = vi.spyOn(modelBackend, 'stop');
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    const first = provider.invoke(makeRequest({
      get isCancellationRequested() { return firstCancelled; },
    }));
    const second = provider.invoke(makeRequest());
    await vi.waitFor(() => expect(modelBackend.start).toHaveBeenCalledOnce());

    start.resolve({ data: { url: 'http://localhost', status: 'running' } });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    firstCancelled = true;

    await expect(first).rejects.toThrow('Model invocation cancelled');
    await expect(second).resolves.toMatchObject({
      completed: true,
      sessionId: 'second-session',
    });
    expect(stop).not.toHaveBeenCalled();

    firstCreate.resolve({ error: 'cancelled invocation did not create a session' });
    await firstCreate.promise;
  });

  it('stops one shared lazy start when every unclaimed invocation cancels', async () => {
    const start = deferred<{ data: { url: string; status: 'running' } }>();
    let firstCancelled = false;
    let secondCancelled = false;
    const modelBackend = makeBackend();
    modelBackend.isRunning = () => false;
    modelBackend.start = vi.fn(() => start.promise);
    const stop = vi.spyOn(modelBackend, 'stop');
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    const first = provider.invoke(makeRequest({
      get isCancellationRequested() { return firstCancelled; },
    }));
    const second = provider.invoke(makeRequest({
      get isCancellationRequested() { return secondCancelled; },
    }));
    await vi.waitFor(() => expect(modelBackend.start).toHaveBeenCalledOnce());

    firstCancelled = true;
    secondCancelled = true;
    await expect(first).rejects.toThrow('Model invocation cancelled');
    await expect(second).rejects.toThrow('Model invocation cancelled');
    expect(stop).not.toHaveBeenCalled();

    start.resolve({ data: { url: 'http://localhost', status: 'running' } });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it('does not stop a replacement runtime when lazy start settles after invalidation', async () => {
    const start = deferred<{ data: { url: string; status: 'running' } }>();
    let cancelled = false;
    let current = true;
    const runtime = {
      generation: 1,
      instanceKey: 'acp:target-a',
      isCurrent: () => current,
    };
    const modelBackend = makeBackend();
    modelBackend.isRunning = () => false;
    modelBackend.start = vi.fn(() => start.promise);
    const stop = vi.spyOn(modelBackend, 'stop');
    const provider = createSessionModelProvider(modelBackend, 'acp');

    const invocation = provider.invoke(makeRequest(
      { get isCancellationRequested() { return cancelled; } },
      { runtime },
    ));
    await vi.waitFor(() => expect(modelBackend.start).toHaveBeenCalledOnce());
    cancelled = true;
    await expect(invocation).rejects.toThrow('Model invocation cancelled');

    current = false;
    start.resolve({ data: { url: 'http://localhost', status: 'running' } });
    await start.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stop).not.toHaveBeenCalled();
  });

  it('cleans up a session that resolves after cancellation wins creation', async () => {
    const create = deferred<Awaited<ReturnType<Backend['sessions']['create']>>>();
    let cancelled = false;
    const cleanupOrder: string[] = [];
    const abort = vi.fn(async () => { cleanupOrder.push('abort'); return { data: true }; });
    const remove = vi.fn(async () => { cleanupOrder.push('delete'); return { data: true }; });
    const modelBackend = makeBackend({ create: vi.fn(() => create.promise), abort, delete: remove });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    const response = provider.invoke(makeRequest({ get isCancellationRequested() { return cancelled; } }));
    await vi.waitFor(() => expect(modelBackend.sessions.create).toHaveBeenCalledOnce());
    cancelled = true;
    await expect(response).rejects.toThrow('Model invocation cancelled');
    expect(abort).not.toHaveBeenCalled();
    create.resolve({ data: { id: 'late-session', title: 'late', createdAt: new Date() } });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('late-session', 'D:/workspace'));
    expect(cleanupOrder).toEqual(['abort', 'delete']);
  });

  it('observes a late creation rejection without replacing cancellation', async () => {
    const create = deferred<Awaited<ReturnType<Backend['sessions']['create']>>>();
    let cancelled = false;
    const appendLine = vi.fn();
    const modelBackend = makeBackend({ create: vi.fn(() => create.promise) });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    const response = provider.invoke(makeRequest(
      { get isCancellationRequested() { return cancelled; } },
      { logger: { appendLine } },
    ));
    await vi.waitFor(() => expect(modelBackend.sessions.create).toHaveBeenCalledOnce());
    cancelled = true;
    await expect(response).rejects.toThrow('Model invocation cancelled');
    create.resolve({ error: 'create failed late' });
    await vi.waitFor(() => expect(appendLine).toHaveBeenCalled());
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('late session creation failed'));
  });

  it('aborts before deleting when pipeline processing fails', async () => {
    const abortSettled = deferred<{ data: true }>();
    const cleanupOrder: string[] = [];
    const abort = vi.fn(() => {
      cleanupOrder.push('abort-start');
      return abortSettled.promise.then(value => {
        cleanupOrder.push('abort-done');
        return value;
      });
    });
    const remove = vi.fn(async () => {
      cleanupOrder.push('delete');
      return { data: true };
    });
    const modelBackend = makeBackend({
      abort,
      delete: remove,
      run: async () => { throw new Error('pipeline failed'); },
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');
    const response = provider.invoke(makeRequest());

    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(remove).not.toHaveBeenCalled();
    abortSettled.resolve({ data: true });
    await expect(response).rejects.toThrow('pipeline failed');
    expect(cleanupOrder).toEqual(['abort-start', 'abort-done', 'delete']);
  });

  it('aborts before deleting when the prompt fails', async () => {
    const cleanupOrder: string[] = [];
    const abort = vi.fn(async () => { cleanupOrder.push('abort'); return { data: true }; });
    const remove = vi.fn(async () => { cleanupOrder.push('delete'); return { data: true }; });
    const modelBackend = makeBackend({
      abort,
      delete: remove,
      prompt: vi.fn(async () => ({ error: 'prompt failed' })),
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.invoke(makeRequest())).rejects.toThrow('Backend prompt failed: prompt failed');
    expect(cleanupOrder).toEqual(['abort', 'delete']);
  });

  it('aborts before deleting when the pipeline reports an incomplete invocation', async () => {
    const cleanupOrder: string[] = [];
    const abort = vi.fn(async () => { cleanupOrder.push('abort'); return { data: true }; });
    const remove = vi.fn(async () => { cleanupOrder.push('delete'); return { data: true }; });
    const modelBackend = makeBackend({
      abort,
      delete: remove,
      run: async () => ({ ...completedPipeline, completed: false }),
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.invoke(makeRequest())).resolves.toMatchObject({ completed: false });
    expect(cleanupOrder).toEqual(['abort', 'delete']);
  });

  it('closes and deletes after a successful invocation without aborting', async () => {
    const modelBackend = makeBackend();
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.invoke(makeRequest())).resolves.toMatchObject({
      completed: true,
      sessionId: 'lm-session',
    });
    expect(modelBackend.sessions.abort).not.toHaveBeenCalled();
    expect(modelBackend.events.closeSessionStream).toHaveBeenCalledWith('lm-session');
    expect(modelBackend.sessions.delete).toHaveBeenCalledWith('lm-session', 'D:/workspace');
    expect(modelBackend.sessions.release).toHaveBeenCalledWith('lm-session', 'D:/workspace');
  });

  it('releases local session resources after remote deletion', async () => {
    const cleanupOrder: string[] = [];
    const modelBackend = makeBackend({
      delete: vi.fn(async () => { cleanupOrder.push('delete'); return { data: true }; }),
      release: vi.fn(async () => { cleanupOrder.push('release'); }),
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.invoke(makeRequest())).resolves.toMatchObject({ completed: true });
    expect(cleanupOrder).toEqual(['delete', 'release']);
  });

  it('continues deleting when closing the stream fails', async () => {
    const cleanupOrder: string[] = [];
    const modelBackend = makeBackend({
      delete: vi.fn(async () => { cleanupOrder.push('delete'); return { data: true }; }),
    });
    modelBackend.events.closeSessionStream = vi.fn(() => {
      cleanupOrder.push('close');
      throw new Error('close failed');
    });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    // Stream-close failures are best effort and must not replace a successful
    // model result. Deletion still proceeds after the close failure.
    await expect(provider.invoke(makeRequest())).resolves.toMatchObject({ completed: true });
    expect(cleanupOrder).toEqual(['close', 'delete']);
  });

  it('aborts before deleting when cancellation is observed after session creation', async () => {
    const cleanupOrder: string[] = [];
    let cancelled = false;
    const abort = vi.fn(async () => { cleanupOrder.push('abort'); return { data: true }; });
    const remove = vi.fn(async () => { cleanupOrder.push('delete'); return { data: true }; });
    const create = vi.fn(async () => {
      cancelled = true;
      return { data: { id: 'lm-session', title: 'LM Provider Chat', createdAt: new Date() } };
    });
    const modelBackend = makeBackend({ create, abort, delete: remove });
    const provider = createSessionModelProvider(modelBackend, 'opencode');

    await expect(provider.invoke(makeRequest({ get isCancellationRequested() { return cancelled; } })))
      .rejects.toThrow('Model invocation cancelled');
    expect(cleanupOrder).toEqual(['abort', 'delete']);
  });
});
