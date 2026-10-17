import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../backend/backend';
import type { BackendModel } from '../backend/types';
import {
  backendOwnsCopilotModel,
  canonicalCopilotModelId,
  createCopilotModelCatalog,
} from '../surfaces/vscode/model-catalog';

function backendWithModels(name: string, models: BackendModel[]): Backend {
  return {
    name,
    modelProvider: {
      vendor: name,
      listModels: async () => ({ data: models }),
      invoke: async () => ({ completed: true, pipeline: { completed: true, userMessageId: null, sessionTitle: null, sessionTitleSource: null, hadSubagentTasks: false } }),
    },
  } as unknown as Backend;
}

function makeOptions(backends: Map<string, Backend>, backendVendors: Map<string, string>) {
  return { backends, backendVendors, logger: { appendLine: () => undefined } as never };
}

describe('Copilot model catalog single-vendor exposure', () => {
  it('isolates a throwing backend and forwards the workspace directory', async () => {
    const logger = { appendLine: vi.fn() };
    const listModels = vi.fn(async (directory?: string) => ({
      data: [{ id: 'workspace-model', name: 'Workspace Model', provider: 'openai' }],
      directory,
    }));
    const healthy = {
      name: 'healthy',
      modelProvider: {
        vendor: 'healthy',
        listModels,
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const broken = {
      name: 'broken',
      modelProvider: {
        vendor: 'broken',
        listModels: vi.fn(async () => { throw new Error('backend offline'); }),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([['healthy', healthy], ['broken', broken]]),
      backendVendors: new Map([['healthy', 'healthy'], ['broken', 'broken']]),
      logger: logger as never,
    });

    await modelCatalog.refresh('D:\\workspace');

    expect(listModels).toHaveBeenCalledWith('D:\\workspace');
    expect(modelCatalog.list()).toEqual([
      expect.objectContaining({ backendId: 'healthy', modelId: 'workspace-model' }),
    ]);
    expect(logger.appendLine).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });

  it('retains the successful OpenCode snapshot when a startup refresh fails', async () => {
    let refreshAttempt = 0;
    const listModels = vi.fn(async () => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) {
        return {
          data: [{ id: 'big-pickle', name: 'Big Pickle', provider: 'opencode' }],
        };
      }
      // A backend can be reachable enough to construct its provider while its
      // startup/discovery call is still failing. That transient result must
      // not erase the last catalog that VS Code can still route to.
      return { error: 'backend is still starting' };
    });
    const opencode = {
      name: 'opencode',
      modelProvider: {
        vendor: 'opencode',
        listModels,
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const catalog = createCopilotModelCatalog({
      backends: new Map([['opencode', opencode]]),
      backendVendors: new Map([['opencode', 'opencode']]),
      logger: { appendLine: vi.fn() } as never,
    });

    await catalog.refresh('D:\\workspace');
    const modelId = canonicalCopilotModelId('opencode', 'opencode', 'big-pickle');
    expect(catalog.resolve('opencode', 'opencode', modelId, 'opencode')).toMatchObject({
      kind: 'backend',
      providerID: 'opencode',
      modelID: 'big-pickle',
    });

    await catalog.refresh('D:\\workspace');

    expect(catalog.list()).toEqual([
      expect.objectContaining({
        vendor: 'opencode',
        copilotModelId: modelId,
        modelId: 'big-pickle',
        backendId: 'opencode',
      }),
    ]);
    expect(catalog.resolve('opencode', 'opencode', modelId, 'opencode')).toMatchObject({
      kind: 'backend',
      modelID: 'big-pickle',
    });
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('lets a latest refresh bypass a hanging older request and wins publication', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>(resolve => { releaseFirst = resolve; });
    let call = 0;
    const backend = {
      name: 'queued',
      modelProvider: {
        vendor: 'queued',
        listModels: vi.fn(async () => {
          call += 1;
          if (call === 1) {await firstDone;}
          return { data: [{ id: `model-${call}`, provider: 'provider' }] };
        }),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([['queued', backend]]),
      backendVendors: new Map([['queued', 'queued']]),
      logger: { appendLine: vi.fn() } as never,
    });

    const first = modelCatalog.refresh();
    await vi.waitFor(() => expect(call).toBe(1));
    const second = modelCatalog.refresh();

    // The second refresh must enter the provider before the first response is
    // released; a global promise queue would leave this assertion pending.
    await vi.waitFor(() => expect(call).toBe(2));
    await second;
    expect(modelCatalog.list().map(model => model.modelId)).toEqual(['model-2']);

    // The superseded caller follows the replacement refresh. It must settle
    // with the published snapshot, rather than waking while the catalog is
    // still empty/old.
    await expect(first).resolves.toBeUndefined();

    releaseFirst!();

    // The late response from the superseded request cannot overwrite the
    // snapshot published by the latest refresh.
    expect(modelCatalog.list().map(model => model.modelId)).toEqual(['model-2']);
  });

  it('refreshes a healthy backend when an earlier backend provider hangs', async () => {
    vi.useFakeTimers();
    let releaseHanging!: () => void;
    const hanging = new Promise<{ data: BackendModel[] }>(resolve => {
      releaseHanging = () => resolve({
        data: [{ id: 'late-model', provider: 'hanging-provider' }],
      });
    });
    const hangingList = vi.fn(() => hanging);
    const healthyList = vi.fn(async () => ({
      data: [{ id: 'healthy-model', provider: 'healthy-provider' }],
    }));
    const hangingBackend = {
      name: 'hanging',
      modelProvider: {
        vendor: 'hanging',
        listModels: hangingList,
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const healthyBackend = {
      name: 'healthy',
      modelProvider: {
        vendor: 'healthy',
        listModels: healthyList,
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([
        ['hanging', hangingBackend],
        ['healthy', healthyBackend],
      ]),
      backendVendors: new Map([
        ['hanging', 'hanging'],
        ['healthy', 'healthy'],
      ]),
      providerTimeoutMs: 25,
      logger: { appendLine: vi.fn() } as never,
    });

    try {
      const refresh = modelCatalog.refresh('D:\\workspace');
      // Both providers are entered before the refresh waits for either one.
      await Promise.resolve();
      await Promise.resolve();
      expect(hangingList).toHaveBeenCalledWith('D:\\workspace');
      expect(healthyList).toHaveBeenCalledWith('D:\\workspace');

      await vi.advanceTimersByTimeAsync(25);
      await expect(refresh).resolves.toBeUndefined();
      expect(modelCatalog.list().map(model => model.modelId)).toEqual(['healthy-model']);

      // A late response from the timed-out backend is consumed and cannot
      // overwrite the snapshot that was published for the healthy backend.
      releaseHanging();
      await Promise.resolve();
      await Promise.resolve();
      expect(modelCatalog.list().map(model => model.modelId)).toEqual(['healthy-model']);
    } finally {
      releaseHanging();
      modelCatalog.dispose();
      vi.useRealTimers();
    }
  });

  it('uses a provider-specific timeout budget for slow model discovery', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<{ data: BackendModel[] }>(resolve => {
      release = () => resolve({
        data: [{ id: 'slow-model', provider: 'slow-provider' }],
      });
    });
    const backend = {
      name: 'slow',
      modelProvider: {
        vendor: 'slow',
        listModelsTimeoutMs: 50,
        listModels: vi.fn(() => pending),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const catalog = createCopilotModelCatalog({
      backends: new Map([['slow', backend]]),
      backendVendors: new Map([['slow', 'slow']]),
      // The backend override should win over this intentionally shorter host
      // default, allowing the discovery operation to finish at 20ms.
      providerTimeoutMs: 10,
      logger: { appendLine: vi.fn() } as never,
    });

    try {
      const refresh = catalog.refresh();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      release();
      await expect(refresh).resolves.toBeUndefined();
      expect(catalog.list()).toEqual([
        expect.objectContaining({ modelId: 'slow-model', backendId: 'slow' }),
      ]);
    } finally {
      release();
      catalog.dispose();
      vi.useRealTimers();
    }
  });

  it('does not cancel unrelated backend refreshes when one backend is cleared', async () => {
    vi.useFakeTimers();
    let targetInstance = 'target:a';
    let releaseTarget!: () => void;
    const targetPending = new Promise<{ data: BackendModel[] }>(resolve => {
      releaseTarget = () => resolve({
        data: [{ id: 'stale-target-model', provider: 'target-provider' }],
      });
    });
    const target = {
      name: 'target',
      modelProvider: {
        vendor: 'target',
        listModels: vi.fn(() => targetPending),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const healthy = {
      name: 'healthy',
      modelProvider: {
        vendor: 'healthy',
        listModels: vi.fn(async () => ({
          data: [{ id: 'healthy-model', provider: 'healthy-provider' }],
        })),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([
        ['target', target],
        ['healthy', healthy],
      ]),
      backendVendors: new Map([
        ['target', 'target'],
        ['healthy', 'healthy'],
      ]),
      backendInstanceKeys: new Map([
        ['target', () => targetInstance],
      ]),
      providerTimeoutMs: 25,
      logger: { appendLine: vi.fn() } as never,
    });

    try {
      const refresh = modelCatalog.refresh();
      await Promise.resolve();
      await Promise.resolve();
      targetInstance = 'target:b';
      modelCatalog.clearBackend('target');

      await vi.advanceTimersByTimeAsync(25);
      await expect(refresh).resolves.toBeUndefined();
      expect(modelCatalog.list().map(model => model.modelId)).toEqual(['healthy-model']);

      releaseTarget();
      await Promise.resolve();
      await Promise.resolve();
      expect(modelCatalog.list().map(model => model.modelId)).toEqual(['healthy-model']);
    } finally {
      releaseTarget();
      modelCatalog.dispose();
      vi.useRealTimers();
    }
  });

  it('does not publish a refresh that completes after disposal', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const backend = {
      name: 'slow',
      modelProvider: {
        vendor: 'slow',
        listModels: vi.fn(async () => {
          await pending;
          return { data: [{ id: 'late-model', provider: 'provider' }] };
        }),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([['slow', backend]]),
      backendVendors: new Map([['slow', 'slow']]),
      logger: { appendLine: vi.fn() } as never,
    });

    const refresh = modelCatalog.refresh();
    modelCatalog.dispose();
    release!();
    await refresh;

    expect(modelCatalog.list()).toEqual([]);
  });

  it('exposes every OpenCode model under one vendor', async () => {
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([['opencode', backendWithModels('opencode', [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'opencode-go' },
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
    ])]]), new Map([['opencode', 'opencode']])));
    await modelCatalog.refresh();
    expect(modelCatalog.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ vendor: 'opencode', modelId: 'kimi-k2.5', providerID: 'opencode-go', backendId: 'opencode' }),
      expect.objectContaining({ vendor: 'opencode', modelId: 'gpt-4o', providerID: 'openai', backendId: 'opencode' }),
    ]));
    expect(modelCatalog.list().every(model => model.vendor === 'opencode')).toBe(true);
  });

  it('keeps one vendor authoritative when a legacy Copilot provider is present', async () => {
    const backend = {
      name: 'opencode',
      modelProvider: {
        vendor: 'opencode',
        listModels: async () => ({
          data: [{ id: 'agent-model', name: 'Agent Model', provider: 'opencode-go' }],
        }),
        invoke: vi.fn(),
      },
      // A stale adapter may still expose this transitional capability. It must
      // not create a second public vendor or a second model catalog namespace.
      copilotModelProvider: {
        vendor: 'opencode-copilot',
        listModels: async () => ({
          data: [{ id: 'copilot-model', name: 'Copilot Model', provider: 'opencode-go' }],
        }),
        invoke: vi.fn(),
      },
    } as unknown as Backend;
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([['opencode', backend]]),
      backendVendors: new Map([['opencode', 'opencode']]),
      logger: { appendLine: vi.fn() } as never,
    });

    await modelCatalog.refresh();

    expect(modelCatalog.list()).toEqual([
      expect.objectContaining({ vendor: 'opencode', modelId: 'agent-model' }),
    ]);
    expect(modelCatalog.list().some(model => model.vendor === 'opencode-copilot')).toBe(false);
  });

  it('maps backend tool and image capabilities into Copilot metadata', async () => {
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([
      ['opencode', backendWithModels('opencode', [{
        id: 'vision-tool-model',
        provider: 'opencode-go',
        capabilitiesRaw: {
          toolcall: true,
          input: { image: true },
        },
      }])],
    ]), new Map([['opencode', 'opencode']])));

    await modelCatalog.refresh();

    expect(modelCatalog.list()[0]?.capabilities).toEqual({
      agentMode: true,
      imageInput: true,
      toolCalling: true,
    });
  });

  it('recognizes either tool capability alias when both are present', async () => {
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([
      ['opencode', backendWithModels('opencode', [{
        id: 'dual-capability-model',
        provider: 'opencode',
        capabilitiesRaw: { toolCalling: false, toolcall: true },
      }])],
    ]), new Map([['opencode', 'opencode']])));

    await modelCatalog.refresh();

    expect(modelCatalog.list()[0]?.capabilities).toMatchObject({
      agentMode: true,
      toolCalling: true,
    });
  });

  it('exposes Reasonix models under its own vendor', async () => {
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([['reasonix', backendWithModels('reasonix', [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'deepseek' },
    ])]]), new Map([['reasonix', 'reasonix']])));
    await modelCatalog.refresh();
    expect(modelCatalog.list()).toEqual([
      expect.objectContaining({ vendor: 'reasonix', modelId: 'deepseek-reasoner', providerID: 'deepseek', backendId: 'reasonix' }),
    ]);
    expect(modelCatalog.resolve('reasonix', 'reasonix', canonicalCopilotModelId('reasonix', 'deepseek', 'deepseek-reasoner'), 'reasonix')).toMatchObject({ kind: 'backend', backendId: 'reasonix', providerID: 'deepseek', backendInstanceKey: 'reasonix' });
  });

  it('keeps same native model ids unique across providers', async () => {
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([
      ['opencode', backendWithModels('opencode', [
        { id: 'shared-model', name: 'OpenAI Shared', provider: 'openai' },
        { id: 'shared-model', name: 'DeepSeek Shared', provider: 'deepseek' },
      ])],
    ]), new Map([['opencode', 'opencode']])));
    await modelCatalog.refresh();

    expect(modelCatalog.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        copilotModelId: canonicalCopilotModelId('opencode', 'openai', 'shared-model'),
        providerID: 'openai',
        modelId: 'shared-model',
      }),
      expect.objectContaining({
        copilotModelId: canonicalCopilotModelId('opencode', 'deepseek', 'shared-model'),
        providerID: 'deepseek',
        modelId: 'shared-model',
      }),
    ]));
    expect(modelCatalog.resolve(
      'opencode',
      'opencode',
      canonicalCopilotModelId('opencode', 'openai', 'shared-model'),
      'opencode',
    )).toMatchObject({ kind: 'backend', providerID: 'openai', modelID: 'shared-model' });
    expect(modelCatalog.resolve('opencode', 'opencode', 'opencode/shared-model', 'opencode')).toEqual({ kind: 'not-found' });
  });

  it('resolves a shared model within the requested backend', async () => {
    const sharedModel: BackendModel = { id: 'shared-model', name: 'Shared Model', provider: 'deepseek' };
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([
      ['opencode', backendWithModels('opencode', [sharedModel])],
      ['reasonix', backendWithModels('reasonix', [sharedModel])],
    ]), new Map([['opencode', 'opencode'], ['reasonix', 'reasonix']])));
    await modelCatalog.refresh();
    expect(modelCatalog.resolve('opencode', 'opencode', canonicalCopilotModelId('opencode', 'deepseek', 'shared-model'), 'opencode')).toMatchObject({ kind: 'backend', backendId: 'opencode', providerID: 'deepseek' });
    expect(modelCatalog.resolve('reasonix', 'reasonix', canonicalCopilotModelId('reasonix', 'deepseek', 'shared-model'), 'reasonix')).toMatchObject({ kind: 'backend', backendId: 'reasonix', providerID: 'deepseek' });
  });

  it('keeps same-vendor model identities scoped to their owning backend', async () => {
    const model = { id: 'shared-model', name: 'Shared Model', provider: 'deepseek' } satisfies BackendModel;
    const modelCatalog = createCopilotModelCatalog(makeOptions(new Map([
      ['first', backendWithModels('first', [model])],
      ['second', backendWithModels('second', [model])],
    ]), new Map([['first', 'shared-vendor'], ['second', 'shared-vendor']])));
    await modelCatalog.refresh();
    const entries = modelCatalog.list();

    const canonicalId = canonicalCopilotModelId('shared-vendor', 'deepseek', 'shared-model');
    expect(backendOwnsCopilotModel(entries, 'first', 'shared-vendor', canonicalId, 'first')).toBe(true);
    expect(backendOwnsCopilotModel(entries, 'second', 'shared-vendor', canonicalId, 'second')).toBe(true);
    expect(backendOwnsCopilotModel(entries, 'second', 'shared-vendor', 'shared-vendor/shared-model', 'second')).toBe(false);
  });

  it('isolates model registrations and handles across dynamic backend instances', async () => {
    let activeInstance = 'acp:target-a';
    const backend = backendWithModels('acp', [
      { id: 'remote-model', name: 'Remote Model', provider: 'remote' },
    ]);
    const modelCatalog = createCopilotModelCatalog({
      backends: new Map([['acp', backend]]),
      backendVendors: new Map([['acp', 'acp']]),
      backendInstanceKeys: new Map([['acp', () => activeInstance]]),
      logger: { appendLine: vi.fn() } as never,
    });

    await modelCatalog.refresh();
    const targetAModelId = canonicalCopilotModelId('acp', 'remote', 'remote-model', 'acp:target-a');
    expect(modelCatalog.list()).toEqual([
      expect.objectContaining({
        copilotModelId: targetAModelId,
        backendInstanceKey: 'acp:target-a',
      }),
    ]);
    expect(modelCatalog.resolve('acp', 'acp', targetAModelId, 'acp:target-a')).toMatchObject({
      kind: 'backend',
      backendInstanceKey: 'acp:target-a',
    });

    activeInstance = 'acp:target-b';
    modelCatalog.clearBackend('acp');
    await modelCatalog.refresh();
    const targetBModelId = canonicalCopilotModelId('acp', 'remote', 'remote-model', 'acp:target-b');
    expect(targetBModelId).not.toBe(targetAModelId);
    expect(modelCatalog.resolve('acp', 'acp', targetAModelId, 'acp:target-a')).toEqual({ kind: 'not-found' });
    expect(modelCatalog.resolve('acp', 'acp', targetBModelId, 'acp:target-b')).toMatchObject({
      kind: 'backend',
      backendInstanceKey: 'acp:target-b',
    });
  });
});
