import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import { isUserSelectableAgent } from '../backend/types';
import type { BackendAgent } from '../backend/types';
import type { Backend } from '../backend/backend';
import type { ExtensionState, BackendContext } from '../types';
import { AppEventBus } from '../backend/app-event-bus';


function getNonDiagnosticSessionItems(controller: vscode.ChatSessionItemController) {
  return Array.from(controller.items)
    .map(([, item]) => item)
    .filter(item => !item.resource.path.startsWith('/__'));
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
    const backend: Backend = {
      name: 'opencode',
      start: vi.fn(async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } })),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn((): import('../backend/types').BackendServerStatus => 'running'),
      getUrl: vi.fn(() => 'http://127.0.0.1:4096'),
      isRunning: vi.fn(() => true),
      sessions: {
        create: vi.fn(),
        get: sessionGet,
        update: vi.fn(async () => ({ data: { id: 'updated-session', title: 'Updated Title', createdAt: new Date() } })),
        prompt: vi.fn(),
        revert: vi.fn(),
        abort: vi.fn(),
        release: vi.fn(),
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
      createPipeline: vi.fn(() => ({
        setStream: vi.fn(),
        setCallbacks: vi.fn(),
        setTracker: vi.fn(),
        processEvent: vi.fn(),
        run: vi.fn().mockResolvedValue({ completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false }),
      })) as unknown as Backend['createPipeline'],
    };

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
        entries: vi.fn(() => sessionStore.entries()),
      } as unknown as BackendContext['sessions'],
      selection: {
        get: vi.fn(() => ({ agent: undefined, model: undefined, modelDisplayName: undefined })),
        setAgent: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
      } as unknown as BackendContext['selection'],
      sessionStore: {
        listSessions: vi.fn().mockResolvedValue([]),
        getSessionPath: vi.fn().mockReturnValue(''),
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
      modelCatalog: {
        list: vi.fn(() => []),
        resolve: vi.fn(() => ({ kind: 'not-found' as const })),
        refresh: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as unknown as ExtensionState['modelCatalog'],
    };

    (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
      { uri: vscode.Uri.parse('file:///test-workspace'), name: 'test', index: 0 },
    ];
  });

  it('publishes the three permission mode options beside the Agent picker', async () => {
    (ctx.backend.config.agents as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 'build', name: 'Build', mode: 'primary' }],
    });
    (ctx.selection.get as ReturnType<typeof vi.fn>).mockReturnValue({
      agent: 'build',
      permissionMode: 'read-only',
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
    const result = await provider.provideChatSessionProviderOptions!({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken);

    const permissionGroup = result.optionGroups?.find(group => group.id === 'permission-mode');
    expect(permissionGroup?.items.map(item => item.id)).toEqual([
      'permission-full-edit',
      'permission-approval',
      'permission-read-only',
    ]);
    expect(permissionGroup?.selected?.id).toBe('permission-read-only');
  });

  it('does not emit an option refresh when the visible groups are unchanged', async () => {
    (ctx.backend.config.agents as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 'build', name: 'Build', mode: 'primary' }],
    });

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
    let changeCount = 0;
    const changeSubscription = provider.onDidChangeChatSessionProviderOptions?.(() => {
      changeCount += 1;
    });

    await provider.provideChatSessionProviderOptions!({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const countAfterInitialRefresh = changeCount;

    await provider.provideChatSessionProviderOptions!({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken);
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(changeCount).toBe(countAfterInitialRefresh);
    changeSubscription?.dispose();
  });

  it('does not retry a failed lazy backend start for every option query', async () => {
    ctx.backend.isRunning = vi.fn(() => false);
    ctx.backend.getStatus = vi.fn((): import('../backend/types').BackendServerStatus => 'stopped');
    (ctx.backend.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('backend unavailable'));

    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken;

    await provider.provideChatSessionProviderOptions!(token);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    await provider.provideChatSessionProviderOptions!(token);
    await provider.provideChatSessionProviderOptions!(token);

    expect(ctx.backend.start).toHaveBeenCalledTimes(1);
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

  it('does not publish a stale session list after the backend runtime changes', async () => {
    let resolveOldList!: (value: unknown) => void;
    const oldList = new Promise(resolve => {
      resolveOldList = resolve;
    });
    (ctx.sessionStore.listSessions as any).mockReturnValueOnce(oldList);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const refresh = controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });
    await vi.waitFor(() => {
      expect(ctx.sessionStore.listSessions).toHaveBeenCalled();
    });

    const oldStore = ctx.sessionStore;
    const nextSessionStore = {
      ...oldStore,
      listSessions: vi.fn().mockResolvedValue([
        { id: 'ses_new_target', title: 'New target session', createdAt: '2026-05-28T04:00:00Z' },
      ]),
    };
    const nextSessions = {
      get: vi.fn(),
      has: vi.fn(() => false),
      set: vi.fn(),
      values: vi.fn(() => [][Symbol.iterator]()),
      entries: vi.fn(() => [][Symbol.iterator]()),
    } as unknown as BackendContext['sessions'];

    // Match the production transition order: invalidate first, then replace
    // the mutable runtime fields while the old filesystem read is pending.
    ctx.runtimeGeneration += 1;
    ctx.acceptingRequests = false;
    state.bus.emit('backend-runtime-changing', {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: 'acp:target-b',
    });
    ctx.instanceKey = 'acp:target-b';
    ctx.storageNamespace = 'acp/instance-target-b';
    ctx.sessions = nextSessions;
    ctx.sessionStore = nextSessionStore as unknown as BackendContext['sessionStore'];
    ctx.acceptingRequests = true;

    const nextRefresh = controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });
    await nextRefresh;
    const nextItems = getNonDiagnosticSessionItems(controller!);
    expect(nextItems).toHaveLength(1);
    expect(nextItems[0]?.resource.path).toBe('/acp%3Atarget-b/ses_new_target');

    resolveOldList([
      { id: 'ses_old_target', title: 'Old target session', createdAt: '2026-05-28T03:00:00Z' },
    ]);
    await refresh;

    const items = getNonDiagnosticSessionItems(controller!);
    expect(items).toHaveLength(1);
    expect(items[0]?.resource.path).toBe('/acp%3Atarget-b/ses_new_target');
  });

  it('does not strand a session refresh when its runtime is invalidated', async () => {
    let resolveOldList!: (value: unknown) => void;
    const oldList = new Promise(resolve => {
      resolveOldList = resolve;
    });
    (ctx.sessionStore.listSessions as any).mockReturnValueOnce(oldList);

    const { controller } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const refresh = controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });
    await vi.waitFor(() => {
      expect(ctx.sessionStore.listSessions).toHaveBeenCalled();
    });

    ctx.runtimeGeneration += 1;
    ctx.acceptingRequests = false;
    state.bus.emit('backend-runtime-changing', {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: 'acp:target-b',
    });

    // The refresh callback observes the runtime invalidation instead of
    // waiting for the stale filesystem operation to settle.
    await expect(Promise.race([
      refresh,
      new Promise((_, reject) => setTimeout(() => reject(new Error('refresh timed out')), 250)),
    ])).resolves.toBeUndefined();

    // Observe the intentionally unresolved operation before test teardown so
    // it cannot become an unhandled rejection if the mock is later changed.
    resolveOldList([]);
    ctx.acceptingRequests = true;
  });

  it('keeps a returned ChatSession handler bound to its original runtime', async () => {
    const { provider } = createSessionContentProvider(
      state,
      ctx,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken;
    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('acpilot.opencode:/new'),
      cancellationToken,
      { inputState: {} as vscode.ChatSessionInputState },
    );
    expect(session.requestHandler).toBeDefined();

    // Invalidate the owner after VS Code has retained the old ChatSession.
    // The returned handler must reject before touching the replacement target.
    ctx.runtimeGeneration += 1;
    ctx.acceptingRequests = false;
    state.bus.emit('backend-runtime-changing', {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: 'acp:target-b',
    });

    const result = await session.requestHandler!(
      {
        prompt: 'must stay on old runtime',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined,
        model: undefined,
        id: 'stale-request',
        sessionId: 'untitled-stale',
        attempt: 0,
      } as unknown as vscode.ChatRequest,
      { history: [] },
      {
        markdown: vi.fn(),
        progress: vi.fn(),
        push: vi.fn(),
      } as unknown as vscode.ChatResponseStream,
      cancellationToken,
    );

    expect(result?.metadata).toEqual({});
    expect(ctx.backend.start).not.toHaveBeenCalled();
    expect(ctx.backend.sessions.create).not.toHaveBeenCalled();
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

  it('ignores archive events from a session item owned by a previous runtime', async () => {
    const oldStore = ctx.sessionStore;
    (ctx.sessionStore.listSessions as any).mockResolvedValue([
      {
        id: 'ses_old_runtime',
        title: 'Old Runtime Session',
        createdAt: '2026-05-28T02:00:00Z',
        backendName: 'opencode',
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

    const nextStore = {
      ...oldStore,
      updateMeta: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendContext['sessionStore'];
    ctx.runtimeGeneration += 1;
    ctx.acceptingRequests = false;
    state.bus.emit('backend-runtime-changing', {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: 'acp:target-b',
    });
    ctx.instanceKey = 'acp:target-b';
    ctx.storageNamespace = 'acp/instance-target-b';
    ctx.sessionStore = nextStore;
    ctx.acceptingRequests = true;

    item.archived = true;
    (controller as any).fireDidChangeChatSessionItemState(item);
    await Promise.resolve();

    expect(nextStore.updateMeta).not.toHaveBeenCalled();
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
  // Agent filtering tests �?ensures isUserSelectableAgent works correctly
  // for both hidden and subagent-mode agents.
  // =========================================================================

  describe('isUserSelectableAgent', () => {
    it('returns true for primary non-hidden agent', () => {
      const agent: BackendAgent = { id: 'primary-agent', mode: 'primary' };
      expect(isUserSelectableAgent(agent)).toBe(true);
    });

    it('returns true for agent with mode all and not hidden', () => {
      const agent: BackendAgent = { id: 'all-mode-agent', mode: 'all' };
      expect(isUserSelectableAgent(agent)).toBe(true);
    });

    it('returns false for hidden agent', () => {
      const agent: BackendAgent = { id: 'hidden-agent', hidden: true, mode: 'primary' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('returns false for subagent-mode agent', () => {
      const agent: BackendAgent = { id: 'subagent', mode: 'subagent' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('returns false for hidden subagent-mode agent', () => {
      const agent: BackendAgent = { id: 'hidden-subagent', hidden: true, mode: 'subagent' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('excludes hidden agents from filtered list', () => {
      const agents: BackendAgent[] = [
        { id: 'agent-1', mode: 'primary' },
        { id: 'agent-2', hidden: true, mode: 'primary' },
        { id: 'agent-3', mode: 'all' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['agent-1', 'agent-3']);
    });

    it('excludes subagent-mode agents from filtered list', () => {
      const agents: BackendAgent[] = [
        { id: 'primary-agent', mode: 'primary' },
        { id: 'sub-agent', mode: 'subagent' },
        { id: 'another-primary', mode: 'primary' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['primary-agent', 'another-primary']);
    });

    it('excludes both hidden and subagent agents together', () => {
      const agents: BackendAgent[] = [
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
