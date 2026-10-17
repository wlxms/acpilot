/**
 * SSP (Serializable Stream Part) — types, base class, and serialization contracts.
 *
 * SSP is independent of any backend protocol. It lives in src/ssp/ because it is
 * conceptually close to VSCode and the extension itself. Backend pipelines
 * create and push SSPs; SSP does not import from backend adapters.
 *
 * Architecture (v2):
 * - Append-only SSPs: AssistantTextSSP, ReasoningSSP, UserPromptSSP
 *   Each push creates a new instance carrying a delta. No update().
 * - Mutable SSPs: ToolInvocationSSP, QuestionSSP, ExternalEditSSP, etc.
 *   Implement IMutableStreamPart. push() creates, update() mutates.
 * - IMetadataProvider: SSPs that contribute to meta.jsonl (e.g. ExternalEditSSP
 *   exposes undoStopId asynchronously via getMetadata()).
 *
 * This file defines:
 * 1. StreamPartRecord — the JSONL serialization contract (plain data shape)
 * 2. SerializableStreamPart — the abstract base class (runtime entity)
 * 3. IMutableStreamPart — interface for parts that support update()
 * 4. IMetadataProvider — interface for parts that contribute to meta.jsonl
 * 5. ISnapshotProvider — interface for parts that emit file snapshots
 * 6. Payload interfaces for each SSP kind
 * 7. SspStream — the rendering target interface
 */

// No imports from backend adapters - SSP is fully independent.

// ===========================================================================
// Serialization contract (JSONL record shape)
// ===========================================================================

export interface SerializableStreamPartMeta {
  turnIndex: number;
  requestId: string;
  sequence: number;
  createdAt: string;
  source: SerializableStreamPartSource;
  sourceType?: string;
  sourcePartId?: string;
  toolCallId?: string;
  editId?: string;
  uri?: string;
  subAgentId?: string;
  sessionId?: string;
  parentSessionId?: string;
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
  subAgentPath?: string[];
}

export type SerializableStreamPartSource =
  | 'backend-event'
  | 'synthetic'
  | 'restore'
  | 'unknown';

export type SerializableStreamPartKind =
  | 'userPrompt'
  | 'assistantText'
  | 'reasoning'
  | 'toolInvocation'
  | 'question'
  | 'sessionLifecycle'
  | 'sessionDiff'
  | 'interactionRequest'
  | 'interactionResponse'
  | 'externalEdit'
  | 'opaqueEvent';

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
  scope?: FileSnapshotScope;
}

export interface FileSnapshotScope {
  v: 1;
  sessionId?: string;
  requestId?: string;
  streamNode: 'root' | 'subsession';
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
  subAgentPath?: string[];
  turnIndex?: number;
  toolCallId: string;
}

/**
 * The plain-data shape of a serialized stream part in JSONL.
 * This is the CONTRACT that SerializableStreamPart.toJSON() must produce.
 */
export interface StreamPartRecord<
  TKind extends SerializableStreamPartKind | string = string,
  TPayload = unknown,
> {
  kind: TKind;
  version: number;
  id: string;
  payload: TPayload;
  meta: SerializableStreamPartMeta;
}

// ===========================================================================
// Payload interfaces (owned by SSP)
// ===========================================================================

export interface OpaqueEventStreamPartPayload<TEvent = unknown> {
  event: TEvent;
}

export type OpaqueEventStreamPart<TEvent = unknown> = StreamPartRecord<
  'opaqueEvent',
  OpaqueEventStreamPartPayload<TEvent>
>;

export interface UserPromptStreamPartPayload {
  text: string;
  partId?: string;
  messageId?: string;
  sessionId?: string;
  command?: string;
}

export interface AssistantTextStreamPartPayload {
  partId: string;
  text: string;
  messageId?: string;
  sessionId?: string;
  synthetic?: boolean;
  isComplete?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ReasoningStreamPartPayload {
  partId: string;
  text: string;
  messageId?: string;
  sessionId?: string;
  thinkingId?: string;
  metadata?: Record<string, unknown>;
  isComplete?: boolean;
}

export interface SerializableToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  originalToolName?: string;
  startTime?: number;
  endTime?: number;
}

export interface ToolInvocationStreamPartPayload {
  partId: string;
  toolName: string;
  callId?: string;
  state: SerializableToolState;
  messageId?: string;
  sessionId?: string;
  subAgentId?: string;
  subAgentInvocationId?: string;
}

export interface QuestionStreamPartPayload {
  questionId: string;
  questions: unknown[];
  status: 'asked' | 'replied' | 'skipped';
  answers?: unknown;
}

