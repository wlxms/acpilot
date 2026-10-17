/**
 * OpaqueEventSSP — lossless fallback for unrecognized backend events.
 *
 * Kind: 'opaqueEvent'
 *
 * Unknown backend event payloads can be wrapped here without leaking a
 * specific backend protocol into the SSP contract.
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { OpaqueEventStreamPartPayload, SerializableStreamPartMeta } from '../types';

export class OpaqueEventSSP extends SerializableStreamPart<
  'opaqueEvent',
  OpaqueEventStreamPartPayload
> {
  readonly kind = 'opaqueEvent' as const;

  constructor(
    payload: OpaqueEventStreamPartPayload,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super(payload, meta, id);
  }

  render(_stream: SspStream): void {
    // No-op: cannot predict how to render unknown events.
  }
}
