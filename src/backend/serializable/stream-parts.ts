/**
 * Stream-part utility helpers for the SSP persistence layer.
 *
 * SSP is the sole persistence format and backends push SSPs directly. This
 * module contains the request metadata derivation consumed by restore:
 * {@link requestDetailsFromStreamParts}.
 *
 * @module
 */

import type { SerializableRequestDetails } from './types';
import type { ExternalEditStreamPartPayload, StreamPartRecord } from '../../ssp/types';

/**
 * Extract per-request edit tool→editId mappings from external-edit stream-part
 * records. Used during session restore to correlate checkpoints with the
 * VS Code external-edit undoStopIds that were persisted to meta.jsonl.
 *
 * `editId` arrives asynchronously (it is the undoStopId returned by VS Code's
 * externalEdit API) and is persisted to meta.jsonl via IMetadataProvider, not
 * to the stream-part record itself — hence the metaIndex fallback.
 */
export function requestDetailsFromStreamParts(
  parts: readonly StreamPartRecord[],
  metaIndex?: ReadonlyMap<string, Record<string, unknown>>,
): SerializableRequestDetails[] {
  const byRequest = new Map<string, SerializableRequestDetails>();

  for (const part of parts) {
    if (part.kind !== 'externalEdit') {
      continue;
    }
    const payload = part.payload as Partial<ExternalEditStreamPartPayload>;
    const toolCallId = payload.toolCallId ?? part.meta.toolCallId;
    let editId = payload.editId ?? part.meta.editId;

    // editId arrives asynchronously (undoStopId from VS Code externalEdit);
    // it is persisted to meta.jsonl via IMetadataProvider, not session.jsonl.
    // Fall back to meta.jsonl when the stream part record has an empty editId.
    if (!editId && metaIndex) {
      const partMeta = metaIndex.get(part.id);
      editId = (partMeta?.undoStopId as string | undefined) ?? (partMeta?.editId as string | undefined);
    }

    if (!toolCallId || !editId) {
      continue;
    }

    const key = `${part.meta.turnIndex}:${part.meta.requestId}`;
    const existing = byRequest.get(key);
    if (existing) {
      existing.toolIdEditMap[toolCallId] = editId;
      continue;
    }

    byRequest.set(key, {
      turnIndex: part.meta.turnIndex,
      vscodeRequestId: part.meta.requestId,
      toolIdEditMap: { [toolCallId]: editId },
    });
  }

  return [...byRequest.values()].sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
}
