/**
 * UserPromptSSP — append-only user message (for persistence/replay only).
 *
 * Kind: 'userPrompt'
 *
 * render() is a no-op — VS Code natively displays user messages.
 * This SSP exists solely so the user's prompt is serialized to session.jsonl
 * and can be reconstructed as a ChatRequestTurn during session restore.
 *
 * Pushed by handler before pipeline.run().
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { SerializableStreamPartMeta, UserPromptStreamPartPayload } from '../types';

export class UserPromptSSP extends SerializableStreamPart<
  'userPrompt',
  UserPromptStreamPartPayload
> {
  readonly kind = 'userPrompt' as const;

  constructor(
    payload: { text: string; partId?: string; command?: string; messageId?: string; sessionId?: string },
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super({
      text: payload.text,
      partId: payload.partId,
      messageId: payload.messageId,
      sessionId: payload.sessionId,
      command: payload.command,
    }, {
      ...meta,
      sessionId: meta?.sessionId ?? payload.sessionId,
      sourcePartId: meta?.sourcePartId ?? payload.partId,
    }, id);
  }

  render(_stream: SspStream): void {
    // No-op — VS Code renders user messages natively
  }
}