export interface SessionLifecycleStreamPartPayload {
  eventType: 'session.created' | 'session.updated' | 'session.deleted' | 'session.error' | 'session.idle' | 'session.status' | 'server.connected' | 'server.heartbeat';
  sessionId?: string;
  parentId?: string;
  title?: string;
  error?: string;
  status?: unknown;
}

export interface SessionDiffStreamPartPayload {
  sessionId: string;
  diffs: unknown[];
}

export interface InteractionRequestStreamPartPayload {
  interactionType: 'permission' | 'question';
  permissionId?: string;
  questionId?: string;
  sessionId?: string;
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  questions?: unknown[];
  tool?: { messageId?: string; callId?: string };
}

export interface InteractionResponseStreamPartPayload {
  interactionType: 'permission' | 'question';
  eventType: 'permission.replied' | 'question.replied' | 'question.rejected';
  sessionId?: string;
  permissionId?: string;
  requestId?: string;
  response?: string;
}

export interface ExternalEditStreamPartPayload {
  toolCallId: string;
  editId?: string;
  uri?: string;
  uris?: unknown[];
  status?: 'pending' | 'completed' | 'error';
  undoStopId?: string;
  onDidComplete?: unknown;
  subAgentId?: string;
  subAgentInvocationId?: string;
}

export type KnownSerializableStreamPart =
  | StreamPartRecord<'userPrompt', UserPromptStreamPartPayload>
  | StreamPartRecord<'assistantText', AssistantTextStreamPartPayload>
  | StreamPartRecord<'reasoning', ReasoningStreamPartPayload>
  | StreamPartRecord<'toolInvocation', ToolInvocationStreamPartPayload>
  | StreamPartRecord<'question', QuestionStreamPartPayload>
  | StreamPartRecord<'sessionLifecycle', SessionLifecycleStreamPartPayload>
  | StreamPartRecord<'sessionDiff', SessionDiffStreamPartPayload>
  | StreamPartRecord<'interactionRequest', InteractionRequestStreamPartPayload>
  | StreamPartRecord<'interactionResponse', InteractionResponseStreamPartPayload>
  | StreamPartRecord<'externalEdit', ExternalEditStreamPartPayload>
  | OpaqueEventStreamPart;

// ===========================================================================
// Duck-typed value interfaces (avoid direct vscode global type dependencies)
// ===========================================================================

export interface MarkdownStringValue {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: unknown;
}

// ===========================================================================
// Stream interface — the rendering target that SSPs call during render()
// ===========================================================================

export interface SspStream {
  markdown(value: string | MarkdownStringValue): void;
  progress(value: string): void;
  push(part: unknown): void;
  thinkingProgress?(value: { text: string; id?: string; metadata?: Record<string, unknown> } | string): void;
  beginToolInvocation?(toolCallId: string, toolName: string, streamData?: unknown): void;
  updateToolInvocation?(toolCallId: string, streamData: unknown): void;
  externalEdit?(target: unknown, callback: () => PromiseLike<unknown>): PromiseLike<string>;
  questionCarousel?(questions: unknown[], allowSkip?: boolean): PromiseLike<Record<string, unknown> | undefined>;
  reference?(value: unknown, iconPath?: unknown): void;
  anchor?(value: unknown, title?: string): void;
  button?(command: unknown): void;
  filetree?(value: unknown, baseUri?: unknown): void;
}

// ===========================================================================
// Abstract base class — the runtime entity with behavior
// ===========================================================================

export abstract class SerializableStreamPart<
  TKind extends SerializableStreamPartKind | string = SerializableStreamPartKind,
  TPayload = unknown,
