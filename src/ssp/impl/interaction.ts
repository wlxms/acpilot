/**
 * InteractionSSP — records permission/question interaction events.
 *
 * Two classes:
 * - InteractionRequestSSP (kind: 'interactionRequest') — permission.asked / question.asked
 * - InteractionResponseSSP (kind: 'interactionResponse') — permission.replied / question.replied / question.rejected
 *
 * Render: no-op (permissions are auto-approved by the Pipeline; questions are handled
 * via the Pipeline's questionCarousel. These SSPs exist for persistence/audit only.)
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type {
  InteractionRequestStreamPartPayload,
  InteractionResponseStreamPartPayload,
} from '../types';

export class InteractionRequestSSP extends SerializableStreamPart<
  'interactionRequest',
  InteractionRequestStreamPartPayload
> {
  readonly kind = 'interactionRequest' as const;

  render(_stream: SspStream): void {
    // No-op: audit only
  }
}

export class InteractionResponseSSP extends SerializableStreamPart<
  'interactionResponse',
  InteractionResponseStreamPartPayload
> {
  readonly kind = 'interactionResponse' as const;

  render(_stream: SspStream): void {
    // No-op: audit only
  }
}
