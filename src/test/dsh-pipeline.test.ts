import { describe, expect, it, vi } from 'vitest';
import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';

function createStream() {
  const pushed: Array<{ id?: string; toJSON?: () => { payload?: Record<string, unknown> } }> = [];
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const ids = new Set<string>();
  const value = {
    push: vi.fn((part: { id?: string; toJSON?: () => { payload?: Record<string, unknown> } }) => {
      pushed.push(part);
      if (part.id) {ids.add(part.id);}
    }),
    update: vi.fn((id: string, data: Record<string, unknown>) => updated.push({ id, data })),
    has: vi.fn((id: string) => ids.has(id)),
    writeMeta: vi.fn(),
    updateTitle: vi.fn(),
  } as unknown as BackendPipelineStream;
  return { value, pushed, updated, ids };
}

function sessionUpdate(update: Record<string, unknown>): ActiveSessionMessage {
  return {
    kind: 'session_update',
    notification: { sessionId: 'session-1', update },
    update,
  } as never;
}

function stop(): ActiveSessionMessage {
  return { kind: 'stop', response: { stopReason: 'end_turn' }, stopReason: 'end_turn' } as ActiveSessionMessage;
}

describe('DshPipeline', () => {
  it('waits for a late bridge call before resolving an incomplete permission request', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-late' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    let settled = false;
    void responsePromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-late',
      rootToolCallId: 'call-late',
      toolName: 'write',
      rawInput: { path: 'src/late.ts' },
      presentation: {
        card: 'diff',
        title: 'Write src/late.ts',
        locations: [{ path: 'src/late.ts', line: 1 }],
        diffs: [{ path: 'src/late.ts', oldText: null, newText: 'new' }],
      },
    });
    await Promise.resolve();
    expect(target.pushed).toHaveLength(1);

    const external = target.pushed[0] as unknown as {
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    external.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop');
      },
    });
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });  it('merges a terminal presentation that arrives before the ACP tool update', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({ sessionId: 'session-1', stream: target.value });

    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-1',
      rootToolCallId: 'call-1',
      toolName: 'pwsh',
      rawInput: { command: 'Get-ChildItem', cwd: 'D:/workspace' },
      presentation: { card: 'terminal', title: 'Get-ChildItem', cwd: 'D:/workspace' },
    });
    pipeline.handleBridgeMessage({
      type: 'tool_result',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-1',
      rootToolCallId: 'call-1',
      toolName: 'pwsh',
      isError: false,
      output: 'src',
      presentation: { card: 'terminal', title: 'Get-ChildItem', output: 'src', exitCode: 0 },
    });

    await pipeline.run((async function* () {
      yield sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'pwsh',
        status: 'in_progress',
        rawInput: { command: 'Get-ChildItem' },
      });
      yield sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: 'src',
      });
      yield stop();
    })(), { isCancellationRequested: false });

    expect(target.pushed).toHaveLength(1);
    expect(target.updated).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'call-1',
        data: expect.objectContaining({
          toolName: 'bash',
          state: expect.objectContaining({
            title: 'Get-ChildItem',
            output: 'src',
            metadata: expect.objectContaining({
              dshPresentation: expect.objectContaining({ card: 'terminal' }),
            }),
            originalToolName: 'pwsh',
          }),
        }),
      }),
    ]));
  });

  it('passes every diff location through ExternalEditSSP', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-multi-edit',
      rootToolCallId: 'call-multi-edit',
      toolName: 'edit',
      rawInput: { paths: ['src/one.ts', 'src/two.ts'] },
      presentation: {
        card: 'diff',
        title: 'Edit two files',
        locations: [{ path: 'src/one.ts' }, { path: 'src/two.ts' }],
        diffs: [
          { path: 'src/one.ts', oldText: 'one', newText: 'ONE' },
          { path: 'src/two.ts', oldText: 'two', newText: 'TWO' },
        ],
      },
    });

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-multi-edit' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();
    const external = target.pushed[0] as unknown as {
      toJSON?: () => { payload?: { uris?: unknown[] } };
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    expect(external.toJSON?.().payload?.uris).toEqual([
      'D:\\workspace\\src\\one.ts',
      'D:\\workspace\\src\\two.ts',
    ]);
    external.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop');
      },
    });
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('defers diff cards and correlates permission facts with ExternalEditSSP', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-edit',
      rootToolCallId: 'call-edit',
      toolName: 'write',
      rawInput: { path: 'src/index.ts' },
      presentation: {
        card: 'diff',
        title: 'Write src/index.ts',
        diffs: [{ path: 'src/index.ts', oldText: null, newText: 'new' }],
        locations: [{ path: 'src/index.ts', line: 1 }],
      },
    });

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-edit' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();
    expect(target.pushed).toHaveLength(1);
    const external = target.pushed[0] as unknown as {
      toJSON?: () => { payload?: { uri?: string; toolCallId?: string } };
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    expect(external.toJSON?.().payload).toMatchObject({
      toolCallId: 'call-edit',
      uri: 'D:\\workspace\\src\\index.ts',
    });
    external.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop');
      },
    });
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    pipeline.handleBridgeMessage({
      type: 'tool_result',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-edit',
      rootToolCallId: 'call-edit',
      toolName: 'write',
      isError: false,
      presentation: { card: 'diff', title: 'Write src/index.ts', diffs: [] },
    });
    expect(target.updated).toContainEqual(expect.objectContaining({
      id: 'external-edit-call-edit',
      data: { status: 'completed', error: undefined },
    }));
  });
  it('does not create a generic tool card when the bridge call follows the ACP update', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    const permissionOptions = [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }];
    const runPromise = pipeline.run((async function* () {
      yield sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-late-bridge',
        title: 'write',
        status: 'in_progress',
        rawInput: { path: 'src/late-bridge.ts' },
      });
      pipeline.handleBridgeMessage({
        type: 'tool_call',
        protocol: 1,
        sessionId: 'session-1',
        toolCallId: 'call-late-bridge',
        rootToolCallId: 'call-late-bridge',
        toolName: 'write',
        rawInput: { path: 'src/late-bridge.ts' },
        presentation: {
          card: 'diff',
          title: 'Write src/late-bridge.ts',
          locations: [{ path: 'src/late-bridge.ts', line: 1 }],
          diffs: [{ path: 'src/late-bridge.ts', oldText: null, newText: 'new' }],
        },
      });
      const permissionPromise = pipeline.resolvePermission({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'call-late-bridge' },
        options: permissionOptions,
      } as never);
      await Promise.resolve();
      expect(target.pushed).toHaveLength(1);
      const external = target.pushed[0] as unknown as {
        render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
      };
      external.render({
        externalEdit: (_uris, callback) => {
          void callback();
          return Promise.resolve('undo-stop');
        },
      });
      yield sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-late-bridge',
        status: 'completed',
      });
      pipeline.handleBridgeMessage({
        type: 'tool_result',
        protocol: 1,
        sessionId: 'session-1',
        toolCallId: 'call-late-bridge',
        rootToolCallId: 'call-late-bridge',
        toolName: 'write',
        isError: false,
        presentation: { card: 'diff', title: 'Write src/late-bridge.ts', diffs: [] },
      });
      await expect(permissionPromise).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
      yield stop();
    })(), { isCancellationRequested: false });

    await runPromise;
    expect(target.pushed).toHaveLength(1);
    expect(target.updated).toContainEqual(expect.objectContaining({
      id: 'external-edit-call-late-bridge',
      data: expect.objectContaining({ status: 'completed' }),
    }));
  });});
