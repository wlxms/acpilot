/**
 * ACP persistence types (session metadata, file snapshots).
 *
 * SSP-specific types (StreamPartRecord, payloads, SerializableStreamPart class)
 * have been migrated to src/ssp/types.ts — ACP re-exports them for backward
 * compatibility.
 */

// ===========================================================================
// ACP-specific persistence types
// ===========================================================================

export interface FileSnapshotRecord {
  uri: string;
  content: string;
  phase?: 'before' | 'after';
  turnIndex?: number;
  editIndex: number;
  toolCallId: string;
  timestamp: string;
  missing?: boolean;
  undoStopId?: string;
}

export interface SerializableRequestDetails {
  turnIndex?: number;
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
  | 'restore'
  | 'legacy';

export interface SerializableSessionMeta {
  id: string;
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

// ===========================================================================
// Re-export SSP-owned types for backward compatibility
// (Existing code importing from 'acp/serializable/types' still works.
//  New code should import directly from 'ssp/types'.)
// ===========================================================================

export type {
  StreamPartRecord as SerializableStreamPart,
  SerializableStreamPartKind,
  SerializableStreamPartMeta,
  KnownSerializableStreamPart,
  RawAcpEventStreamPartPayload,
  RawAcpEventStreamPart,
  UserPromptStreamPartPayload,
  AssistantTextStreamPartPayload,
  AssistantTextDeltaStreamPartPayload,
  ReasoningStreamPartPayload,
  ReasoningDeltaStreamPartPayload,
  SerializableToolState,
  ToolInvocationStreamPartPayload,
  SessionLifecycleStreamPartPayload,
  SessionDiffStreamPartPayload,
  InteractionRequestStreamPartPayload,
  InteractionResponseStreamPartPayload,
  ExternalEditStreamPartPayload,
} from '../../ssp/types';
