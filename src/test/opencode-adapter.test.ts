import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  session: {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    prompt: vi.fn(),
    promptAsync: vi.fn(),
    revert: vi.fn(),
    abort: vi.fn(),
    list: vi.fn(),
    children: vi.fn(),
    status: vi.fn(),
    messages: vi.fn(),
  },
  global: {
    event: vi.fn(),
    config: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
  event: {
    subscribe: vi.fn(),
  },
  app: {
    agents: vi.fn(),
  },
  config: {
    providers: vi.fn(),
    get: vi.fn(),
  },
  permission: {
    reply: vi.fn(),
  },
  question: {
    reply: vi.fn(),
    reject: vi.fn(),
  },
};

const mockServerManager = {
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
  getUrl: vi.fn(),
  isRunning: vi.fn(),
  getClient: vi.fn(),
};

vi.mock('../opencode/server', () => ({
  OpenCodeServerManager: vi.fn(function OpenCodeServerManager() {
    return mockServerManager;
  }),
}));

import { OpenCodeBackend } from '../backends/opencode/adapter';

describe('OpenCodeBackend', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:12345');
    mockServerManager.stop.mockResolvedValue(undefined);
    mockServerManager.getStatus.mockReturnValue('running');
    mockServerManager.getUrl.mockReturnValue('http://127.0.0.1:12345');
    mockServerManager.isRunning.mockReturnValue(true);
    mockServerManager.getClient.mockReturnValue(mockClient);
  });

  it('retries a transient empty provider catalog after startup', async () => {
    vi.useFakeTimers();
    try {
      const backend = new OpenCodeBackend();
      await backend.start('D:\\Temp');
      mockClient.config.providers
        .mockResolvedValueOnce({ data: { providers: [] } })
        .mockResolvedValueOnce({ data: { providers: [] } })
        .mockResolvedValueOnce({
          data: {
            providers: [{
              id: 'opencode',
              name: 'OpenCode',
              models: {
                'big-pickle': { id: 'big-pickle', name: 'Big Pickle' },
              },
            }],
          },
        });

      const resultPromise = backend.config.models('D:\\Temp');
      await vi.runAllTimersAsync();
      await expect(resultPromise).resolves.toEqual({
        data: [{
          id: 'big-pickle',
          name: 'Big Pickle',
          provider: 'opencode',
          providerName: 'OpenCode',
          capabilitiesRaw: undefined,
          maxInputTokens: undefined,
          maxOutputTokens: undefined,
        }],
      });
      expect(mockClient.config.providers).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops model discovery when the captured runtime is stopped', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    let resolveProviders!: (value: { data: { providers: [] } }) => void;
    mockClient.config.providers.mockReturnValueOnce(new Promise(resolve => {
      resolveProviders = resolve;
    }));

    const resultPromise = backend.config.models('D:\\Temp');
    await vi.waitFor(() => expect(mockClient.config.providers).toHaveBeenCalledOnce());
    await backend.stop();
    resolveProviders({ data: { providers: [] } });

    await expect(resultPromise).resolves.toEqual({
      error: 'OpenCode backend runtime changed while discovering models',
    });
    expect(mockClient.config.providers).toHaveBeenCalledOnce();
  });

  it('uses the async prompt route so streaming turns are accepted by OpenCode', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.prompt.mockResolvedValue({
      error: {
        name: 'UnknownError',
        data: {
          message: 'Unexpected server error. Check server logs for details.',
          ref: 'err_sync_route',
        },
      },
    });
    mockClient.session.promptAsync.mockResolvedValue({
      data: null,
      request: { timeout: false },
      response: {},
    });

    const result = await backend.sessions.prompt('ses_123', 'Say only: ok', 'D:\\Temp', {
      agent: 'build',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    });

    expect(result.error).toBeUndefined();
    expect(mockClient.session.prompt).not.toHaveBeenCalled();
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      directory: 'D:\\Temp',
      parts: [{ type: 'text', text: 'Say only: ok' }],
      agent: 'build',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    });
  });

  it('forwards per-request tool permission overrides to OpenCode', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.promptAsync.mockResolvedValue({
      data: null,
      request: { timeout: false },
      response: {},
    });

    const result = await backend.sessions.prompt('ses_123', 'Answer with text only', 'D:\\Temp', {
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      tools: { '*': false },
    });

    expect(result.error).toBeUndefined();
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      directory: 'D:\\Temp',
      parts: [{ type: 'text', text: 'Answer with text only' }],
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      tools: { '*': false },
    });
  });

  it('forces OpenCode into a read-only tool set for read-only requests', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.promptAsync.mockResolvedValue({
      data: null,
      request: { timeout: false },
      response: {},
    });

    await backend.sessions.prompt('ses_123', 'Inspect the workspace', 'D:\\Temp', {
      permissionMode: 'read-only',
    });

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      tools: {
        '*': false,
        read: true,
        glob: true,
        grep: true,
        list: true,
        lsp: true,
        webfetch: true,
        websearch: true,
      },
    }));
  });

  it('maps the supported model variant to the OpenCode prompt field and ignores unknown options', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.promptAsync.mockResolvedValue({
      data: null,
      request: { timeout: false },
      response: {},
    });

    const result = await backend.sessions.prompt('ses_123', 'Use the fast variant', 'D:\\Temp', {
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      modelOptions: {
        variant: 'fast',
        temperature: 0.2,
      },
    });

    expect(result.error).toBeUndefined();
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      directory: 'D:\\Temp',
      parts: [{ type: 'text', text: 'Use the fast variant' }],
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      variant: 'fast',
    });
  });

  it('does not send an invalid or empty model variant', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.promptAsync.mockResolvedValue({ data: null });

    await backend.sessions.prompt('ses_123', 'Use defaults', 'D:\\Temp', {
      modelOptions: { variant: 42 },
    });
    await backend.sessions.prompt('ses_123', 'Use defaults', 'D:\\Temp', {
      modelOptions: { variant: '' },
    });

    expect(mockClient.session.promptAsync).toHaveBeenNthCalledWith(1, {
      sessionID: 'ses_123',
      directory: 'D:\\Temp',
      parts: [{ type: 'text', text: 'Use defaults' }],
    });
    expect(mockClient.session.promptAsync).toHaveBeenNthCalledWith(2, {
      sessionID: 'ses_123',
      directory: 'D:\\Temp',
      parts: [{ type: 'text', text: 'Use defaults' }],
    });
  });

  it('deletes a temporary session through the OpenCode session API', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.delete.mockResolvedValue({ data: true });

    const result = await backend.sessions.delete?.('ses_temporary', 'D:\\Temp');

    expect(result).toEqual({ data: true });
    expect(mockClient.session.delete).toHaveBeenCalledWith({
      sessionID: 'ses_temporary',
      directory: 'D:\\Temp',
    });
  });

  it('cleans transient model sessions before stopping the OpenCode server', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_transient', title: 'LM Provider Chat' },
    });
    mockClient.session.delete.mockResolvedValue({ data: true });

    await expect(backend.sessions.create({
      directory: 'D:\\Temp',
      transient: true,
    })).resolves.toMatchObject({ data: { id: 'ses_transient' } });

    await backend.stop();

    expect(mockClient.session.delete).toHaveBeenCalledWith({
      sessionID: 'ses_transient',
      directory: 'D:\\Temp',
    });
    expect(mockClient.session.delete.mock.invocationCallOrder[0])
      .toBeLessThan(mockServerManager.stop.mock.invocationCallOrder[0]);
  });

  it('does not retry a transient session after it was deleted normally', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_deleted', title: 'LM Provider Chat' },
    });
    mockClient.session.delete.mockResolvedValue({ data: true });

    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });
    await expect(backend.sessions.delete?.('ses_deleted', 'D:\\Temp'))
      .resolves.toEqual({ data: true });
    await backend.stop();

    expect(mockClient.session.delete).toHaveBeenCalledTimes(1);
  });

  it('reuses a transient cleanup tombstone for repeated explicit deletes', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_repeat_delete', title: 'LM Provider Chat' },
    });
    mockClient.session.delete.mockResolvedValue({ data: true });

    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });
    await expect(backend.sessions.delete?.('ses_repeat_delete', 'D:\\Temp'))
      .resolves.toEqual({ data: true });
    await expect(backend.sessions.delete?.('ses_repeat_delete', 'D:\\Temp'))
      .resolves.toEqual({ data: true });

    expect(mockClient.session.delete).toHaveBeenCalledTimes(1);
  });

  it('shares an explicit transient delete with shutdown cleanup', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_delete_race', title: 'LM Provider Chat' },
    });

    let resolveDelete!: (value: { data: boolean }) => void;
    mockClient.session.delete.mockReturnValue(new Promise(resolve => {
      resolveDelete = resolve;
    }));
    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });

    const explicitDelete = backend.sessions.delete?.('ses_delete_race', 'D:\\Temp');
    await vi.waitFor(() => expect(mockClient.session.delete).toHaveBeenCalledOnce());

    const stop = backend.stop();
    await Promise.resolve();
    expect(mockClient.session.delete).toHaveBeenCalledOnce();

    resolveDelete({ data: true });
    await expect(explicitDelete).resolves.toEqual({ data: true });
    await stop;
    expect(mockClient.session.delete).toHaveBeenCalledOnce();
  });

  it('deduplicates transient markers that reuse a client session id', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_reused', title: 'LM Provider Chat' },
    });
    mockClient.session.delete.mockResolvedValue({ data: true });

    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });
    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });
    await backend.stop();

    // Both marker objects identify the same client/runtime/session resource;
    // shutdown must issue one remote delete and share its keyed state.
    expect(mockClient.session.delete).toHaveBeenCalledTimes(1);
  });

  it('replaces a completed cleanup tombstone when a transient id is reused', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_reused_after_cleanup', title: 'LM Provider Chat' },
    });
    mockClient.session.delete.mockResolvedValue({ data: true });

    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });
    await expect(backend.sessions.delete?.('ses_reused_after_cleanup', 'D:\\Temp'))
      .resolves.toEqual({ data: true });

    // A new remote resource may legally recycle the protocol id after the
    // prior delete has completed. It must receive its own cleanup request.
    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });
    await backend.stop();

    expect(mockClient.session.delete).toHaveBeenCalledTimes(2);
  });

  it('cleans a transient session that is created while stop is in flight', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    let resolveCreate!: (value: { data: { id: string; title: string } }) => void;
    mockClient.session.create.mockReturnValue(new Promise(resolve => {
      resolveCreate = resolve;
    }));
    mockClient.session.delete.mockResolvedValue({ data: true });

    const create = backend.sessions.create({
      directory: 'D:\\Temp',
      transient: true,
    });
    await vi.waitFor(() => expect(mockClient.session.create).toHaveBeenCalledOnce());
    const stop = backend.stop();
    resolveCreate({ data: { id: 'ses_late', title: 'LM Provider Chat' } });

    await expect(create).resolves.toMatchObject({ data: { id: 'ses_late' } });
    await stop;

    expect(mockClient.session.delete).toHaveBeenCalledWith({
      sessionID: 'ses_late',
      directory: 'D:\\Temp',
    });
    expect(mockClient.session.delete.mock.invocationCallOrder[0])
      .toBeLessThan(mockServerManager.stop.mock.invocationCallOrder[0]);
  });

  it('drains an in-flight transient create before closing the server', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    let resolveCreate!: (value: { data: { id: string; title: string } }) => void;
    mockClient.session.create.mockReturnValue(new Promise(resolve => {
      resolveCreate = resolve;
    }));
    mockClient.session.delete.mockResolvedValue({ data: true });

    const create = backend.sessions.create({
      directory: 'D:\\Temp',
      transient: true,
    });
    await vi.waitFor(() => expect(mockClient.session.create).toHaveBeenCalledOnce());

    const stop = backend.stop();
    await Promise.resolve();
    expect(mockServerManager.stop).not.toHaveBeenCalled();

    resolveCreate({ data: { id: 'ses_drained', title: 'LM Provider Chat' } });
    await expect(create).resolves.toMatchObject({ data: { id: 'ses_drained' } });
    await stop;

    expect(mockClient.session.delete).toHaveBeenCalledWith({
      sessionID: 'ses_drained',
      directory: 'D:\\Temp',
    });
    expect(mockClient.session.delete.mock.invocationCallOrder[0])
      .toBeLessThan(mockServerManager.stop.mock.invocationCallOrder[0]);
  });

  it('waits for transient cleanup before starting a replacement runtime', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.create.mockResolvedValue({
      data: { id: 'ses_restart', title: 'LM Provider Chat' },
    });

    let resolveDelete!: (value: { data: boolean }) => void;
    mockClient.session.delete.mockReturnValueOnce(new Promise(resolve => {
      resolveDelete = resolve;
    }));
    await backend.sessions.create({ directory: 'D:\\Temp', transient: true });

    const stop = backend.stop();
    await vi.waitFor(() => expect(mockClient.session.delete).toHaveBeenCalledOnce());

    const restart = backend.start('D:\\Next');
    expect(mockServerManager.start).toHaveBeenCalledOnce();

    resolveDelete({ data: true });
    await stop;
    await expect(restart).resolves.toMatchObject({ data: { status: 'running' } });
    expect(mockServerManager.start).toHaveBeenCalledTimes(2);
  });

  it('bounds a deferred server start and lets a replacement runtime proceed', async () => {
    vi.useFakeTimers();
    try {
      const backend = new OpenCodeBackend();
      let resolveFirstStart!: (value: string) => void;
      mockServerManager.start
        .mockReturnValueOnce(new Promise(resolve => {
          resolveFirstStart = resolve;
        }))
        .mockResolvedValueOnce('http://127.0.0.1:22334');

      const firstStart = backend.start();
      await Promise.resolve();
      expect(mockServerManager.start).toHaveBeenCalledOnce();

      const stop = backend.stop();
      await Promise.resolve();
      const replacement = backend.start();
      await Promise.resolve();
      expect(mockServerManager.start).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(2_000);
      await stop;
      await expect(replacement).resolves.toMatchObject({
        data: { status: 'running' },
      });

      resolveFirstStart('http://127.0.0.1:11223');
      await expect(firstStart).resolves.toEqual({
        error: 'OpenCode backend start cancelled',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
