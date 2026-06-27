import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import { isUserSelectableAgent } from '../acp/types';
import type { AcpAgent } from '../acp/types';
import type { AcpBackend } from '../acp/backend';
import type { ExtensionState, BackendContext } from '../types';
import { AppEventBus } from '../acp/app-event-bus';
import { readLegacySessionEvents, readLegacySessionTurnEvents, readSessionTurnStreamParts } from '../acp/serializable/serializer';
import { readCheckpoints } from '../acp/checkpoint/checkpoint-store';

vi.mock('../acp/serializable/serializer', () => ({
  readLegacySessionEvents: vi.fn(),
  readLegacySessionTurnEvents: vi.fn(),
  readSessionTurnStreamParts: vi.fn(),
}));
vi.mock('../acp/checkpoint/checkpoint-store', () => ({
  readCheckpoints: vi.fn(),
}));

function makeTextEvent(text: string) {
  return {
    type: 'part.updated',
    part: { id: `p_${Date.now()}`, type: 'text', text },
  };
}

function expectRestoredTextEditParts(pushed: readonly unknown[], editId: string | undefined) {
  const uriPart = pushed.find(part => part instanceof (vscode as any).ChatResponseCodeblockUriPart) as any;
  expect(uriPart?.isEdit).toBe(true);
  expect(uriPart?.undoStopId).toBe(editId);

  const textEditParts = pushed.filter(part => part instanceof (vscode as any).ChatResponseTextEditPart) as any[];
  expect(textEditParts).toHaveLength(2);
  expect(textEditParts[0]?.editsOrDone).toEqual([]);
  expect(textEditParts[1]?.editsOrDone).toBe(true);
}

function getNonDiagnosticSessionItems(controller: vscode.ChatSessionItemController) {
  return Array.from(controller.items)
    .map(([, item]) => item)
    .filter(item => !item.resource.path.startsWith('/__'));
}

function getFirstResponseParts(session: vscode.ChatSession): unknown[] {
  const responseTurn = session.history.find(turn => !('prompt' in (turn as any))) as vscode.ChatResponseTurn;
  return (responseTurn as unknown as { responses: unknown[] }).responses;
}

