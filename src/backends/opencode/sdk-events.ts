import type {
  EventSubscribeResponse,
  FilePart,
} from '@opencode-ai/sdk/v2';

/** Real SSE event types from the OpenCode server */

// Server lifecycle
export const EVENT_SERVER_CONNECTED = 'server.connected' as const;
export const EVENT_SERVER_HEARTBEAT = 'server.heartbeat' as const;

// Message events
export const EVENT_MESSAGE_UPDATED = 'message.updated' as const;
export const EVENT_MESSAGE_PART_UPDATED = 'message.part.updated' as const;
export const EVENT_MESSAGE_PART_DELTA = 'message.part.delta' as const;
export const EVENT_MESSAGE_REMOVED = 'message.removed' as const;

// Session events
export const EVENT_SESSION_CREATED = 'session.created' as const;
export const EVENT_SESSION_UPDATED = 'session.updated' as const;
export const EVENT_SESSION_DELETED = 'session.deleted' as const;
export const EVENT_SESSION_STATUS = 'session.status' as const;
export const EVENT_SESSION_DIFF = 'session.diff' as const;
export const EVENT_SESSION_ERROR = 'session.error' as const;
export const EVENT_SESSION_IDLE = 'session.idle' as const;

// Permission events
export const EVENT_PERMISSION_ASKED = 'permission.asked' as const;
export const EVENT_PERMISSION_REPLIED = 'permission.replied' as const;

// Question events
export const EVENT_QUESTION_ASKED = 'question.asked' as const;
export const EVENT_QUESTION_REPLIED = 'question.replied' as const;
export const EVENT_QUESTION_REJECTED = 'question.rejected' as const;

/** All known real event type strings */
export type RealEventType =
  | typeof EVENT_SERVER_CONNECTED
  | typeof EVENT_SERVER_HEARTBEAT
  | typeof EVENT_MESSAGE_UPDATED
  | typeof EVENT_MESSAGE_PART_UPDATED
  | typeof EVENT_MESSAGE_PART_DELTA
  | typeof EVENT_MESSAGE_REMOVED
  | typeof EVENT_SESSION_CREATED
  | typeof EVENT_SESSION_UPDATED
  | typeof EVENT_SESSION_DELETED
  | typeof EVENT_SESSION_STATUS
  | typeof EVENT_SESSION_DIFF
  | typeof EVENT_SESSION_ERROR
  | typeof EVENT_SESSION_IDLE
  | typeof EVENT_PERMISSION_ASKED
  | typeof EVENT_PERMISSION_REPLIED
  | typeof EVENT_QUESTION_ASKED
  | typeof EVENT_QUESTION_REPLIED
  | typeof EVENT_QUESTION_REJECTED;

/**
 * Part types in message.part.updated events.
 *
 * Event flow for a chat turn:
 * 1. type=text (user echo)       → full prompt text, first messageID
 * 2. type=step-start             → step/tool begins (new messageID)
 * 3. type=reasoning              → reasoning part (empty, then delta stream)
 * 4. type=tool                   → tool call (pending → running → completed)
 * 5. type=text (AI response)     → AI text part (empty, then delta stream)
 * 6. type=step-finish            → step done
 * 7. session.idle                → turn complete
 */
export type PartType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'file'
  | 'agent'
  | 'snapshot'
  | 'patch'
  | 'subtask'
  | 'retry'
  | 'compaction'
  | 'tool_use'
  | 'tool_result'
  | 'step-start'
  | 'step-finish';

/**
 * Tool call status progression in message.part.updated type=tool events:
 * - state.status: "pending" → "running" → "completed"
 * - state.input: tool parameters (on running/completed)
 * - state.output: tool result (on completed)
 * - state.title: display name (on completed)
 */
export type ToolCallStatus = 'pending' | 'running' | 'completed';

export interface MessagePartDeltaEvent {
  type: 'message.part.delta';
  properties: {
    partID: string;
    delta: string;
    field?: string;
    /** Session the delta belongs to (present at runtime, optional in schema). */
    sessionID?: string;
    /** Compatibility spelling emitted by some OpenCode event versions. */
    sessionId?: string;
    /** messageID echoed on some delta events (present at runtime, optional). */
    messageID?: string;
  };
}

export type ToolInput = Record<string, unknown>;

