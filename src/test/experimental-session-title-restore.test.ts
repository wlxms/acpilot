import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import { buildLine } from '../backend/serializable/serializer';
import { AppEventBus } from '../backend/app-event-bus';
import type { Backend } from '../backend/backend';
import type { BackendContext, ExtensionState } from '../types';

function streamRecord(kind: string, id: string, payload: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  return {
    kind,
    version: 1,
    id,
    payload,
    meta: {
      turnIndex: 0,
      requestId: 'restore-req',
      sequence: 0,
      createdAt: '2026-06-17T00:00:00.000Z',
      source: 'backend-event',
      ...meta,
    },
  };
}

function makeBackend(): Backend {
  return {
    name: 'opencode',
    start: vi.fn(async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } })),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn((): import('../backend/types').BackendServerStatus => 'running'),
    getUrl: vi.fn(() => 'http://127.0.0.1:4096'),
    isRunning: vi.fn(() => true),
    sessions: {
      create: vi.fn(),
      get: vi.fn(async () => ({
        data: { id: 'ses_restore', title: 'New OpenCode Session', createdAt: new Date('2026-05-28T03:00:00Z') },
      })),
      update: vi.fn(),
      prompt: vi.fn(),
      revert: vi.fn(),
      abort: vi.fn(),
      release: vi.fn(),
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
    createPipeline: vi.fn() as unknown as Backend['createPipeline'],
  };
}

describe('session provider title restore', () => {
  it('keeps persisted final title when opened session has placeholder backend title', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpilot-title-restore-'));
    try {
      const sessionDir = path.join(tmpDir, '.acpilot', 'opencode', 'ses_restore');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, 'session.jsonl'), [
        buildLine('version', '2.0'),
        buildLine('turn-start', { turnIndex: 0, timestamp: '2026-06-17T00:00:00.000Z' }),
        buildLine('stream-part', streamRecord(
          'userPrompt',
          'userPrompt:0',
          { text: 'first prompt should not overwrite title' },
          { sequence: 0, sourceType: 'userPrompt' },
        )),
        buildLine('stream-part', streamRecord(
          'assistantText',
          'assistantText:0',
          { partId: 'assistant:0', text: 'ok' },
          { sequence: 1, sourceType: 'assistantText' },
        )),
        buildLine('turn-end', { turnIndex: 0, timestamp: '2026-06-17T00:00:01.000Z' }),
      ].join(''), 'utf-8');

      const backend = makeBackend();
      const sessionMap = new Map<string, unknown>();
      sessionMap.set('acpilot.opencode:/ses_restore', {
        backendSessionId: 'ses_restore',
        turnMap: [],
        title: 'first prompt should not overwrite title',
        titleSource: 'history',
        provisionalTitle: true,
        createdAt: new Date('2026-05-28T03:00:00.000Z'),
      });
      const meta = {
        id: 'ses_restore',
        title: 'Persisted Generated Title',
        titleSource: 'copilot-style' as const,
        provisionalTitle: false,
        createdAt: '2026-05-28T03:00:00.000Z',
        backendName: 'opencode',
      };
      const ctx = {
        id: 'opencode',
        instanceKey: 'opencode',
        storageNamespace: 'opencode',
        displayName: 'OpenCode',
        scheme: 'acpilot.opencode',
        vendor: 'opencode',
        backend,
        sessions: {
          get: vi.fn((key: string) => sessionMap.get(key)),
          has: vi.fn((key: string) => sessionMap.has(key)),
          set: vi.fn((key: string, value: unknown) => { sessionMap.set(key, value); }),
          values: vi.fn(() => sessionMap.values()),
          entries: vi.fn(() => sessionMap.entries()),
        },
        selection: {
          get: vi.fn(() => ({ agent: undefined, model: undefined, modelDisplayName: undefined })),
          setAgent: vi.fn(async () => {}),
          setModel: vi.fn(async () => {}),
        },
        sessionStore: {
          listSessions: vi.fn().mockResolvedValue([meta]),
          getSessionPath: vi.fn((sessionId: string) => path.join(tmpDir, '.acpilot', 'opencode', sessionId, 'session.jsonl')),
          getSessionDir: vi.fn((sessionId: string) => path.join(tmpDir, '.acpilot', 'opencode', sessionId)),
          initialize: vi.fn().mockResolvedValue(undefined),
          readMeta: vi.fn().mockResolvedValue(meta),
          updateMeta: vi.fn().mockResolvedValue(undefined),
          writeMeta: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as BackendContext;
      const state = {
        backends: new Map([['opencode', ctx]]),
        outputChannel: vscode.window.createOutputChannel('test'),
        statusBar: { update: vi.fn() },
        bus: new AppEventBus(),
        modelCatalog: {
          resolve: vi.fn(() => ({ kind: 'not-found' as const })),
          list: vi.fn(() => []),
          refresh: vi.fn(async () => {}),
          dispose: vi.fn(),
        },
      } as unknown as ExtensionState;

      (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
        { uri: vscode.Uri.file(tmpDir), name: 'test', index: 0 },
      ];

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

      expect(session.title).toBe('Persisted Generated Title');
      expect(sessionMap.get('acpilot.opencode:/ses_restore')).toEqual(
        expect.objectContaining({
          title: 'Persisted Generated Title',
          titleSource: 'copilot-style',
          provisionalTitle: false,
        }),
      );
      expect(ctx.sessionStore.updateMeta).toHaveBeenCalledWith(
        'ses_restore',
        expect.objectContaining({
          title: 'Persisted Generated Title',
          titleSource: 'copilot-style',
          provisionalTitle: false,
        }),
      );
      expect(ctx.sessionStore.updateMeta).not.toHaveBeenCalledWith(
        'ses_restore',
        expect.objectContaining({ title: 'first prompt should not overwrite title' }),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
