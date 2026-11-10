import { SerializableStreamPart, type SerializableStreamPartMeta, type SspStream } from '../types';
import { dshViewFence, parseDshRichView, type DshRichView } from '../../chat-rendering/protocol';

export class RichViewSSP extends SerializableStreamPart<'richView', DshRichView> {
  readonly kind = 'richView' as const;
  constructor(
    payload: { partId: string; view: DshRichView; sessionId?: string; toolCallId?: string; parentSessionId?: string; subAgentInvocationId?: string },
    meta?: Partial<SerializableStreamPartMeta>, id?: string,
  ) {
    const view = parseDshRichView(payload.view);
    if (!view) { throw new Error('Invalid DSH renderer envelope'); }
    super(view, { ...meta, sourcePartId: meta?.sourcePartId ?? payload.partId,
      sessionId: meta?.sessionId ?? payload.sessionId, toolCallId: meta?.toolCallId ?? payload.toolCallId,
      parentSessionId: meta?.parentSessionId ?? payload.parentSessionId,
      subAgentInvocationId: meta?.subAgentInvocationId ?? payload.subAgentInvocationId }, id ?? payload.partId);
  }
  render(stream: SspStream): void {
    if (stream.richView) { stream.richView(this.payload, this.meta); }
    else { stream.markdown(dshViewFence(this.payload)); }
  }
}
