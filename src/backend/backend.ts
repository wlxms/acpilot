/**
 * Backend adapter interface.
 *
 * Defines the contract that every backend adapter must fulfil.
 * The participant layer consumes this - never the raw SDK or VSCode APIs.
 */

import type {
  BackendChildSessionInfo,
  BackendSessionInfo,
  BackendSessionStatus,
  BackendAgent,
  BackendConfig,
  BackendFileAttachment,
  BackendResult,
  BackendModel,
  BackendPermissionResponse,
  BackendServerInfo,
  BackendServerStatus,
  BackendMessageHistory,
  BackendSettingsDescriptor,
  PermissionMode,
} from './types';

import type { SessionTitleSource } from '../backend/serializable/types';
import type { SessionStreamNode } from './streaming/session-stream-node';

// ===========================================================================
// Event stream
// ===========================================================================

export interface BackendEventStream<TEvent = unknown> {
  stream: AsyncIterable<TEvent>;
}

// ===========================================================================
// Session operations
// ===========================================================================

export interface BackendSessionOperations {
  create(options?: {
    parentId?: string;
    title?: string;
    directory?: string;
    /**
     * Marks a backend-owned disposable session (for example, a native model
     * provider invocation) that must not become a user-visible participant
     * session.
     */
    transient?: boolean;
  }): Promise<BackendResult<BackendSessionInfo>>;

  get(
    id: string,
    directory?: string,
  ): Promise<BackendResult<BackendSessionInfo>>;

  update(
    id: string,
    options: { title?: string; directory?: string },
  ): Promise<BackendResult<BackendSessionInfo>>;

  /**
   * Permanently remove a session when the backend supports session deletion.
   *
   * This is optional because some protocols (for example ACP) do not expose
   * a delete operation. Callers that create disposable sessions should treat
   * failures as best-effort cleanup rather than user-visible request errors.
   */
  delete?(
    id: string,
    directory?: string,
  ): Promise<BackendResult<boolean>>;

  /**
   * Release active resources without deleting the durable session record.
   * Native ACP uses this for its in-process ActiveSession handle and, when
   * supported, `session/close`; remote-only backends may implement it as a
   * no-op.
   */
  release(
    id: string,
    directory?: string,
  ): Promise<void>;

  prompt(
    id: string,
    text: string,
    directory?: string,
    options?: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      /** Per-request tool permission overrides (OpenCode: true=allow, false=deny). */
      tools?: Record<string, boolean>;
      /** Permission scope selected for this Agent request. */
      permissionMode?: PermissionMode;
      /** Backend-specific model options. Each adapter decides which keys it supports. */
      modelOptions?: BackendModelOptions;
      /** File attachments (images, documents) to include with the prompt */
      attachments?: BackendFileAttachment[];
    },
  ): Promise<BackendResult<unknown>>;

  revert(
    id: string,
    messageId: string,
    partId?: string,
    directory?: string,
  ): Promise<BackendResult<unknown>>;

  abort(
    id: string,
    directory?: string,
  ): Promise<BackendResult<boolean>>;

  list(directory?: string): Promise<BackendResult<BackendSessionInfo[]>>;

  /** Get child sessions of a given parent session */
  children(id: string, directory?: string): Promise<BackendResult<BackendChildSessionInfo[]>>;

  /** Get status of all sessions: { [sessionId]: SessionStatus } */
  status(directory?: string): Promise<BackendResult<Record<string, BackendSessionStatus>>>;

  // -- Hierarchy navigation (sub-agent session tree) ---------------------

  /** Get all descendant session IDs (children, grandchildren, etc.) */
  descendants(parentId: string): string[];

  /** Walk up the parent chain and return the first session ID found in `candidateIds` */
  findAncestor(sessionId: string, candidateIds: Set<string>): string | undefined;

  /** Get the parent session ID for a given session */
  parent(sessionId: string): string | undefined;

  /**
   * Get message history for a session.
   * Returns user/assistant message pairs with text content extracted from parts.
   */
  messages(id: string, directory?: string): Promise<BackendResult<BackendMessageHistory>>;
}

// ===========================================================================
// Config operations
// ===========================================================================

export interface BackendConfigOperations {
  models(directory?: string): Promise<BackendResult<BackendModel[]>>;

  /** List available agents */
  agents(directory?: string): Promise<BackendResult<BackendAgent[]>>;

  /** Get full configuration */
  get(directory?: string): Promise<BackendResult<BackendConfig>>;

  /** Update configuration (partial merge) */
  update(config: Partial<BackendConfig>, directory?: string): Promise<BackendResult<void>>;

