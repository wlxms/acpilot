import { describe, expect, it, vi } from 'vitest';
import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import type { BackendPipelineStream } from '../backend/backend';
import { AcpPipeline } from '../backends/acp/pipeline';

function stream() {
  const pushed: Array<{ toJSON?: () => { payload?: { state?: { status?: string } } } }> = [];
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    pushed,
    updated,
    value: {
      push: vi.fn((part: { toJSON?: () => { payload?: { state?: { status?: string } } } }) => {
        pushed.push(part);
      }),
      update: vi.fn((id: string, data: Record<string, unknown>) => {
        updated.push({ id, data });
      }),
      writeMeta: vi.fn(),
      updateTitle: vi.fn(),
    } as unknown as BackendPipelineStream,
  };
}

function stop(reason: string): ActiveSessionMessage {
  return {
    kind: 'stop',
    response: { stopReason: reason },
    stopReason: reason,
  } as ActiveSessionMessage;
}

function update(update: Record<string, unknown>): ActiveSessionMessage {
  return {
    kind: 'session_update',
    notification: { sessionId: 'session-1', update },
    update,
  } as never;
}

describe('AcpPipeline', () => {
  it.each([
    ['end_turn', true, 'completed'],
    ['max_tokens', true, 'completed'],
    ['max_turn_requests', true, 'completed'],
    ['refusal', false, 'failed'],
    ['cancelled', false, 'failed'],
  ])('maps stopReason %s to completed=%s and status=%s', async (reason, completed, status) => {
    const target = stream();
    const pipeline = new AcpPipeline({ sessionId: 'session-1', stream: target.value });

    await expect(pipeline.run((async function* () {
      yield stop(reason);
    })(), { isCancellationRequested: false })).resolves.toMatchObject({ completed });
    expect(target.value.writeMeta).toHaveBeenCalledWith({ status });
  });

  it('applies the terminal status when the first tool event is an update', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({ sessionId: 'session-1', stream: target.value });

    await pipeline.run((async function* () {
      yield update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'failed',
        title: 'read',
        rawInput: { path: 'missing.txt' },
        rawOutput: 'not found',
      });
      yield stop('end_turn');
    })(), { isCancellationRequested: false });

    expect(target.pushed).toHaveLength(1);
    expect(target.pushed[0].toJSON?.().payload?.state?.status).toBe('error');
  });

  it('preserves tool status when an update omits the optional status', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({ sessionId: 'session-1', stream: target.value });

    await pipeline.run((async function* () {
      yield update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'read',
        status: 'completed',
        rawInput: { path: 'package.json' },
      });
      yield update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        rawOutput: 'contents',
      });
      yield stop('end_turn');
    })(), { isCancellationRequested: false });

    expect(target.updated).toHaveLength(1);
    expect(target.updated[0]).toMatchObject({
      id: 'call-1',
      data: { state: { status: 'completed', output: 'contents' } },
    });
  });

  it('rejects mutating permission requests in read-only mode before rendering approval UI', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({
      sessionId: 'session-1',
      stream: target.value,
      permissionMode: 'read-only',
    });

    const response = await pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-edit',
        kind: 'edit',
        title: 'Edit file',
        rawInput: { path: 'src/index.ts' },
      },
      options: [{
        optionId: 'allow-once',
        name: 'Allow once',
        kind: 'allow_once',
      }],
    } as never);

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(target.value.push).not.toHaveBeenCalled();
  });

  it('automatically selects a request-scoped allow option in full-edit mode', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({
      sessionId: 'session-1',
      stream: target.value,
      permissionMode: 'full-edit',
    });

    const response = await pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-edit',
        kind: 'edit',
        title: 'Edit file',
        rawInput: { command: 'echo hello' },
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      ],
    } as never);

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(target.value.push).not.toHaveBeenCalled();
  });

  it('automatically selects a request-scoped allow option for non-interactive LM turns', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({
      sessionId: 'session-1',
      stream: target.value,
      permissionMode: 'approval',
      allowUserInteraction: false,
    });

    const response = await pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-bash',
        kind: 'execute',
        title: 'Run command',
        rawInput: { command: 'echo hello' },
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(target.value.push).not.toHaveBeenCalled();
  });

  it('waits for the ExternalEdit baseline before auto-allowing a file edit', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({
      sessionId: 'session-1',
      directory: 'D:/workspace',
      stream: target.value,
      permissionMode: 'full-edit',
    });

    const responsePromise = pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-edit-file',
        kind: 'edit',
        title: 'Edit file',
        rawInput: { path: 'src/index.ts' },
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    await Promise.resolve();
    expect(target.pushed).toHaveLength(1);

    let settled = false;
    void responsePromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const externalEdit = target.pushed[0] as unknown as {
      render(stream: { externalEdit(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string> }): void;
    };
    externalEdit.render({
      externalEdit: (_uris, callback) => {
        void callback();
        return Promise.resolve('undo-stop');
      },
    });

    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('automatically allows read-only tools without rendering approval UI', async () => {
    const target = stream();
    const pipeline = new AcpPipeline({
      sessionId: 'session-1',
      stream: target.value,
      permissionMode: 'read-only',
    });

    const response = await pipeline.resolvePermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-read',
        kind: 'read',
        title: 'Read file',
        rawInput: { path: 'src/index.ts' },
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(target.value.push).not.toHaveBeenCalled();
  });
});
