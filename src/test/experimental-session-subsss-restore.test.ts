import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import type { Backend } from '../backend/backend';
import type { ExtensionState, BackendContext } from '../types';
import { AppEventBus } from '../backend/app-event-bus';
import { buildLine } from '../backend/serializable/serializer';
import type { StreamPartRecord } from '../ssp/types';
import type { FileSnapshotRecord } from '../ssp/types';

function expectRestoredTextEditParts(pushed: readonly unknown[], editId: string | undefined) {
  const uriPart = pushed.find(part => part instanceof (vscode as any).ChatResponseCodeblockUriPart) as any;
  expect(uriPart?.isEdit).toBe(true);
  expect(uriPart?.undoStopId).toBe(editId);

  const textEditParts = pushed.filter(part => part instanceof (vscode as any).ChatResponseTextEditPart) as any[];
  expect(textEditParts).toHaveLength(2);
  expect(textEditParts[0]?.editsOrDone).toEqual([]);
  expect(textEditParts[1]?.editsOrDone).toBe(true);
}

function getRestoredUriParts(pushed: readonly unknown[]): any[] {
  return pushed.filter(part => part instanceof (vscode as any).ChatResponseCodeblockUriPart) as any[];
}

function getFirstResponseParts(session: vscode.ChatSession): unknown[] {
  const responseTurn = session.history.find(turn => !('prompt' in (turn as any))) as vscode.ChatResponseTurn;
  return (responseTurn as unknown as { responses: unknown[] }).responses;
}

function makeState(sessionDir: string): { state: ExtensionState; ctx: BackendContext } {
  const sessionStore = new Map<string, any>();
  const backend = {
    name: 'opencode',
      start: vi.fn(async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } })),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn((): import('../backend/types').BackendServerStatus => 'running'),
      getUrl: vi.fn(() => 'http://127.0.0.1:4096'),
      isRunning: vi.fn(() => true),
      sessions: {
        create: vi.fn(),
        get: vi.fn(async () => ({
          data: { id: 'ses_restore', title: 'New OpenCode Session', createdAt: new Date('2026-06-17T00:00:00.000Z') },
        })),
        update: vi.fn(async () => ({ data: { id: 'ses_restore', title: 'Sub restore', createdAt: new Date() } })),
        prompt: vi.fn(),
        revert: vi.fn(),
        abort: vi.fn(),
        list: vi.fn(async () => ({ data: [] })),
        children: vi.fn(),
        status: vi.fn(),
        descendants: vi.fn(() => []),
        findAncestor: vi.fn(),
        parent: vi.fn(),
        messages: vi.fn(async () => ({ data: { items: [] } })),
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
        run: vi.fn().mockResolvedValue({ completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false }),
      })) as unknown as Backend['createPipeline'],
  } as unknown as Backend;

  const ctx: BackendContext = {
    id: 'opencode',
    instanceKey: 'opencode',
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
      getSessionPath: vi.fn().mockReturnValue(path.join(sessionDir, 'session.jsonl')),
      getSessionDir: vi.fn().mockReturnValue(sessionDir),
      initialize: vi.fn().mockResolvedValue(undefined),
      readMeta: vi.fn().mockResolvedValue({ id: 'ses_restore' }),
      updateMeta: vi.fn().mockResolvedValue(undefined),
      writeMeta: vi.fn().mockResolvedValue(undefined),
    } as any,
  } as unknown as BackendContext;

  const state = {
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
  } as unknown as ExtensionState;

  return { state, ctx };
}

function writeJsonl(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join(''), 'utf-8');
}

function streamRecord(
  kind: string,
  id: string,
  payload: unknown,
  meta: Partial<StreamPartRecord['meta']>,
): StreamPartRecord {
  return {
    kind,
    version: 1,
    id,
    payload,
    meta: {
      turnIndex: 0,
      requestId: 'request-subsss-restore-0',
      sequence: 0,
      createdAt: '2026-06-17T00:00:00.000Z',
      source: 'backend-event',
      ...meta,
    },
  };
}

