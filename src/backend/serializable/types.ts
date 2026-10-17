/**
 * Backend persistence types (session metadata).
 *
 * SSP-specific types are owned by src/ssp/types.ts.
 */

// ===========================================================================
// Backend persistence types
// ===========================================================================

export interface SerializableRequestDetails {
  turnIndex: number;
  vscodeRequestId: string;
  backendRequestId?: string;
  toolIdEditMap: Record<string, string>;
}

export type SessionTitleSource =
  | 'manual'
  | 'copilot-style'
  | 'backend'
  | 'history'
  | 'placeholder'
  | 'restore';

export interface SerializableSessionMeta {
  id: string;
  /** Backend instance that owns this session (for example `acp:<targetId>`). */
  backendInstanceKey?: string;
  title?: string;
  titleSource?: SessionTitleSource;
  titleUpdatedAt?: string;
  provisionalTitle?: boolean;
  createdAt?: string;
  backendName?: string;
  description?: string;
  changeSummary?: {
    files: number;
    additions?: number;
    deletions?: number;
    paths?: string[];
  };
  status?: 'completed' | 'inProgress' | 'needsInput' | 'failed';
  archived?: boolean;
  changeApprovalState?: 'none' | 'pending' | 'accepted' | 'rejected' | 'partial';
  checkpointCursor?: {
    acceptedThroughTurn: number;
    replayedThroughTurn?: number;
    lastConflictTurn?: number;
  };
  replaySummary?: {
    appliedFiles: number;
    skippedFiles: number;
    appliedHunks: number;
    skippedHunks: number;
    conflicts: Array<{ uri: string; reason: string; turnIndex?: number }>;
  };
  requestDetails?: SerializableRequestDetails[];
}
