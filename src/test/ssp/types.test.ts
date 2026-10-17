import { describe, it, expect, vi } from 'vitest';
import type { SspStream } from '../../ssp/types';
import {
  SerializableStreamPart,
  isMutable,
  isMutableKind,
  isMetadataProvider,
} from '../../ssp/types';
import type { StreamPartRecord } from '../../ssp/types';

// ---------------------------------------------------------------------------
// Test subclass (concrete implementation for testing abstract base)
// ---------------------------------------------------------------------------

interface TestPayload {
  text: string;
  count?: number;
}

class TestSSP extends SerializableStreamPart<'testKind', TestPayload> {
  readonly kind = 'testKind' as const;
  public renderCalled = 0;

  render(stream: SspStream): void {
    this.renderCalled++;
    stream.markdown(this.payload.text);
  }
}

class TestMutableSSP extends SerializableStreamPart<'testMutable', TestPayload>
  implements IMutableStreamPart<TestPayload> {
  readonly kind = 'testMutable' as const;

  update(data: Partial<TestPayload>): void {
    Object.assign(this.payload, data);
  }

  render(_stream: SspStream): void {}
}

import type { IMutableStreamPart, IMetadataProvider } from '../../ssp/types';

// ---------------------------------------------------------------------------

function mockStream(): SspStream {
  return { markdown: vi.fn(), progress: vi.fn(), push: vi.fn() };
}

// ---------------------------------------------------------------------------

describe('SerializableStreamPart (base class)', () => {
  describe('construction', () => {
    it('should initialize with payload, meta defaults, and unique id', () => {
      const ssp = new TestSSP({ text: 'hello' });
      expect(ssp.kind).toBe('testKind');
      expect(ssp.version).toBe(1);
      expect(ssp.id).toMatch(/^ssp-/);
      expect(ssp.payload).toEqual({ text: 'hello' });
      expect(ssp.meta.turnIndex).toBe(0);
      expect(ssp.meta.sequence).toBe(0);
      expect(ssp.meta.requestId).toBe('');
      expect(ssp.meta.source).toBe('backend-event');
      expect(ssp.meta.createdAt).toBeTruthy();
    });

    it('should accept partial meta overrides', () => {
      const ssp = new TestSSP(
        { text: 'hi' },
        { turnIndex: 3, requestId: 'req-1', source: 'synthetic' },
      );
      expect(ssp.meta.turnIndex).toBe(3);
      expect(ssp.meta.requestId).toBe('req-1');
      expect(ssp.meta.source).toBe('synthetic');
    });

    it('should accept explicit id', () => {
      const ssp = new TestSSP({ text: 'x' }, {}, 'custom-id-123');
      expect(ssp.id).toBe('custom-id-123');
    });
  });

  describe('render', () => {
    it('should output to stream when render is called', () => {
      const ssp = new TestSSP({ text: 'initial' });
      const stream = mockStream();
      ssp.render(stream);
      expect(ssp.renderCalled).toBe(1);
      expect(stream.markdown).toHaveBeenCalledWith('initial');
    });

    it('should not render before render() is called', () => {
      const ssp = new TestSSP({ text: 'pending' });
      expect(ssp.renderCalled).toBe(0);
    });
  });

  describe('toJSON (serialization contract)', () => {
    it('should produce shape matching StreamPartRecord', () => {
      const ssp = new TestSSP(
        { text: 'data', count: 42 },
        { turnIndex: 1, requestId: 'req-9' },
      );
      const json = ssp.toJSON();
      expect(json).toHaveProperty('kind');
      expect(json).toHaveProperty('version');
      expect(json).toHaveProperty('id');
      expect(json).toHaveProperty('payload');
      expect(json).toHaveProperty('meta');
      expect(json.kind).toBe('testKind');
      expect(json.version).toBe(1);
      expect(json.payload).toEqual({ text: 'data', count: 42 });
      expect(json.meta.turnIndex).toBe(1);
    });

    it('should round-trip through JSON', () => {
      const ssp = new TestSSP({ text: 'round-trip' }, { turnIndex: 2 });
      const json = ssp.toJSON();
      const parsed = JSON.parse(JSON.stringify(json));
      expect(parsed.kind).toBe('testKind');
      expect(parsed.payload.text).toBe('round-trip');
      expect(parsed.meta.turnIndex).toBe(2);
    });
  });

  describe('onStateChange', () => {
    it('should notify listeners when emitStateChange is called', () => {
      const ssp = new TestSSP({ text: 'x' });
      const cb = vi.fn();
      const unsub = ssp.onStateChange(cb);
      (ssp as any).emitStateChange();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(ssp);

      unsub();
      (ssp as any).emitStateChange();
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});

describe('IMutableStreamPart type guard', () => {
  it('isMutable should return true for mutable parts', () => {
    const ssp = new TestMutableSSP({ text: 'x' });
    expect(isMutable(ssp)).toBe(true);
  });

  it('isMutable should return false for append-only parts', () => {
    const ssp = new TestSSP({ text: 'x' });
    expect(isMutable(ssp)).toBe(false);
  });

  it('isMutableKind should identify mutable kinds', () => {
    expect(isMutableKind('toolInvocation')).toBe(true);
    expect(isMutableKind('question')).toBe(true);
    expect(isMutableKind('externalEdit')).toBe(true);
    expect(isMutableKind('sessionLifecycle')).toBe(false);  // does NOT implement IMutableStreamPart
    expect(isMutableKind('reasoning')).toBe(false);
    expect(isMutableKind('assistantText')).toBe(false);
    expect(isMutableKind('userPrompt')).toBe(false);
  });
});

describe('IMetadataProvider type guard', () => {
  it('isMetadataProvider should return true for parts with getMetadata', () => {
    const ssp = new (class extends TestSSP {
      get metaId() { return this.id; }
      getMetadata() { return { foo: 'bar' }; }
    })({ text: 'x' });
    expect(isMetadataProvider(ssp)).toBe(true);
  });

  it('isMetadataProvider should return false for parts without getMetadata', () => {
    const ssp = new TestSSP({ text: 'x' });
    expect(isMetadataProvider(ssp)).toBe(false);
  });
});
