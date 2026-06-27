import type { FileSnapshotRecord, SerializableSessionMeta } from '../serializable/types';

export interface CheckpointApproval {
  acceptedThroughTurn: number;
  pendingSnapshots: FileSnapshotRecord[];
  pendingTurns: number[];
  changeApprovalState: NonNullable<SerializableSessionMeta['changeApprovalState']>;
}

export function normalizeAcceptedThroughTurn(meta?: SerializableSessionMeta): number {
  const value = meta?.checkpointCursor?.acceptedThroughTurn;
  return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

export function snapshotTurnIndex(snapshot: FileSnapshotRecord): number {
  return typeof snapshot.turnIndex === 'number' && Number.isFinite(snapshot.turnIndex)
    ? snapshot.turnIndex
    : 0;
}

export function getPendingSnapshots(
  snapshots: readonly FileSnapshotRecord[],
  acceptedThroughTurn: number,
): FileSnapshotRecord[] {
  return snapshots.filter((snapshot) => snapshotTurnIndex(snapshot) > acceptedThroughTurn);
}

export function getCheckpointApproval(
  snapshots: readonly FileSnapshotRecord[],
  meta?: SerializableSessionMeta,
): CheckpointApproval {
  const acceptedThroughTurn = normalizeAcceptedThroughTurn(meta);
  const pendingSnapshots = getPendingSnapshots(snapshots, acceptedThroughTurn);
  const pendingTurns = Array.from(new Set(pendingSnapshots.map(snapshotTurnIndex))).sort((a, b) => a - b);

  let changeApprovalState = meta?.changeApprovalState;
  if (!changeApprovalState) {
    changeApprovalState = pendingSnapshots.length > 0
      ? 'pending'
      : snapshots.length > 0
        ? 'accepted'
        : 'none';
  }

  return {
    acceptedThroughTurn,
    pendingSnapshots,
    pendingTurns,
    changeApprovalState,
  };
}

export function markAcceptedThroughTurn(
  meta: SerializableSessionMeta,
  turnIndex: number,
): SerializableSessionMeta {
  return {
    ...meta,
    changeApprovalState: 'accepted',
    checkpointCursor: {
      ...meta.checkpointCursor,
      acceptedThroughTurn: Math.max(normalizeAcceptedThroughTurn(meta), turnIndex),
      replayedThroughTurn: turnIndex,
    },
  };
}
