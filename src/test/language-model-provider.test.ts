import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { Backend } from '../backend/backend';
import { AppEventBus } from '../backend/app-event-bus';
import { createLanguageModelChatProvider } from '../surfaces/vscode/language-model-provider';
import {
  canonicalCopilotModelId,
  createCopilotModelCatalog,
} from '../surfaces/vscode/model-catalog';
import type { BackendContext, ExtensionState } from '../types';

describe('language model provider routing', () => {
  it('exposes the backend model catalog for its single vendor', async () => {
    let running = true;
    const ctx = {
      id: 'acp',
      instanceKey: 'acp:target-a',
      storageNamespace: 'acp/target-a',
      displayName: 'ACP Agent',
      scheme: 'acpilot.acp',
      vendor: 'acp',
      backend: { isRunning: () => running } as Backend,
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus: new AppEventBus(),
      modelCatalog: {
        list: () => [{
        vendor: 'acp',
        copilotModelId: canonicalCopilotModelId('acp', 'acp', 'remote-model', 'acp:target-a'),
        modelId: 'remote-model',
          providerID: 'acp',
          displayName: 'Remote Model',
          maxInputTokens: 128_000,
          maxOutputTokens: 16_384,
          capabilities: {},
          backendId: 'acp',
          backendInstanceKey: 'acp:target-a',
        }],
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as vscode.CancellationToken;
    const models = await provider.provideLanguageModelChatInformation!(
      { silent: false } as vscode.PrepareLanguageModelChatModelOptions,
      token,
    ) ?? [];
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      isBYOK: true,
      isUserSelectable: true,
    }));
    running = false;
    await expect(provider.provideLanguageModelChatInformation!(
      { silent: false } as vscode.PrepareLanguageModelChatModelOptions,
      token,
    )).resolves.toEqual([]);
    dispose();
  });

  it('clears stale catalog entries when lazy backend startup fails', async () => {
    let running = true;
    const start = vi.fn(async () => ({ error: 'backend offline' }));
    const backend = {
      name: 'opencode',
      isRunning: () => running,
      start,
      modelProvider: {
        vendor: 'opencode',
        listModels: vi.fn(async () => ({
          data: [{ id: 'stale-model', name: 'Stale Model', provider: 'openai' }],
        })),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const ctx = {
      id: 'opencode',
      instanceKey: 'opencode',
      storageNamespace: 'opencode',
      displayName: 'OpenCode',
      scheme: 'acpilot.opencode',
      vendor: 'opencode',
      backend,
    } as unknown as BackendContext;
    const logger = { appendLine: vi.fn() };
    const catalog = createCopilotModelCatalog({
      backends: new Map([['opencode', backend]]),
      backendVendors: new Map([['opencode', 'opencode']]),
      logger: logger as never,
    });
    await catalog.refresh();
    const staleId = canonicalCopilotModelId('opencode', 'openai', 'stale-model');
    expect(catalog.resolve('opencode', 'opencode', staleId, 'opencode')).toMatchObject({
      kind: 'backend',
    });

    running = false;
    const state = {
      outputChannel: logger,
      bus: new AppEventBus(),
      modelCatalog: catalog,
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);

    await expect(provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      { isCancellationRequested: false } as vscode.CancellationToken,
    )).resolves.toEqual([]);

    expect(start).toHaveBeenCalledOnce();
    expect(catalog.list()).toEqual([]);
    expect(catalog.resolve('opencode', 'opencode', staleId, 'opencode')).toEqual({
      kind: 'not-found',
    });
    dispose();
    catalog.dispose();
  });

  it('does not rebroadcast an already-empty catalog after repeated lazy start failures', async () => {
    const start = vi.fn(async () => ({ error: 'No ACP target selected' }));
    const backend = {
      name: 'acp',
      isRunning: () => false,
      start,
    } as unknown as Backend;
    const ctx = {
      id: 'acp',
      instanceKey: 'acp:unconfigured',
      storageNamespace: 'acp/unconfigured',
      displayName: 'ACP Agent',
      scheme: 'acpilot.acp',
      vendor: 'acp',
      backend,
    } as unknown as BackendContext;
    const bus = new AppEventBus();
    const modelsChanged = vi.fn();
    bus.on('models-changed', modelsChanged);
    const clearBackend = vi.fn();
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus,
      modelCatalog: {
        list: () => [],
        clearBackend,
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const token = { isCancellationRequested: false } as vscode.CancellationToken;

    await expect(provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      token,
    )).resolves.toEqual([]);
    await expect(provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      token,
    )).resolves.toEqual([]);

    expect(start).toHaveBeenCalledTimes(2);
    expect(clearBackend).not.toHaveBeenCalled();
    expect(modelsChanged).not.toHaveBeenCalled();
    dispose();
  });

  it('propagates an unresolved model route after reporting the provider error', async () => {
    const ctx = {
      id: 'opencode',
      instanceKey: 'opencode',
      storageNamespace: 'opencode',
      displayName: 'OpenCode',
      scheme: 'acpilot.opencode',
      vendor: 'opencode',
      backend: { isRunning: () => true } as Backend,
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus: new AppEventBus(),
      modelCatalog: { list: () => [], resolve: () => ({ kind: 'not-found' as const }) },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const progress = { report: vi.fn() } as unknown as vscode.Progress<vscode.LanguageModelResponsePart2>;
    const token = { isCancellationRequested: false } as vscode.CancellationToken;

    await expect(provider.provideLanguageModelChatResponse!(
      { id: 'opencode/missing' } as unknown as import('../surfaces/vscode/language-model-provider').BackendLanguageModelChatInformation,
      [],
      {} as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    )).rejects.toThrow('Unable to resolve model');
    expect(progress.report).toHaveBeenCalled();
    dispose();
  });
});