describe('SubSSS externalEdit restore', () => {
  it('does not restore subagent assistant text or reasoning as root response parts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsss-text-restore-'));
    try {
      const sessionDir = path.join(tmpDir, '.acpilot', 'opencode', 'ses_restore');
      const childSubId = 'subagent-child-text-restore';
      const childReadCallId = 'call-child-read-restore';

      const rootRecords = [
        streamRecord(
          'userPrompt',
          'userPrompt:0',
          { text: 'restore child text' },
          { sequence: 0, sourceType: 'part.updated', sourcePartId: 'user' },
        ),
        streamRecord(
          'toolInvocation',
          'call-root-task',
          {
            partId: 'part-root-task',
            toolName: 'task',
            callId: 'call-root-task',
            state: {
              status: 'completed',
              input: { prompt: 'child text' },
              output: 'done',
              title: 'child agent',
            },
            subAgentInvocationId: childSubId,
          },
          { sequence: 1, sourceType: 'part.updated', sourcePartId: 'part-root-task' },
        ),
        streamRecord(
          'assistantText',
          'root-text',
          { partId: 'root-text', text: 'root answer' },
          { sequence: 2, sourceType: 'part.updated', sourcePartId: 'root-text' },
        ),
      ];
      writeJsonl(path.join(sessionDir, 'session.jsonl'), [
        buildLine('version', '2.0'),
        buildLine('turn-start', { turnIndex: 0, timestamp: '2026-06-17T00:00:00.000Z' }),
        ...rootRecords.map(record => buildLine('stream-part', record)),
        buildLine('turn-end', { turnIndex: 0, timestamp: '2026-06-17T00:00:03.000Z' }),
      ]);

      const childDir = path.join(sessionDir, 'subsessions', childSubId);
      const childRecords = [
        streamRecord(
          'reasoning',
          'child-reasoning',
          { partId: 'child-reasoning', text: 'child private reasoning', thinkingId: 'thinking-child' },
          {
            sequence: 0,
            sourceType: 'part.updated',
            sourcePartId: 'child-reasoning',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
          },
        ),
        streamRecord(
          'assistantText',
          'child-text',
          { partId: 'child-text', text: 'child markdown answer' },
          {
            sequence: 1,
            sourceType: 'part.updated',
            sourcePartId: 'child-text',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
          },
        ),
        streamRecord(
          'toolInvocation',
          childReadCallId,
          {
            partId: 'part-child-read',
            toolName: 'read',
            callId: childReadCallId,
            state: {
              status: 'completed',
              input: { filePath: path.join(tmpDir, 'child.ts') },
              output: 'content',
              title: 'child.ts',
            },
            subAgentInvocationId: childSubId,
          },
          {
            sequence: 2,
            sourceType: 'part.updated',
            sourcePartId: 'part-child-read',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
          },
        ),
      ];
      writeJsonl(path.join(childDir, 'subsession.jsonl'), [
        buildLine('version', '2.0'),
        ...childRecords.map(record => buildLine('stream-part', record)),
      ]);

      (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
        { uri: vscode.Uri.file(tmpDir), name: 'test', index: 0 },
      ];
      const { state, ctx } = makeState(sessionDir);
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

      const parts = getFirstResponseParts(session);
      expect(parts).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: expect.objectContaining({ value: 'root answer' }) }),
        expect.objectContaining({ toolName: 'task', toolCallId: 'call-root-task' }),
        expect.objectContaining({ toolName: 'read', toolCallId: childReadCallId, subAgentInvocationId: childSubId }),
      ]));
      expect(parts).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ value: expect.objectContaining({ value: 'child markdown answer' }) }),
        expect.objectContaining({ value: 'child private reasoning' }),
      ]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('restores root externalEdit bubbles with response metadata when there is no subagent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-external-edit-restore-'));
    try {
      const sessionDir = path.join(tmpDir, '.acpilot', 'opencode', 'ses_restore');
      const writeCallId = 'call-root-write-restore';
      const file = path.join(tmpDir, 'root.txt');
      fs.writeFileSync(file, 'after\n', 'utf-8');
      const uri = vscode.Uri.file(file).toString();

      const records = [
        streamRecord(
          'userPrompt',
          'userPrompt:0',
          { text: 'restore root write' },
          { sequence: 0, sourceType: 'part.updated', sourcePartId: 'user' },
        ),
        streamRecord(
          'externalEdit',
          `externalEdit:${writeCallId}`,
          {
            toolCallId: writeCallId,
            editId: '',
            status: 'pending',
            uri: file,
          },
          {
            sequence: 1,
            source: 'synthetic',
            sourceType: 'externalEdit',
            toolCallId: writeCallId,
          },
        ),
        streamRecord(
          'toolInvocation',
          writeCallId,
          {
            partId: 'part-root-write',
            toolName: 'write',
            callId: writeCallId,
            state: {
              status: 'completed',
              input: { filePath: file },
              output: 'ok',
              title: 'root.txt',
            },
          },
          {
            sequence: 2,
            sourceType: 'part.updated',
            sourcePartId: 'part-root-write',
            toolCallId: writeCallId,
          },
        ),
      ];
      const snapshots: FileSnapshotRecord[] = [
        {
          uri,
          content: 'before\n',
          phase: 'before',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: writeCallId,
          timestamp: '2026-06-17T00:00:01.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'root',
            turnIndex: 0,
            toolCallId: writeCallId,
          },
        },
        {
          uri,
          content: 'after\n',
          phase: 'after',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: writeCallId,
          timestamp: '2026-06-17T00:00:02.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'root',
            turnIndex: 0,
            toolCallId: writeCallId,
          },
        },
      ];
      writeJsonl(path.join(sessionDir, 'session.jsonl'), [
        buildLine('version', '2.0'),
        buildLine('turn-start', { turnIndex: 0, timestamp: '2026-06-17T00:00:00.000Z' }),
        ...records.map(record => buildLine('stream-part', record)),
        ...snapshots.map(snapshot => buildLine('snapshot', snapshot)),
        buildLine('turn-end', { turnIndex: 0, timestamp: '2026-06-17T00:00:03.000Z' }),
      ]);
      writeJsonl(path.join(sessionDir, 'meta.jsonl'), [
        JSON.stringify({
          v: 2,
          type: 'part-meta',
          id: `externalEdit:${writeCallId}`,
          undoStopId: 'undo-root-meta',
        }) + '\n',
      ]);

      (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
        { uri: vscode.Uri.file(tmpDir), name: 'test', index: 0 },
      ];
      const { state, ctx } = makeState(sessionDir);
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

      const responseTurn = session.history.find(turn => !('prompt' in (turn as any))) as vscode.ChatResponseTurn;
      expectRestoredTextEditParts(getFirstResponseParts(session), 'undo-root-meta');
      expect((responseTurn as any).result?.metadata?.toolIdEditMap).toEqual({
        [writeCallId]: 'undo-root-meta',
      });
      expect(session.activeResponseCallback).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['root session stream', 'root'],
    ['subsession stream', 'subsession'],
  ] as const)('uses node-local sub meta to restore edit bubble ids from %s snapshots', async (_label, snapshotLocation) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsss-external-edit-restore-'));
    try {
      const sessionDir = path.join(tmpDir, '.acpilot', 'opencode', 'ses_restore');
      const childSubId = 'subagent-child-restore';
      const writeCallId = 'call-child-write-restore';
      const file = path.join(tmpDir, 'child.txt');
      fs.writeFileSync(file, 'after\n', 'utf-8');
      const uri = vscode.Uri.file(file).toString();

      const rootRecords = [
        streamRecord(
          'userPrompt',
          'userPrompt:0',
          { text: 'restore child write' },
          { sequence: 0, sourceType: 'part.updated', sourcePartId: 'user' },
        ),
        streamRecord(
          'toolInvocation',
          'call-root-task',
          {
            partId: 'part-root-task',
            toolName: 'task',
            callId: 'call-root-task',
            state: {
              status: 'completed',
              input: { prompt: 'child write' },
              output: 'done',
              title: 'child agent',
            },
            subAgentInvocationId: childSubId,
          },
          { sequence: 1, sourceType: 'part.updated', sourcePartId: 'part-root-task' },
        ),
      ];
      const snapshots: FileSnapshotRecord[] = [
        {
          uri,
          content: 'before\n',
          phase: 'before',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: writeCallId,
          timestamp: '2026-06-17T00:00:01.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'subsession',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
            turnIndex: 0,
            toolCallId: writeCallId,
          },
        },
        {
          uri,
          content: 'after\n',
          phase: 'after',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: writeCallId,
          timestamp: '2026-06-17T00:00:02.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'subsession',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
            turnIndex: 0,
            toolCallId: writeCallId,
          },
        },
      ];
      writeJsonl(path.join(sessionDir, 'session.jsonl'), [
        buildLine('version', '2.0'),
        buildLine('turn-start', { turnIndex: 0, timestamp: '2026-06-17T00:00:00.000Z' }),
        ...rootRecords.map(record => buildLine('stream-part', record)),
        ...(snapshotLocation === 'root' ? snapshots.map(snapshot => buildLine('snapshot', snapshot)) : []),
        buildLine('turn-end', { turnIndex: 0, timestamp: '2026-06-17T00:00:03.000Z' }),
      ]);

      const childDir = path.join(sessionDir, 'subsessions', childSubId);
      const childExternalEdit = streamRecord(
        'externalEdit',
        `externalEdit:${writeCallId}`,
        {
          toolCallId: writeCallId,
          editId: '',
          status: 'pending',
          uri: file,
        },
        {
          sequence: 0,
          source: 'synthetic',
          sourceType: 'externalEdit',
          toolCallId: writeCallId,
          subAgentInvocationId: childSubId,
          subAgentPath: [childSubId],
        },
      );
      writeJsonl(path.join(childDir, 'subsession.jsonl'), [
        buildLine('version', '2.0'),
        buildLine('stream-part', childExternalEdit),
        ...(snapshotLocation === 'subsession' ? snapshots.map(snapshot => buildLine('snapshot', snapshot)) : []),
      ]);
      writeJsonl(path.join(childDir, 'meta.jsonl'), [
        JSON.stringify({
          v: 2,
          type: 'part-meta',
          id: `externalEdit:${writeCallId}`,
          undoStopId: 'undo-child-meta',
        }) + '\n',
      ]);

      (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
        { uri: vscode.Uri.file(tmpDir), name: 'test', index: 0 },
      ];
      const { state, ctx } = makeState(sessionDir);
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

      expectRestoredTextEditParts(getFirstResponseParts(session), 'undo-child-meta');
      expect(session.activeResponseCallback).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not mix restored diff snapshots when root and subsession reuse a tool call id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsss-shared-call-restore-'));
    try {
      const sessionDir = path.join(tmpDir, '.acpilot', 'opencode', 'ses_restore');
      const childSubId = 'subagent-child-shared-call';
      const sharedCallId = 'shared-edit-call';
      const rootFile = path.join(tmpDir, 'root.txt');
      const childFile = path.join(tmpDir, 'child.txt');
      fs.writeFileSync(rootFile, 'root after\n', 'utf-8');
      fs.writeFileSync(childFile, 'child after\n', 'utf-8');
      const rootUri = vscode.Uri.file(rootFile).toString();
      const childUri = vscode.Uri.file(childFile).toString();

      const rootRecords = [
        streamRecord(
          'userPrompt',
          'userPrompt:0',
          { text: 'restore shared call id edits' },
          { sequence: 0, sourceType: 'part.updated', sourcePartId: 'user', sessionId: 'ses_restore' },
        ),
        streamRecord(
          'toolInvocation',
          'root-edit-tool',
          {
            partId: 'root-edit-tool',
            toolName: 'write',
            callId: sharedCallId,
            state: { status: 'completed', input: { filePath: rootFile }, output: 'root done' },
          },
          {
            sequence: 1,
            sourceType: 'part.updated',
            sourcePartId: 'root-edit-tool',
            sessionId: 'ses_restore',
          },
        ),
        streamRecord(
          'externalEdit',
          `externalEdit:${sharedCallId}:root`,
          { toolCallId: sharedCallId, editId: '', status: 'pending', uri: rootFile },
          {
            sequence: 2,
            source: 'synthetic',
            sourceType: 'externalEdit',
            toolCallId: sharedCallId,
            sessionId: 'ses_restore',
          },
        ),
        streamRecord(
          'toolInvocation',
          'call-root-task',
          {
            partId: 'call-root-task',
            toolName: 'task',
            callId: 'call-root-task',
            state: { status: 'completed', input: { prompt: 'child edit' }, output: 'done' },
            subAgentInvocationId: childSubId,
          },
          { sequence: 3, sourceType: 'part.updated', sourcePartId: 'call-root-task', sessionId: 'ses_restore' },
        ),
      ];

      const rootSnapshots: FileSnapshotRecord[] = [
        {
          uri: rootUri,
          content: 'root before\n',
          phase: 'before',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: sharedCallId,
          timestamp: '2026-06-17T00:00:01.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'root',
            turnIndex: 0,
            toolCallId: sharedCallId,
          },
        },
        {
          uri: rootUri,
          content: 'root after\n',
          phase: 'after',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: sharedCallId,
          timestamp: '2026-06-17T00:00:02.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'root',
            turnIndex: 0,
            toolCallId: sharedCallId,
          },
        },
      ];

      writeJsonl(path.join(sessionDir, 'session.jsonl'), [
        buildLine('version', '2.0'),
        buildLine('turn-start', { turnIndex: 0, timestamp: '2026-06-17T00:00:00.000Z' }),
        ...rootRecords.map(record => buildLine('stream-part', record)),
        ...rootSnapshots.map(snapshot => buildLine('snapshot', snapshot)),
        buildLine('turn-end', { turnIndex: 0, timestamp: '2026-06-17T00:00:03.000Z' }),
      ]);
      writeJsonl(path.join(sessionDir, 'meta.jsonl'), [
        JSON.stringify({
          v: 2,
          type: 'part-meta',
          id: `externalEdit:${sharedCallId}:root`,
          undoStopId: 'undo-root-shared',
        }) + '\n',
      ]);

      const childDir = path.join(sessionDir, 'subsessions', childSubId);
      const childRecords = [
        streamRecord(
          'toolInvocation',
          'child-edit-tool',
          {
            partId: 'child-edit-tool',
            toolName: 'write',
            callId: sharedCallId,
            state: { status: 'completed', input: { filePath: childFile }, output: 'child done' },
          },
          {
            sequence: 0,
            sourceType: 'part.updated',
            sourcePartId: 'child-edit-tool',
            sessionId: 'ses_restore',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
          },
        ),
        streamRecord(
          'externalEdit',
          `externalEdit:${sharedCallId}:child`,
          { toolCallId: sharedCallId, editId: '', status: 'pending', uri: childFile },
          {
            sequence: 1,
            source: 'synthetic',
            sourceType: 'externalEdit',
            toolCallId: sharedCallId,
            sessionId: 'ses_restore',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
          },
        ),
      ];
      const childSnapshots: FileSnapshotRecord[] = [
        {
          uri: childUri,
          content: 'child before\n',
          phase: 'before',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: sharedCallId,
          timestamp: '2026-06-17T00:00:04.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'subsession',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
            turnIndex: 0,
            toolCallId: sharedCallId,
          },
        },
        {
          uri: childUri,
          content: 'child after\n',
          phase: 'after',
          turnIndex: 0,
          editIndex: 0,
          toolCallId: sharedCallId,
          timestamp: '2026-06-17T00:00:05.000Z',
          scope: {
            v: 1,
            sessionId: 'ses_restore',
            requestId: 'request-subsss-restore-0',
            streamNode: 'subsession',
            subAgentInvocationId: childSubId,
            subAgentPath: [childSubId],
            turnIndex: 0,
            toolCallId: sharedCallId,
          },
        },
      ];
      writeJsonl(path.join(childDir, 'subsession.jsonl'), [
        buildLine('version', '2.0'),
        ...childRecords.map(record => buildLine('stream-part', record)),
        ...childSnapshots.map(snapshot => buildLine('snapshot', snapshot)),
      ]);
      writeJsonl(path.join(childDir, 'meta.jsonl'), [
        JSON.stringify({
          v: 2,
          type: 'part-meta',
          id: `externalEdit:${sharedCallId}:child`,
          undoStopId: 'undo-child-shared',
        }) + '\n',
      ]);

      (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
        { uri: vscode.Uri.file(tmpDir), name: 'test', index: 0 },
      ];
      const { state, ctx } = makeState(sessionDir);
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

      const uriParts = getRestoredUriParts(getFirstResponseParts(session));
      expect(uriParts.map(part => part.value.toString())).toEqual([rootUri, childUri]);
      expect(uriParts.map(part => part.undoStopId)).toEqual(['undo-root-shared', 'undo-child-shared']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