export type StreamToolState =
  | {
      status: 'pending';
      input: ToolInput;
      raw?: string;
    }
  | {
      status: 'running';
      input: ToolInput;
      title?: string;
      metadata?: Record<string, unknown>;
      time?: { start?: number };
    }
  | {
      status: 'completed';
      input: ToolInput;
      output?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      time?: { start?: number; end?: number; compacted?: number };
      attachments?: FilePart[];
    }
  | {
      status: 'error';
      input: ToolInput;
      error?: string;
      metadata?: Record<string, unknown>;
      time?: { start?: number; end?: number };
    };

interface BaseStreamPart {
  id: string;
  type: PartType;
  messageID?: string;
  sessionID?: string;
  /** Compatibility spelling emitted by some OpenCode event versions. */
  sessionId?: string;
}

export interface TextStreamPart extends BaseStreamPart {
  type: 'text';
  messageID: string;
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
}

export interface ReasoningStreamPart extends BaseStreamPart {
  type: 'reasoning';
  messageID: string;
  text: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export interface StreamToolPart extends BaseStreamPart {
  callID?: string;
  type: 'tool';
  tool: string;
  state: StreamToolState;
  metadata?: Record<string, unknown>;
}

export interface StepStartStreamPart extends BaseStreamPart {
  type: 'step-start';
  snapshot?: string;
}

export interface StepFinishStreamPart extends BaseStreamPart {
  type: 'step-finish';
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

export interface OtherStreamPart extends BaseStreamPart {
  type: Exclude<PartType, 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish'>;
  [key: string]: unknown;
}

export type StreamPart =
  | TextStreamPart
  | ReasoningStreamPart
  | StreamToolPart
  | StepStartStreamPart
  | StepFinishStreamPart
  | OtherStreamPart;

export interface MessagePartUpdatedEvent {
  type: 'message.part.updated';
  properties: {
    part: StreamPart;
    delta?: string;
    /** Session may be attached to the event envelope instead of the part. */
    sessionID?: string;
    /** Compatibility spelling used by some OpenCode event versions. */
    sessionId?: string;
  };
}

export interface SessionIdleEvent {
  type: 'session.idle';
  properties: {
    sessionID?: string;
  };
}

export interface SnapshotFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

export interface SessionDiffEvent {
  type: 'session.diff';
  properties: {
    sessionID: string;
    diff: SnapshotFileDiff[];
  };
}

export interface PermissionAskedEvent {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: {
      filepath?: string;
      diff?: string;
      [key: string]: unknown;
    };
    always: string[];
    tool?: { messageID: string; callID: string };
  };
}

export interface PermissionRepliedEvent {
  type: 'permission.replied';
  properties: {
    sessionID: string;
    /** The original permission request ID (field name per SDK v2 SSE event) */
    requestID: string;
    /** 'once' | 'always' | 'reject' */
    reply: string;
  };
}

// ---------------------------------------------------------------------------
// Question events
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionTool {
  messageID: string;
  callID: string;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: QuestionTool;
}

export type QuestionAnswer = Array<string>;

export interface QuestionReplied {
  sessionID: string;
  requestID: string;
  answers: Array<QuestionAnswer>;
}

export interface QuestionRejected {
  sessionID: string;
  requestID: string;
}

export interface QuestionAskedEvent {
  type: 'question.asked';
  properties: QuestionRequest;
}

export interface QuestionRepliedEvent {
  type: 'question.replied';
  properties: QuestionReplied;
}

export interface QuestionRejectedEvent {
  type: 'question.rejected';
  properties: QuestionRejected;
}

type OtherSdkEvents = Exclude<
  EventSubscribeResponse,
  | Extract<EventSubscribeResponse, { type: 'message.part.updated' }>
  | Extract<EventSubscribeResponse, { type: 'session.idle' }>
>;

export type OpenCodeEvent =
  | OtherSdkEvents
  | MessagePartUpdatedEvent
  | MessagePartDeltaEvent
  | SessionIdleEvent
  | SessionDiffEvent
  | PermissionAskedEvent
  | PermissionRepliedEvent
  | QuestionAskedEvent
  | QuestionRepliedEvent
  | QuestionRejectedEvent;

export interface OpenCodeGlobalEventEnvelope {
  directory: string;
  payload: OpenCodeEvent;
}

export type OpenCodeStreamEvent = OpenCodeEvent | OpenCodeGlobalEventEnvelope;
export type OpenCodeEventStream = { stream: AsyncIterable<OpenCodeStreamEvent> };