  /** Update global configuration (persists to disk, no restart needed) */
  updateGlobal(config: Partial<BackendConfig>): Promise<BackendResult<void>>;
}

// ===========================================================================
// Backend model capability
// ===========================================================================

/** A backend-native model selector. */
export interface BackendModelReference {
  readonly providerID: string;
  readonly modelID: string;
}

/**
 * Opaque model options originating at a caller such as Copilot.
 *
 * The common layer deliberately does not assign semantics to these values;
 * each backend/model provider may allow-list and translate the keys it knows.
 */
export type BackendModelOptions = Readonly<Record<string, unknown>>;

/** Purpose of a native model request, used to avoid recursive host features. */
export type BackendModelRequestPurpose = 'chat' | 'title-generation';

/** Prompt accepted by a backend model provider. */
export interface BackendModelPrompt {
  readonly text: string;
  readonly attachments?: readonly BackendFileAttachment[];
}

/**
 * Runtime lease captured by a host surface before invoking a backend model.
 *
 * Backend instances can be reused while their transport/target is replaced.
 * A model request must therefore carry the identity it was created against;
 * the provider uses this lease to stop a stale request before it reaches the
 * replacement connection. The optional listener is host-owned so the backend
 * layer does not depend on the application event bus.
 */
export interface BackendRuntimeGuard {
  readonly generation: number;
  readonly instanceKey: string;
  isCurrent(): boolean;
  onInvalidated?(listener: () => void): () => void;
}

/** Error used when a model request outlives the backend runtime it targeted. */
export class BackendRuntimeChangedError extends Error {
  constructor(instanceKey: string) {
    super(`Backend runtime changed while the model request was running (instance "${instanceKey}").`);
    this.name = 'BackendRuntimeChangedError';
  }
}

/**
 * Stream contract exposed to a backend model provider.
 *
 * The normal Copilot participant passes a real SerializableSessionStream.
 * Native language-model requests pass a transient implementation backed by
 * the same SSP renderer. Keeping this contract at the backend boundary lets
 * the provider own session/pipeline lifecycle without importing VS Code.
 */
export interface BackendPipelineStream extends SessionStreamNode {
  recordFirstPrompt(prompt: string | undefined): void;
  getFirstPrompt(): string | undefined;
  updateTitle(
    title: string,
    source: SessionTitleSource,
    options?: { provisional?: boolean },
  ): string | undefined;
}

export interface BackendModelInvocationRequest {
  readonly model: BackendModelReference;
  /** Runtime identity captured by the Copilot host before this invocation. */
  readonly runtime?: BackendRuntimeGuard;
  /** Backend-specific options copied from the native model request. */
  readonly modelOptions?: BackendModelOptions;
  /** Allows a backend pipeline to suppress features that recurse into LM chat. */
  readonly purpose?: BackendModelRequestPurpose;
  readonly prompt: BackendModelPrompt;
  readonly directory?: string;
  readonly agent?: string;
  readonly permissionMode?: PermissionMode;
  /**
   * Whether this invocation can surface a user-facing permission prompt.
   * Native Copilot LM requests have no participant interaction channel, so
   * they set this to false and pipelines must resolve permissions without
   * waiting for a carousel. The default keeps normal Chat Session turns
   * interactive.
   */
  readonly allowUserInteraction?: boolean;
  readonly title?: string;
  readonly stream: BackendPipelineStream;
  readonly token: BackendPipelineToken;
  readonly logger?: { appendLine(message: string): void };
}

export interface BackendModelInvocationResult {
  readonly completed: boolean;
  readonly sessionId?: string;
  readonly pipeline: BackendPipelineResult;
}

/** Model catalog and invocation strategy owned by one backend plugin. */
export interface BackendModelProvider {
  /** Agent-session vendor namespace owned by this backend. */
  readonly vendor: string;
  /**
   * Optional per-provider timeout for model discovery. Backends whose model
   * catalog is initialized asynchronously may need a larger budget than the
   * host-wide default used by the aggregate Copilot catalog.
   */
  readonly listModelsTimeoutMs?: number;
  listModels(directory?: string): Promise<BackendResult<BackendModel[]>>;
  invoke(request: BackendModelInvocationRequest): Promise<BackendModelInvocationResult>;
}

// ===========================================================================
// Event operations
// ===========================================================================

export interface BackendEventOperations<TEvent = unknown> {
  /** Open a per-session event stream */
  openSessionStream(sessionId: string): BackendEventStream<TEvent>;

