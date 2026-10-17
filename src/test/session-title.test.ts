import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  applySessionTitle,
  cleanGeneratedTitle,
  generateTitleWithVsCodeLm,
  pickTitleModels,
} from '../participant/session-title';
import type { ExtensionState, BackendContext } from '../types';

describe('applySessionTitle', () => {
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
