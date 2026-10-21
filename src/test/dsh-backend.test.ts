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
