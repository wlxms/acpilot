import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Backend } from '../backend/backend';

// ---------------------------------------------------------------------------
// Mocks 閳?must be before all imports
// ---------------------------------------------------------------------------

const mockSdkClient = {
  session: {
    create: vi.fn(),
    get: vi.fn(),
    prompt: vi.fn(),
    promptAsync: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { createParticipantHandler } from '../participant/handler';
import type { OpenCodeEvent } from '../backends/opencode/sdk-events';
import type { BackendServerStatus } from '../backend/types';
import type { ExtensionState, SessionState, BackendContext } from '../types';
import { AppEventBus } from '../backend/app-event-bus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Empty async generator for event subscribe mock */
async function* emptyEventStream(): AsyncIterable<OpenCodeEvent> {
  // No events 閳?completes immediately
}

function createRequest(
  overrides: Partial<vscode.ChatRequest> & Pick<vscode.ChatRequest, 'prompt'>,
): vscode.ChatRequest {
  const { prompt, ...rest } = overrides;
  return {
    prompt,
    command: undefined,
    references: [],
    toolReferences: [],
    toolInvocationToken: undefined,
    model: undefined,
    id: 'req-1',
    sessionId: 'chat-test',
    sessionResource: { fsPath: '/test/chat' } as vscode.Uri,
    attempt: 0,
    ...rest,
  } as unknown as vscode.ChatRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createParticipantHandler', () => {
  let state: ExtensionState;
  let ctx: BackendContext & { sessionMap: Map<string, SessionState> };
  let stream: vscode.ChatResponseStream;
  let token: vscode.CancellationToken;
  let backendStatus: BackendServerStatus;
  let workspaceRoot: string;

  beforeEach(() => {
    vi.resetAllMocks();
    backendStatus = 'stopped';
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-workspace-'));
    const sessionStore = new Map<string, SessionState>();
    vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([]);

    const backend: Backend = {
      name: 'opencode',
      start: vi.fn(async () => {
        backendStatus = 'running';
        return { data: { url: 'http://127.0.0.1:51777', status: 'running' as const } };
      }),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => backendStatus),
      getUrl: vi.fn(() => 'http://127.0.0.1:51777'),
      isRunning: vi.fn(() => backendStatus === 'running'),
      sessions: {
        create: vi.fn(async (options?: { title?: string; directory?: string; parentId?: string }) => {
          const result = await mockSdkClient.session.create({
            directory: options?.directory,
            title: options?.title,
            parentId: options?.parentId,
          });
          return { data: result.data ? { id: result.data.id ?? '', title: result.data.title ?? '', createdAt: new Date() } : undefined, error: result.error };
        }),
        get: vi.fn(async () => ({ data: undefined })),
        prompt: vi.fn(async (id: string, text: string, directory?: string) => {
          const result = await mockSdkClient.session.promptAsync({
            sessionID: id,
            directory,
            parts: [{ type: 'text', text }],
          });
          return { data: result };
        }),
        revert: vi.fn(async (id: string, messageId: string, partId?: string, directory?: string) => {
          const result = await mockSdkClient.session.revert({
            sessionID: id,
            directory,
            messageID: messageId,
            partID: partId,
          });
          if (result && typeof result === 'object' && 'error' in result) {
            return { error: String(result.error) };
          }
          return { data: result };
        }),
        abort: vi.fn(async (id: string, directory?: string) => {
          const result = await mockSdkClient.session.abort({
            sessionID: id,
            directory,
          });
          return { data: result.data };
        }),
        list: vi.fn(async () => ({ data: [] })),
        update: vi.fn(async () => ({ data: { id: 'updated-session', title: 'Updated Title', createdAt: new Date() } })),
        children: vi.fn(),
        status: vi.fn(),
        descendants: vi.fn(() => []),
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
        openSessionStream: vi.fn((backendSessionId: string) => ({
          stream: (async function* () {
            const global = await mockSdkClient.global.event();
            for await (const event of global.stream) {
              if (!('directory' in event && 'payload' in event)) {
                yield event;
                continue;
              }
              const payload = event.payload;
              const payloadSession = payload.type === 'session.idle'
                ? payload.sessionId
                : payload.type === 'part.updated'
                  ? payload.part?.sessionId
                  : payload.type === 'part.delta'
                    ? undefined
                    : payload.type === 'session.diff'
                      ? payload.sessionId
                      : payload.type === 'permission.asked'
                        ? payload.sessionId
                        : undefined;
              if (!payloadSession || payloadSession === backendSessionId) {
                yield event;
              }
            }
          })(),
        })),
        openGlobalStream: vi.fn(async () => ({ stream: (async function* () {})() })),
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
      createBridge: vi.fn(() => ({
        setSSS: vi.fn(),
        setStream: vi.fn(),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn(),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      })) as unknown as Backend['createBridge'],
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
      scheme: 'acpilot.opencode',
      vendors: ['opencode-cli', 'opencode-zen'],
      backend,
      sessions: {
        get: vi.fn((key: string) => sessionStore.get(key)),
        has: vi.fn((key: string) => sessionStore.has(key)),
        set: vi.fn((key: string, value: SessionState) => { sessionStore.set(key, value); }),
        values: vi.fn(() => sessionStore.values()),
      } as unknown as BackendContext['sessions'],
      sessionMap: sessionStore,
      selection: {
        get: vi.fn(() => ({ agent: undefined, model: undefined })),
        setModel: vi.fn(async () => {}),
        setAgent: vi.fn(async () => {}),
      } as unknown as BackendContext['selection'],
      sessionStore: {
        getTurnsPath: vi.fn().mockReturnValue(''),
        getSessionDir: vi.fn().mockReturnValue(''),
        initialize: vi.fn().mockResolvedValue(undefined),
        writeMeta: vi.fn().mockResolvedValue(undefined),
        updateMeta: vi.fn().mockResolvedValue(undefined),
      } as any,
    };

    state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel,
      statusBar: {} as ExtensionState['statusBar'],
      bus: new AppEventBus(),
      acpModels: {
        sync: vi.fn(async () => {}),
        resolve: vi.fn(() => ({ kind: 'not-found' as const })),
        getModelsForCopilotRegistration: vi.fn(() => []),
        refresh: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as unknown as ExtensionState['acpModels'],
    };

    stream = {
      markdown: vi.fn(),
      progress: vi.fn(),
      push: vi.fn(),
    } as unknown as vscode.ChatResponseStream;

    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };

    // Default abort mock 閳?resolves to prevent handler crash on cancellation
    mockSdkClient.session.abort.mockResolvedValue({ data: true });

    // Set workspace folders for consistent test behavior
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      {
        uri: { fsPath: workspaceRoot } as vscode.Uri,
        name: 'test',
        index: 0,
      },
    ];
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  it('should return a function', () => {
    const handler = createParticipantHandler(state, ctx);
    expect(typeof handler).toBe('function');
  });

  // -----------------------------------------------------------------------
  // Cancellation
  // -----------------------------------------------------------------------

  it('should return early on cancellation', async () => {
    const handler = createParticipantHandler(state, ctx);
    const cancelledToken: vscode.CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: vi.fn(),
    };

    const result = await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      cancelledToken,
    );

    expect(result).toEqual({ metadata: {} });
    expect(ctx.backend.start).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Empty prompt
  // -----------------------------------------------------------------------
  // Empty prompt
  // -----------------------------------------------------------------------

  it('should return early with help message for empty prompt', async () => {
    const handler = createParticipantHandler(state, ctx);

    await handler(
      createRequest({ prompt: '' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('/help'),
    );
    expect(ctx.backend.start).not.toHaveBeenCalled();
  });

  it('should return early for whitespace-only prompt', async () => {
    const handler = createParticipantHandler(state, ctx);

    await handler(
      createRequest({ prompt: '   ' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('/help'),
    );
  });

  // -----------------------------------------------------------------------
  // Slash command routing
  // -----------------------------------------------------------------------

  it('should route slash commands via the commands module', async () => {
    const handler = createParticipantHandler(state, ctx);

    await handler(
      createRequest({ prompt: '/help', command: 'help' }),
      { history: [] },
      stream,
      token,
    );

    // /help should output help text
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('/new'),
    );
  });

  // -----------------------------------------------------------------------
  // Full flow 閳?start server, create session, send message
  // -----------------------------------------------------------------------

  it('should start server and create session when not running', async () => {
    const handler = createParticipantHandler(state, ctx);

    // Setup mocks for the full flow
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-1' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'write a test', sessionId: 'chat-1' }),
      { history: [] },
      stream,
      token,
    );

    // Server was started
    expect(ctx.backend.start).toHaveBeenCalledOnce();

    // Session was created with workspace directory and title
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      directory: workspaceRoot,
      title: 'OpenCode Session chat-1',
    });
    // Session stored in sessionMap under the vscode chat session ID
    expect(ctx.sessionMap.get('chat-1')?.backendSessionId).toBe('session-1');

    // Events subscribed
    expect(ctx.backend.events.ensureStarted).toHaveBeenCalled();

    // Prompt sent with correct format (v2 flat params)
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'session-1',
      parts: [{ type: 'text', text: 'write a test' }],
      directory: workspaceRoot,
    });

    // Progress was reported
    expect(stream.progress).toHaveBeenCalled();

    // Result contains session metadata
    expect(result!.metadata).toHaveProperty('sessionId', 'session-1');
    // turnMap should be in metadata
    expect(result!.metadata).toHaveProperty('turnMap');
  });

  it('writes initial session meta before first-prompt title patches', async () => {
    backendStatus = 'running';
    const order: string[] = [];
    const handler = createParticipantHandler(state, ctx);

    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-meta-order', title: 'New OpenCode Session' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    vi.mocked(ctx.sessionStore.writeMeta).mockImplementation(async () => {
      order.push('writeMeta:start');
      await Promise.resolve();
      order.push('writeMeta:end');
    });
    vi.mocked(ctx.sessionStore.updateMeta).mockImplementation(async () => {
      order.push('updateMeta');
      return undefined as never;
    });
    vi.mocked(ctx.backend.sessions.update).mockImplementation(async (_id, options) => {
      order.push('backendUpdate');
      return {
        data: {
          id: 'session-meta-order',
          title: options.title ?? '',
          createdAt: new Date(),
        },
      };
    });

    await handler(
      createRequest({ prompt: 'rename the session early', sessionId: 'chat-meta-order' }),
      { history: [] },
      stream,
      token,
    );

    expect(order).toContain('writeMeta:end');
    expect(order).toContain('backendUpdate');
    expect(order.indexOf('writeMeta:end')).toBeLessThan(order.indexOf('backendUpdate'));
    expect(order.indexOf('writeMeta:end')).toBeLessThan(order.indexOf('updateMeta'));
  });

  // -----------------------------------------------------------------------
  // Multi-turn 閳?reuses existing session
  // -----------------------------------------------------------------------

  it('should reuse active session for multi-turn conversation', async () => {
    backendStatus = 'running';
    // Pre-populate sessionMap with existing session
    ctx.sessionMap.set('chat-1', {
      backendSessionId: 'existing-session',
      turnMap: [],
      title: 'Existing Session',
    });

    const handler = createParticipantHandler(state, ctx);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'follow up', sessionId: 'chat-1' }),
      { history: [] },
      stream,
      token,
    );

    // Should NOT start server (already running)
    expect(ctx.backend.start).not.toHaveBeenCalled();
    // Should NOT create session (reusing existing)
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    // Should send message to existing session with directory query
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'existing-session',
      parts: [{ type: 'text', text: 'follow up' }],
      directory: workspaceRoot,
    });
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');
  });

  it('should persist the live VS Code request id in SSS stream records', async () => {
    backendStatus = 'running';
    ctx.sessionMap.set('chat-edit-request-id', {
      backendSessionId: 'existing-session',
      turnMap: [],
    });

    vi.mocked(ctx.backend.createBridge).mockReturnValue({
      setSSS: vi.fn(),
      run: vi.fn().mockResolvedValue(true),
      getUserMessageId: vi.fn().mockReturnValue('msg-live'),
      getSessionTitle: vi.fn().mockReturnValue(null),
      getHadSubagentTasks: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<Backend['createBridge']>);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state, ctx);
    await handler(
      createRequest({
        prompt: 'edit file',
        id: 'request-live-handler-0',
        sessionId: 'chat-edit-request-id',
      }),
      { history: [] },
      stream,
      token,
    );

    const sessionPath = path.join(
      workspaceRoot,
      '.acpilot',
      'opencode',
      'existing-session',
      'session.jsonl',
    );
    const records = fs.readFileSync(sessionPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const userPromptRecord = records.find(record => record.t === 'stream-part' && record.d?.kind === 'userPrompt');

    expect(userPromptRecord?.d?.meta?.requestId).toBe('request-live-handler-0');
    expect(userPromptRecord?.d?.meta?.turnIndex).toBe(0);
  });

  it('should reuse restored target session when state exists under sessionResource', async () => {
    backendStatus = 'running';
    const resourceKey = 'acpilot.opencode:///session-existing';
    const restoredState = {
      backendSessionId: 'existing-session',
      turnMap: [],
      title: 'Restored Session',
    };
    ctx.sessionMap.set(resourceKey, restoredState);

    const handler = createParticipantHandler(state, ctx);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({
        prompt: 'continue restored chat',
        sessionId: 'chat-from-target',
        sessionResource: {
          toString: () => resourceKey,
          fsPath: '/test/chat',
        } as vscode.Uri,
      }),
      { history: [] },
      stream,
      token,
    );

    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'existing-session',
      parts: [{ type: 'text', text: 'continue restored chat' }],
      directory: workspaceRoot,
    });
    expect(ctx.sessionMap.get('chat-from-target')).toBe(restoredState);
    expect(ctx.sessionMap.get(resourceKey)).toBe(restoredState);
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');
  });

  it('should create provider untitled sessions with New OpenCode Session title', async () => {
    backendStatus = 'running';
    const handler = createParticipantHandler(state, ctx);

    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-provider-1', title: 'New OpenCode Session' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    await handler(
      createRequest({
        prompt: 'provider start',
        sessionId: 'acpilot.opencode:/untitled-123',
        sessionResource: { toString: () => 'acpilot.opencode:/untitled-123', fsPath: '/test/chat' } as vscode.Uri,
      }),
      { history: [] },
      stream,
      token,
    );

    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      directory: workspaceRoot,
      title: 'New OpenCode Session',
    });
  });

  // -----------------------------------------------------------------------
  // Rewind / revert
  // -----------------------------------------------------------------------

  it('should detect rewind and revert extraneous messages when user edits a previous turn', async () => {
    backendStatus = 'running';
    // Simulate 2 completed turns: turnMap has 2 entries
    ctx.sessionMap.set('chat-revert-1', {
      backendSessionId: 'revert-session',
      turnMap: [
        { vscodeTurn: 0, messageId: 'msg-0' },
        { vscodeTurn: 1, messageId: 'msg-1' },
      ],
    });

    // Mock revert to succeed
    mockSdkClient.session.revert.mockResolvedValue({ data: true });
    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state, ctx);

    // History has only 1 ChatRequestTurn 閳?currentTurnIndex = 1 < turnMap.length(2) 閳?rewind
    // @ts-expect-error 閳?private ctor in vscode types, public in mock
const reqTurn = new vscode.ChatRequestTurn('initial', undefined);
    const result = await handler(
      createRequest({ prompt: 'edited follow-up', sessionId: 'chat-revert-1' }),
      { history: [reqTurn] },
      stream,
      token,
    );

    // Should revert msg-1 (the extraneous turn, from back to front)
    expect(mockSdkClient.session.revert).toHaveBeenCalledTimes(1);
    expect(mockSdkClient.session.revert).toHaveBeenCalledWith({
      sessionID: 'revert-session',
      messageID: 'msg-1',
      directory: workspaceRoot,
    });

    // Should NOT create a new session
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();

    // TurnMap should be trimmed to keep only the first entry
    const chatState = ctx.sessionMap.get('chat-revert-1')!;
    expect(chatState.turnMap).toEqual([
      { vscodeTurn: 0, messageId: 'msg-0' },
    ]);

    // Should prompt on the same reverted session
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'revert-session',
      parts: [{ type: 'text', text: 'edited follow-up' }],
      directory: workspaceRoot,
    });
    expect(result!.metadata).toHaveProperty('sessionId', 'revert-session');
  });

  it('should revert multiple extraneous messages when user rewinds multiple turns', async () => {
    backendStatus = 'running';
    // Simulate 3 completed turns
    ctx.sessionMap.set('chat-revert-3', {
      backendSessionId: 'revert-session-3',
      turnMap: [
        { vscodeTurn: 0, messageId: 'msg-0' },
        { vscodeTurn: 1, messageId: 'msg-1' },
        { vscodeTurn: 2, messageId: 'msg-2' },
      ],
    });

    mockSdkClient.session.revert.mockResolvedValue({ data: true });
    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state, ctx);

    // History has only 1 ChatRequestTurn 閳?currentTurnIndex = 1 < 3 閳?full rewind
    // @ts-expect-error 閳?private ctor in vscode types, public in mock
const reqTurn = new vscode.ChatRequestTurn('initial', undefined);
    const result = await handler(
      createRequest({ prompt: 'restart from turn 0', sessionId: 'chat-revert-3' }),
      { history: [reqTurn] },
      stream,
      token,
    );

    // Should revert msg-2 first (back to front), then msg-1
    expect(mockSdkClient.session.revert).toHaveBeenCalledTimes(2);
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(1, {
      sessionID: 'revert-session-3',
      messageID: 'msg-2',
      directory: workspaceRoot,
    });
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(2, {
      sessionID: 'revert-session-3',
      messageID: 'msg-1',
      directory: workspaceRoot,
    });

    // TurnMap should keep only msg-0
    const chatState = ctx.sessionMap.get('chat-revert-3')!;
    expect(chatState.turnMap).toEqual([
      { vscodeTurn: 0, messageId: 'msg-0' },
    ]);
    expect(result!.metadata).toHaveProperty('sessionId', 'revert-session-3');
  });

  it('should handle full rewind to beginning when no prior messages remain', async () => {
    backendStatus = 'running';
    // Simulate 2 completed turns
    ctx.sessionMap.set('chat-revert-full', {
      backendSessionId: 'full-rewind-session',
      turnMap: [
        { vscodeTurn: 0, messageId: 'msg-0' },
        { vscodeTurn: 1, messageId: 'msg-1' },
      ],
    });

    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state, ctx);

    // No request turns in history 閳?currentTurnIndex = 0 < 2 閳?full rewind with no revert needed
    const result = await handler(
      createRequest({ prompt: 'start fresh', sessionId: 'chat-revert-full' }),
      { history: [] },
      stream,
      token,
    );

    // Should NOT call revert (no prior message to revert to)
    expect(mockSdkClient.session.revert).not.toHaveBeenCalled();

    // TurnMap should be empty
    const chatState = ctx.sessionMap.get('chat-revert-full')!;
    expect(chatState.turnMap).toEqual([]);

    // Should prompt on the same session
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'full-rewind-session',
      parts: [{ type: 'text', text: 'start fresh' }],
      directory: workspaceRoot,
    });
  });

  it('should fall back to new session on revert failure', async () => {
    backendStatus = 'running';
    ctx.sessionMap.set('chat-revert-fail', {
      backendSessionId: 'fail-session',
      turnMap: [
        { vscodeTurn: 0, messageId: 'msg-0' },
        { vscodeTurn: 1, messageId: 'msg-1' },
      ],
    });

    // Mock revert to fail
    mockSdkClient.session.revert.mockResolvedValue({ error: 'revert rejected' });
    // Mock session.create fallback to succeed
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'fallback-session' },
    });
    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state, ctx);

    // @ts-expect-error 閳?private ctor in vscode types, public in mock
