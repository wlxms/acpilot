import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { BackendContext, SessionState } from '../types';
import * as routes from '../chat-rendering/session-route';
import { createParticipantHandler } from '../participant/handler';
import { AppEventBus } from '../backend/app-event-bus';
import type { ExtensionState } from '../types';

const commandTransport = vi.hoisted(() => ({
  getCommands: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock('vscode', async importOriginal => ({
  ...await importOriginal<typeof import('vscode')>(),
  commands: commandTransport,
}));

const command = 'workbench.action.chat.openSessionWithPrompt.acpilot.dsh';

function createRuntime() {
  const sessions = new Map<string, SessionState>();
  const runtime = {
    id: 'dsh', instanceKey: 'dsh:desktop-one', runtimeGeneration: 1,
    acceptingRequests: true, storageNamespace: 'dsh-desktop-one',
    scheme: 'acpilot.dsh', selection: {}, sessions,
    sessionStore: {}, backend: {},
  } as unknown as BackendContext;
  return { runtime, sessions };
}

function bind(runtime: BackendContext, sessions: Map<string, SessionState>, name: string) {
  const resource = vscode.Uri.parse('acpilot.dsh:/dsh%3Adesktop-one/' + name);
  sessions.set(resource.toString(), { backendSessionId: name, turnMap: [] });
  expect(routes.createDshRenderSessionRoute).toBeTypeOf('function');
  return { resource, route: routes.createDshRenderSessionRoute(runtime, { ...runtime }, resource, name) };
}

function acknowledgeSubmission(runtime: BackendContext): void {
  commandTransport.executeCommand.mockImplementation(async (_command, args) => {
    routes.assertDshRenderSessionSubmission(runtime, { ...runtime }, args.resource, args.prompt);
  });
}

describe('DSH renderer originating session actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    commandTransport.getCommands.mockResolvedValue([command]);
    commandTransport.executeCommand.mockResolvedValue(undefined);
  });

  it('submits to the bound resource through the visible contributed session lifecycle', async () => {
    const { runtime, sessions } = createRuntime();
    acknowledgeSubmission(runtime);
    const first = bind(runtime, sessions, 'session-a');
    const second = bind(runtime, sessions, 'session-b');
    await first.route.submit('confirm', { item: 'a' });
    await second.route.submit('choose', { item: 'b' });
    expect(commandTransport.executeCommand.mock.calls).toEqual([
      [command, { resource: first.resource, prompt: '[genui-action] confirm {"item":"a"}' }],
      [command, { resource: second.resource, prompt: '[genui-action] choose {"item":"b"}' }],
    ]);
    expect(first.route.sessionKey).toBe(first.resource.toString());
  });

  it('rejects a resolved command that never enters the originating handler and permits retry', async () => {
    const { runtime, sessions } = createRuntime();
    const { route } = bind(runtime, sessions, 'session-a');
    await expect(route.submit('confirm', {})).rejects.toThrow(/not accepted|rejected/i);
    commandTransport.executeCommand.mockImplementation(async (_command, args) => {
      routes.assertDshRenderSessionSubmission(runtime, { ...runtime }, args.resource, args.prompt);
    });
    await route.submit('confirm', {});
    expect(commandTransport.executeCommand).toHaveBeenCalledTimes(2);
  });

  it.each(['resource', 'prompt'] as const)('rejects acknowledgement for the wrong %s', async mismatch => {
    const { runtime, sessions } = createRuntime();
    const { route } = bind(runtime, sessions, 'session-a');
    commandTransport.executeCommand.mockImplementation(async (_command, args) => {
      routes.assertDshRenderSessionSubmission(runtime, { ...runtime },
        mismatch === 'resource' ? vscode.Uri.parse('acpilot.dsh:/wrong-resource') : args.resource,
        mismatch === 'prompt' ? args.prompt + ' altered' : args.prompt);
    });
    await expect(route.submit('confirm', {})).rejects.toThrow(/not accepted|rejected/i);
  });

  it('accepts an action admitted by the actual originating participant handler', async () => {
    const { runtime, sessions } = createRuntime();
    const { resource, route } = bind(runtime, sessions, 'session-a');
    const start = vi.fn(async () => ({ error: 'fixture backend unavailable' }));
    Object.assign(runtime.backend, { isRunning: () => false, getStatus: () => 'stopped', start });
    const state = {
      outputChannel: { appendLine: vi.fn() }, bus: new AppEventBus(),
      statusBar: { setActiveBackend: vi.fn() },
    } as unknown as ExtensionState;
    const handler = createParticipantHandler(state, runtime);
    commandTransport.executeCommand.mockImplementation(async (_command, args) => {
      await handler({ prompt: args.prompt, sessionResource: args.resource, sessionId: 'session-a' } as vscode.ChatRequest,
        { history: [] } as vscode.ChatContext,
        { markdown: vi.fn(), progress: vi.fn() } as unknown as vscode.ChatResponseStream,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken);
    });
    await route.submit('confirm', {});
    expect(start).toHaveBeenCalledTimes(1);
    expect(commandTransport.executeCommand).toHaveBeenCalledWith(command, { resource, prompt: '[genui-action] confirm {}' });
  });

  it('rejects actions while the originating request is busy and releases the guard after completion', async () => {
    const { runtime, sessions } = createRuntime();
    acknowledgeSubmission(runtime);
    const { route } = bind(runtime, sessions, 'session-a');
    const release = routes.markDshRenderSessionBusy(runtime, 'session-a');
    await expect(route.submit('confirm', {})).rejects.toThrow(/busy/i);
    expect(commandTransport.executeCommand).not.toHaveBeenCalled();
    release();
    release();
    await route.submit('confirm', {});
    expect(commandTransport.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('reserves submission before asynchronous command discovery to prevent duplicate clicks', async () => {
    const { runtime, sessions } = createRuntime();
    acknowledgeSubmission(runtime);
    const { route } = bind(runtime, sessions, 'session-a');
    let discover!: (value: string[]) => void;
    commandTransport.getCommands.mockReturnValue(new Promise(resolve => { discover = resolve; }));
    const first = route.submit('confirm', {});
    await expect(route.submit('confirm', {})).rejects.toThrow(/busy/i);
    discover([command]);
    await first;
    expect(commandTransport.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects an old route after the runtime is replaced even if the backend session id is reused', async () => {
    const { runtime, sessions } = createRuntime();
    const { route } = bind(runtime, sessions, 'session-a');
    runtime.runtimeGeneration++;
    await expect(route.submit('confirm', {})).rejects.toThrow(/changed|stale/i);
    expect(commandTransport.executeCommand).not.toHaveBeenCalled();
  });

  it('rechecks the runtime after command discovery before dispatching', async () => {
    const { runtime, sessions } = createRuntime();
    const { route } = bind(runtime, sessions, 'session-a');
    commandTransport.getCommands.mockImplementation(async () => {
      runtime.acceptingRequests = false;
      return [command];
    });
    await expect(route.submit('confirm', {})).rejects.toThrow(/changed|stale/i);
    expect(commandTransport.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects an old view after its originating conversation maps to a replacement session', async () => {
    const { runtime, sessions } = createRuntime();
    const { resource, route } = bind(runtime, sessions, 'session-a');
    sessions.set(resource.toString(), { backendSessionId: 'replacement', turnMap: [] });
    await expect(route.submit('confirm', {})).rejects.toThrow(/changed|stale/i);
    expect(commandTransport.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects an old view when the conversation mapping object is replaced with the same native id', async () => {
    const { runtime, sessions } = createRuntime();
    const { resource, route } = bind(runtime, sessions, 'session-a');
    sessions.set(resource.toString(), { backendSessionId: 'session-a', turnMap: [] });
    await expect(route.submit('confirm', {})).rejects.toThrow(/changed|stale/i);
    expect(commandTransport.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects a submitted action if the runtime changes before the visible handler starts', async () => {
    const { runtime, sessions } = createRuntime();
    const { resource, route } = bind(runtime, sessions, 'session-a');
    commandTransport.executeCommand.mockImplementation(async (_command, args) => {
      runtime.runtimeGeneration++;
      expect(routes.assertDshRenderSessionSubmission).toBeTypeOf('function');
      routes.assertDshRenderSessionSubmission(runtime, { ...runtime }, resource, args.prompt);
    });
    await expect(route.submit('confirm', {})).rejects.toThrow(/changed|stale/i);
  });

  it('checks a queued action lease at the actual visible request handler before starting a replacement runtime', async () => {
    const { runtime, sessions } = createRuntime();
    const { resource, route } = bind(runtime, sessions, 'session-a');
    const start = vi.fn(async () => ({ error: 'test stop' }));
    Object.assign(runtime.backend, { isRunning: () => false, getStatus: () => 'stopped', start });
    const markdown = vi.fn();
    const state = {
      outputChannel: { appendLine: vi.fn() }, bus: new AppEventBus(),
      statusBar: { setActiveBackend: vi.fn() },
    } as unknown as ExtensionState;
    commandTransport.executeCommand.mockImplementation(async (_command, args) => {
      runtime.runtimeGeneration++;
      const handler = createParticipantHandler(state, runtime);
      await handler({ prompt: args.prompt, sessionResource: resource, sessionId: 'session-a' } as vscode.ChatRequest,
        { history: [] } as vscode.ChatContext,
        { markdown, progress: vi.fn() } as unknown as vscode.ChatResponseStream,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken);
    });
    await expect(route.submit('confirm', {})).rejects.toThrow(/changed/i);
    expect(start).not.toHaveBeenCalled();
    expect(markdown).toHaveBeenCalledWith(expect.stringMatching(/originating DSH conversation changed/i));
  });

  it('keeps busy guards isolated when Desktop installations reuse a native id', async () => {
    const first = createRuntime();
    const second = createRuntime();
    acknowledgeSubmission(second.runtime);
    const a = bind(first.runtime, first.sessions, 'session-a');
    const b = bind(second.runtime, second.sessions, 'session-a');
    const release = routes.markDshRenderSessionBusy(first.runtime, 'session-a');
    await expect(a.route.submit('confirm', {})).rejects.toThrow(/busy/i);
    await b.route.submit('confirm', {});
    expect(commandTransport.executeCommand).toHaveBeenCalledWith(command, {
      resource: b.resource, prompt: '[genui-action] confirm {}',
    });
    release();
  });

  it('binds a restored view before its mapping is installed and uses that resource on action', async () => {
    const { runtime, sessions } = createRuntime();
    acknowledgeSubmission(runtime);
    const resource = vscode.Uri.parse('acpilot.dsh:/dsh%3Adesktop-one/restored');
    expect(routes.createDshRenderSessionRoute).toBeTypeOf('function');
    const route = routes.createDshRenderSessionRoute(runtime, { ...runtime }, resource, 'restored');
    sessions.set(resource.toString(), { backendSessionId: 'restored', turnMap: [] });
    await route.submit('continue', { page: 2 });
    expect(commandTransport.executeCommand).toHaveBeenCalledWith(command, {
      resource, prompt: '[genui-action] continue {"page":2}',
    });
  });

  it('fails explicitly when the targeted session command is unavailable and permits retry', async () => {
    const { runtime, sessions } = createRuntime();
    acknowledgeSubmission(runtime);
    const { route } = bind(runtime, sessions, 'session-a');
    commandTransport.getCommands.mockResolvedValue([]);
    await expect(route.submit('confirm', {})).rejects.toThrow(/unavailable|not available/i);
    expect(commandTransport.executeCommand).not.toHaveBeenCalled();
    commandTransport.getCommands.mockResolvedValue([command]);
    await route.submit('confirm', {});
    expect(commandTransport.executeCommand).toHaveBeenCalledTimes(1);
  });
});
