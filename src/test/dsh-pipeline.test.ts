import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';

function createStream() {
  const pushed: Array<{ id?: string; toJSON?: () => { payload?: Record<string, unknown> } }> = [];
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const ids = new Set<string>();
  const parts = new Map<string, { update?: (data: Record<string, unknown>) => void }>();
  const value = {
    push: vi.fn((part: { id?: string; toJSON?: () => { payload?: Record<string, unknown> }; update?: (data: Record<string, unknown>) => void }) => {
      pushed.push(part);
      if (part.id) {
        ids.add(part.id);
        parts.set(part.id, part);
      }
    }),
    update: vi.fn((id: string, data: Record<string, unknown>) => {
      updated.push({ id, data });
      parts.get(id)?.update?.(data);
    }),
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

  it('derives diff-only paths for the permission-gated ExternalEdit lifecycle', async () => {
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
      toolCallId: 'call-diff-only',
      rootToolCallId: 'call-diff-only',
      toolName: 'write',
      presentation: {
        card: 'diff',
        title: 'Write src/diff-only.ts',
        diffs: [{ path: 'src/diff-only.ts', oldText: null, newText: 'new' }],
      },
    });

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-diff-only' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();

    expect(target.pushed).toHaveLength(1);
    const external = target.pushed[0] as unknown as {
      toJSON?: () => { payload?: { uri?: string } };
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    expect(external.toJSON?.().payload?.uri).toBe('D:\\workspace\\src\\diff-only.ts');
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
  it('creates ExternalEditSSP from permission after a bridge diff call', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'acpilot-dsh-'));
    try {
      const filePath = path.join(directory, 'dsh-hello.md');
      const target = createStream();
      const pipeline = new DshPipeline({
        sessionId: 'session-1',
        directory,
        stream: target.value,
        permissionMode: 'full-edit',
      });
      const snapshots: Array<Record<string, unknown>> = [];
      let external: {
        onSnapshot?: (callback: (snapshot: Record<string, unknown>) => void) => void;
        render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
        getMetadata?: () => Record<string, unknown> | undefined;
        whenMetadataSettled?: () => Promise<void>;
      } | undefined;

      await pipeline.run((async function* () {
        yield sessionUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-bridge-only-edit',
          title: 'write',
          status: 'in_progress',
          rawInput: { path: 'dsh-hello.md', content: 'after' },
        });
        pipeline.handleBridgeMessage({
          type: 'tool_call',
          protocol: 1,
          sessionId: 'session-1',
          toolCallId: 'call-bridge-only-edit',
          rootToolCallId: 'call-bridge-only-edit',
          toolName: 'write',
          rawInput: { path: 'dsh-hello.md', content: 'after' },
          presentation: {
            card: 'diff',
            title: 'Write dsh-hello.md',
            locations: [{ path: 'dsh-hello.md', line: 1 }],
            diffs: [{ path: 'dsh-hello.md', oldText: null, newText: 'after' }],
          },
        });
        await Promise.resolve();

        expect(target.pushed).toHaveLength(0);

        const permissionPromise = pipeline.resolvePermission({
          sessionId: 'session-1',
          toolCall: { toolCallId: 'call-bridge-only-edit' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        } as never);
        let permissionSettled = false;
        void permissionPromise.then(() => { permissionSettled = true; });
        await Promise.resolve();
        expect(permissionSettled).toBe(false);
        expect(target.pushed).toHaveLength(1);

        external = target.pushed[0] as unknown as typeof external;
        external?.onSnapshot?.(snapshot => snapshots.push(snapshot));
        external?.render({
          externalEdit: (_uris, callback) => Promise.resolve(callback()).then(() => 'undo-stop'),
        });
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({ phase: 'before', missing: true });
        await expect(permissionPromise).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: 'allow-once' },
        });
        expect(await access(filePath).then(() => true, () => false)).toBe(false);

        await writeFile(filePath, 'after', 'utf8');
        yield sessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-bridge-only-edit',
          status: 'completed',
        });
        pipeline.handleBridgeMessage({
          type: 'tool_result',
          protocol: 1,
          sessionId: 'session-1',
          toolCallId: 'call-bridge-only-edit',
          rootToolCallId: 'call-bridge-only-edit',
          toolName: 'write',
          isError: false,
          presentation: { card: 'diff', title: 'Write dsh-hello.md', diffs: [] },
        });
        await external?.whenMetadataSettled?.();
        yield stop();
      })(), { isCancellationRequested: false });

      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toMatchObject({ phase: 'after', content: 'after', undoStopId: 'undo-stop' });
      expect(external?.getMetadata?.()).toEqual({ undoStopId: 'undo-stop' });
      expect(target.pushed.some(part => (part as unknown as { kind?: string }).kind === 'toolInvocation')).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for the bridge before choosing a representation when ACP arrives first', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });

    let pushedBeforeBridge = -1;
    await pipeline.run((async function* () {
      yield sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-late-diff',
        title: 'write',
        status: 'in_progress',
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      pushedBeforeBridge = target.pushed.length;

      pipeline.handleBridgeMessage({
        type: 'tool_call',
        protocol: 1,
        sessionId: 'session-1',
        toolCallId: 'call-late-diff',
        rootToolCallId: 'call-late-diff',
        toolName: 'write',
        presentation: {
          card: 'diff',
          title: 'Write src/late-diff.ts',
          locations: [{ path: 'src/late-diff.ts', line: 1 }],
          diffs: [{ path: 'src/late-diff.ts', oldText: null, newText: 'new' }],
        },
      });
      const responsePromise = pipeline.resolvePermission({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'call-late-diff' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
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
      await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      yield stop();
    })(), { isCancellationRequested: false });
    expect(pushedBeforeBridge).toBe(0);
    expect(target.pushed.filter(part => (part as unknown as { kind?: string }).kind === 'externalEdit')).toHaveLength(1);
  });

  it('waits for a late bridge even when ACP permission includes a file path', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    const internals = pipeline as unknown as {
      handleSessionUpdate(update: never, eventSessionId: string): void;
    };
    internals.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-path-race',
      title: 'write',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'src/path-race.ts' },
    } as never, 'session-1');

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-path-race',
        kind: 'edit',
        rawInput: { path: 'src/path-race.ts' },
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();
    expect(target.pushed).toHaveLength(0);

    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-path-race',
      rootToolCallId: 'call-path-race',
      toolName: 'write',
      presentation: {
        card: 'diff',
        title: 'Write src/path-race.ts',
        diffs: [{ path: 'src/path-race.ts', oldText: null, newText: 'new' }],
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
  });

  it('renders a bridge-free read tool while it is still running', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      stream: target.value,
    });
    let pushedDuringRun = -1;

    await pipeline.run((async function* () {
      yield sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-long-read',
        title: 'read',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'src/long-read.ts' },
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      pushedDuringRun = target.pushed.length;
      expect(target.pushed[0]?.toJSON?.().payload).toMatchObject({
        state: {
          input: expect.objectContaining({ filePath: 'src/long-read.ts' }),
          metadata: { dshPresentation: { card: 'read' } },
        },
      });
      yield sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-long-read',
        status: 'completed',
        rawOutput: 'content',
      });
      yield stop();
    })(), { isCancellationRequested: false });

    expect(pushedDuringRun).toBe(1);
    expect((target.pushed[0] as unknown as { kind?: string }).kind).toBe('toolInvocation');
  });

  it('renders an unknown bridge-free tool after the bounded bridge window', async () => {
    vi.useFakeTimers();
    try {
      const target = createStream();
      const pipeline = new DshPipeline({
        sessionId: 'session-1',
        stream: target.value,
      });
      let pushedDuringRun = -1;

      await pipeline.run((async function* () {
        yield sessionUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-unknown-long',
          title: 'custom-tool',
          kind: 'other',
          status: 'in_progress',
        });
        await vi.advanceTimersByTimeAsync(1_600);
        pushedDuringRun = target.pushed.length;
        yield sessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-unknown-long',
          status: 'completed',
          rawOutput: 'done',
        });
        yield stop();
      })(), { isCancellationRequested: false });

      expect(pushedDuringRun).toBe(1);
      expect((target.pushed[0] as unknown as { kind?: string }).kind).toBe('toolInvocation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides a generic placeholder when a late diff bridge arrives', async () => {
    vi.useFakeTimers();
    try {
      const target = createStream();
      const pipeline = new DshPipeline({
        sessionId: 'session-1',
        directory: 'D:/workspace',
        stream: target.value,
        permissionMode: 'full-edit',
      });
      const internals = pipeline as unknown as {
        handleSessionUpdate(update: never, eventSessionId: string): void;
      };
      internals.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-unknown-late-diff',
        title: 'custom-tool',
        kind: 'other',
        status: 'in_progress',
      } as never, 'session-1');
      await vi.advanceTimersByTimeAsync(1_600);
      expect(target.pushed).toHaveLength(1);

      pipeline.handleBridgeMessage({
        type: 'tool_call',
        protocol: 1,
        sessionId: 'session-1',
        toolCallId: 'call-unknown-late-diff',
        rootToolCallId: 'call-unknown-late-diff',
        toolName: 'custom-tool',
        presentation: {
          card: 'diff',
          title: 'Update src/late.ts',
          diffs: [{ path: 'src/late.ts', oldText: null, newText: 'new' }],
        },
      });
      expect(target.pushed[0]?.toJSON?.().payload?.state).toMatchObject({
        metadata: { externalEdit: true },
      });

      const responsePromise = pipeline.resolvePermission({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'call-unknown-late-diff' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      } as never);
      await Promise.resolve();
      expect(target.pushed.filter(part => (part as unknown as { kind?: string }).kind === 'externalEdit')).toHaveLength(1);
      const external = target.pushed[1] as unknown as {
        render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
      };
      external.render({
        externalEdit: (_uris, callback) => {
          void callback();
          return Promise.resolve('undo-stop');
        },
      });
      await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the standard ACP write input to start ExternalEdit without the bridge', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    const internals = pipeline as unknown as {
      handleSessionUpdate(update: never, eventSessionId: string): void;
    };
    internals.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-write-no-bridge',
      title: 'write',
      kind: 'other',
      status: 'in_progress',
      rawInput: { file_path: 'src/no-bridge.md', content: '# created\n' },
    } as never, 'session-1');

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-write-no-bridge' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();
    expect(target.pushed).toHaveLength(1);
    expect((target.pushed[0] as unknown as { kind?: string }).kind).toBe('externalEdit');

    const external = target.pushed[0] as unknown as {
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    external.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop');
      },
    });
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it.each([
    {
      toolName: 'write',
      rawInput: { file_path: 'src/no-bridge-write.md', content: '# created\n' },
    },
    {
      toolName: 'create',
      rawInput: { file_path: 'src/no-bridge-create.md', content: '# created\n' },
    },
    {
      toolName: 'edit',
      rawInput: { file_path: 'src/no-bridge-edit.md', old_string: 'before', new_string: 'after' },
    },
  ])('starts ExternalEdit before a bridge-free $toolName can complete', async ({ toolName, rawInput }) => {
    vi.useFakeTimers();
    try {
      const target = createStream();
      const pipeline = new DshPipeline({
        sessionId: 'session-1',
        directory: 'D:/workspace',
        stream: target.value,
        permissionMode: 'full-edit',
      });
      const internals = pipeline as unknown as {
        handleSessionUpdate(update: never, eventSessionId: string): void;
      };

      internals.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: `call-${toolName}-no-bridge`,
        title: toolName,
        kind: 'other',
        status: 'in_progress',
        rawInput,
      } as never, 'session-1');
      await vi.advanceTimersByTimeAsync(101);

      expect(target.pushed).toHaveLength(1);
      expect((target.pushed[0] as unknown as { kind?: string }).kind).toBe('externalEdit');

      internals.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: `call-${toolName}-no-bridge`,
        status: 'completed',
        rawOutput: 'done',
      } as never, 'session-1');

      expect(target.updated).toContainEqual(expect.objectContaining({
        id: `external-edit-call-${toolName}-no-bridge`,
        data: expect.objectContaining({ status: 'completed' }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses a bridge-free DSH read envelope into an OpenCode-style read card', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
    });

    await pipeline.run((async function* () {
      yield sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-no-bridge',
        title: 'read',
        kind: 'read',
        status: 'in_progress',
        rawInput: { file_path: 'src/no-bridge.ts', offset: 10, limit: 2 },
      });
      yield sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-no-bridge',
        status: 'completed',
        rawOutput: `<path>D:/workspace/src/no-bridge.ts</path>\n<type>file</type>\n<content>\n10: line ten\n11: line eleven\n\n(Showing lines 10-11 of 12. Use offset=12 to continue.)\n</content>`,
      });
      yield stop();
    })(), { isCancellationRequested: false });

    expect(target.pushed).toHaveLength(1);
    expect((target.pushed[0] as unknown as { kind?: string }).kind).toBe('toolInvocation');
    expect(target.pushed[0]?.toJSON?.().payload).toMatchObject({
      toolName: 'read',
      state: {
        input: expect.objectContaining({
          filePath: 'src/no-bridge.ts',
          offset: 10,
          limit: 2,
        }),
        metadata: {
          dshPresentation: {
            card: 'read',
            path: 'D:/workspace/src/no-bridge.ts',
            offset: 10,
            lines: [
              { number: 10, text: 'line ten' },
              { number: 11, text: 'line eleven' },
            ],
            totalLines: 12,
          },
        },
      },
    });
  });

  it('recovers a structured read card when a bridge result only carries ACP text content', () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
    });
    const internals = pipeline as unknown as {
      handleSessionUpdate(update: never, eventSessionId: string): void;
    };
    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-bridge-read',
      rootToolCallId: 'call-bridge-read',
      toolName: 'read',
      rawInput: { file_path: 'src/bridge-read.ts', offset: 2, limit: 1 },
      presentation: { card: 'generic', title: 'Read src/bridge-read.ts', kind: 'read' },
    });
    internals.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-bridge-read',
      title: 'read',
      kind: 'read',
      status: 'in_progress',
      rawInput: { file_path: 'src/bridge-read.ts', offset: 2, limit: 1 },
    } as never, 'session-1');
    pipeline.handleBridgeMessage({
      type: 'tool_result',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-bridge-read',
      rootToolCallId: 'call-bridge-read',
      toolName: 'read',
      isError: false,
      output: [{
        type: 'text',
        text: '<path>D:/workspace/src/bridge-read.ts</path>\n<type>file</type>\n<content>\n2: export const value = 1\n\n(End of file - total 2 lines)\n</content>',
      }],
    });

    expect(target.pushed[0]?.toJSON?.().payload).toMatchObject({
      toolName: 'read',
      state: {
        metadata: {
          dshPresentation: {
            card: 'read',
            path: 'D:/workspace/src/bridge-read.ts',
            lines: [{ number: 2, text: 'export const value = 1' }],
            totalLines: 2,
          },
        },
      },
    });
  });

  it('cleans deferred ExternalEdit correlation after terminal completion', async () => {
    const target = createStream();
    const pipeline = new DshPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });
    const internals = pipeline as unknown as {
      handleSessionUpdate(update: never, eventSessionId: string): void;
    };

    pipeline.handleBridgeMessage({
      type: 'tool_call',
      protocol: 1,
      sessionId: 'session-1',
      toolCallId: 'call-cleanup',
      rootToolCallId: 'call-cleanup',
      toolName: 'write',
      presentation: {
        card: 'diff',
        title: 'Write src/cleanup.ts',
        locations: [{ path: 'src/cleanup.ts', line: 1 }],
        diffs: [{ path: 'src/cleanup.ts', oldText: null, newText: 'new' }],
      },
    });
    internals.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-cleanup',
      title: 'write',
      status: 'in_progress',
    } as never, 'session-1');

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-cleanup' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();
    const firstExternal = target.pushed[0] as unknown as {
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    firstExternal.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop');
      },
    });
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    internals.handleSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-cleanup',
      status: 'completed',
    } as never, 'session-1');

    const secondResponsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-cleanup' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await Promise.resolve();
    expect(target.pushed.filter(part => (part as unknown as { kind?: string }).kind === 'externalEdit')).toHaveLength(2);
    const secondExternal = target.pushed[1] as unknown as {
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    secondExternal.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop-2');
      },
    });
    await expect(secondResponsePromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
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
