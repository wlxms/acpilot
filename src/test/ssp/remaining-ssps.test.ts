import { describe, it, expect, vi } from 'vitest';
import type { SspStream } from '../../ssp/types';
import { SerializableStreamPart, isMutable, isMetadataProvider } from '../../ssp/types';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { SubagentManager } from '../../ssp/impl/subagent';
import { SessionLifecycleSSP, SessionDiffSSP } from '../../ssp/impl/session-lifecycle';
import { InteractionRequestSSP, InteractionResponseSSP } from '../../ssp/impl/interaction';
import { OpaqueEventSSP } from '../../ssp/impl/opaque-event';

function mockStream(): SspStream {
  return { markdown: vi.fn(), progress: vi.fn(), push: vi.fn() };
}

// ===========================================================================
// ExternalEditSSP
// ===========================================================================

describe('ExternalEditSSP', () => {
  it('should be instanceof SerializableStreamPart', () => {
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '' });
    expect(ssp).toBeInstanceOf(SerializableStreamPart);
  });

  it('should implement IMutableStreamPart', () => {
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '' });
    expect(isMutable(ssp)).toBe(true);
  });

  it('should implement IMetadataProvider', () => {
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '' });
    expect(isMetadataProvider(ssp)).toBe(true);
  });

  it('getMetadata should return undefined when no undoStopId', () => {
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '', status: 'pending' });
    expect(ssp.getMetadata()).toBeUndefined();
  });

  it('render should be no-op when status is not pending', () => {
    const stream = mockStream();
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '', status: 'completed' });
    ssp.render(stream);
    expect(stream.push).not.toHaveBeenCalled();
  });

  it('render should be no-op when stream has no externalEdit', () => {
    const stream = mockStream();
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '', status: 'pending', uri: '/test.ts' });
    ssp.render(stream);
    // stream.externalEdit doesn't exist on mockStream → no-op
    expect(stream.push).not.toHaveBeenCalled();
  });

  it('update should merge data without emitStateChange', () => {
    const ssp = new ExternalEditSSP({ toolCallId: 'c1', editId: '', status: 'pending' });
    ssp.update({ status: 'completed' });
    expect(ssp.payload.status).toBe('completed');
  });
});

// ===========================================================================
// SessionLifecycleSSP
// ===========================================================================

describe('SessionLifecycleSSP', () => {
  it('should render error via progress', () => {
    const stream = mockStream();
    const ssp = new SessionLifecycleSSP({
      eventType: 'session.error',
      error: 'Something broke',
    });
    ssp.render(stream);
    expect(stream.progress).toHaveBeenCalledWith('⚠️ Something broke');
  });

  it('should NOT render non-error events', () => {
    const stream = mockStream();
    const ssp = new SessionLifecycleSSP({
      eventType: 'session.idle',
    });
    ssp.render(stream);
    expect(stream.progress).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// SessionDiffSSP (append-only)
// ===========================================================================

describe('SessionDiffSSP', () => {
  it('should NOT implement IMutableStreamPart', () => {
    const ssp = new SessionDiffSSP({ sessionId: 's1', diffs: [] });
    expect(isMutable(ssp)).toBe(false);
  });

  it('render should be no-op', () => {
    const stream = mockStream();
    const ssp = new SessionDiffSSP({ sessionId: 's1', diffs: [{ file: 'a.ts' }] });
    ssp.render(stream);
    expect(stream.push).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// InteractionRequestSSP / InteractionResponseSSP
// ===========================================================================

describe('InteractionRequestSSP', () => {
  it('render should be no-op (audit only)', () => {
    const stream = mockStream();
    const ssp = new InteractionRequestSSP({
      interactionType: 'permission',
      permissionId: 'p1',
    });
    ssp.render(stream);
    expect(stream.push).not.toHaveBeenCalled();
  });
});

describe('InteractionResponseSSP', () => {
  it('render should be no-op (audit only)', () => {
    const stream = mockStream();
    const ssp = new InteractionResponseSSP({
      interactionType: 'permission',
      eventType: 'permission.replied',
    });
    ssp.render(stream);
    expect(stream.push).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// OpaqueEventSSP
// ===========================================================================

describe('OpaqueEventSSP', () => {
  it('render should be no-op', () => {
    const stream = mockStream();
    const ssp = new OpaqueEventSSP({ event: { type: 'unknown.event', data: 'test' } });
    ssp.render(stream);
    expect(stream.push).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// SubagentManager (unchanged — pure state tracking, no SSP)
// ===========================================================================

describe('SubagentManager', () => {
  it('should start and complete a subagent scope', () => {
    const mgr = new SubagentManager();
    const scope = mgr.startSubagent('call1', { toolName: 'task', title: 'Task', input: {} });
    expect(scope.callId).toBe('call1');
    expect(scope.completed).toBe(false);

    mgr.recordChildToolCall('call1', { name: 'read', status: 'completed' });
    mgr.completeSubagent('call1', 'result text');
    expect(mgr.getScope('call1')?.completed).toBe(true);
    expect(mgr.getScope('call1')?.output).toBe('result text');
  });

  it('hasBusyDescendant should reflect active scopes', () => {
    const mgr = new SubagentManager();
    expect(mgr.hasBusyDescendant()).toBe(false);

    mgr.startSubagent('call1', { toolName: 'task', title: 'Task', input: {} });
    expect(mgr.hasBusyDescendant()).toBe(true);

    mgr.completeSubagent('call1');
    mgr.markChildIdle('call1');
    expect(mgr.hasBusyDescendant()).toBe(false);
  });
});