> {
  abstract readonly kind: TKind;
  readonly version: number = 1;
  readonly id: string;
  payload: TPayload;
  meta: SerializableStreamPartMeta;

  constructor(
    initialPayload: TPayload,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    this.id = id ?? this.generateId();
    this.payload = initialPayload;
    this.meta = {
      turnIndex: meta?.turnIndex ?? 0,
      requestId: meta?.requestId ?? '',
      sequence: meta?.sequence ?? 0,
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      source: meta?.source ?? 'backend-event',
      sourceType: meta?.sourceType,
      sourcePartId: meta?.sourcePartId,
      toolCallId: meta?.toolCallId,
      editId: meta?.editId,
      uri: meta?.uri,
      subAgentId: meta?.subAgentId,
      sessionId: meta?.sessionId,
      parentSessionId: meta?.parentSessionId,
      subAgentInvocationId: meta?.subAgentInvocationId,
      parentSubAgentInvocationId: meta?.parentSubAgentInvocationId,
      subAgentPath: meta?.subAgentPath,
    };
  }

  /**
   * Render this part to the given stream.
   * Called by SSS after push() or update().
   * SSPs should check optional stream capabilities before calling proposed APIs.
   */
  abstract render(stream: SspStream): void;

  /** Produce JSONL-compatible record. Shape matches StreamPartRecord. */
  toJSON(): StreamPartRecord<TKind, TPayload> {
    return {
      kind: this.kind,
      version: this.version,
      id: this.id,
      payload: this.payload,
      meta: this.meta,
    };
  }

  // ── State change events ────────────────────────────────────────────────
  //
  // ONLY for SSP-internal async state changes (e.g. questionCarousel result,
  // externalEdit undoStopId arrival). SSS-driven update() does NOT trigger
  // this — SSS handles render + append itself.
  //
  // When emitStateChange() fires, SSS (which subscribed via onStateChange)
  // will call syncMetadata() to write meta.jsonl.

  private listeners: Array<(ssp: this) => void> = [];

  onStateChange(cb: (ssp: this) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter(l => l !== cb);
    };
  }

  protected emitStateChange(): void {
    for (const cb of this.listeners) {cb(this);}
  }

  private generateId(): string {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) { return `ssp-${g.crypto.randomUUID()}`; }
    return `ssp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ===========================================================================
// Non-generic interface for SSP method signatures (avoids generic invariance)
// ===========================================================================

/** Structural interface — all SSP subclasses are assignable to this.
 *  Use in method signatures like push(ssp: ISerializableStreamPart). */
export interface ISerializableStreamPart {
  readonly kind: string;
  readonly version: number;
  readonly id: string;
  payload: unknown;
  meta: SerializableStreamPartMeta;
  render(stream: SspStream): void;
  toJSON(): StreamPartRecord;
  onStateChange(cb: (ssp: ISerializableStreamPart) => void): () => void;
}

/** Convenience type alias — same as ISerializableStreamPart */
export type AnySerializableStreamPart = ISerializableStreamPart;

// ===========================================================================
// IMutableStreamPart — parts that support update() after creation
// ===========================================================================

/**
 * Interface for mutable stream parts. Only parts implementing this interface
 * can be updated via SSS.update(). Append-only parts (text, reasoning) do NOT
 * implement this — attempting update() on them is an error.
 *
 * update() must ONLY merge data into payload. It must NOT call emitStateChange().
 * emitStateChange() is reserved for SSP-internal async state changes.
 */
export interface IMutableStreamPart<TPayload = unknown>
  extends ISerializableStreamPart {
  update(data: Partial<TPayload>): void;
}

/** Type guard: returns true if the part implements IMutableStreamPart */
export function isMutable(part: ISerializableStreamPart): part is IMutableStreamPart {
  return typeof (part as any).update === 'function';
}

/** Set of mutable SSP kinds (used by materializeRecords for aggregation strategy) */
export const MUTABLE_KINDS = new Set([
  'toolInvocation',
  'question',
  'externalEdit',
]);

export function isMutableKind(kind: string): boolean {
  return MUTABLE_KINDS.has(kind);
}

// ===========================================================================
// IMetadataProvider — parts that contribute data to meta.jsonl
// ===========================================================================

/**
 * Interface for parts that have metadata to persist in meta.jsonl.
 * SSS calls getMetadata() after push/update/onStateChange.
 * metaId uniquely identifies this instance in meta.jsonl (defaults to part.id).
 */
export interface IMetadataProvider {
  readonly metaId: string;
  getMetadata(): Record<string, unknown> | undefined;
}

export interface IAsyncMetadataProvider extends IMetadataProvider {
  whenMetadataSettled(): Promise<void>;
}

// ===========================================================================
// ISnapshotProvider — parts that emit file snapshots to session JSONL
// ===========================================================================

export interface ISnapshotProvider {
  onSnapshot(cb: (snapshot: FileSnapshotRecord) => void): () => void;
}

/** Type guard: returns true if the part implements IMetadataProvider */
export function isMetadataProvider(
  part: ISerializableStreamPart,
): part is ISerializableStreamPart & IMetadataProvider {
  return typeof (part as unknown as IMetadataProvider).getMetadata === 'function';
}

/** Type guard: returns true if the part emits file snapshots */
export function isSnapshotProvider(
  part: ISerializableStreamPart,
): part is ISerializableStreamPart & ISnapshotProvider {
  return typeof (part as unknown as ISnapshotProvider).onSnapshot === 'function';
}

export function isAsyncMetadataProvider(
  part: ISerializableStreamPart,
): part is ISerializableStreamPart & IAsyncMetadataProvider {
  const candidate = part as unknown as IAsyncMetadataProvider;
  return isMetadataProvider(part) && typeof candidate.whenMetadataSettled === 'function';
}