const reqTurn = new vscode.ChatRequestTurn('initial', undefined);
    const result = await handler(
      createRequest({ prompt: 'after revert fail', sessionId: 'chat-revert-fail' }),
      { history: [reqTurn] },
      stream,
      token,
    );

    // Should have attempted revert
    expect(mockSdkClient.session.revert).toHaveBeenCalled();

    // Should fall back by creating a new session
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      directory: workspaceRoot,
    });

    // Should prompt on the fallback session
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'fallback-session',
      parts: [{ type: 'text', text: 'after revert fail' }],
      directory: workspaceRoot,
    });

    // TurnMap should be reset
    const chatState = ctx.sessionMap.get('chat-revert-fail')!;
    expect(chatState.turnMap).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Backend start failure
  // -----------------------------------------------------------------------

  it('should show error when backend fails to start', async () => {
    const handler = createParticipantHandler(state, ctx);

    vi.mocked(ctx.backend.start).mockResolvedValue({ error: 'backend unavailable' });

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
  });

  // -----------------------------------------------------------------------
  // Server start failure
  // -----------------------------------------------------------------------

  it('should show error when server fails to start', async () => {
    const handler = createParticipantHandler(state, ctx);
    vi.mocked(ctx.backend.start).mockRejectedValue(
      new Error('OpenCode CLI not found'),
    );

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
  });

  // -----------------------------------------------------------------------
  // Error during processing
  // -----------------------------------------------------------------------

  it('should catch errors and show them in stream', async () => {
    const handler = createParticipantHandler(state, ctx);
    mockSdkClient.session.create.mockRejectedValue(
      new Error('Session limit reached'),
    );

    await handler(
      createRequest({ prompt: 'hello', sessionId: 'chat-err' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Session limit reached'),
    );
  });

  it('should handle non-Error thrown values', async () => {
    const handler = createParticipantHandler(state, ctx);
    vi.mocked(ctx.backend.start).mockRejectedValue('string error');

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
  });

  // -----------------------------------------------------------------------
  // Already running 閳?skip server start
  // -----------------------------------------------------------------------

  it('should skip server start if already running', async () => {
    backendStatus = 'running';
    // Pre-populate sessionMap so session is reused
    ctx.sessionMap.set('chat-running', {
      backendSessionId: 'existing-id',
      turnMap: [],
      title: 'Existing Session',
    });

    const handler = createParticipantHandler(state, ctx);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    await handler(
      createRequest({ prompt: 'question', sessionId: 'chat-running' }),
      { history: [] },
      stream,
      token,
    );

    expect(ctx.backend.start).not.toHaveBeenCalled();
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'existing-id',
      parts: [{ type: 'text', text: 'question' }],
      directory: workspaceRoot,
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation during active session 閳?abort
  // -----------------------------------------------------------------------

  it('should call session.abort when cancelled mid-session', async () => {
    const handler = createParticipantHandler(state, ctx);

    // Set up a running backend
    backendStatus = 'running';
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-abort-test' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    // Create a token that fires cancellation via onCancellationRequested callback
    let cancelCallback: (() => void) | undefined;
    const cancelToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn((cb: () => void) => {
        cancelCallback = cb;
        return { dispose: vi.fn() };
      }),
    } as unknown as vscode.CancellationToken;

    // Fire the handler 閳?it will subscribe to cancellation
    const handlerPromise = handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      cancelToken,
    );

    // Give the handler a tick to register the cancellation listener
    await vi.waitFor(() => {
      expect(cancelCallback).toBeDefined();
    });

    // Simulate VSCode firing cancellation (user clicks "Stop")
    cancelCallback!();

    // Wait for handler to complete
    await handlerPromise;

    // Verify abort was called with the correct session ID
    expect(mockSdkClient.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session-abort-test',
        directory: workspaceRoot,
      }),
    );
  });

  it('should not call session.abort when handler completes normally', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('chat-normal', {
      backendSessionId: 'session-normal',
      turnMap: [],
      title: 'Existing Session',
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    await handler(
      createRequest({ prompt: 'hello', sessionId: 'chat-normal' }),
      { history: [] },
      stream,
      token,
    );

    // abort should NOT have been called for a normal completion
    expect(mockSdkClient.session.abort).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Per-edit externalEdit tracker 閳?injected into StreamBridge for permission.asked lifecycle
  // -----------------------------------------------------------------------

  it('should pass tracker to StreamBridge for per-edit externalEdit handling', async () => {
    const handler = createParticipantHandler(state, ctx);

    // Set up full flow mocks
    backendStatus = 'running';
    ctx.sessionMap.set('chat-cp-1', {
      backendSessionId: 'existing-session',
      turnMap: [],
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'test tracker', sessionId: 'chat-cp-1' }),
      { history: [] },
      stream,
      token,
    );

    // Should complete without error
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');

    // Prompt should have been sent (StreamBridge processes events)
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalled();
  });

  it('should collect open file URIs for knownFileUris new-file detection', async () => {
    const handler = createParticipantHandler(state, ctx);

    // Simulate open text documents (file scheme, not untitled)
    const mockDocs = [
      { uri: vscode.Uri.file('/src/app.ts'), isUntitled: false },
      { uri: vscode.Uri.file('/src/util.ts'), isUntitled: false },
    ];
    (vscode.workspace as { textDocuments: unknown }).textDocuments = mockDocs;

    // Set up full flow mocks
    backendStatus = 'running';
    ctx.sessionMap.set('chat-cp-2', {
      backendSessionId: 'existing-session',
      turnMap: [],
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'test files', sessionId: 'chat-cp-2' }),
      { history: [] },
      stream,
      token,
    );

    // Should complete without error
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');

    // Clean up
    (vscode.workspace as { textDocuments: unknown }).textDocuments = [];
  });

  it('should dispose tracker in finally block even on error', async () => {
    const handler = createParticipantHandler(state, ctx);

    // Set up so that the handler starts but prompt throws
    backendStatus = 'running';
    ctx.sessionMap.set('chat-cp-3', {
      backendSessionId: 'existing-session',
      turnMap: [],
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.promptAsync.mockRejectedValue(new Error('prompt failed'));

    // Handler should complete without crashing (prompt error is caught internally)
    const result = await handler(
      createRequest({ prompt: 'test error cleanup', sessionId: 'chat-cp-3' }),
      { history: [] },
      stream,
      token,
    );

    // Should still return metadata (prompt error is swallowed by .catch())
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');

    // Prompt error should be logged
    expect(state.outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('Prompt error'),
    );
  });

  it('should update sessionMap title from backend after turn completes', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('chat-title-test', {
      backendSessionId: 'ses-title-123',
      turnMap: [],
      title: 'New OpenCode Session',
    });

    // Backend returns an auto-generated title
    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-123', title: 'How to implement OAuth', createdAt: new Date() },
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    const result = await handler(
      createRequest({ prompt: 'how to implement oauth', sessionId: 'chat-title-test' }),
      { history: [] },
      stream,
      token,
    );

    // Handler should complete normally
    expect(result!.metadata).toHaveProperty('sessionId');

    // sessionMap should be updated with the backend title
    const chatState = ctx.sessionMap.get('chat-title-test');
    expect(chatState?.title).toBe('How to implement OAuth');
    expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
      'ses-title-123',
      expect.objectContaining({
        title: 'How to implement OAuth',
        backendName: 'opencode',
      }),
    );
  });

  it('should apply copilot-style session title returned by the bridge', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('chat-title-lm', {
      backendSessionId: 'ses-title-lm',
      turnMap: [],
      title: 'New OpenCode Session',
    });

    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-lm', title: 'New OpenCode Session', createdAt: new Date() },
    });
    vi.mocked(ctx.backend.sessions.update).mockImplementation(async (_id, options) => ({
      data: { id: 'ses-title-lm', title: options.title ?? '', createdAt: new Date() },
    }));
    const selectChatModelsSpy = vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([]);

    vi.mocked(ctx.backend.createBridge).mockReturnValue({
      setSSS: vi.fn(),
      setStream: vi.fn(),
      setCallbacks: vi.fn(),
      setTracker: vi.fn(),
      processEvent: vi.fn(),
      run: vi.fn().mockResolvedValue(true),
      getUserMessageId: vi.fn().mockReturnValue('user-title-lm'),
      getSessionTitle: vi.fn().mockReturnValue('OAuth Middleware'),
      getSessionTitleSource: vi.fn().mockReturnValue('copilot-style'),
      getHadSubagentTasks: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<Backend['createBridge']>);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    const result = await handler(
      createRequest({ prompt: 'how to implement oauth middleware', sessionId: 'chat-title-lm' }),
      { history: [] },
      stream,
      token,
    );

    expect(result!.metadata).toHaveProperty('sessionId');
    expect(selectChatModelsSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(ctx.sessionMap.get('chat-title-lm')?.title).toBe('OAuth Middleware');
    });
    expect(ctx.backend.sessions.update).toHaveBeenCalledWith(
      'ses-title-lm',
      expect.objectContaining({ title: 'how to implement oauth middleware' }),
    );
    expect(ctx.backend.sessions.update).toHaveBeenCalledWith(
      'ses-title-lm',
      expect.objectContaining({ title: 'how to implement oauth middleware' }),
    );
    expect(ctx.backend.sessions.update).not.toHaveBeenCalledWith(
      'ses-title-lm',
      expect.objectContaining({ title: 'OAuth Middleware' }),
    );
    expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
      'ses-title-lm',
      expect.objectContaining({ title: 'OAuth Middleware', titleSource: 'copilot-style' }),
    );
  });

  it('should apply SSS title updates while bridge is still running', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('chat-title-live', {
      backendSessionId: 'ses-title-live',
      turnMap: [],
      title: 'New OpenCode Session',
    });

    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-live', title: 'New OpenCode Session', createdAt: new Date() },
    });
    vi.mocked(ctx.backend.sessions.update).mockImplementation(async (_id, options) => ({
      data: { id: 'ses-title-live', title: options.title ?? '', createdAt: new Date() },
    }));
    vi.mocked(ctx.backend.createBridge).mockReturnValue({
      setSSS: vi.fn(),
      run: vi.fn().mockImplementation(async function (this: { setSSS: ReturnType<typeof vi.fn> }) {
        const sss = this.setSSS.mock.calls[0]?.[0] as {
          updateTitle(title: string, source: 'copilot-style'): string | undefined;
        };
        sss.updateTitle('OAuth Middleware', 'copilot-style');
        await vi.waitFor(() => {
          expect(ctx.sessionMap.get('chat-title-live')?.title).toBe('OAuth Middleware');
        });
        expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
          'ses-title-live',
          expect.objectContaining({ title: 'OAuth Middleware', titleSource: 'copilot-style' }),
        );
        return true;
      }),
      getUserMessageId: vi.fn().mockReturnValue('user-title-live'),
      getSessionTitle: vi.fn().mockReturnValue('OAuth Middleware'),
      getSessionTitleSource: vi.fn().mockReturnValue('copilot-style'),
      getHadSubagentTasks: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<Backend['createBridge']>);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    const result = await handler(
      createRequest({ prompt: 'how to implement oauth middleware', sessionId: 'chat-title-live' }),
      { history: [] },
      stream,
      token,
    );

    expect(result!.metadata).toHaveProperty('sessionId', 'ses-title-live');
  });

  it('should apply copilot-style bridge title over provider-created prompt title', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('acpilot.opencode:/ses-title-provider', {
      backendSessionId: 'ses-title-provider',
      turnMap: [],
      title: 'how to implement oauth middleware',
      titleSource: 'history',
      // This reproduces the live failure: the visible prompt-derived title is
      // present, but the request lookup may not carry provisionalTitle.
      provisionalTitle: undefined,
    });

    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-provider', title: 'how to implement oauth middleware', createdAt: new Date() },
    });
    vi.mocked(ctx.backend.sessions.update).mockImplementation(async (_id, options) => ({
      data: { id: 'ses-title-provider', title: options.title ?? '', createdAt: new Date() },
    }));
    vi.mocked(ctx.backend.createBridge).mockReturnValue({
      setSSS: vi.fn(),
      setStream: vi.fn(),
      setCallbacks: vi.fn(),
      setTracker: vi.fn(),
      processEvent: vi.fn(),
      run: vi.fn().mockResolvedValue(true),
      getUserMessageId: vi.fn().mockReturnValue('user-title-provider'),
      getSessionTitle: vi.fn().mockReturnValue('OAuth Middleware'),
      getSessionTitleSource: vi.fn().mockReturnValue('copilot-style'),
      getHadSubagentTasks: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<Backend['createBridge']>);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    const result = await handler(
      createRequest({
        prompt: 'how to implement oauth middleware',
        sessionId: 'acpilot.opencode:/ses-title-provider',
      }),
      { history: [] },
      stream,
      token,
    );

    expect(result!.metadata).toHaveProperty('sessionId', 'ses-title-provider');
    const chatState = ctx.sessionMap.get('acpilot.opencode:/ses-title-provider');
    expect(chatState?.title).toBe('OAuth Middleware');
    expect(chatState?.titleSource).toBe('copilot-style');
    expect(chatState?.provisionalTitle).toBe(false);
    expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
      'ses-title-provider',
      expect.objectContaining({
        title: 'OAuth Middleware',
        titleSource: 'copilot-style',
        provisionalTitle: false,
      }),
    );
  });

  it('should not create a backend title-generator session when no bridge title is available', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('chat-title-backend-gen', {
      backendSessionId: 'ses-title-backend-gen',
      turnMap: [],
      title: 'New OpenCode Session',
    });

    vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([]);
    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-backend-gen', title: 'New OpenCode Session', createdAt: new Date() },
    });
    vi.mocked(ctx.backend.sessions.update).mockImplementation(async (_id, options) => ({
      data: { id: 'ses-title-backend-gen', title: options.title ?? '', createdAt: new Date() },
    }));
    vi.mocked(ctx.backend.createBridge).mockReturnValue({
      setSSS: vi.fn(),
      setStream: vi.fn(),
      setCallbacks: vi.fn(),
      setTracker: vi.fn(),
      processEvent: vi.fn(),
      run: vi.fn().mockResolvedValue(true),
      getUserMessageId: vi.fn().mockReturnValue('user-title-backend-gen'),
      getSessionTitle: vi.fn().mockReturnValue(null),
      getHadSubagentTasks: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<Backend['createBridge']>);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    const result = await handler(
      createRequest({ prompt: 'how to implement oauth middleware', sessionId: 'chat-title-backend-gen' }),
      { history: [] },
      stream,
      token,
    );

    expect(result!.metadata).toHaveProperty('sessionId', 'ses-title-backend-gen');
    expect(mockSdkClient.session.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'ses-title-backend-gen',
        title: 'Title Generator',
      }),
    );
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(ctx.sessionMap.get('chat-title-backend-gen')?.title).toBe('how to implement oauth middleware');
    expect(ctx.sessionMap.get('chat-title-backend-gen')?.provisionalTitle).toBe(true);
    expect(ctx.backend.sessions.update).toHaveBeenCalledWith(
      'ses-title-backend-gen',
      expect.objectContaining({ title: 'how to implement oauth middleware' }),
    );
  });

  it('should ignore provisional prompt-derived bridge title without running a title generator', async () => {
    const handler = createParticipantHandler(state, ctx);
    const provisionalTitle = 'how to implement oauth middleware';

    backendStatus = 'running';
    ctx.sessionMap.set('chat-title-provisional', {
      backendSessionId: 'ses-title-provisional',
      turnMap: [],
      title: provisionalTitle,
      titleSource: 'history',
      provisionalTitle: true,
    });

    vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([]);
    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-provisional', title: provisionalTitle, createdAt: new Date() },
    });
    vi.mocked(ctx.backend.sessions.update).mockImplementation(async (_id, options) => ({
      data: { id: 'ses-title-provisional', title: options.title ?? '', createdAt: new Date() },
    }));
    vi.mocked(ctx.backend.createBridge).mockReturnValue({
      setSSS: vi.fn(),
      setStream: vi.fn(),
      setCallbacks: vi.fn(),
      setTracker: vi.fn(),
      processEvent: vi.fn(),
      run: vi.fn().mockResolvedValue(true),
      getUserMessageId: vi.fn().mockReturnValue('user-title-provisional'),
      getSessionTitle: vi.fn().mockReturnValue(provisionalTitle),
      getHadSubagentTasks: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<Backend['createBridge']>);

    const result = await handler(
      createRequest({ prompt: provisionalTitle, sessionId: 'chat-title-provisional' }),
      { history: [] },
      stream,
      token,
    );

    expect(result!.metadata).toHaveProperty('sessionId', 'ses-title-provisional');
    expect(mockSdkClient.session.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'ses-title-provisional',
        title: 'Title Generator',
      }),
    );
    expect(ctx.sessionMap.get('chat-title-provisional')?.title).toBe(provisionalTitle);
    expect(ctx.sessionMap.get('chat-title-provisional')?.titleSource).toBe('history');
    expect(ctx.sessionMap.get('chat-title-provisional')?.provisionalTitle).toBe(true);
    expect(ctx.backend.sessions.update).toHaveBeenCalledWith(
      'ses-title-provisional',
      expect.objectContaining({ title: provisionalTitle }),
    );
  });

  it('should not overwrite existing non-placeholder title with backend placeholder', async () => {
    const handler = createParticipantHandler(state, ctx);

    backendStatus = 'running';
    ctx.sessionMap.set('chat-title-keep', {
      backendSessionId: 'ses-title-456',
      turnMap: [],
      title: 'Existing Good Title',
    });

    // Backend returns a placeholder title
    vi.mocked(ctx.backend.sessions.get).mockResolvedValue({
      data: { id: 'ses-title-456', title: 'Session 001', createdAt: new Date() },
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    const result = await handler(
      createRequest({ prompt: 'test keeping title', sessionId: 'chat-title-keep' }),
      { history: [] },
      stream,
      token,
    );

    expect(result!.metadata).toHaveProperty('sessionId');

    // sessionMap should keep the existing non-placeholder title
    const chatState = ctx.sessionMap.get('chat-title-keep');
    expect(chatState?.title).toBe('Existing Good Title');
  });
});
// ---------------------------------------------------------------------------
// resolvePromptModel 閳?native model sync tests
// ---------------------------------------------------------------------------

