import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import { getDshRenderHost, registerDshRenderHost } from '../chat-rendering/host';
import { parseDshRichView, type DshRichView } from '../chat-rendering/protocol';
import { assertDshRenderSessionSubmission } from '../chat-rendering/session-route';
import { SessionManager } from '../backend/session-manager';
import { AppEventBus } from '../backend/app-event-bus';
import { buildLine } from '../backend/serializable/serializer';
import type { Backend } from '../backend/backend';
import type { BackendContext, ExtensionState } from '../types';

const transport = vi.hoisted(() => ({ getCommands: vi.fn(), executeCommand: vi.fn() }));
vi.mock('vscode', async importOriginal => ({ ...await importOriginal<typeof import('vscode')>(), commands: transport }));
const view: DshRichView = { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'restored-view', data: { items: [{ type: 'text', text: 'Restored choices' }] } };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;
const tempDirectories: string[] = [];
let oldRegister: unknown;

function stateForRestore() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-view-restore-'));
  tempDirectories.push(temp);
  fs.writeFileSync(path.join(temp, 'session.jsonl'), [
    buildLine('version', '2.0'),
    buildLine('stream-part', { kind: 'userPrompt', version: 1, id: 'user', payload: { text: 'show choices' }, meta: { turnIndex: 0, sequence: 0 } }),
    buildLine('stream-part', { kind: 'richView', version: 1, id: 'restored-view', payload: view, meta: { turnIndex: 0, sequence: 1 } }),
  ].join(''), 'utf8');
  const backend = {
    name: 'dsh', isRunning: () => true, getStatus: () => 'running',
    sessions: {
      get: vi.fn(async (id: string) => ({ data: { id, title: 'Existing DSH conversation', createdAt: new Date() } })),
      list: vi.fn(async () => ({ data: [] })),
      update: vi.fn(async (id: string) => ({ data: { id, title: 'Existing DSH conversation' } })),
    },
    config: { models: vi.fn(async () => ({ data: [] })), agents: vi.fn(async () => ({ data: [] })) },
  } as unknown as Backend;
  const bus = new AppEventBus();
  const ctx = {
    id: 'dsh', instanceKey: 'dsh:desktop', runtimeGeneration: 1, acceptingRequests: true,
    storageNamespace: 'dsh-desktop', displayName: 'DSH', scheme: 'acpilot.dsh', vendor: 'dsh', backend,
    sessions: new SessionManager(backend, bus, 'dsh'),
    selection: { get: () => ({}) },
    sessionStore: {
      getSessionDir: () => temp, listSessions: async () => [],
      readMeta: async () => ({ id: 'native-restored', title: 'Existing DSH conversation', status: 'completed' }),
      updateMeta: async () => {}, writeMeta: async () => {},
    },
  } as unknown as BackendContext;
  const state = {
    backends: new Map([['dsh', ctx]]), bus, outputChannel: { appendLine: vi.fn() },
    statusBar: { update: vi.fn() }, modelCatalog: { list: () => [], resolve: () => ({ kind: 'not-found' }), refresh: async () => {} },
  } as unknown as ExtensionState;
  transport.executeCommand.mockImplementation(async (_command, args) => {
    assertDshRenderSessionSubmission(ctx, { ...ctx }, args.resource, args.prompt);
  });
  const context = { subscriptions: [], extensionUri: vscode.Uri.file('D:/acpilot') } as unknown as vscode.ExtensionContext;
  const { provider } = createSessionContentProvider(state, ctx, context);
  return { ctx, provider };
}

function restoredEnvelope(session: vscode.ChatSession): DshRichView & { routeToken: string } {
  const response = session.history.find(turn => !('prompt' in turn)) as unknown as { responses: Array<{ value?: { value?: string } }> };
  const fence = response?.responses.map(part => part.value?.value ?? '').find(text => text.includes('restored-view'));
  expect(fence).toBeDefined();
  const json = fence!.split('\n').slice(1, -2).join('\n');
  const envelope = JSON.parse(json) as DshRichView & { routeToken: string };
  expect(envelope.routeToken).toBeTypeOf('string');
  return envelope;
}

describe('restored DSH renderer session ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transport.getCommands.mockResolvedValue(['workbench.action.chat.openSessionWithPrompt.acpilot.dsh']);
    transport.executeCommand.mockResolvedValue(undefined);
    oldRegister = (vscode.chat as unknown as { registerChatOutputRenderer?: unknown }).registerChatOutputRenderer;
    Object.assign(vscode.chat, { registerChatOutputRenderer: () => ({ dispose() {} }) });
    registerDshRenderHost({ subscriptions: [], extensionUri: vscode.Uri.file('D:/acpilot') } as unknown as vscode.ExtensionContext);
  });
  afterEach(() => {
    getDshRenderHost().dispose();
    if (oldRegister === undefined) {delete (vscode.chat as unknown as { registerChatOutputRenderer?: unknown }).registerChatOutputRenderer;}
    else {Object.assign(vscode.chat, { registerChatOutputRenderer: oldRegister });}
    for (const directory of tempDirectories.splice(0)) {
      if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) {throw new Error('Unsafe restore test cleanup');}
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds canonical restored history to the selected resource and visible lifecycle', async () => {
    const { provider } = stateForRestore();
    const resource = vscode.Uri.parse('acpilot.dsh:/dsh%3Adesktop/native-restored');
    const session = await provider.provideChatSessionContent(resource, token, { inputState: {} as vscode.ChatSessionInputState });
    const envelope = restoredEnvelope(session);
    await getDshRenderHost().submit(envelope.routeToken, parseDshRichView(envelope)!, 'continue', { page: 2 });
    expect(transport.executeCommand).toHaveBeenCalledWith('workbench.action.chat.openSessionWithPrompt.acpilot.dsh', {
      resource, prompt: '[genui-action] continue {"page":2}',
    });
  });

  it('keeps an untitled restored view bound when the prior mapping exists under the VS Code session id', async () => {
    const { ctx, provider } = stateForRestore();
    ctx.sessions.set('untitled-restored', { backendSessionId: 'native-restored', turnMap: [], title: 'Existing DSH conversation' });
    const resource = vscode.Uri.parse('acpilot.dsh:/dsh%3Adesktop/untitled-restored');
    const session = await provider.provideChatSessionContent(resource, token, { inputState: {} as vscode.ChatSessionInputState });
    const envelope = restoredEnvelope(session);
    await getDshRenderHost().submit(envelope.routeToken, parseDshRichView(envelope)!, 'continue', {});
    expect(transport.executeCommand).toHaveBeenCalledWith('workbench.action.chat.openSessionWithPrompt.acpilot.dsh', {
      resource, prompt: '[genui-action] continue {}',
    });
  });

  it('rejects a native restored view if its mapping is replaced before the first action', async () => {
    const { ctx, provider } = stateForRestore();
    const resource = vscode.Uri.parse('acpilot.dsh:/dsh%3Adesktop/native-restored');
    const session = await provider.provideChatSessionContent(resource, token, { inputState: {} as vscode.ChatSessionInputState });
    const envelope = restoredEnvelope(session);
    ctx.sessions.set(resource.toString(), { backendSessionId: 'native-restored', turnMap: [] });
    await expect(getDshRenderHost().submit(envelope.routeToken, parseDshRichView(envelope)!, 'continue', {}))
      .rejects.toThrow(/changed/i);
    expect(transport.executeCommand).not.toHaveBeenCalled();
  });
});
