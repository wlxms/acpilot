/**
 * ReasoningSSP — append-only AI reasoning/thinking output (delta-driven).
 *
 * Kind: 'reasoning'
 *
 * Each push creates a new instance carrying a reasoning delta.
 * render() outputs the delta to stream.thinkingProgress().
 * No update() — this part is immutable after construction.
 * Silently skips when thinkingProgress is unavailable (no markdown degradation).
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { ReasoningStreamPartPayload, SerializableStreamPartMeta } from '../types';

export class ReasoningSSP extends SerializableStreamPart<
  'reasoning',
  ReasoningStreamPartPayload
> {
  readonly kind = 'reasoning' as const;

  constructor(
    payload: {
      partId: string;
      delta: string;
      messageId?: string;
      sessionId?: string;
      thinkingId?: string;
      metadata?: Record<string, unknown>;
      isComplete?: boolean;
    },
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super({
      partId: payload.partId,
      text: payload.delta,
      messageId: payload.messageId,
      sessionId: payload.sessionId,
      thinkingId: payload.thinkingId,
      metadata: payload.metadata,
      isComplete: payload.isComplete,
    }, {
      ...meta,
      sessionId: meta?.sessionId ?? payload.sessionId,
      sourcePartId: meta?.sourcePartId ?? payload.partId,
    }, id);
  }

  render(stream: SspStream): void {
    if (!this.payload.text) {return;}

    const delta: { text: string; id?: string; metadata?: Record<string, unknown> } = {
      text: this.payload.text,
      id: this.payload.thinkingId ?? this.payload.partId,
    };
    const metadata = this.buildMetadata();
    if (metadata) {
      delta.metadata = metadata;
    }
    stream.thinkingProgress?.(delta);
  }

  private buildMetadata(): Record<string, unknown> | undefined {
    const metadata = {
      ...this.payload.metadata,
    };
    if (this.meta.sessionId && metadata.sessionId === undefined) {
      metadata.sessionId = this.meta.sessionId;
    }
    if (this.meta.parentSessionId && metadata.parentSessionId === undefined) {
      metadata.parentSessionId = this.meta.parentSessionId;
    }
    if (this.meta.subAgentInvocationId && metadata.subAgentInvocationId === undefined) {
      metadata.subAgentInvocationId = this.meta.subAgentInvocationId;
    }
    if (this.meta.parentSubAgentInvocationId && metadata.parentSubAgentInvocationId === undefined) {
      metadata.parentSubAgentInvocationId = this.meta.parentSubAgentInvocationId;
    }
    if (this.meta.subAgentPath && metadata.subAgentPath === undefined) {
      metadata.subAgentPath = this.meta.subAgentPath;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }
}