  /** Open the global event stream (all sessions) */
  openGlobalStream(): Promise<BackendEventStream<TEvent>>;

  /** Close a previously-opened session stream */
  closeSessionStream(sessionId: string): void;

  /** Ensure global event subscription is active for the given client */
  ensureStarted(): Promise<void>;
}

// ===========================================================================
// Permission operations
// ===========================================================================

export interface BackendPermissionOperations {
  reply(
    sessionId: string,
    permissionId: string,
    response: BackendPermissionResponse,
    directory?: string,
  ): Promise<void>;

}

// ===========================================================================
// Question operations
// ===========================================================================

export interface BackendQuestionOperations {
  /** Reply to a question.asked request with user answers */
  reply(
    sessionId: string,
    requestId: string,
    answers: Array<Array<string>>,
    directory?: string,
  ): Promise<BackendResult<boolean>>;

  /** Reject a question.asked request */
  reject(
    sessionId: string,
    requestId: string,
    directory?: string,
  ): Promise<BackendResult<boolean>>;

}

// ===========================================================================
// Backend settings provider (pluggable settings UI)
// ===========================================================================

export interface BackendSettingsProvider {
  /** Build the settings descriptor for the current backend state */
  getDescriptor(agents: BackendAgent[], models: BackendModel[]): Promise<BackendSettingsDescriptor>;
  /** Persist backend-specific settings values */
  saveValues(values: Record<string, unknown>): Promise<void>;
}

// ===========================================================================
// Auth operations
// ===========================================================================

/** Auth key operations shared across all backend adapters */
export interface BackendAuthOperations {
  /** Persist an API key for a provider (writes to backend auth storage) */
  setKey(providerID: string, key: string): Promise<BackendResult<void>>;
  /** Remove an API key for a provider */
  removeKey(providerID: string): Promise<BackendResult<void>>;
}

// ===========================================================================
// BackendPipeline - backend-specific event interpreter
// ===========================================================================

export interface BackendPipelineToken {
  readonly isCancellationRequested: boolean;
}

export interface BackendPipelineOptions {
  readonly sessionId: string;
  readonly directory?: string;
  /** The stream owned by the Copilot integration for this turn. */
  readonly stream: BackendPipelineStream;
  readonly logger?: { appendLine(message: string): void };
  /** Permission scope selected for this Agent request. */
  readonly permissionMode?: PermissionMode;
  /** See BackendModelInvocationRequest.allowUserInteraction. */
  readonly allowUserInteraction?: boolean;
  /** Title-generation requests must not trigger another title-generation pass. */
  readonly suppressTitleGeneration?: boolean;
}

export interface BackendPipelineResult {
  readonly completed: boolean;
  /** Human-readable backend failure when the turn ended at a terminal error. */
  readonly error?: string;
  readonly userMessageId: string | null;
  readonly sessionTitle: string | null;
  readonly sessionTitleSource: SessionTitleSource | null;
  readonly hadSubagentTasks: boolean;
}

/**
 * Interprets one backend's raw event stream and writes SSPs into the stream
 * supplied at construction time. A pipeline is single-use and bound to one
 * backend session and one Copilot turn.
 */
export interface BackendPipeline<TEvent = unknown> {
  run(events: AsyncIterable<TEvent>, token: BackendPipelineToken): Promise<BackendPipelineResult>;
}

// ===========================================================================
// Complete backend contract
// ===========================================================================

export interface Backend<TEvent = unknown> {
  /** Human-readable backend name */
  readonly name: string;

  // -- lifecycle -------------------------------------------------------

  start(directory?: string): Promise<BackendResult<BackendServerInfo>>;
  stop(): Promise<void>;
  getStatus(): BackendServerStatus;
  getUrl(): string | null;
  isRunning(): boolean;

  // -- sub-operations --------------------------------------------------

  sessions: BackendSessionOperations;
  config: BackendConfigOperations;
  events: BackendEventOperations<TEvent>;
  permissions: BackendPermissionOperations;
  questions: BackendQuestionOperations;

  /** Optional model catalog/invocation capability owned by this backend. */
  readonly modelProvider?: BackendModelProvider;

  /** Create a pipeline bound to one backend session and one Copilot SSS stream. */
  createPipeline(options: BackendPipelineOptions): BackendPipeline<TEvent>;

  auth: BackendAuthOperations;

  // -- pluggable settings UI -------------------------------------------

  /** Optional: provides backend-specific settings descriptor for the UI */
  readonly settingsProvider?: BackendSettingsProvider;
}
