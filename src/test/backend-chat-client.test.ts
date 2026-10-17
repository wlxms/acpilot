import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { BackendModelInvocationResult } from '../backend/backend';
import {
  NATIVE_STREAM_FLUSH_TIMEOUT_MS,
  streamBackendChatResponse,
} from '../surfaces/vscode/backend-chat-client';
import { TransientSessionStream } from '../backend/transient-session-stream';
import { AssistantTextSSP } from '../ssp/impl/assistant-text';
import { ReasoningSSP } from '../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../ssp/impl/tool-invocation';

function makeContext(provider: {
  invoke: (request: any) => Promise<BackendModelInvocationResult>;
}) {
  return {
    displayName: 'OpenCode',
    backend: { modelProvider: provider },
  } as any;
}

function makeOptions(provider: { invoke: (request: any) => Promise<BackendModelInvocationResult> }) {
  return {
    ctx: makeContext(provider),
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    messages: [{ role: 1, content: [{ value: 'hello' }] }] as any,
    progress: { report: vi.fn() },
    token: { isCancellationRequested: false } as vscode.CancellationToken,
  } as any;
}

const completed = (completedValue: boolean): BackendModelInvocationResult => ({
  completed: completedValue,
  sessionId: 'native-lm-session',
  pipeline: {
    completed: completedValue,
    userMessageId: null,
    sessionTitle: null,
    sessionTitleSource: null,
    hadSubagentTasks: false,
  },
});

describe('native LM backend chat adapter', () => {
  it('projects text, thinking, and internal tool output into legal LM response parts', async () => {
    const provider = {
      invoke: vi.fn(async (request) => {
        request.stream.push(new AssistantTextSSP({ partId: 'answer', delta: 'answer' }));
        request.stream.push(new ReasoningSSP({ partId: 'thought', delta: 'thinking', thinkingId: 't1' }));
        request.stream.push(new ToolInvocationSSP({
          partId: 'call-1',
          toolName: 'read',
          callId: 'call-1',
          state: { status: 'completed', input: {} },
        }));
        return completed(true);
      }),
    };
    const options = makeOptions(provider);

    await expect(streamBackendChatResponse(options)).resolves.toBeUndefined();

    const reports = options.progress.report.mock.calls.map((call: [unknown]) => call[0]);
    expect(reports.some((part: unknown) => part instanceof vscode.LanguageModelTextPart
      && (part as vscode.LanguageModelTextPart).value === 'answer')).toBe(true);
    expect(reports.some((part: unknown) => part instanceof vscode.LanguageModelThinkingPart
      && (part as vscode.LanguageModelThinkingPart).value === 'thinking')).toBe(true);
    expect(reports.some((part: unknown) => {
      const value = part as Record<string, unknown>;
      return value.toolName === 'read' || value.toolCallId === 'call-1';
    })).toBe(false);
  });

  it('forwards a defensive copy of backend-specific model options', async () => {
    const provider = {
      invoke: vi.fn(async (_request: unknown) => completed(true)),
    };
    const options = makeOptions(provider);
    const modelOptions = { variant: 'fast', temperature: 0.2 };
    options.modelOptions = modelOptions;

    await expect(streamBackendChatResponse(options)).resolves.toBeUndefined();

    expect(provider.invoke).toHaveBeenCalledOnce();
    const invocation = (provider.invoke.mock.calls as unknown as [[{ modelOptions?: Record<string, unknown> }]])[0][0];
    expect(invocation.modelOptions).toEqual(modelOptions);
    expect(invocation.modelOptions).not.toBe(modelOptions);
  });

  it('rejects a stale runtime before taking the empty-prompt fast path', async () => {
    const provider = {
      invoke: vi.fn(async (_request: unknown) => completed(true)),
    };
    const options = makeOptions(provider) as any;
    options.messages = [{ role: 1, content: [] }];
    options.runtime = {
      instanceKey: 'opencode:old',
      isCurrent: () => false,
    };

    await expect(streamBackendChatResponse(options))
      .rejects.toThrow('Backend runtime changed');
    expect(provider.invoke).not.toHaveBeenCalled();
  });

  it('bounds a hung transient flush and closes the stream', async () => {
    vi.useFakeTimers();
    const flush = vi.spyOn(TransientSessionStream.prototype, 'flush')
      .mockImplementation(() => new Promise<void>(() => {}));
    const close = vi.spyOn(TransientSessionStream.prototype, 'close');
    try {
      const provider = { invoke: vi.fn(async (_request: unknown) => completed(true)) };
      const invocation = streamBackendChatResponse(makeOptions(provider));
      const rejection = invocation.then(
        () => undefined,
        error => error,
      );
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(NATIVE_STREAM_FLUSH_TIMEOUT_MS);
      await expect(rejection).resolves.toEqual(expect.objectContaining({
        message: 'Transient stream flush timed out after 2000ms',
      }));
      expect(close).toHaveBeenCalledOnce();
    } finally {
      flush.mockRestore();
      close.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails when the backend pipeline is incomplete and flushes output first', async () => {
    const provider = {
      invoke: vi.fn(async (request) => {
        request.stream.push(new AssistantTextSSP({ partId: 'partial', delta: 'partial' }));
        return completed(false);
      }),
    };
    const options = makeOptions(provider);

    await expect(streamBackendChatResponse(options))
      .rejects.toThrow('Backend model invocation did not complete');
    expect(options.progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'partial' }),
    );
  });

  it('flushes rendered output when backend invocation throws', async () => {
    const provider = {
      invoke: vi.fn(async (request) => {
        request.stream.push(new AssistantTextSSP({ partId: 'error', delta: 'before error' }));
        throw new Error('backend failed');
      }),
    };
    const options = makeOptions(provider);

    await expect(streamBackendChatResponse(options)).rejects.toThrow('backend failed');
    expect(options.progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'before error' }),
    );
  });

  it('ignores backend events that arrive after invocation cleanup', async () => {
    const provider = {
      invoke: vi.fn(async (request) => {
        request.stream.push(new AssistantTextSSP({ partId: 'early', delta: 'early' }));
        setTimeout(() => {
          request.stream.push(new AssistantTextSSP({ partId: 'late', delta: 'late' }));
        }, 0);
        return completed(true);
      }),
    };
    const options = makeOptions(provider);

    await expect(streamBackendChatResponse(options)).resolves.toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 10));

    const text = options.progress.report.mock.calls
      .map((call: [unknown]) => call[0])
      .filter((part: unknown) => part instanceof vscode.LanguageModelTextPart)
      .map((part: unknown) => (part as vscode.LanguageModelTextPart).value);
    expect(text).toEqual(['early']);
  });
});
