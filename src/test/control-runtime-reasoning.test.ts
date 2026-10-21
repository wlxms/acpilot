import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../backend/backend';
import { AppEventBus } from '../backend/app-event-bus';
import { createLanguageModelChatProvider } from '../surfaces/vscode/language-model-provider';
import { canonicalCopilotModelId } from '../surfaces/vscode/model-catalog';
import type { BackendContext, ExtensionState } from '../types';

describe('reasoning configuration request propagation', () => {
  it('passes the modelConfiguration reasoningEffort to the backend invocation', async () => {
    const vendor = 'dsh';
    const instanceKey = 'dsh:local';
    const modelId = canonicalCopilotModelId(vendor, 'deepseek-official', 'deepseek-flash', instanceKey);
    const invoke = vi.fn(async () => ({
      completed: true,
      pipeline: {
        completed: true,
        userMessageId: null,
        sessionTitle: null,
        sessionTitleSource: null,
        hadSubagentTasks: false,
      },
    }));
    const backend = {
      name: 'dsh',
      isRunning: () => true,
      modelProvider: { vendor, listModels: async () => ({ data: [] }), invoke },
      createPipeline: () => ({
        run: async () => ({ completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false }),
      }),
    } as unknown as Backend;
    const ctx = {
      id: 'dsh', instanceKey, storageNamespace: 'dsh/local',
      displayName: 'DeepSeek Harness', scheme: 'acpilot.dsh', vendor,
      backend, selection: { get: () => ({}) },
    } as unknown as BackendContext;
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus: new AppEventBus(),
      modelCatalog: {
        list: () => [{
          vendor, copilotModelId: modelId, modelId: 'deepseek-flash',
          providerID: 'deepseek-official', displayName: 'DeepSeek V4.1 Flash',
          maxInputTokens: 1_000_000, maxOutputTokens: 256_000,
          reasoning: {
            current: 'high',
            options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }],
          },
          capabilities: {}, backendId: 'dsh', backendInstanceKey: instanceKey,
        }],
        refresh: async () => undefined,
        resolve: () => ({
          kind: 'backend' as const, backendId: 'dsh', backendInstanceKey: instanceKey,
          providerID: 'deepseek-official', modelID: 'deepseek-flash',
        }),
      },
    } as unknown as ExtensionState;
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx);
    const progress = { report: vi.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };

    await provider.provideLanguageModelChatResponse!(
      { id: modelId } as never,
      [{ role: 1, name: undefined, content: [{ value: 'hello' }] }] as never,
      { modelConfiguration: { reasoningEffort: 'off' } } as never,
      progress as never,
      token as never,
    );

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'deepseek-official', modelID: 'deepseek-flash' },
      modelOptions: { reasoningEffort: 'off' },
    }));
    dispose();
  });
});
