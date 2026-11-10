import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../backend/streaming/session-store';
import { SerializableSessionStream } from '../backend/streaming/session-stream';
import { DshBackend } from '../backends/dsh/adapter';
import {
  applySessionTitle,
  applyProvisionalSessionTitle,
  cleanGeneratedTitle,
  generateTitleWithVsCodeLm,
  isPlaceholderSessionTitle,
  pickTitleModels,
  SessionTitleService,
} from '../participant/session-title';
import type { ExtensionState, BackendContext } from '../types';

describe('applySessionTitle', () => {
  function makeManualTitleContext() {
    const session = {
      backendSessionId: 'dsh-manual-title',
      title: '用户指定的会话标题',
      titleSource: 'manual',
      provisionalTitle: false,
    };
    const ctx = {
      id: 'dsh',
      backend: { sessions: { update: vi.fn() } },
      sessions: { get: () => session, values: () => [session] },
      sessionStore: { updateMeta: vi.fn() },
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus: { emit: vi.fn() },
    } as unknown as ExtensionState;
    return { ctx, state, session };
  }

  it('keeps a manual title in every surface when first-prompt generation completes late', async () => {
    const { ctx, state, session } = makeManualTitleContext();

    await expect(applySessionTitle(state, ctx, {
      backendSessionId: 'dsh-manual-title',
      title: 'Late generated title',
      source: 'copilot-style',
      updateBackend: true,
      overwrite: false,
    })).resolves.toBeUndefined();

    expect(session.title).toBe('用户指定的会话标题');
    expect(ctx.backend.sessions.update).not.toHaveBeenCalled();
    expect(ctx.sessionStore.updateMeta).not.toHaveBeenCalled();
  });

  it('keeps a final title when a delayed provisional write arrives', async () => {
    const { ctx, state, session } = makeManualTitleContext();

    await expect(applyProvisionalSessionTitle(state, ctx, {
      backendSessionId: 'dsh-manual-title',
      title: 'First prompt fallback',
      updateBackend: true,
    })).resolves.toBeUndefined();

    expect(session.title).toBe('用户指定的会话标题');
    expect(ctx.backend.sessions.update).not.toHaveBeenCalled();
    expect(ctx.sessionStore.updateMeta).not.toHaveBeenCalled();
  });

  it('keeps the later manual title after overlapping real metadata writes and restart', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpilot-title-order-'));
    const store = new SessionStore({ workspaceRoot: tmpDir, backendName: 'dsh' });
    const backend = new DshBackend();
    const session = {
      backendSessionId: 'title-order', title: 'First prompt', titleSource: 'history', provisionalTitle: true,
    };
    const ctx = {
      id: 'dsh', backend, sessionStore: store,
      sessions: { get: () => session, values: () => [session] },
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() }, bus: { emit: vi.fn() },
    } as unknown as ExtensionState;
    let releaseGenerated!: () => void;
    let reachGeneratedWrite!: () => void;
    const blocked = new Promise<void>(resolve => { releaseGenerated = resolve; });
    const reached = new Promise<void>(resolve => { reachGeneratedWrite = resolve; });
    const appendFile = fs.appendFile.bind(fs);
    let firstWrite = true;
    const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
      if (firstWrite && args[0] === store.getMetaPath('title-order')) {
        firstWrite = false;
        reachGeneratedWrite();
        await blocked;
      }
      await appendFile(...args);
    });
    try {
      const generated = applySessionTitle(state, ctx, {
        backendSessionId: 'title-order', title: 'Generated title', source: 'copilot-style', updateBackend: true,
      });
      await reached;
      const manual = applySessionTitle(state, { ...ctx }, {
        backendSessionId: 'title-order', title: 'Pinned manual title', source: 'manual', updateBackend: true, overwrite: true,
      });
      await Promise.resolve();
      // If writes overlap, finish the manual write while the older append is
      // paused. A serial application instead waits behind the older write.
      if (session.title === 'Pinned manual title') {await manual;}
      releaseGenerated();
      await Promise.all([generated, manual]);

      const restoredStore = new SessionStore({ workspaceRoot: tmpDir, backendName: 'dsh' });
      expect(await restoredStore.readMeta('title-order')).toEqual(expect.objectContaining({
        title: 'Pinned manual title', titleSource: 'manual', provisionalTitle: false,
      }));
      expect(session.title).toBe('Pinned manual title');
    } finally {
      releaseGenerated();
      appendSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('restores the current manual title when persisted metadata was fetched before renaming', async () => {
    const { ctx, state, session } = makeManualTitleContext();
    const service = new SessionTitleService(state, ctx);

    expect(await service.applyRestoredTitle({
      backendSessionId: 'dsh-manual-title',
      history: [],
      meta: { id: 'dsh-manual-title', title: 'Old generated title', titleSource: 'copilot-style', provisionalTitle: false },
      backendTitle: 'DSH Session dsh-manu',
      overwrite: false,
    })).toEqual({ title: '用户指定的会话标题', source: 'manual' });
    expect(session.title).toBe('用户指定的会话标题');
  });

  it.each(['manual', 'copilot-style'] as const)(
    'keeps a %s title persisted when a stale streamed title arrives before cancellation',
    async source => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpilot-managed-title-'));
      try {
        const store = new SessionStore({ workspaceRoot: tmpDir, backendName: 'dsh' });
        const session = {
          backendSessionId: 'managed-title', title: 'First prompt', titleSource: 'history', provisionalTitle: true,
        };
        const ctx = {
          id: 'dsh', backend: new DshBackend(), sessionStore: store,
          sessions: new Map([['resource', session]]),
        } as unknown as BackendContext;
        const state = {
          outputChannel: { appendLine() {} }, bus: { emit() {} },
        } as unknown as ExtensionState;
        const service = new SessionTitleService(state, ctx);
        let titleApplication: Promise<string | undefined> | undefined;
        const sss = new SerializableSessionStream({} as vscode.ChatResponseStream, {
          workspaceRoot: tmpDir, backendName: 'dsh', sessionId: 'managed-title', turnIndex: 0, requestId: 'req-0',
          persistTitles: false,
          onTitleChanged: update => {
            titleApplication = service.applyFinal({
              backendSessionId: update.sessionId, title: update.title, source: update.source,
              updateBackend: false, overwrite: false,
            });
          },
        });
        await sss.initialize();
        await sss.flush();
        await service.applyFinal({
          backendSessionId: 'managed-title', title: 'Authoritative title', source, updateBackend: true,
        });

        sss.updateTitle('Late native generated title', 'backend');
        await titleApplication;
        sss.close();
        await sss.flush();

        const restoredStore = new SessionStore({ workspaceRoot: tmpDir, backendName: 'dsh' });
        expect(await restoredStore.readMeta('managed-title')).toEqual(expect.objectContaining({
          title: 'Authoritative title', titleSource: source, provisionalTitle: false,
        }));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('merges title updates so request details are preserved in session metadata', async () => {
    const updateMeta = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      id: 'opencode',
      scheme: 'acpilot.opencode',
    vendor: 'opencode',
      backend: { name: 'opencode', sessions: { update: vi.fn() } },
      sessions: {
        get: vi.fn(),
        values: vi.fn(() => []),
      },
      sessionStore: {
        updateMeta,
      },
    } as unknown as BackendContext;
    const state = {
      backends: new Map([['opencode', ctx]]),
      outputChannel: { appendLine: vi.fn() },
      bus: { emit: vi.fn() },
    } as unknown as ExtensionState;

    await applySessionTitle(state, ctx, {
      backendSessionId: 'ses-title-preserve',
      title: 'Real Title',
      source: 'backend',
    });

    expect(updateMeta).toHaveBeenCalledWith(
      'ses-title-preserve',
      expect.objectContaining({
        title: 'Real Title',
        titleSource: 'backend',
        backendName: 'opencode',
      }),
    );
    expect(updateMeta.mock.calls[0]?.[1]).not.toHaveProperty('requestDetails');
  });
});

