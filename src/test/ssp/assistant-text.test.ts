import { describe, it, expect, vi } from 'vitest';
import type { SspStream } from '../../ssp/types';
import { SerializableStreamPart, isMutable } from '../../ssp/types';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';

function mockStream(): SspStream {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
  };
}

describe('AssistantTextSSP', () => {
  describe('construction', () => {
    it('should initialize with partId and delta as text', () => {
      const ssp = new AssistantTextSSP({ partId: 'p1', delta: 'hello' });
      expect(ssp.kind).toBe('assistantText');
      expect(ssp.version).toBe(1);
      expect(ssp.payload).toEqual({ partId: 'p1', text: 'hello', messageId: undefined });
    });
  });

  describe('render', () => {
    it('should call stream.markdown with the delta text', () => {
      const stream = mockStream();
      const ssp = new AssistantTextSSP({ partId: 'p1', delta: 'hello' });
      ssp.render(stream);
      expect(stream.markdown).toHaveBeenCalledWith('hello');
    });
  });

  describe('append-only contract', () => {
    it('should NOT implement IMutableStreamPart (no update)', () => {
      const ssp = new AssistantTextSSP({ partId: 'p1', delta: 'hello' });
      expect(isMutable(ssp)).toBe(false);
    });
  });

  describe('toJSON', () => {
    it('should produce assistantText kind with correct payload', () => {
      const ssp = new AssistantTextSSP(
        { partId: 'p1', delta: 'hello', messageId: 'm1' },
        { turnIndex: 0 },
      );
      const json = ssp.toJSON();
      expect(json.kind).toBe('assistantText');
      expect(json.version).toBe(1);
      expect(json.payload).toEqual({ partId: 'p1', text: 'hello', messageId: 'm1' });
      expect(json.meta.turnIndex).toBe(0);
    });
  });

  describe('instanceof', () => {
    it('should be instanceof SerializableStreamPart', () => {
      const ssp = new AssistantTextSSP({ partId: 'p1', delta: '' });
      expect(ssp).toBeInstanceOf(SerializableStreamPart);
    });
  });
});