import { resolvePromptAgent, resolvePromptModel } from '../participant/handler';

describe('resolvePromptModel', () => {
  let state: ExtensionState;
  let ctx: BackendContext;
  let backend: Backend;

  beforeEach(() => {
    vi.resetAllMocks();

    backend = {
      config: {
        models: vi.fn(async () => ({ data: [] })),
      },
    } as unknown as Backend;

    const selection = {
      get: vi.fn(() => ({ agent: undefined, model: { providerID: 'openai', modelID: 'gpt-4' } })),
      setModel: vi.fn(async () => {}),
    };
    ctx = {
      id: 'opencode',
      scheme: 'acpilot.opencode',
      vendors: ['opencode-cli', 'opencode-zen'],
      backend,
      selection,
    } as unknown as BackendContext;

    state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel: {
        appendLine: vi.fn(),
      } as any,
    } as unknown as ExtensionState;
  });

  it('should fall back to SelectionStore when request.model is undefined', async () => {
    const request = createRequest({ prompt: 'test' });
    // request.model is undefined by default in createRequest
    const result = await resolvePromptModel(request, state, ctx);

    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    expect(ctx.selection.setModel).not.toHaveBeenCalled();
  });

  it('should fall back to SelectionStore when backend model list is empty', async () => {
    const request = createRequest({
      prompt: 'test',
      model: { id: 'gpt-4o', name: 'GPT-4o', vendor: 'openai', family: 'gpt-4o', version: '1' } as any,
    });

    const result = await resolvePromptModel(request, state, ctx);

    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    expect(ctx.selection.setModel).not.toHaveBeenCalled();
  });

  it('should match native model id to backend model and sync selection', async () => {
    (backend.config.models as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        { id: 'claude-3', name: 'Claude 3', provider: 'anthropic' },
      ],
    });
    // SelectionStore has a different model
    (ctx.selection.get as ReturnType<typeof vi.fn>).mockReturnValue({
      agent: undefined,
      model: { providerID: 'anthropic', modelID: 'claude-3' },
    });

    const request = createRequest({
      prompt: 'test',
      model: { id: 'gpt-4o', name: 'GPT-4o', vendor: 'openai', family: 'gpt-4o', version: '1' } as any,
    });

    const result = await resolvePromptModel(request, state, ctx);

    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    // Should sync to SelectionStore since it differs from current
    expect(ctx.selection.setModel).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('should not re-sync when native model matches current selection', async () => {
    (backend.config.models as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }],
    });

    const request = createRequest({
      prompt: 'test',
      model: { id: 'gpt-4', name: 'GPT-4', vendor: 'openai', family: 'gpt-4', version: '1' } as any,
    });

    const result = await resolvePromptModel(request, state, ctx);

    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    // Same as current 閳?no sync needed
    expect(ctx.selection.setModel).not.toHaveBeenCalled();
  });

  it('should fall back to SelectionStore on ambiguous match (multiple candidates)', async () => {
    (backend.config.models as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: 'gpt-4', name: 'GPT-4', provider: 'openai' },
        { id: 'gpt-4', name: 'GPT-4 Custom', provider: 'custom' },
      ],
    });

    const request = createRequest({
      prompt: 'test',
      model: { id: 'gpt-4', name: 'GPT-4', vendor: 'openai', family: 'gpt-4', version: '1' } as any,
    });

    const result = await resolvePromptModel(request, state, ctx);

    // Ambiguous 閳?should fall back to SelectionStore
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    expect(ctx.selection.setModel).not.toHaveBeenCalled();
  });

  it('should fall back to SelectionStore when native model not in backend catalogue', async () => {
    (backend.config.models as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 'claude-3', name: 'Claude 3', provider: 'anthropic' }],
    });

    const request = createRequest({
      prompt: 'test',
      model: { id: 'copilot-model-x', name: 'Copilot X', vendor: 'copilot', family: 'unknown', version: '1' } as any,
    });

    const result = await resolvePromptModel(request, state, ctx);

    // No match 閳?fall back to SelectionStore
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
  });
});

