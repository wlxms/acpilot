import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type {
  Backend,
  BackendModelInvocationResult,
  BackendModelProvider,
} from '../backend/backend';
import type { BackendModel } from '../backend/types';
import { AppEventBus } from '../backend/app-event-bus';
import {
  createLanguageModelChatProvider,
  registerLanguageModelChatProvider,
} from '../surfaces/vscode/language-model-provider';
import {
  canonicalCopilotModelId,
  createCopilotModelCatalog,
} from '../surfaces/vscode/model-catalog';
import type { BackendContext, ExtensionState } from '../types';
import { AssistantTextSSP } from '../ssp/impl/assistant-text';

function token() {
  let cancelled = false;
  return {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    cancel: () => { cancelled = true; },
  } as unknown as vscode.CancellationToken & { cancel(): void };
}

function cancellableToken() {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    }),
    cancel: () => {
      if (cancelled) {return;}
      cancelled = true;
      for (const listener of [...listeners]) {listener();}
    },
  } as unknown as vscode.CancellationToken & { cancel(): void };
}

function messages(text = 'hello'): vscode.LanguageModelChatRequestMessage[] {
  return [{
    role: 1,
    name: undefined,
    content: [new vscode.LanguageModelTextPart(text)],
  }] as unknown as vscode.LanguageModelChatRequestMessage[];
}

