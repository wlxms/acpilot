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
});