describe('DSH session title fallback', () => {
  it('treats DSH and DeepSeek Harness defaults as placeholder titles', async () => {
    expect(isPlaceholderSessionTitle('DSH Session 12345678')).toBe(true);
    expect(isPlaceholderSessionTitle('New DSH Session')).toBe(true);
    expect(isPlaceholderSessionTitle('New DeepSeek Harness Session')).toBe(true);
    expect(isPlaceholderSessionTitle('DeepSeek Harness Session abc12345')).toBe(true);
    expect(isPlaceholderSessionTitle('Fix DSH session title generation')).toBe(false);

    const service = new SessionTitleService(
      {
        backends: new Map(),
        outputChannel: { appendLine: vi.fn() },
        bus: { emit: vi.fn() },
      } as unknown as ExtensionState,
      {
        vendor: 'dsh',
        backend: { sessions: { get: vi.fn() } },
      } as unknown as BackendContext,
    );

    await expect(service.resolveFinalTurnTitle({
      backendSessionId: 'dsh-default-title',
      pipelineTitle: 'DSH Session 12345678',
      pipelineTitleSource: 'backend',
    })).resolves.toBeUndefined();
  });
});

describe('generateTitleWithVsCodeLm', () => {
  it('keeps a model when VS Code access is temporarily reported as unavailable', () => {
    const sendRequest = vi.fn();
    const model = {
      id: 'opencode/openai/title-model',
      vendor: 'opencode',
      family: 'OpenCode',
      name: 'Title model',
      sendRequest,
    } as unknown as vscode.LanguageModelChat;

    expect(pickTitleModels(
      [model],
      { canSendRequest: () => false },
      'opencode',
    )).toEqual([model]);
  });

  it('prefers accessible candidates but retains blocked candidates as a final attempt', () => {
    const makeModel = (id: string, vendor: string) => ({
      id,
      vendor,
      family: vendor,
      name: id,
      sendRequest: vi.fn(),
    } as unknown as vscode.LanguageModelChat);
    const blockedCopilot = makeModel('copilot-title', 'copilot');
    const accessibleBackend = makeModel('backend-title', 'opencode');

    expect(pickTitleModels(
      [blockedCopilot, accessibleBackend],
      { canSendRequest: model => model === blockedCopilot ? false : true },
      'opencode',
    )).toEqual([accessibleBackend, blockedCopilot]);
  });

  it('uses an ACPilot model when Copilot has no available model', async () => {
    const sendRequest = vi.fn(async () => ({
      text: (async function* () {
        yield 'ACP model routing';
      })(),
    }));
    const selectChatModels = vi.spyOn(vscode.lm, 'selectChatModels')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'opencode/openai/gpt-5',
        vendor: 'opencode',
        family: 'OpenCode',
        name: 'GPT-5',
        sendRequest,
      } as unknown as vscode.LanguageModelChat]);

    await expect(generateTitleWithVsCodeLm(
      'route ACP backend models through Copilot',
      { appendLine: vi.fn() },
      'opencode',
    )).resolves.toBe('ACP model routing');

    expect(selectChatModels).toHaveBeenNthCalledWith(1, { vendor: 'copilot' });
    expect(selectChatModels).toHaveBeenCalledWith({ vendor: 'opencode' });
    expect(sendRequest).toHaveBeenCalledOnce();
    expect((sendRequest.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual({
      modelOptions: { acpilotPurpose: 'title-generation' },
    });
    selectChatModels.mockRestore();
  });

  it('accepts a fenced or multi-line model response', () => {
    expect(cleanGeneratedTitle('```text\nFix model picker\n```')).toBe('Fix model picker');
    expect(cleanGeneratedTitle('"Fix model picker"\nExplanation')).toBe('Fix model picker');
  });

  it('keeps the explicit backend model when an unscoped query is unavailable', async () => {
    const sendRequest = vi.fn(async () => ({
      text: (async function* () {
        yield 'Use backend model';
      })(),
    }));
    const selectChatModels = vi.spyOn(vscode.lm, 'selectChatModels')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'opencode/opencode/backend-model',
        vendor: 'opencode',
        family: 'OpenCode',
        name: 'Backend model',
        sendRequest,
      } as unknown as vscode.LanguageModelChat])
      .mockRejectedValueOnce(new Error('unscoped query unavailable'));

    await expect(generateTitleWithVsCodeLm(
      'generate a title through the active backend',
      { appendLine: vi.fn() },
      'opencode',
    )).resolves.toBe('Use backend model');

    expect(sendRequest).toHaveBeenCalledOnce();
    selectChatModels.mockRestore();
  });

  it('does not pass ACPilot-only options to Copilot title models', async () => {
    const sendRequest = vi.fn(async () => ({
      text: (async function* () {
        yield 'Copilot title';
      })(),
    }));
    const selectChatModels = vi.spyOn(vscode.lm, 'selectChatModels')
      .mockResolvedValueOnce([{
        id: 'gpt-5',
        vendor: 'copilot',
        family: 'gpt-5',
        name: 'GPT-5',
        sendRequest,
      } as unknown as vscode.LanguageModelChat])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(generateTitleWithVsCodeLm(
      'summarize the current coding task',
      { appendLine: vi.fn() },
      'opencode',
    )).resolves.toBe('Copilot title');

    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
      undefined,
    );
    selectChatModels.mockRestore();
  });

  it('tries the model selected for the current turn even before the global pool refreshes', async () => {
    const sendRequest = vi.fn(async () => ({
      text: (async function* () {
        yield 'Current backend title';
      })(),
    }));
    const selectedModel = {
      id: 'opencode/opencode/current-model',
      vendor: 'opencode',
      family: 'OpenCode',
      name: 'Current model',
      sendRequest,
    } as unknown as vscode.LanguageModelChat;
    const selectChatModels = vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([]);

    await expect(generateTitleWithVsCodeLm(
      'use the selected backend model for this title',
      { appendLine: vi.fn() },
      'opencode',
      selectedModel,
    )).resolves.toBe('Current backend title');

    expect(sendRequest).toHaveBeenCalledOnce();
    expect(selectChatModels).not.toHaveBeenCalled();
    selectChatModels.mockRestore();
  });
});
