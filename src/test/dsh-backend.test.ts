import { describe, expect, it, vi } from 'vitest';
import { DshBackend } from '../backends/dsh/adapter';
import { DshPipeline } from '../backends/dsh/pipeline';
import type { BackendPipelineStream } from '../backend/backend';

describe('DshBackend', () => {
  it('is a concrete dsh backend with a DshPipeline factory', () => {
    const backend = new DshBackend();
    expect(backend.name).toBe('dsh');
    const pipeline = backend.createPipeline({
      sessionId: 'session-1',
      stream: {
        push: vi.fn(),
        update: vi.fn(),
        has: vi.fn(() => false),
        subsession: vi.fn(),
        writeMeta: vi.fn(),
        flushAppendBuffer: vi.fn(),
        flushScheduled: vi.fn(),
        getSchedulingMode: vi.fn(() => 'immediate'),
        setSchedulingMode: vi.fn(),
        flush: vi.fn(async () => undefined),
      } as unknown as BackendPipelineStream,
    });
    expect(pipeline).toBeInstanceOf(DshPipeline);
  });

  it('merges bridge model metadata into ACP discovery without changing models', async () => {
    const backend = new DshBackend();
    const lines: string[] = [];
    backend.setLogger({ appendLine: message => lines.push(message) });
    const internals = backend as unknown as {
      onLocalStderrLine(line: string): void;
      configModels(directory?: string): Promise<{ data?: Array<Record<string, unknown>> }>;
      getAdvertisedModels(directory?: string): Array<Record<string, unknown>>;
    };

    internals.onLocalStderrLine(
      'ACPILOT_DSH_BRIDGE_CATALOG\t'
        + JSON.stringify({
          protocol: 1,
          models: [{
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            name: 'DeepSeek V4.1 Flash',
            contextWindow: 1_000_000,
            maxOutputTokens: 256_000,
            reasoningEfforts: [
              { value: 'off', name: 'Off' },
              { value: 'high', name: 'High' },
            ],
            defaultReasoningEffort: 'high',
          }],
        }),
    );
    internals.getAdvertisedModels = () => [{
      id: 'deepseek-v4-flash',
      name: 'deepseek-v4-flash',
      provider: 'deepseek-official',
    }];

    await expect(internals.configModels('D:/workspace')).resolves.toEqual({
      data: [{
        id: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash',
        provider: 'deepseek-official',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 256_000,
        reasoningEfforts: [
          { value: 'off', name: 'Off' },
          { value: 'high', name: 'High' },
        ],
        defaultReasoningEffort: 'high',
      }],
    });
    expect(lines).toContain('[dsh-backend] bridge.catalog models=1');
  });

  it('notifies the host when the bridge catalog arrives after initial model discovery', () => {
    const backend = new DshBackend();
    const internals = backend as unknown as {
      onLocalStderrLine(line: string): void;
      bridgeCatalog: Map<string, unknown>;
    };
    const listener = vi.fn();
    backend.onDidChangeModelCatalog?.(listener);
    internals.onLocalStderrLine(
      'ACPILOT_DSH_BRIDGE_CATALOG\t'
        + JSON.stringify({
          protocol: 1,
          models: [{
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            name: 'DeepSeek V4.1 Flash',
            contextWindow: 1_000_000,
            reasoningEfforts: [{ value: 'high', name: 'High' }],
          }],
        }),
    );

    expect(internals.bridgeCatalog.size).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('forwards ordinary local stderr diagnostics to the backend logger', () => {
    const backend = new DshBackend();
    const lines: string[] = [];
    backend.setLogger({ appendLine: message => lines.push(message) });

    const observeStderr = (backend as unknown as {
      onLocalStderrLine(line: string): void;
    }).onLocalStderrLine.bind(backend);
    observeStderr('profile boot failed');

    expect(lines).toEqual(['[dsh-backend] stderr: profile boot failed']);
  });

  it('formats bridge diagnostics for the backend log', () => {
    const backend = new DshBackend();
    const lines: string[] = [];
    backend.setLogger({ appendLine: message => lines.push(message) });

    const observeStderr = (backend as unknown as {
      onLocalStderrLine(line: string): void;
    }).onLocalStderrLine.bind(backend);
    observeStderr(
      'ACPILOT_DSH_BRIDGE_DIAGNOSTIC\t'
        + '{"protocol":1,"event":"pre-execute.ask","sessionId":"session-1",'
        + '"toolCallId":"call-edit","toolName":"edit","card":"diff"}',
    );

    expect(lines).toEqual([
      '[dsh-backend] bridge.diagnostic event=pre-execute.ask '
        + 'sessionId=session-1 toolCallId=call-edit toolName=edit card=diff',
    ]);
  });
});
