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
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual(expect.objectContaining({
      name: 'Auto',
      isBYOK: true,
      isUserSelectable: true,
    }));
    expect(models[1]).toEqual(expect.objectContaining({
      id: canonicalCopilotModelId('acp', 'acp', 'remote-model', 'acp:target-a'),
      isBYOK: true,
      isUserSelectable: true,
    }));
    running = false;
    await expect(provider.provideLanguageModelChatInformation!(
      { silent: false } as vscode.PrepareLanguageModelChatModelOptions,
      token,
    )).resolves.toEqual([expect.objectContaining({ name: 'Auto' })]);
    dispose();
  });

  it('exposes a reasoning selector with only the model-advertised levels', async () => {
    const modelId = canonicalCopilotModelId('dsh', 'deepseek-official', 'deepseek-v4-flash', 'dsh:local');
    const ctx = {
      id: 'dsh',
      instanceKey: 'dsh:local',
      storageNamespace: 'dsh/local',
      displayName: 'DeepSeek Harness',
      scheme: 'acpilot.dsh',
      vendor: 'dsh',
      backend: { isRunning: () => true } as Backend,
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus: new AppEventBus(),
      modelCatalog: {
        list: () => [{
          vendor: 'dsh',
          copilotModelId: modelId,
          modelId: 'deepseek-v4-flash',
          providerID: 'deepseek-official',
          displayName: 'DeepSeek V4.1 Flash',
          maxInputTokens: 1_000_000,
          maxOutputTokens: 256_000,
          reasoning: {
            current: 'high',
            options: [
              { value: 'off', name: 'Off' },
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
              { value: 'max', name: 'Max' },
            ],
          },
          capabilities: {},
          backendId: 'dsh',
          backendInstanceKey: 'dsh:local',
        }],
        refresh: async () => undefined,
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const models = await provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      { isCancellationRequested: false } as vscode.CancellationToken,
    ) ?? [];
    const model = models.find(entry => entry.id === modelId) as unknown as Record<string, unknown>;

    expect(model).toMatchObject({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 256_000,
      configurationSchema: {
        properties: {
          contextWindow: expect.objectContaining({
            enum: [1_000_000],
            enumItemLabels: ['1M'],
            default: 1_000_000,
          }),
          reasoningEffort: expect.objectContaining({
            enum: ['off', 'low', 'high', 'max'],
            enumItemLabels: ['Off', 'Low', 'High', 'Max'],
            default: 'high',
          }),
        },
      },
    });
    dispose();
  });

  it('refreshes the catalog before signaling a late backend catalog change', async () => {
    const modelId = canonicalCopilotModelId('dsh', 'deepseek-official', 'deepseek-v4-flash', 'dsh:local');
    let reasoning = false;
    let catalogListener: (() => void | Promise<void>) | undefined;
    const backend = {
      isRunning: () => true,
      onDidChangeModelCatalog: (listener: () => void | Promise<void>) => {
        catalogListener = listener;
        return () => { catalogListener = undefined; };
      },
    } as unknown as Backend;
    const ctx = {
      id: 'dsh', instanceKey: 'dsh:local', storageNamespace: 'dsh/local',
      displayName: 'DeepSeek Harness', scheme: 'acpilot.dsh', vendor: 'dsh', backend,
    } as unknown as BackendContext;
    const resolveReasoning = () => reasoning
      ? { current: 'high', options: [{ value: 'high', name: 'High' }] }
      : undefined;
    const refresh = vi.fn(async () => {
      reasoning = true;
    });
    const state = {
      outputChannel: { appendLine: vi.fn() }, bus: new AppEventBus(),
      modelCatalog: {
        refresh,
        list: () => [{ vendor: 'dsh', copilotModelId: modelId, modelId: 'deepseek-v4-flash',
          providerID: 'deepseek-official', displayName: 'DeepSeek V4.1 Flash',
          maxInputTokens: 1_000_000, maxOutputTokens: 256_000,
          ...(resolveReasoning() ? { reasoning: resolveReasoning() } : {}),
          capabilities: {}, backendId: 'dsh', backendInstanceKey: 'dsh:local' }],
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const changed = vi.fn();
    const registration = provider.onDidChangeLanguageModelChatInformation?.(changed);
    await provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );
    refresh.mockClear();
    reasoning = false;

    await catalogListener?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(refresh).toHaveBeenCalledOnce();
    const models = await provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      { isCancellationRequested: false } as vscode.CancellationToken,
    ) ?? [];
    const model = models.find(entry => entry.id === modelId) as unknown as Record<string, unknown>;
    expect(model.configurationSchema).toMatchObject({
      properties: { reasoningEffort: { enum: ['high'], default: 'high' } },
    });
    registration?.dispose();
    dispose();
  });
  it('re-queries model capabilities when a late backend catalog change arrives', async () => {
    const modelId = canonicalCopilotModelId('dsh', 'deepseek-official', 'deepseek-v4-flash', 'dsh:local');
    let reasoning = false;
    let catalogListener: (() => void) | undefined;
    const backend = {
      isRunning: () => true,
      onDidChangeModelCatalog: (listener: () => void) => {
        catalogListener = listener;
        return () => { catalogListener = undefined; };
      },
    } as unknown as Backend;
    const ctx = {
      id: 'dsh', instanceKey: 'dsh:local', storageNamespace: 'dsh/local',
      displayName: 'DeepSeek Harness', scheme: 'acpilot.dsh', vendor: 'dsh', backend,
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() }, bus: new AppEventBus(),
      modelCatalog: {
        refresh: async () => undefined,
        list: () => [{
          vendor: 'dsh', copilotModelId: modelId, modelId: 'deepseek-v4-flash',
          providerID: 'deepseek-official', displayName: 'DeepSeek V4.1 Flash',
          maxInputTokens: 1_000_000, maxOutputTokens: 256_000,
          ...(reasoning ? { reasoning: { current: 'high', options: [{ value: 'high', name: 'High' }] } } : {}),
          capabilities: {}, backendId: 'dsh', backendInstanceKey: 'dsh:local',
        }],
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const changed = vi.fn();
    const eventRegistration = provider.onDidChangeLanguageModelChatInformation?.(changed);
    const query = async () => (await provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      { isCancellationRequested: false } as vscode.CancellationToken,
    ) ?? []).find(model => model.id === modelId) as unknown as Record<string, unknown>;

    expect((await query()).configurationSchema).toEqual({ properties: expect.objectContaining({ contextWindow: expect.anything() }) });
    reasoning = true;
    catalogListener?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect((await query()).configurationSchema).toEqual({ properties: expect.objectContaining({
      reasoningEffort: expect.objectContaining({ enum: ['high'], default: 'high' }),
    })});
    eventRegistration?.dispose();
    dispose();
  });
  it('omits the reasoning selector entirely for a model without levels', async () => {
    const modelId = canonicalCopilotModelId('dsh', 'zai-coding-cn', 'glm-5.3', 'dsh:local');
    const ctx = {
      id: 'dsh', instanceKey: 'dsh:local', storageNamespace: 'dsh/local',
      displayName: 'DeepSeek Harness', scheme: 'acpilot.dsh', vendor: 'dsh',
      backend: { isRunning: () => true } as Backend,
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() }, bus: new AppEventBus(),
      modelCatalog: {
        list: () => [{
          vendor: 'dsh', copilotModelId: modelId, modelId: 'glm-5.3',
          providerID: 'zai-coding-cn', displayName: 'GLM-5.3',
          maxInputTokens: 1_000_000, maxOutputTokens: 131_072,
          capabilities: {}, backendId: 'dsh', backendInstanceKey: 'dsh:local',
        }],
        refresh: async () => undefined,
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const models = await provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      { isCancellationRequested: false } as vscode.CancellationToken,
    ) ?? [];
    const model = models.find(entry => entry.id === modelId) as unknown as Record<string, unknown>;
    const properties = (model.configurationSchema as { properties?: Record<string, unknown> } | undefined)?.properties;

    expect(properties).not.toHaveProperty('reasoningEffort');
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
    )).resolves.toEqual([expect.objectContaining({ name: 'Auto' })]);

    expect(start).not.toHaveBeenCalled();
    expect(catalog.list()).toEqual([
      expect.objectContaining({ modelId: 'stale-model' }),
    ]);
    expect(catalog.resolve('opencode', 'opencode', staleId, 'opencode')).toMatchObject({
      kind: 'backend',
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
    )).resolves.toEqual([expect.objectContaining({ name: 'Auto' })]);
    await expect(provider.provideLanguageModelChatInformation!(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      token,
    )).resolves.toEqual([expect.objectContaining({ name: 'Auto' })]);

    expect(start).not.toHaveBeenCalled();
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