describe('resolvePromptAgent', () => {
  let state: ExtensionState;
  let ctx: BackendContext;
  let backend: Backend;

  beforeEach(() => {
    vi.resetAllMocks();

    backend = {
      config: {
        agents: vi.fn(async () => ({
          data: [
            { id: 'sisyphus', name: 'Sisyphus - Ultraworker', mode: 'primary' },
            { id: 'prometheus', name: 'Prometheus', mode: 'primary' },
          ],
        })),
      },
    } as unknown as Backend;

    const selection = {
      get: vi.fn(() => ({ agent: 'Sisyphus - Ultraworker' })),
      setAgent: vi.fn(async () => {}),
    };
    ctx = {
      id: 'opencode',
      scheme: 'acpilot.opencode',
      vendors: ['opencode-cli', 'opencode-zen'],
      backend,
      selection,
    } as unknown as BackendContext;

    state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel: {
        appendLine: vi.fn(),
      } as any,
    } as unknown as ExtensionState;
  });

  it('normalizes a persisted display name to the backend agent id', async () => {
    const result = await resolvePromptAgent(state, ctx, 'D:\\Temp');

    expect(result).toBe('sisyphus');
    expect(ctx.selection.setAgent).toHaveBeenCalledWith('sisyphus');
    expect(backend.config.agents).toHaveBeenCalledWith('D:\\Temp');
  });

  it('keeps an already-valid backend agent id unchanged', async () => {
    (ctx.selection.get as ReturnType<typeof vi.fn>).mockReturnValue({ agent: 'prometheus' });

    const result = await resolvePromptAgent(state, ctx);

    expect(result).toBe('prometheus');
    expect(ctx.selection.setAgent).not.toHaveBeenCalled();
  });
});
