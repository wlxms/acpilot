import { describe, expect, it } from 'vitest';
import {
  projectStreamPartToAcpEvent,
  requestDetailsFromStreamParts,
  SerializableStreamPartEventHandler,
} from '../../backend/serializable/stream-parts';
import type { AcpEvent } from '../../backend/types';
import type { SerializableStreamPart } from '../../backend/serializable/types';

describe('SerializableStreamPartEventHandler', () => {
  it('maps the first prompt text event to userPrompt and projects it back', () => {
    const handler = new SerializableStreamPartEventHandler({
      turnIndex: 0,
      requestId: 'request-0',
      prompt: 'Edit hello.txt',
    });
    const event: AcpEvent = {
      type: 'part.updated',
      part: { type: 'text', id: 'user-part', text: 'Edit hello.txt', messageId: 'msg-user' },
    };

    const parts = handler.serializeEvent(event);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual(expect.objectContaining({
      kind: 'userPrompt',
      payload: {
        text: 'Edit hello.txt',
        partId: 'user-part',
        messageId: 'msg-user',
      },
      meta: expect.objectContaining({
        turnIndex: 0,
        requestId: 'request-0',
        sourceType: 'part.updated',
        sourcePartId: 'user-part',
      }),
    }));
    expect(projectStreamPartToAcpEvent(parts[0])).toEqual(event);
  });

  it('maps text and reasoning deltas according to the known part kind', () => {
    const handler = new SerializableStreamPartEventHandler({
      turnIndex: 1,
      requestId: 'request-1',
      prompt: 'Question',
    });

    handler.serializeEvent({
      type: 'part.updated',
      part: { type: 'reasoning', id: 'reasoning-1', text: '', messageId: 'msg-assistant' },
    });
    const reasoningDelta = handler.serializeEvent({
      type: 'part.delta',
      partId: 'reasoning-1',
      delta: 'thinking',
      field: 'text',
    })[0];
    const textDelta = handler.serializeEvent({
      type: 'part.delta',
      partId: 'text-1',
      delta: 'hello',
      field: 'text',
    })[0];

    expect(reasoningDelta.kind).toBe('reasoningDelta');
    expect(projectStreamPartToAcpEvent(reasoningDelta)).toEqual({
      type: 'part.delta',
      partId: 'reasoning-1',
      delta: 'thinking',
      field: 'text',
    });
    expect(textDelta.kind).toBe('assistantTextDelta');
    expect(projectStreamPartToAcpEvent(textDelta)).toEqual({
      type: 'part.delta',
      partId: 'text-1',
      delta: 'hello',
      field: 'text',
    });
  });

  it('preserves event-level sessionId through text, reasoning, and delta records', () => {
    const handler = new SerializableStreamPartEventHandler({
      turnIndex: 1,
      requestId: 'request-session',
      prompt: 'Question',
    });

    const reasoning = handler.serializeEvent({
      type: 'part.updated',
      sessionId: 'ses_child',
      part: { type: 'reasoning', id: 'reasoning-1', text: '', messageId: 'msg-assistant' },
    })[0];
    const reasoningDelta = handler.serializeEvent({
      type: 'part.delta',
      sessionId: 'ses_child',
      partId: 'reasoning-1',
      delta: 'thinking',
      field: 'text',
    })[0];
    const text = handler.serializeEvent({
      type: 'part.updated',
      sessionId: 'ses_child',
      part: { type: 'text', id: 'text-1', text: '', messageId: 'msg-assistant' },
    })[0];
    const textDelta = handler.serializeEvent({
      type: 'part.delta',
      sessionId: 'ses_child',
      partId: 'text-1',
      delta: 'answer',
      field: 'text',
    })[0];

    expect(reasoning.meta.sessionId).toBe('ses_child');
    expect(text.meta.sessionId).toBe('ses_child');
    expect(projectStreamPartToAcpEvent(reasoning)).toEqual(expect.objectContaining({
      type: 'part.updated',
      sessionId: 'ses_child',
      part: expect.objectContaining({ sessionId: 'ses_child' }),
    }));
    expect(projectStreamPartToAcpEvent(reasoningDelta)).toEqual(expect.objectContaining({
      type: 'part.delta',
      sessionId: 'ses_child',
    }));
    expect(projectStreamPartToAcpEvent(text)).toEqual(expect.objectContaining({
      type: 'part.updated',
      sessionId: 'ses_child',
      part: expect.objectContaining({ sessionId: 'ses_child' }),
    }));
    expect(projectStreamPartToAcpEvent(textDelta)).toEqual(expect.objectContaining({
      type: 'part.delta',
      sessionId: 'ses_child',
    }));
  });

  it('maps tool invocations and interaction requests to concept parts', () => {
    const handler = new SerializableStreamPartEventHandler({
      turnIndex: 0,
      requestId: 'request-0',
      prompt: 'Edit file',
    });

    const toolPart = handler.serializeEvent({
      type: 'part.updated',
      part: {
        type: 'tool',
        id: 'tool-part',
        toolName: 'edit',
        callId: 'call-edit',
        state: { status: 'completed', input: { filePath: 'a.txt' }, output: 'ok' },
      },
    } as AcpEvent)[0];
    const permissionPart = handler.serializeEvent({
      type: 'permission.asked',
      permissionId: 'perm-1',
      sessionId: 'ses-1',
      permission: 'edit',
      patterns: ['a.txt'],
      metadata: { filepath: 'a.txt' },
      always: [],
      tool: { messageId: 'msg-tool', callId: 'call-edit' },
    })[0];

    expect(toolPart.kind).toBe('toolInvocation');
    expect(toolPart.meta.toolCallId).toBe('call-edit');
    expect(projectStreamPartToAcpEvent(toolPart)).toEqual(expect.objectContaining({
      type: 'part.updated',
      part: expect.objectContaining({ type: 'tool', callId: 'call-edit' }),
    }));
    expect(permissionPart.kind).toBe('interactionRequest');
    expect(permissionPart.meta.toolCallId).toBe('call-edit');
    expect(projectStreamPartToAcpEvent(permissionPart)).toEqual(expect.objectContaining({
      type: 'permission.asked',
      permissionId: 'perm-1',
    }));
  });

  it('extracts request details from external edit stream part metadata', () => {
    const part: SerializableStreamPart = {
      kind: 'externalEdit',
      version: 1,
      id: 'ssp-0-4',
      payload: { toolCallId: 'tool-1', editId: 'undo-1' },
      meta: {
        turnIndex: 0,
        requestId: 'request-live-0',
        sequence: 4,
        createdAt: '2026-06-13T00:00:00.000Z',
        source: 'synthetic',
        sourceType: 'externalEdit',
        toolCallId: 'tool-1',
        editId: 'undo-1',
      },
    };

    expect(requestDetailsFromStreamParts([part])).toEqual([
      {
        turnIndex: 0,
        vscodeRequestId: 'request-live-0',
        toolIdEditMap: { 'tool-1': 'undo-1' },
      },
    ]);
  });
});