function fixture(
  invoke: BackendModelProvider['invoke'] = vi.fn(async () => ({
  completed: true,
  pipeline: { completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false },
  })),
  catalogModels: Array<BackendModel & { provider: string }> = [{
    id: 'big-pickle',
    name: 'Big Pickle',
    provider: 'opencode',
    maxInputTokens: 200_000,
    maxOutputTokens: 128_000,
  }],
) {
  const listModels = vi.fn(async () => ({ data: catalogModels }));
  const backend = {
    name: 'opencode',
    isRunning: () => true,
    modelProvider: { vendor: 'opencode', listModels, invoke },
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
  const state = {
    outputChannel: { appendLine: vi.fn() },
    bus: new AppEventBus(),
      modelCatalog: {
      list: () => catalogModels.map(model => ({
        vendor: 'opencode',
        copilotModelId: canonicalCopilotModelId('opencode', model.provider, model.id),
        modelId: model.id,
        providerID: model.provider,
        displayName: model.name ?? model.id,
        maxInputTokens: model.maxInputTokens ?? 128_000,
        maxOutputTokens: model.maxOutputTokens ?? 16_384,
        capabilities: { agentMode: true, toolCalling: true },
        backendId: 'opencode',
        backendInstanceKey: 'opencode',
      })),
      resolve: (_backendId: string, _vendor: string, modelId: string, _instanceKey: string) => {
        const match = catalogModels.find(model => canonicalCopilotModelId('opencode', model.provider, model.id) === modelId);
        return match
          ? { kind: 'backend' as const, backendId: 'opencode', backendInstanceKey: 'opencode', providerID: match.provider, modelID: match.id }
          : { kind: 'not-found' as const };
      },
    },
  } as unknown as ExtensionState;
  return { backend, ctx, state, listModels, invoke };
}

async function getProvider(f = fixture()) {
  const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
  const models = await provider.provideLanguageModelChatInformation!({ silent: true }, token()) ?? [];
  return { ...f, provider, dispose, model: models[0] };
}

describe('language model provider backend route', () => {
  it('signals Copilot to re-query after an initially empty catalog becomes ready', async () => {
    const catalogModels: Array<BackendModel & { provider: string }> = [];
    const f = fixture(vi.fn(async () => ({
      completed: true,
      pipeline: {
        completed: true,
        userMessageId: null,
        sessionTitle: null,
        sessionTitleSource: null,
        hadSubagentTasks: false,
      },
    })), catalogModels);
    const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
    const changed = vi.fn();
    const eventRegistration = provider.onDidChangeLanguageModelChatInformation?.(changed);

    try {
      await expect(provider.provideLanguageModelChatInformation!({ silent: true }, token()))
        .resolves.toEqual([]);

      catalogModels.push({
        id: 'ready-model',
        name: 'Ready Model',
        provider: 'ready-provider',
      });
      f.state.bus.emit('models-changed', { backendId: 'opencode' });

      expect(changed).toHaveBeenCalledOnce();
      await expect(provider.provideLanguageModelChatInformation!({ silent: true }, token()))
        .resolves.toEqual([
          expect.objectContaining({
            id: 'opencode/ready-provider/ready-model',
            name: 'Ready Model',
            targetChatSessionType: 'acpilot.opencode',
            isUserSelectable: true,
          }),
        ]);
    } finally {
      eventRegistration?.dispose();
      dispose();
    }
  });

  it('waits for the replacement catalog refresh during parallel vendor queries', async () => {
    let releaseFirstRefresh!: () => void;
    let releaseSecondRefresh!: () => void;
    const firstRefresh = new Promise<void>(resolve => { releaseFirstRefresh = resolve; });
    const secondRefresh = new Promise<void>(resolve => { releaseSecondRefresh = resolve; });
    let firstBackendCalls = 0;
    const firstBackend = {
      name: 'first',
      isRunning: () => true,
      modelProvider: {
        vendor: 'first',
        listModels: vi.fn(() => {
          firstBackendCalls += 1;
          const waitForRefresh = firstBackendCalls === 1 ? firstRefresh : secondRefresh;
          return waitForRefresh.then(() => ({
            data: [{ id: 'first-model', name: 'First Model', provider: 'first-provider' }],
          }));
        }),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const secondBackend = {
      name: 'second',
      isRunning: () => true,
      modelProvider: {
        vendor: 'second',
        listModels: vi.fn(async () => ({
          data: [{ id: 'second-model', name: 'Second Model', provider: 'second-provider' }],
        })),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const context = (id: string, vendor: string, backend: Backend): BackendContext => ({
      id,
      instanceKey: id,
      runtimeGeneration: 0,
      acceptingRequests: true,
      storageNamespace: id,
      displayName: id,
      scheme: `acpilot.${id}`,
      vendor,
      backend,
    } as unknown as BackendContext);
    const firstContext = context('first', 'first', firstBackend);
    const secondContext = context('second', 'second', secondBackend);
    const state = {
      outputChannel: { appendLine: vi.fn() },
      bus: new AppEventBus(),
      modelCatalog: createCopilotModelCatalog({
        backends: new Map([
          ['first', firstBackend],
          ['second', secondBackend],
        ]),
        backendVendors: new Map([
          ['first', 'first'],
          ['second', 'second'],
        ]),
        logger: { appendLine: vi.fn() } as never,
      }),
    } as unknown as ExtensionState;
    const firstProvider = createLanguageModelChatProvider(state, firstContext);
    const secondProvider = createLanguageModelChatProvider(state, secondContext);

    const firstInfo = Promise.resolve(
      firstProvider.provider.provideLanguageModelChatInformation!({ silent: true }, token()),
    ).then(models => models ?? []);
    await vi.waitFor(() => expect(firstBackendCalls).toBe(1));
    const secondInfo = Promise.resolve(
      secondProvider.provider.provideLanguageModelChatInformation!({ silent: true }, token()),
    ).then(models => models ?? []);
    await vi.waitFor(() => expect(firstBackendCalls).toBe(2));

    let firstSettled = false;
    void firstInfo.then(() => { firstSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    releaseSecondRefresh();
    const [firstModels, secondModels] = await Promise.all([firstInfo, secondInfo]);
    expect(firstModels.map(model => model.id)).toEqual(['first/first-provider/first-model']);
    expect(secondModels.map(model => model.id)).toEqual(['second/second-provider/second-model']);

    releaseFirstRefresh();
    firstProvider.dispose();
    secondProvider.dispose();
    state.modelCatalog.dispose();
  });

  it('exposes the backend catalog through its single vendor', async () => {
    const f = await getProvider();
    expect(f.listModels).not.toHaveBeenCalled();
    expect(f.model).toMatchObject({
      id: 'opencode/opencode/big-pickle',
      capabilities: { agentMode: true, toolCalling: true },
    });
    expect(f.model.targetChatSessionType).toBe('acpilot.opencode');
    expect(f.model.isUserSelectable).toBe(true);
    f.dispose();
  });

  it('does not publish a stale model list when a runtime changes during refresh', async () => {
    const f = fixture();
    Object.assign(f.ctx, {
      runtimeGeneration: 0,
      acceptingRequests: true,
      instanceKey: 'opencode',
    });
    let releaseRefresh!: () => void;
    const refreshPromise = new Promise<void>(resolve => { releaseRefresh = resolve; });
    f.state.modelCatalog.refresh = vi.fn(() => refreshPromise);
    const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
    const info = provider.provideLanguageModelChatInformation!({ silent: true }, token());
    await vi.waitFor(() => expect(f.state.modelCatalog.refresh).toHaveBeenCalledOnce());

    f.ctx.runtimeGeneration = 1;
    f.ctx.instanceKey = 'opencode:replacement';
    releaseRefresh();

    await expect(info).resolves.toEqual([]);
    dispose();
  });

  it('settles a lazy-start model query when its cancellation token fires', async () => {
    const f = fixture();
    f.backend.isRunning = () => false;
    let releaseStart!: () => void;
    const pendingStart = new Promise<{ data: { url: string; status: 'running' } }>(resolve => {
      releaseStart = () => resolve({ data: { url: '', status: 'running' } });
    });
    f.backend.start = vi.fn(() => pendingStart);
    const requestToken = cancellableToken();
    const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
    const info = provider.provideLanguageModelChatInformation!({ silent: true }, requestToken);

    try {
      await vi.waitFor(() => expect(f.backend.start).toHaveBeenCalledOnce());
      requestToken.cancel();
      await expect(info).resolves.toEqual([]);
    } finally {
      releaseStart();
      dispose();
    }
  });

  it('settles a model query when the backend runtime is invalidated', async () => {
    const f = fixture();
    Object.assign(f.ctx, {
      runtimeGeneration: 0,
      acceptingRequests: true,
      instanceKey: 'opencode',
    });
    f.backend.isRunning = () => false;
    let releaseStart!: () => void;
    const pendingStart = new Promise<{ data: { url: string; status: 'running' } }>(resolve => {
      releaseStart = () => resolve({ data: { url: '', status: 'running' } });
    });
    f.backend.start = vi.fn(() => pendingStart);
    const requestToken = cancellableToken();
    const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
    const info = provider.provideLanguageModelChatInformation!({ silent: true }, requestToken);

    try {
      await vi.waitFor(() => expect(f.backend.start).toHaveBeenCalledOnce());
      f.ctx.runtimeGeneration = 1;
      f.ctx.acceptingRequests = false;
      f.state.bus.emit('backend-runtime-changing', {
        backendId: 'opencode',
        runtimeGeneration: 1,
        instanceKey: 'opencode',
      });
      await expect(info).resolves.toEqual([]);
    } finally {
      releaseStart();
      dispose();
    }
  });

  it('settles while a catalog refresh is pending when the request is cancelled', async () => {
    const f = fixture();
    let releaseRefresh!: () => void;
    const pendingRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
    f.state.modelCatalog.refresh = vi.fn(() => pendingRefresh);
    const requestToken = cancellableToken();
    const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
    const info = provider.provideLanguageModelChatInformation!({ silent: true }, requestToken);

    try {
      await vi.waitFor(() => expect(f.state.modelCatalog.refresh).toHaveBeenCalledOnce());
      requestToken.cancel();
      await expect(info).resolves.toEqual([]);
    } finally {
      releaseRefresh();
      dispose();
    }
  });

  it('invalidates the catalog when a lazy backend start fails', async () => {
    const f = await getProvider();
    const previousEntries = f.state.modelCatalog.list();
    const previousResolve = f.state.modelCatalog.resolve;
    let entries = previousEntries;
    f.state.modelCatalog.list = () => entries;
    f.state.modelCatalog.resolve = (
      backendId: string,
      vendor: string,
      modelId: string,
      instanceKey: string,
    ) => entries.length === 0
      ? { kind: 'not-found' as const }
      : previousResolve(backendId, vendor, modelId, instanceKey);
    f.state.modelCatalog.clearBackend = vi.fn(() => {
      entries = [];
    });
    f.backend.isRunning = () => false;
    f.backend.start = vi.fn(async () => ({ error: 'backend offline' }));

    await expect(f.provider.provideLanguageModelChatInformation!({ silent: true }, token()))
      .resolves.toEqual([]);

    expect(f.state.modelCatalog.clearBackend).toHaveBeenCalledWith('opencode');
    expect(f.state.modelCatalog.list()).toEqual([]);
    await expect(f.provider.provideLanguageModelChatResponse!(
      f.model,
      messages(),
      {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report: vi.fn() },
      token(),
    )).rejects.toThrow('Unable to resolve model');
    expect(f.invoke).not.toHaveBeenCalled();
    f.dispose();
  });

  it('routes only through the registered canonical model id', async () => {
    const invoke = vi.fn(async (request) => {
      request.stream.push(new AssistantTextSSP({ partId: 'part-1', delta: 'canonical response' }));
      return { completed: true, pipeline: { completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false } };
    });
    const f = await getProvider(fixture(invoke));
    const report = vi.fn();
    await f.provider.provideLanguageModelChatResponse!(
      f.model,
      messages(), {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report }, token(),
    );
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'opencode', modelID: 'big-pickle' },
    }));
    expect(report.mock.calls.some(([part]) => part instanceof vscode.LanguageModelTextPart && part.value === 'canonical response')).toBe(true);
    f.dispose();
  });

  it('marks native LM invocations as non-interactive for backend permissions', async () => {
    const f = await getProvider();

    await f.provider.provideLanguageModelChatResponse!(
      f.model,
      messages(),
      {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report: vi.fn() },
      token(),
    );

    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'approval',
      allowUserInteraction: false,
    }));
    f.dispose();
  });

  it('accepts Agent requests with caller-owned tools and keeps routing in the backend pipeline', async () => {
    const f = await getProvider();
    const report = vi.fn();

    await expect(f.provider.provideLanguageModelChatResponse!(
      f.model,
      messages(),
      {
        tools: [{ name: 'lookup', description: 'Lookup a value' }],
        toolMode: 1,
      } as vscode.ProvideLanguageModelChatResponseOptions,
      { report },
      token(),
    )).resolves.toBeUndefined();

    expect(f.invoke).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('accepts required tool mode when no tool array is present', async () => {
    const f = await getProvider();

    await expect(f.provider.provideLanguageModelChatResponse!(
      f.model,
      messages(),
      { toolMode: 2 } as vscode.ProvideLanguageModelChatResponseOptions,
      { report: vi.fn() },
      token(),
    )).resolves.toBeUndefined();

    expect(f.invoke).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('routes the single backend vendor through the backend pipeline', async () => {
    const f = await getProvider();
    const report = vi.fn();

    await expect(f.provider.provideLanguageModelChatResponse!(
      f.model,
      messages('use the OpenCode Agent path'),
      {
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
        toolMode: 1,
      } as vscode.ProvideLanguageModelChatResponseOptions,
      { report },
      token(),
    )).resolves.toBeUndefined();

    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      allowUserInteraction: false,
    }));
    f.dispose();
  });

  it('keeps same model ids distinct when providers differ', async () => {
    const invoke = vi.fn(async (request) => {
      request.stream.push(new AssistantTextSSP({ partId: 'part-1', delta: 'provider-specific response' }));
      return { completed: true, pipeline: { completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false } };
    });
    const f = await getProvider(fixture(invoke, [
      { id: 'shared-model', name: 'OpenAI Shared', provider: 'openai' },
      { id: 'shared-model', name: 'DeepSeek Shared', provider: 'deepseek' },
    ]));
    const models = await f.provider.provideLanguageModelChatInformation!({ silent: true }, token()) ?? [];
    expect(models.map(model => model.id)).toEqual([
      'opencode/openai/shared-model',
      'opencode/deepseek/shared-model',
    ]);

    await f.provider.provideLanguageModelChatResponse!(
      models[1], messages(), {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report: vi.fn() }, token(),
    );
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'deepseek', modelID: 'shared-model' },
    }));
    f.dispose();
  });

  it('rejects a model with a forged or unregistered id', async () => {
    const f = await getProvider();
    const report = vi.fn();
    await expect(f.provider.provideLanguageModelChatResponse!(
      { ...f.model, id: 'opencode/forged-provider/forged-model' },
      messages(), {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report }, token(),
    )).rejects.toThrow('Unable to resolve model');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
    f.dispose();
  });

  it('streams through modelProvider.invoke and flushes the transient stream', async () => {
    const invoke = vi.fn(async (request) => {
      const flush = vi.spyOn(request.stream, 'flush');
      request.stream.push(new AssistantTextSSP({ partId: 'part-1', delta: 'ok' }));
      const result: BackendModelInvocationResult = { completed: true, pipeline: { completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false } };
      (result as BackendModelInvocationResult & { flush?: typeof flush }).flush = flush;
      return result;
    });
    const f = await getProvider(fixture(invoke));
    await f.provider.provideLanguageModelChatResponse!(f.model, messages(), {} as vscode.ProvideLanguageModelChatResponseOptions, { report: vi.fn() }, token());
    expect(invoke.mock.results[0]?.value).toBeDefined();
    const result = await invoke.mock.results[0]!.value;
    expect((result as BackendModelInvocationResult & { flush?: ReturnType<typeof vi.spyOn> }).flush).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('reports backend failures to the Copilot progress sink', async () => {
    const f = await getProvider(fixture(vi.fn(async () => { throw new Error('backend unavailable'); })));
    const report = vi.fn();
    await expect(f.provider.provideLanguageModelChatResponse!(f.model, messages(), {} as vscode.ProvideLanguageModelChatResponseOptions, { report }, token())).rejects.toThrow('backend unavailable');
    expect(report).toHaveBeenCalled();
    expect((report.mock.calls[0][0] as vscode.LanguageModelTextPart).value).toContain('Backend error: backend unavailable');
    f.dispose();
  });

  it('passes cancellation through the backend invocation token', async () => {
    const requestToken = token();
    requestToken.cancel();
    let seen: boolean | undefined;
    const invoke = vi.fn(async (request) => {
      seen = request.token.isCancellationRequested;
      return { completed: true, pipeline: { completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false } };
    });
    const f = await getProvider(fixture(invoke));
    await f.provider.provideLanguageModelChatResponse!(f.model, messages(), {} as vscode.ProvideLanguageModelChatResponseOptions, { report: vi.fn() }, requestToken);
    expect(seen).toBe(true);
    f.dispose();
  });

  it('rejects a stale model handle after an ACP target switch', async () => {
    const invoke = vi.fn(async (request) => {
      request.stream.push(new AssistantTextSSP({ partId: 'part-1', delta: 'target response' }));
      return {
        completed: true,
        pipeline: {
          completed: true,
          userMessageId: null,
          sessionTitle: null,
          sessionTitleSource: null,
          hadSubagentTasks: false,
        },
      };
    });
    const f = fixture(invoke, [{ id: 'shared-model', name: 'Shared Model', provider: 'remote' }]);
    Object.assign(f.ctx, {
      id: 'acp',
      instanceKey: 'acp:target-a',
      vendor: 'acp',
      role: 'agent' as const,
    });
    const targetA = {
      vendor: 'acp',
      copilotModelId: canonicalCopilotModelId('acp', 'remote', 'shared-model', 'acp:target-a'),
      modelId: 'shared-model',
      providerID: 'remote',
      displayName: 'Shared Model',
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
      capabilities: {},
      role: 'agent' as const,
      backendId: 'acp',
      backendInstanceKey: 'acp:target-a',
    };
    const targetB = {
      ...targetA,
      copilotModelId: canonicalCopilotModelId('acp', 'remote', 'shared-model', 'acp:target-b'),
      backendInstanceKey: 'acp:target-b',
    };
    let current = targetA;
    f.state.modelCatalog.list = () => [current];
    f.state.modelCatalog.resolve = vi.fn((backendId: string, vendor: string, modelId: string, instanceKey: string) => {
      return backendId === 'acp' && vendor === 'acp' && instanceKey === current.backendInstanceKey && modelId === current.copilotModelId
        ? {
            kind: 'backend' as const,
            backendId: 'acp',
            backendInstanceKey: current.backendInstanceKey,
            providerID: current.providerID,
            modelID: current.modelId,
          }
        : { kind: 'not-found' as const };
    });

    const { provider, dispose } = createLanguageModelChatProvider(f.state, f.ctx);
    const modelsA = await provider.provideLanguageModelChatInformation!({ silent: true }, token()) ?? [];
    const staleModel = modelsA[0];
    expect(staleModel.id).toBe(targetA.copilotModelId);

    current = targetB;
    f.ctx.instanceKey = 'acp:target-b';
    const modelsB = await provider.provideLanguageModelChatInformation!({ silent: true }, token()) ?? [];
    expect(modelsB[0].id).toBe(targetB.copilotModelId);

    const staleReport = vi.fn();
    await expect(provider.provideLanguageModelChatResponse!(
      staleModel,
      messages(),
      {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report: staleReport },
      token(),
    )).rejects.toThrow(/active backend instance "acp:target-b"/);
    expect(invoke).not.toHaveBeenCalled();

    await provider.provideLanguageModelChatResponse!(
      modelsB[0],
      messages(),
      {} as vscode.ProvideLanguageModelChatResponseOptions,
      { report: vi.fn() },
      token(),
    );
    expect(invoke).toHaveBeenCalledOnce();
    dispose();
  });

  it('disposes provider resources when VS Code registration throws', () => {
    const f = fixture();
    const register = vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider')
      .mockImplementation(() => { throw new Error('registration failed'); });
    const emitterDispose = vi.spyOn(vscode.EventEmitter.prototype, 'dispose');

    expect(() => registerLanguageModelChatProvider(f.state, f.ctx)).toThrow('registration failed');
    expect(emitterDispose).toHaveBeenCalledOnce();

    register.mockRestore();
    emitterDispose.mockRestore();
  });

  it('registers one VS Code provider under the backend vendor', () => {
    const f = fixture();
    const register = vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider');

    try {
      const registration = registerLanguageModelChatProvider(f.state, f.ctx);

      expect(register).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledWith('opencode', expect.anything());
      registration?.dispose();
    } finally {
      register.mockRestore();
    }
  });

  it('keeps the backend vendor when a legacy Copilot provider is present', () => {
    const f = fixture();
    Object.assign(f.backend, {
      copilotModelProvider: {
        vendor: 'opencode-copilot',
        listModels: vi.fn(async () => ({ data: [] })),
        invoke: vi.fn(),
      },
    });
    const register = vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider');

    try {
      const registration = registerLanguageModelChatProvider(f.state, f.ctx);

      expect(register).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledWith('opencode', expect.anything());
      registration?.dispose();
    } finally {
      register.mockRestore();
    }
  });
});
