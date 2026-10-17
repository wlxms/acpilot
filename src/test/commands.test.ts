import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { Backend } from '../backend/backend';
import type { BackendServerStatus } from '../backend/types';
import type { ExtensionState, BackendContext } from '../types';
import { diagnosticPermissionResponse, routeCommand } from '../participant/commands';
import { AppEventBus } from '../backend/app-event-bus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock SDK client with the expected interface */
function createMockClient() {
  return {
    session: {
      create: vi.fn(),
      get: vi.fn(),
      prompt: vi.fn(),
      revert: vi.fn(),
      abort: vi.fn(),
    },
    global: {
      event: vi.fn(),
    },
    config: {
      providers: vi.fn(),
    },
    event: {
      subscribe: vi.fn(),
    },
    permission: {
      reply: vi.fn(),
    },
    question: {
      reply: vi.fn(),
      reject: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeCommand', () => {
  let state: ExtensionState;
  let ctx: BackendContext;
  let stream: vscode.ChatResponseStream;
  let token: vscode.CancellationToken;
  let backendStatus: BackendServerStatus;

  beforeEach(() => {
    vi.resetAllMocks();
    backendStatus = 'stopped';
    const sessionStore = new Map<string, unknown>();
    const backend: Backend = {
      name: 'opencode',
      start: vi.fn(async () => {
        backendStatus = 'running';
        return { data: { url: 'http://127.0.0.1:51777', status: 'running' as const } };
      }),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn((): BackendServerStatus => backendStatus),
      getUrl: vi.fn(() => null),
      isRunning: vi.fn(() => backendStatus === 'running'),
      sessions: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(async () => ({ data: undefined })),
        prompt: vi.fn(),
        revert: vi.fn(),
        abort: vi.fn(),
        release: vi.fn(),
        list: vi.fn(),
        children: vi.fn(),
        status: vi.fn(),
        descendants: vi.fn(),
        findAncestor: vi.fn(),
        parent: vi.fn(),
        messages: vi.fn(),
      },
      config: {
        models: vi.fn(async () => ({ data: [] })),
        agents: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        updateGlobal: vi.fn(async () => ({ data: undefined })),
      },
      auth: {
        setKey: vi.fn(async () => ({ data: undefined })),
        removeKey: vi.fn(async () => ({ data: undefined })),
      },
      events: {
        openSessionStream: vi.fn(),
        openGlobalStream: vi.fn(),
        closeSessionStream: vi.fn(),
        ensureStarted: vi.fn(async () => undefined),
      },
      permissions: {
        reply: vi.fn(async () => undefined),
      },
      questions: {
        reply: vi.fn(),
        reject: vi.fn(),
      },
      createPipeline: vi.fn(() => ({
        setStream: vi.fn(),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn(),
        run: vi.fn().mockResolvedValue({ completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false }),
      })) as unknown as Backend['createPipeline'],
    };
    const outputChannel = {
      name: 'test',
      lines: [] as string[],
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.OutputChannel;

    ctx = {
      id: 'opencode',
      instanceKey: 'opencode',
      runtimeGeneration: 0,
      acceptingRequests: true,
      storageNamespace: 'opencode',
      displayName: 'OpenCode',
      scheme: 'acpilot.opencode',
      vendor: 'opencode',
      backend,
      sessions: {
        get: vi.fn((key: string) => sessionStore.get(key)),
        has: vi.fn((key: string) => sessionStore.has(key)),
        set: vi.fn((key: string, value: unknown) => { sessionStore.set(key, value); }),
        values: vi.fn(() => sessionStore.values()),
      } as unknown as BackendContext['sessions'],
      selection: {
        get: vi.fn(() => ({ agent: undefined, model: undefined, modelDisplayName: undefined })),
        setAgent: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
      } as unknown as BackendContext['selection'],
      sessionStore: {
        getSessionPath: vi.fn().mockReturnValue(''),
        getSessionDir: vi.fn().mockReturnValue(''),
        initialize: vi.fn().mockResolvedValue(undefined),
      } as any,
    };

    state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel,
      statusBar: {} as ExtensionState['statusBar'],
      bus: new AppEventBus(),
      modelCatalog: {
        list: vi.fn(() => []),
        resolve: vi.fn(() => ({ kind: 'not-found' as const })),
        refresh: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as unknown as ExtensionState['modelCatalog'],
    };
    stream = {
      markdown: vi.fn(),
      progress: vi.fn(),
      push: vi.fn(),
    } as unknown as vscode.ChatResponseStream;
    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    };
  });

  // -----------------------------------------------------------------------
  // /new
  // -----------------------------------------------------------------------

  it('should create a new session and update state for /new command', async () => {
    vi.mocked(ctx.backend.sessions.create).mockResolvedValue({
      data: { id: 'session-new', title: '', createdAt: new Date() },
    });

    await routeCommand('new', state, ctx, stream, token);

    expect(ctx.backend.start).toHaveBeenCalledOnce();
    expect(ctx.backend.sessions.create).toHaveBeenCalledWith();
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Started a new conversation session'),
    );
  });

  it('should show error when /new is called without a connected client', async () => {
    vi.mocked(ctx.backend.start).mockResolvedValue({ error: 'Server not available' });

    await routeCommand('new', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
  });

  it('should show error on /new when session creation fails', async () => {
    vi.mocked(ctx.backend.sessions.create).mockRejectedValue(
      new Error('Session limit reached'),
    );

    await routeCommand('new', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Session error'),
    );
  });

  // -----------------------------------------------------------------------
  // /help
  // -----------------------------------------------------------------------

  it('should show formatted help text for /help command', async () => {
    await routeCommand('help', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledTimes(1);
    const helpText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(helpText).toContain('/new');
    expect(helpText).toContain('/help');
    expect(helpText).toContain('/model');
    expect(helpText).toContain('Available Commands');
  });

  it('does not expose OpenCode-only diagnostics through another backend', async () => {
    const acpCtx = {
      ...ctx,
      id: 'acp',
      displayName: 'ACP Agent',
      vendor: 'acp',
    } as BackendContext;

    for (const command of ['test-external-edit-e2e', 'test-stream-latency']) {
      await routeCommand(command, state, acpCtx, stream, token);
    }

    const messages = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls
      .map(([value]) => String(value));
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.includes('only available for the OpenCode backend'))).toBe(true);
    expect(ctx.backend.start).not.toHaveBeenCalled();
    expect(ctx.backend.events.ensureStarted).not.toHaveBeenCalled();
  });

  it('omits OpenCode-only diagnostics from another backend help text', async () => {
    const acpCtx = {
      ...ctx,
      id: 'acp',
      displayName: 'ACP Agent',
      vendor: 'acp',
    } as BackendContext;

    await routeCommand('help', state, acpCtx, stream, token);

    const helpText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(helpText).not.toContain('/test-external-edit-e2e');
    expect(helpText).not.toContain('/test-stream-latency');
    expect(helpText).toContain('Just type your message to chat with ACP Agent!');
  });

  // -----------------------------------------------------------------------
  // /model
  // -----------------------------------------------------------------------

  it('should show providers and models for /model command', async () => {
    backendStatus = 'running';
    vi.mocked(ctx.backend.config.models).mockResolvedValue({
      data: [
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
        { id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'Anthropic' },
      ],
    });

    await routeCommand('model', state, ctx, stream, token);

    const modelText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(modelText).toContain('Available Models');
    expect(modelText).toContain('OpenAI');
    expect(modelText).toContain('gpt-4o');
    expect(modelText).toContain('GPT-4o');
    expect(modelText).toContain('Anthropic');
    expect(modelText).toContain('claude-3-opus');

    // Should NOT include inactive models
    expect(modelText).not.toContain('gpt-3.5-turbo');
  });

  it('should show error when /model is called without a connected client', async () => {
    vi.mocked(ctx.backend.start).mockResolvedValue({ error: 'Server not available' });

    await routeCommand('model', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
  });

  it('should show error when providers call fails', async () => {
    backendStatus = 'running';
    vi.mocked(ctx.backend.config.models).mockRejectedValue(new Error('API error'));

    await routeCommand('model', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Unable to retrieve model information'),
    );
  });

  it('should show message when no providers configured', async () => {
    backendStatus = 'running';
    vi.mocked(ctx.backend.config.models).mockResolvedValue({ data: [] });

    await routeCommand('model', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('No providers configured'),
    );
  });

  // -----------------------------------------------------------------------
  // Unknown command
  // -----------------------------------------------------------------------

  it('should show error for unknown command', async () => {
    await routeCommand('unknown', state, ctx, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command'),
    );
  });

  it('should be case-insensitive for command names', async () => {
    vi.mocked(ctx.backend.sessions.create).mockResolvedValue({
      data: { id: 'session-case', title: '', createdAt: new Date() },
    });

    await routeCommand('New', state, ctx, stream, token);

    expect(ctx.backend.sessions.create).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // /model with providers that have no active models
  // -----------------------------------------------------------------------

  it('should skip providers with no active models in /model output', async () => {
    backendStatus = 'running';
    vi.mocked(ctx.backend.config.models).mockResolvedValue({ data: [] });

    await routeCommand('model', state, ctx, stream, token);

    const modelText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;

    // Provider with no active models should not appear
    expect(modelText).not.toContain('TestAI');
  });
});

describe('diagnostic permission policy', () => {
  it('rejects missing, unexpected, and unapproved edit paths', () => {
    expect(diagnosticPermissionResponse(false, 'Allow Once')).toBe('reject');
    expect(diagnosticPermissionResponse(true, undefined)).toBe('reject');
  });

  it('allows only an explicitly approved expected path', () => {
    expect(diagnosticPermissionResponse(true, 'Allow Once')).toBe('once');
  });
});