describe('createSessionContentProvider', () => {
  let state: ExtensionState;
  let ctx: BackendContext;

  beforeEach(() => {
    const sessionStore = new Map<string, unknown>();
    const sessionsList = vi.fn(async () => ({
      data: [
        { id: 'ses_1', title: 'First Session', createdAt: new Date('2026-05-28T00:00:00Z') },
        { id: 'ses_2', title: '', createdAt: new Date('2026-05-28T01:00:00Z') },
      ],
    }));

    const sessionGet = vi.fn(async () => ({
      data: { id: 'ses_restore', title: '', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));

    const sessionMessages = vi.fn(async (sessionId?: string) => ({
      data: {
        items: sessionId === 'ses_restore'
          ? [
              { id: 'user_1', role: 'user' as const, text: 'Need help with session titles' },
              { id: 'assistant_1', role: 'assistant' as const, text: 'Sure', toolCalls: [] },
            ]
          : [],
      },
    }));

    vi.mocked(readLegacySessionEvents).mockResolvedValue([]);
    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([]);
    vi.mocked(readSessionTurnStreamParts).mockResolvedValue([]);
    vi.mocked(readCheckpoints).mockResolvedValue([]);

    const backend: AcpBackend = {
      name: 'opencode',
      start: vi.fn(async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } })),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn((): import('../acp/types').AcpServerStatus => 'running'),
      getUrl: vi.fn(() => 'http://127.0.0.1:4096'),
      isRunning: vi.fn(() => true),
      sessions: {
        create: vi.fn(),
        get: sessionGet,
        update: vi.fn(async () => ({ data: { id: 'updated-session', title: 'Updated Title', createdAt: new Date() } })),
        prompt: vi.fn(),
        revert: vi.fn(),
        abort: vi.fn(),
        list: sessionsList,
        children: vi.fn(),
        status: vi.fn(),
        descendants: vi.fn(() => []),
        findAncestor: vi.fn(),
        parent: vi.fn(),
        messages: sessionMessages,
      },
      config: {
        models: vi.fn(async () => ({ data: [] })),
        agents: vi.fn(async () => ({ data: [] })),
        get: vi.fn(),
        update: vi.fn(),
        updateGlobal: vi.fn(async () => ({ data: undefined })),
      },
      auth: {
        setKey: vi.fn(async () => ({ data: undefined })),
        removeKey: vi.fn(async () => ({ data: undefined })),
      },
      events: {
        ensureStarted: vi.fn(),
        openSessionStream: vi.fn(),
        openGlobalStream: vi.fn(),
        closeSessionStream: vi.fn(),
      },
      permissions: {
        reply: vi.fn(),
      },
      questions: {
        reply: vi.fn(),
        reject: vi.fn(),
      },
      createBridge: vi.fn(() => ({
        setStream: vi.fn(),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn(),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      })) as unknown as AcpBackend['createBridge'],
    };

    ctx = {
      id: 'opencode',
      scheme: 'acpilot.opencode',
      vendors: ['opencode-cli', 'opencode-zen'],
      backend,
      sessions: {
        get: vi.fn((key: string) => sessionStore.get(key)),
        has: vi.fn((key: string) => sessionStore.has(key)),
        set: vi.fn((key: string, value: unknown) => { sessionStore.set(key, value); }),
        values: vi.fn(() => sessionStore.values()),
        entries: vi.fn(() => sessionStore.entries()),
      } as unknown as BackendContext['sessions'],
      selection: {
        get: vi.fn(() => ({ agent: undefined, model: undefined, modelDisplayName: undefined })),
        setAgent: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
      } as unknown as BackendContext['selection'],
      sessionStore: {
        listSessions: vi.fn().mockResolvedValue([]),
        getTurnsPath: vi.fn().mockReturnValue(''),
        getSessionDir: vi.fn().mockReturnValue(''),
        initialize: vi.fn().mockResolvedValue(undefined),
        readMeta: vi.fn().mockResolvedValue(undefined),
        updateMeta: vi.fn().mockResolvedValue(undefined),
        writeMeta: vi.fn().mockResolvedValue(undefined),
      } as any,
    };

    state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel: vscode.window.createOutputChannel('test'),
      statusBar: { update: vi.fn() } as unknown as ExtensionState['statusBar'],
      bus: new AppEventBus(),
      acpModels: {
        sync: vi.fn(async () => {}),
        resolve: vi.fn(() => ({ kind: 'not-found' as const })),
        getModelsForCopilotRegistration: vi.fn(() => []),
        refresh: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as unknown as ExtensionState['acpModels'],
    };

    (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
      { uri: vscode.Uri.parse('file:///test-workspace'), name: 'test', index: 0 },
    ];
  });

  it('publishes session items from SessionStore during refresh', async () => {
    // Mock SessionStore to return expected sessions
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_1', title: 'First Session', createdAt: '2026-05-28T01:00:00Z', backendName: 'opencode' },
      { id: 'ses_2', title: 'Session ses_2', createdAt: '2026-05-28T01:30:00Z', backendName: 'opencode' },
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    expect(controller).toBeDefined();

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items).toHaveLength(2);
    const labels = items.map(item => item.label);
    const paths = items.map(item => item.resource.path);
    expect(labels).toContain('First Session');
    expect(labels).toContain('Session ses_2');
    expect(paths).toContain('/ses_1');
    expect(paths).toContain('/ses_2');
    expect(items.every(item => item.status === vscode.ChatSessionStatus.Completed)).toBe(true);
    expect(items.every(item => item.archived === false)).toBe(true);
  });

  it('creates a real session item before the first request for edit-session storage', async () => {
    const createdAt = new Date('2026-06-11T00:00:00.000Z');
    (ctx.backend.sessions.create as any).mockResolvedValue({
      data: { id: 'ses_new_real', title: 'Fix restored edits', createdAt },
    });

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const handler = controller!.newChatSessionItemHandler!;
    const item = await handler(
      {
        request: { prompt: 'Fix restored edits' },
        inputState: {} as vscode.ChatSessionInputState,
      },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    );

    expect(item.resource.scheme).toBe('acpilot.opencode');
    expect(item.resource.path).toBe('/ses_new_real');
    expect(item.label).toBe('Fix restored edits');
    expect(controller!.items.get(item.resource)).toBe(item);
    expect(ctx.sessions.get(item.resource.toString())?.backendSessionId).toBe('ses_new_real');
    expect(ctx.sessionStore.writeMeta).toHaveBeenCalledWith('ses_new_real', expect.objectContaining({
      id: 'ses_new_real',
      title: 'Fix restored edits',
      titleSource: 'history',
      provisionalTitle: true,
      createdAt: createdAt.toISOString(),
      backendName: 'opencode',
    }));
  });

  it('publishes runtime session when backend list is empty', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_runtime', title: 'Runtime Session', createdAt: '2026-05-28T02:00:00.000Z', backendName: 'opencode' },
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('Runtime Session');
    expect(items[0]?.description).toBeUndefined();
    expect(items[0]?.resource.path).toBe('/ses_runtime');
  });

  it('publishes archived state from persisted session metadata', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      {
        id: 'ses_archived',
        title: 'Archived Session',
        createdAt: '2026-05-28T02:00:00.000Z',
        backendName: 'opencode',
        archived: true,
      },
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items).toHaveLength(1);
    expect(items[0]?.resource.path).toBe('/ses_archived');
    expect(items[0]?.archived).toBe(true);
  });

  it('persists chat session item archive state changes', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      {
        id: 'ses_unarchive',
        title: 'Unarchive Session',
        createdAt: '2026-05-28T02:00:00.000Z',
        backendName: 'opencode',
        archived: true,
      },
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const item = getNonDiagnosticSessionItems(controller!)[0]!;
    item.archived = false;
    (controller as any).fireDidChangeChatSessionItemState(item);

    await vi.waitFor(() => {
      expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith('ses_unarchive', { archived: false });
    });
  });

  it('preserves restored provider session title in Session list items', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_restore', title: 'Restored Session', createdAt: '2026-05-28T03:00:00.000Z', backendName: 'opencode' },
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items[0]?.label).toBe('Restored Session');
    expect(items[0]?.description).toBeUndefined();
  });

  it('does not inject persisted diffs into Session list item changes', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_changes', title: 'Changed Session', createdAt: '2026-05-28T04:00:00.000Z', backendName: 'opencode' },
    ]);
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      {
        type: 'session.diff',
        sessionId: 'ses_changes',
        diffs: [
          { file: '/workspace/a.ts', patch: '', additions: 3, deletions: 1, status: 'modified' },
          { file: '/workspace/b.ts', patch: '', additions: 10, deletions: 0, status: 'added' },
        ],
      } as any,
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items[0]?.label).toBe('Changed Session');
    expect(items[0]?.status).toBe(vscode.ChatSessionStatus.Completed);
    expect(items[0]?.description).toBeUndefined();
    expect(items[0]?.changes).toBeUndefined();
  });

  it('does not inject checkpoint summaries into Session list item changes', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_checkpoint_summary', title: 'Checkpoint Summary', createdAt: '2026-05-28T04:00:00.000Z', backendName: 'opencode' },
    ]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: '/workspace/actual.ts',
        content: 'before',
        phase: 'before',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        uri: '/workspace/actual.ts',
        content: 'after',
        phase: 'after',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:01.000Z',
      },
    ]);
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      {
        type: 'session.diff',
        sessionId: 'ses_checkpoint_summary',
        diffs: [
          { file: '/workspace/actual.ts', patch: '', additions: 1, deletions: 0, status: 'modified' },
          { file: '/workspace/stale-a.ts', patch: '', additions: 2, deletions: 0, status: 'modified' },
          { file: '/workspace/stale-b.ts', patch: '', additions: 3, deletions: 0, status: 'modified' },
        ],
      } as any,
    ]);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items[0]?.description).toBeUndefined();
    expect(items[0]?.changes).toBeUndefined();
  });

  it('derives a restored session title from first user message when backend title is empty', async () => {
    ctx.backend.sessions.list = vi.fn(async () => ({ data: [] }));
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      makeTextEvent('Need help with session titles') as any,
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );
    const restoredResourceKey = vscode.Uri.parse('acpilot.opencode:/ses_restore').toString();

    expect(ctx.sessionStore.getTurnsPath).toHaveBeenCalledWith('ses_restore');
    expect(session.title).toBe('Need help with session titles');
    expect(ctx.sessions.get(restoredResourceKey)?.title).toBe('Need help with session titles');
    expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
      'ses_restore',
      expect.objectContaining({
        title: 'Need help with session titles',
        backendName: 'opencode',
      }),
    );
  });

  it('falls back to legacy turn events when stream-part turns contain no parts', async () => {
    ctx.backend.sessions.list = vi.fn(async () => ({ data: [] }));
    vi.mocked(readSessionTurnStreamParts).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'Legacy prompt', timestamp: '2026-06-13T00:00:00.000Z' },
        parts: [],
        end: { turnIndex: 0, timestamp: '2026-06-13T00:00:01.000Z' },
      },
    ]);
    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'Legacy prompt', timestamp: '2026-06-13T00:00:00.000Z' },
        events: [
          makeTextEvent('Legacy prompt') as any,
          { type: 'session.idle', sessionId: 'ses_restore' } as any,
        ],
        end: { turnIndex: 0, timestamp: '2026-06-13T00:00:01.000Z' },
      },
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(readLegacySessionTurnEvents).toHaveBeenCalled();
    const requestTurns = session.history.filter((turn): turn is vscode.ChatRequestTurn => 'prompt' in (turn as any));
    expect(requestTurns.map(turn => turn.prompt)).toEqual(['Legacy prompt']);
  });

  it('restores multiple persisted turns instead of collapsing them into one response', async () => {
    ctx.backend.sessions.list = vi.fn(async () => ({ data: [] }));
    (ctx.backend.createBridge as any).mockImplementation(() => {
      let stream: { markdown(value: string): void } | undefined;
      const partKinds = new Map<string, string>();
      return {
        setStream: vi.fn((next: unknown) => { stream = next as { markdown(value: string): void }; }),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn((event: any) => {
          if (event.type === 'part.updated' && event.part?.type === 'text' && !event.part.text) {
            partKinds.set(event.part.id, 'text');
          }
          if (event.type === 'part.delta' && partKinds.get(event.partId) === 'text') {
            stream?.markdown(event.delta);
          }
        }),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      };
    });
    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'First question', timestamp: '2026-06-07T00:00:00.000Z' },
        events: [
          { type: 'part.updated', part: { type: 'text', id: 'u1', text: 'First question', messageId: 'user-1' } } as any,
          { type: 'part.updated', part: { type: 'text', id: 'a1', text: '', messageId: 'assistant-1' } } as any,
          { type: 'part.delta', partId: 'a1', delta: 'First answer', field: 'text' } as any,
        ],
        end: { turnIndex: 0, timestamp: '2026-06-07T00:00:01.000Z' },
      },
      {
        turnIndex: 1,
        start: { turnIndex: 1, prompt: 'Second question', timestamp: '2026-06-07T00:00:02.000Z' },
        events: [
          { type: 'part.updated', part: { type: 'text', id: 'u2', text: 'Second question', messageId: 'user-2' } } as any,
          { type: 'part.updated', part: { type: 'text', id: 'a2', text: '', messageId: 'assistant-2' } } as any,
          { type: 'part.delta', partId: 'a2', delta: 'Second answer', field: 'text' } as any,
        ],
        end: { turnIndex: 1, timestamp: '2026-06-07T00:00:03.000Z' },
      },
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    const requestTurns = session.history.filter((turn): turn is vscode.ChatRequestTurn => 'prompt' in (turn as any));
    const responseTurns = session.history.filter(turn => !('prompt' in (turn as any)));
    expect(requestTurns.map(turn => turn.prompt)).toEqual(['First question', 'Second question']);
    expect(requestTurns.map(turn => (turn as any).id)).toEqual(['turn-0', 'turn-1']);
    expect(responseTurns).toHaveLength(2);
    expect(session.history).toHaveLength(4);
  });

  it('adds restored edit bubble parts at the completed edit tool position', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-external-edit-'));
    const file = path.join(dir, 'File.TXT');
    fs.writeFileSync(file, 'after\n', 'utf-8');
    const checkpointUri = vscode.Uri.file(file).toString();
    const callId = 'tool-edit-1';
    (ctx.backend.createBridge as any).mockImplementation(() => {
      let stream: { push(part: unknown): void } | undefined;
      return {
        setStream: vi.fn((next: unknown) => { stream = next as { push(part: unknown): void }; }),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn((event: any) => {
          if (event.type === 'part.updated' && event.part?.type === 'tool') {
            const ToolPart = (vscode as any).ChatToolInvocationPart;
            stream?.push(new ToolPart(event.part.toolName, event.part.callId));
          }
        }),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      };
    });

    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'Edit the file', timestamp: '2026-06-07T00:00:00.000Z' },
        events: [
          {
            type: 'part.updated',
            part: {
              type: 'tool',
              id: 'tool-part-1',
              toolName: 'edit',
              callId,
              state: {
                status: 'completed',
                input: { filePath: file },
                output: 'ok',
                title: 'File.TXT',
              },
            },
          } as any,
        ],
        end: { turnIndex: 0, timestamp: '2026-06-07T00:00:01.000Z' },
      },
    ]);
    vi.mocked(ctx.sessionStore.readMeta).mockResolvedValue({ id: 'ses_restore' });
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: checkpointUri,
        content: 'before\n',
        phase: 'before',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-07T00:00:00.500Z',
      },
      {
        uri: checkpointUri,
        content: 'after\n',
        phase: 'after',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-07T00:00:01.000Z',
        undoStopId: 'undo-stop-edit-1',
      },
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );
    expect(fs.readFileSync(file, 'utf-8')).toBe('after\n');

    const responses = getFirstResponseParts(session);
    const toolPart = responses.find(part => part instanceof (vscode as any).ChatToolInvocationPart) as any;
    expect(toolPart?.toolCallId).toBe(callId);
    expect(toolPart?.presentation).toBe('hidden');
    expectRestoredTextEditParts(responses, 'undo-stop-edit-1');
    expect(session.activeResponseCallback).toBeUndefined();
    expect(fs.readFileSync(file, 'utf-8')).toBe('after\n');
  });

  it('uses persisted tool edit records for restored edit bubble ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-edit-record-'));
    const file = path.join(dir, 'recorded.txt');
    fs.writeFileSync(file, 'after\n', 'utf-8');
    const checkpointUri = vscode.Uri.file(file).toString();
    const callId = 'tool-edit-record-1';
    (ctx.backend.createBridge as any).mockImplementation(() => {
      let stream: { push(part: unknown): void } | undefined;
      return {
        setStream: vi.fn((next: unknown) => { stream = next as { push(part: unknown): void }; }),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn((event: any) => {
          if (event.type === 'part.updated' && event.part?.type === 'tool') {
            const ToolPart = (vscode as any).ChatToolInvocationPart;
            stream?.push(new ToolPart(event.part.toolName, event.part.callId));
          }
        }),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      };
    });

    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'Edit with record', timestamp: '2026-06-07T00:00:00.000Z' },
        events: [
          {
            type: 'part.updated',
            part: {
              type: 'tool',
              id: 'tool-part-1',
              toolName: 'edit',
              callId,
              state: { status: 'completed', input: { filePath: file }, output: 'ok', title: 'recorded.txt' },
            },
          } as any,
        ],
        end: { turnIndex: 0, timestamp: '2026-06-07T00:00:01.000Z' },
      },
    ]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: checkpointUri,
        content: 'before\n',
        phase: 'before',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-07T00:00:00.500Z',
      },
      {
        uri: checkpointUri,
        content: 'after\n',
        phase: 'after',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-07T00:00:01.000Z',
      },
    ]);
    vi.mocked(ctx.sessionStore.readMeta).mockResolvedValue({
      id: 'ses_restore',
      requestDetails: [
        {
          turnIndex: 0,
          vscodeRequestId: 'request-live-restore-0',
          toolIdEditMap: { [callId]: 'persisted-undo-stop-1' },
        },
      ],
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    const responses = getFirstResponseParts(session);
    expectRestoredTextEditParts(responses, 'persisted-undo-stop-1');
    const requestTurn = session.history.find((turn): turn is vscode.ChatRequestTurn => 'prompt' in (turn as any));
    expect((requestTurn as any)?.id).toBe('request-live-restore-0');
    expect(session.activeResponseCallback).toBeUndefined();
  });

  it('restores edit bubble ids and request ids from stream part metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-ssp-edit-record-'));
    const file = path.join(dir, 'ssp-recorded.txt');
    fs.writeFileSync(file, 'after\n', 'utf-8');
    const checkpointUri = vscode.Uri.file(file).toString();
    const callId = 'tool-ssp-edit-record-1';
    (ctx.backend.createBridge as any).mockImplementation(() => {
      let stream: { push(part: unknown): void } | undefined;
      return {
        setStream: vi.fn((next: unknown) => { stream = next as { push(part: unknown): void }; }),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn((event: any) => {
          if (event.type === 'part.updated' && event.part?.type === 'tool') {
            const ToolPart = (vscode as any).ChatToolInvocationPart;
            stream?.push(new ToolPart(event.part.toolName, event.part.callId));
          }
        }),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      };
    });

    vi.mocked(readSessionTurnStreamParts).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'Edit with stream parts', timestamp: '2026-06-13T00:00:00.000Z' },
        parts: [
          {
            kind: 'userPrompt',
            version: 1,
            id: 'ssp-0-0',
            payload: { text: 'Edit with stream parts', partId: 'user-part' },
            meta: {
              turnIndex: 0,
              requestId: 'request-from-ssp-0',
              sequence: 0,
              createdAt: '2026-06-13T00:00:00.000Z',
              source: 'acp-event',
              sourceType: 'part.updated',
              sourcePartId: 'user-part',
            },
          },
          {
            kind: 'toolInvocation',
            version: 1,
            id: 'ssp-0-1',
            payload: {
              partId: 'tool-part-1',
              toolName: 'edit',
              callId,
              state: { status: 'completed', input: { filePath: file }, output: 'ok', title: 'ssp-recorded.txt' },
            },
            meta: {
              turnIndex: 0,
              requestId: 'request-from-ssp-0',
              sequence: 1,
              createdAt: '2026-06-13T00:00:01.000Z',
              source: 'acp-event',
              sourceType: 'part.updated',
              sourcePartId: 'tool-part-1',
              toolCallId: callId,
            },
          },
          {
            kind: 'externalEdit',
            version: 1,
            id: 'ssp-0-2',
            payload: { toolCallId: callId, editId: 'ssp-undo-stop-1' },
            meta: {
              turnIndex: 0,
              requestId: 'request-from-ssp-0',
              sequence: 2,
              createdAt: '2026-06-13T00:00:02.000Z',
              source: 'synthetic',
              sourceType: 'externalEdit',
              toolCallId: callId,
              editId: 'ssp-undo-stop-1',
            },
          },
        ] as any,
        end: { turnIndex: 0, timestamp: '2026-06-13T00:00:03.000Z' },
      },
    ]);
    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([]);
    vi.mocked(readLegacySessionEvents).mockResolvedValue([]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: checkpointUri,
        content: 'before\n',
        phase: 'before',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-13T00:00:01.500Z',
      },
      {
        uri: checkpointUri,
        content: 'after\n',
        phase: 'after',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-13T00:00:02.000Z',
      },
    ]);
    vi.mocked(ctx.sessionStore.readMeta).mockResolvedValue({ id: 'ses_restore' });
    vi.mocked(readLegacySessionTurnEvents).mockClear();

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(readLegacySessionTurnEvents).not.toHaveBeenCalled();
    expectRestoredTextEditParts(getFirstResponseParts(session), 'ssp-undo-stop-1');
    const requestTurn = session.history.find((turn): turn is vscode.ChatRequestTurn => 'prompt' in (turn as any));
    expect((requestTurn as any)?.id).toBe('request-from-ssp-0');
    expect(session.activeResponseCallback).toBeUndefined();
  });

  it('does not publish a session-list change just from restoring content', async () => {
    const sessionListChanged = vi.fn();
    state.bus.on('session-list-changed', sessionListChanged);
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      makeTextEvent('Need help with session titles') as any,
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(sessionListChanged).not.toHaveBeenCalled();
  });

  it('does not replay already accepted restored checkpoints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-replay-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nB\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const callId = 'tool-1';

    (ctx.backend.createBridge as any).mockImplementation(() => {
      let stream: { push(part: unknown): void } | undefined;
      return {
        setStream: vi.fn((next: unknown) => { stream = next as { push(part: unknown): void }; }),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn((event: any) => {
          if (event.type === 'part.updated' && event.part?.type === 'tool') {
            const ToolPart = (vscode as any).ChatToolInvocationPart;
            stream?.push(new ToolPart(event.part.toolName, event.part.callId));
          }
        }),
        run: vi.fn().mockResolvedValue(true),
        getUserMessageId: vi.fn().mockReturnValue(null),
        getSessionTitle: vi.fn().mockReturnValue(null),
        getHadSubagentTasks: vi.fn().mockReturnValue(false),
      };
    });

    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 0,
        start: { turnIndex: 0, prompt: 'Restore edited file', timestamp: '2026-06-05T00:00:00.000Z' },
        events: [
          {
            type: 'part.updated',
            part: {
              type: 'tool',
              id: 'tool-part-1',
              toolName: 'edit',
              callId,
              state: { status: 'completed', input: { filePath: file }, output: 'ok', title: 'file.txt' },
            },
          } as any,
        ],
        end: { turnIndex: 0, timestamp: '2026-06-05T00:00:01.000Z' },
      },
    ]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: uri.fsPath,
        content: 'a\nb\nc\n',
        phase: 'before',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        uri: uri.fsPath,
        content: 'a\nB\nc\n',
        phase: 'after',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: callId,
        timestamp: '2026-06-05T00:00:01.000Z',
        undoStopId: 'undo-stop-tool-1',
      },
    ]);
    (ctx.sessionStore.readMeta as any).mockResolvedValue({
      id: 'ses_restore',
      checkpointCursor: { acceptedThroughTurn: 0 },
      changeApprovalState: 'accepted',
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.activeResponseCallback).toBeUndefined();
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');

    expectRestoredTextEditParts(getFirstResponseParts(session), 'undo-stop-tool-1');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
    expect(ctx.sessionStore.updateMeta).not.toHaveBeenCalledWith(
      'ses_restore',
      expect.objectContaining({ changeApprovalState: 'pending' }),
    );
  });

  it('does not replay unaccepted checkpoints when restored edit records have undo stop ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-pending-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);

    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 1,
        start: { turnIndex: 1, prompt: 'Restore pending edit', timestamp: '2026-06-05T00:00:00.000Z' },
        events: [
          {
            type: 'part.updated',
            part: {
              type: 'tool',
              id: 'tool-part-1',
              toolName: 'edit',
              callId: 'tool-1',
              state: { status: 'completed', input: { filePath: file }, output: 'ok', title: 'file.txt' },
            },
          } as any,
        ],
        end: { turnIndex: 1, timestamp: '2026-06-05T00:00:01.000Z' },
      },
    ]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: uri.fsPath,
        content: 'a\nb\nc\n',
        phase: 'before',
        turnIndex: 1,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        uri: uri.fsPath,
        content: 'a\nB\nc\n',
        phase: 'after',
        turnIndex: 1,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:01.000Z',
        undoStopId: 'undo-stop-tool-1',
      },
    ]);
    (ctx.sessionStore.readMeta as any).mockResolvedValue({
      id: 'ses_restore',
      checkpointCursor: { acceptedThroughTurn: 0 },
      changeApprovalState: 'pending',
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.activeResponseCallback).toBeUndefined();
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\nc\n');

    expectRestoredTextEditParts(getFirstResponseParts(session), 'undo-stop-tool-1');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\nc\n');
    expect(ctx.sessionStore.updateMeta).not.toHaveBeenCalledWith(
      'ses_restore',
      expect.objectContaining({
        checkpointCursor: expect.objectContaining({ replayedThroughTurn: 1 }),
      }),
    );
  });

  it('replays pending checkpoints again after a prior restore replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-replayed-pending-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);

    vi.mocked(readLegacySessionTurnEvents).mockResolvedValue([
      {
        turnIndex: 1,
        start: { turnIndex: 1, prompt: 'Restore previously replayed pending edit', timestamp: '2026-06-05T00:00:00.000Z' },
        events: [
          {
            type: 'part.updated',
            part: {
              type: 'tool',
              id: 'tool-part-1',
              toolName: 'edit',
              callId: 'tool-1',
              state: { status: 'completed', input: { filePath: file }, output: 'ok', title: 'file.txt' },
            },
          } as any,
        ],
        end: { turnIndex: 1, timestamp: '2026-06-05T00:00:01.000Z' },
      },
    ]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: uri.fsPath,
        content: 'a\nb\nc\n',
        phase: 'before',
        turnIndex: 1,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        uri: uri.fsPath,
        content: 'a\nB\nc\n',
        phase: 'after',
        turnIndex: 1,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:01.000Z',
      },
    ]);
    (ctx.sessionStore.readMeta as any).mockResolvedValue({
      id: 'ses_restore',
      checkpointCursor: { acceptedThroughTurn: 0, replayedThroughTurn: 1 },
      changeApprovalState: 'pending',
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.activeResponseCallback).toBeTypeOf('function');
  });

  it('uses live in-memory session state when a session-list item targets the same backend session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-live-alias-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const liveState = {
      backendSessionId: 'ses_live',
      turnMap: [{ vscodeTurn: 0, messageId: 'msg_1' }],
      title: 'Live Session',
      createdAt: new Date('2026-06-05T00:00:00.000Z'),
    };
    const liveKey = 'acpilot.opencode:/untitled-live';
    ctx.sessions.set(liveKey, liveState);
    ctx.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_live', title: 'Live Session', createdAt: liveState.createdAt },
    }));
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      makeTextEvent('Restore pending edit') as any,
    ]);
    vi.mocked(readCheckpoints).mockResolvedValue([
      {
        uri: uri.fsPath,
        content: 'a\nb\nc\n',
        phase: 'before',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        uri: uri.fsPath,
        content: 'a\nB\nc\n',
        phase: 'after',
        turnIndex: 0,
        editIndex: 1,
        toolCallId: 'tool-1',
        timestamp: '2026-06-05T00:00:01.000Z',
      },
    ]);
    (ctx.sessionStore.readMeta as any).mockResolvedValue({
      id: 'ses_live',
      checkpointCursor: { acceptedThroughTurn: -1 },
      changeApprovalState: 'pending',
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
    const resource = vscode.Uri.parse('acpilot.opencode:/ses_live');
    const session = await provider.provideChatSessionContent(
      resource,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.title).toBe('Live Session');
    expect(ctx.sessions.get(resource.toString())).toBe(liveState);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\nc\n');
    expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
      'ses_live',
      expect.objectContaining({
        title: 'Live Session',
        titleSource: 'backend',
      }),
    );
  });

  // =========================================================================
  // Title persistence tests â€?verify fix for titles reverting to placeholder
  // after tab switches (backend stores placeholder at create time).
  // =========================================================================

  it('derives title from history when backend returns placeholder title "New OpenCode Session"', async () => {
    ctx.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_placeholder', title: 'New OpenCode Session', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      makeTextEvent('How do I fix the auth bug?') as any,
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_placeholder'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.title).toBe('How do I fix the auth bug?');
  });

  it('derives title from history when backend returns placeholder "OpenCode Session xxx"', async () => {
    ctx.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_abc12345', title: 'OpenCode Session abc12345', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));
    vi.mocked(readLegacySessionEvents).mockResolvedValue([
      makeTextEvent('Refactor the database layer') as any,
    ]);

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_abc12345'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.title).toBe('Refactor the database layer');
  });

  it('prefers runtime non-placeholder title over placeholder when same sessionId has multiple entries', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_dup', title: 'Derived From Prompt', createdAt: '2026-05-28T01:00:00.000Z', backendName: 'opencode' },
    ]);

    // Original tab entry with derived title
    ctx.sessions.set('acpilot.opencode:/untitled-1', {
      backendSessionId: 'ses_dup',
      turnMap: [],
      title: 'Derived From Prompt',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    // Session list click created a duplicate entry with placeholder title
    ctx.sessions.set('acpilot.opencode:/ses_dup', {
      backendSessionId: 'ses_dup',
      turnMap: [],
      title: 'New OpenCode Session',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('Derived From Prompt');
  });

  it('merges runtime renamed titles over SessionStore placeholders', async () => {
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_renamed', title: 'New OpenCode Session', createdAt: '2026-05-28T01:00:00.000Z', backendName: 'opencode' },
    ]);

    ctx.sessions.set('acpilot.opencode:/untitled-rename', {
      backendSessionId: 'ses_renamed',
      turnMap: [],
      title: 'Runtime Rename Title',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('Runtime Rename Title');
  });

  it('restoring existing session reuses non-placeholder title from another sessionMap entry', async () => {
    // Pre-populate sessionMap with the original entry that has the derived title
    ctx.sessions.set('acpilot.opencode:/untitled-1', {
      backendSessionId: 'ses_existing',
      turnMap: [],
      title: 'My original prompt title',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    // Backend still has the placeholder title (never updated in backend)
    ctx.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_existing', title: 'New OpenCode Session', createdAt: new Date('2026-05-28T01:00:00Z') },
    }));
    ctx.backend.sessions.messages = vi.fn(async () => ({
      data: { items: [] },
    }));

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/ses_existing'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    const newKey = vscode.Uri.parse('acpilot.opencode:/ses_existing').toString();
    expect(ctx.sessions.get(newKey)?.title).toBe('My original prompt title');
    expect(session.title).toBe('My original prompt title');
  });

  // =========================================================================
  // Agent filtering tests â€?ensures isUserSelectableAgent works correctly
  // for both hidden and subagent-mode agents.
  // =========================================================================

  describe('isUserSelectableAgent', () => {
    it('returns true for primary non-hidden agent', () => {
      const agent: AcpAgent = { id: 'primary-agent', mode: 'primary' };
      expect(isUserSelectableAgent(agent)).toBe(true);
    });

    it('returns true for agent with mode all and not hidden', () => {
      const agent: AcpAgent = { id: 'all-mode-agent', mode: 'all' };
      expect(isUserSelectableAgent(agent)).toBe(true);
    });

    it('returns false for hidden agent', () => {
      const agent: AcpAgent = { id: 'hidden-agent', hidden: true, mode: 'primary' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('returns false for subagent-mode agent', () => {
      const agent: AcpAgent = { id: 'subagent', mode: 'subagent' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('returns false for hidden subagent-mode agent', () => {
      const agent: AcpAgent = { id: 'hidden-subagent', hidden: true, mode: 'subagent' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('excludes hidden agents from filtered list', () => {
      const agents: AcpAgent[] = [
        { id: 'agent-1', mode: 'primary' },
        { id: 'agent-2', hidden: true, mode: 'primary' },
        { id: 'agent-3', mode: 'all' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['agent-1', 'agent-3']);
    });

    it('excludes subagent-mode agents from filtered list', () => {
      const agents: AcpAgent[] = [
        { id: 'primary-agent', mode: 'primary' },
        { id: 'sub-agent', mode: 'subagent' },
        { id: 'another-primary', mode: 'primary' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['primary-agent', 'another-primary']);
    });

    it('excludes both hidden and subagent agents together', () => {
      const agents: AcpAgent[] = [
        { id: 'good', mode: 'primary' },
        { id: 'hidden-primary', hidden: true, mode: 'primary' },
        { id: 'sub', mode: 'subagent' },
        { id: 'hidden-sub', hidden: true, mode: 'subagent' },
        { id: 'all-mode', mode: 'all' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['good', 'all-mode']);
    });
  });
});
