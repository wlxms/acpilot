/**
 * AcpBackend — a Backend implementation backed by a standard Agent Client
 * Protocol agent (JSON-RPC 2.0) via the official `@agentclientprotocol/sdk`.
 *
 * Unlike OpenCodeBackend (which wraps the OpenCode-CLI HTTP/SSE server), this
 * backend speaks the protocol directly: it connects to a local-spawned or
 * remote ACP agent, opens sessions via `client().buildSession()`, prompts via
 * `ActiveSession.prompt()`, and consumes streaming updates via
 * `ActiveSession.nextUpdate()`.
 *
 * Architecture notes
 * ------------------
 * - The Backend contract expects `events.openSessionStream(id)` to return a
 *   sync `BackendEventStream` wrapping an `AsyncIterable<TEvent>`. ACP's model is
 *   pull-based (`nextUpdate()`), so the adapter bridges by holding the
 *   `ActiveSession` per session id and exposing its `nextUpdate()` as an async
 *   iterable that yields `ActiveSessionMessage` until `stop`.
 * - Permissions: ACP's `session/request_permission` is a blocking JSON-RPC
 *   request the agent awaits. The handler is registered via
 *   `client().onRequest(methods.client.session.requestPermission, ...)` and
 *   resolves when the ExternalEditSSP baseline capture completes (see
 *   AcpPipeline). This reuses the OpenCode-origin snapshot mechanism with the
 *   filepath sourced from the tool call input (filepath-resolver.ts).
 *
 * @module
 */

import {
  client,
  PROTOCOL_VERSION,
  methods,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type Stream,
  type ActiveSession,
  type ActiveSessionMessage,
  type ContentBlock,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionCapabilities,
  type SessionMode,
} from '@agentclientprotocol/sdk';
import type {
  BackendPipeline,
  BackendPipelineOptions,
  Backend,
  BackendSessionOperations,
  BackendConfigOperations,
  BackendEventOperations,
  BackendEventStream,
  BackendPermissionOperations,
  BackendQuestionOperations,
  BackendAuthOperations,
  BackendModelProvider,
} from '../../backend/backend';
import type {
  BackendResult,
  BackendServerInfo,
  BackendSessionInfo,
  BackendSessionStatus,
  BackendConfig,
  BackendFileAttachment,
  BackendMessageHistory,
  BackendServerStatus,
} from '../../backend/types';
import { AcpPipeline } from './pipeline';
import { createSessionModelProvider } from '../../backend/session-model-provider';
import { spawnAcpAgent, connectAcpRemote, type LocalSpawnOptions, type RemoteConnectOptions } from './transport';

export interface AcpBackendOptions {
  /** Stable backend name exposed through the shared Backend contract. */
  name?: string;
  /** Name advertised to ACP agents during initialization. */
  clientName?: string;
  /** Prefix used when ACP creates a session but does not provide a title. */
  sessionTitlePrefix?: string;
  /** Error shown when neither local nor remote transport is configured. */
  missingOptionsMessage?: string;
  /** Local spawn configuration (mutually exclusive with `remote`).). */
  local?: LocalSpawnOptions;
  /** Remote WebSocket configuration (mutually exclusive with `local`). */
  remote?: RemoteConnectOptions;
  /** Logger sink (defaults to no-op). */
  logger?: { appendLine(message: string): void };
}

export type AcpBackendOptionsProvider =
  () => AcpBackendOptions | undefined | Promise<AcpBackendOptions | undefined>;

interface OpenStreamHandle {
  stream: BackendEventStream<ActiveSessionMessage>;
  dispose: () => void;
}

interface TransientSessionRecord {
  id: string;
  connection: ClientConnection;
  cleanupClaimed: boolean;
}

interface TransientCleanupAttempt {
  ok: boolean;
  error?: unknown;
}

interface TransientCleanupResult {
  deleteSucceeded: boolean;
  closeSucceeded: boolean;
  deleteError?: unknown;
  closeError?: unknown;
}

/**
 * Cleanup state is keyed by the remote connection and session id rather than
 * by the local marker object. A session id can be represented by more than
 * one marker while stop/release/delete race, but the agent must still receive
 * at most one request for each cleanup action.
 */
interface TransientCleanupState {
  connection: ClientConnection;
  id: string;
  deleteAttempted: boolean;
  deleteSucceeded: boolean;
  deleteError?: unknown;
  closeAttempted: boolean;
  closeSucceeded: boolean;
  closeError?: unknown;
  terminal: boolean;
  result?: TransientCleanupResult;
  operation?: Promise<TransientCleanupResult>;
}

interface DiscoverySessionRecord {
  id: string;
  connection: ClientConnection;
  cleanupClaimed: boolean;
}

interface PendingTransientCreate {
  promise: Promise<unknown>;
  connection: ClientConnection;
}

interface PendingDiscoveryCreate {
  promise: Promise<unknown>;
  connection: ClientConnection;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const TRANSIENT_CREATE_DRAIN_TIMEOUT_MS = 2_000;
const DISCOVERY_CREATE_DRAIN_TIMEOUT_MS = 2_000;
const START_DRAIN_TIMEOUT_MS = 2_000;
const TRANSIENT_SESSION_CLEANUP_TIMEOUT_MS = 2_000;

export class AcpBackend implements Backend<ActiveSessionMessage> {
  readonly name: string;
  readonly modelProvider: BackendModelProvider;
  private readonly clientName: string;
  private readonly sessionTitlePrefix: string;
  private readonly missingOptionsMessage: string;
  private log: (m: string) => void = () => {};

  private app: ClientApp | null = null;
  /** Long-lived ACP JSON-RPC connection. `connectWith()` must not be used
   * here because it closes the connection as soon as its callback returns. */
  private clientConnection: ClientConnection | null = null;
  private connection: { stream: Stream; dispose: () => void } | null = null;
  private status: BackendServerStatus = 'stopped';
  private activeOptions: AcpBackendOptions | null = null;
  /** Workspace used for sessions opened while this connection is active. */
  private workingDirectory: string | undefined;
  private optionsProvider: AcpBackendOptionsProvider | undefined;
  private startPromise: Promise<BackendResult<BackendServerInfo>> | null = null;
  private startGeneration = 0;
  /** Serializes shutdown with a replacement start request. */
  private stopPromise: Promise<void> | null = null;
  /** Set synchronously at stop entry so callers cannot reuse a dying runtime. */
  private stopping = false;

  /** Active sessions keyed by session id (for event streaming + prompt/cancel). */
  private readonly activeSessions = new Map<string, ActiveSession>();
  /**
   * Sessions created by the native model provider. These are intentionally
   * kept separate from participant sessions so stopping ACP can clean only
   * backend-owned disposable sessions on the old connection.
   */
  private readonly transientSessions = new Set<TransientSessionRecord>();
  /** De-duplicate transient cleanup by remote connection and session id. */
  private readonly transientCleanupStates = new Map<ClientConnection, Map<string, TransientCleanupState>>();
  /** Remember completed keys after their active state is safely pruned. */
  private readonly transientCleanupResults = new Map<ClientConnection, Map<string, TransientCleanupResult>>();
  /** Closed connections are weakly tracked so late creates can be ignored without
   * retaining the transport object after all callers release it. */
  private readonly closedTransientConnections = new WeakSet<ClientConnection>();
  /** Disposable model-discovery sessions, kept separate from participant state. */
  private readonly discoverySessions = new Set<DiscoverySessionRecord>();
  /** Transient session/new calls that must settle before an old connection is closed. */
  private readonly pendingTransientCreates = new Set<PendingTransientCreate>();
  /** Discovery session/new calls that may publish a late disposable session. */
  private readonly pendingDiscoveryCreates = new Set<PendingDiscoveryCreate>();
  private readonly sessionDirectories = new Map<string, string>();
  /** De-duplicate concurrent resume requests from stream and prompt callers. */
  private readonly sessionActivationPromises = new Map<string, Promise<ActiveSession | undefined>>();
  /** Invalidate a late resume after a session is released or discarded. */
  private readonly sessionActivationEpochs = new Map<string, number>();
  private readonly sessionConfigOptions = new Map<string, SessionConfigOption[]>();
  /** Config/mode data learned from a disposable discovery session. */
  private readonly discoveredConfigOptions = new Map<string, SessionConfigOption[]>();
  private readonly discoveredModes = new Map<string, SessionMode[]>();
  private readonly discoveryPromises = new Map<string, Promise<void>>();
  private readonly attemptedDiscoveryDirectories = new Set<string>();
  private initializeResponse: InitializeResponse | null = null;

  /** Per-session open stream handles (sessionId → handles). */
  private readonly openStreams = new Map<string, Set<OpenStreamHandle>>();

  /** Per-session permission resolvers (set by pipeline wiring). */
  private readonly permissionResolvers = new Map<string, (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>>();
  /** Connection that owns each resolver; session ids may be reused by targets. */
  private readonly permissionResolverConnections = new Map<string, ClientConnection>();

  constructor(private options: AcpBackendOptions = {}) {
    this.name = options.name ?? 'acp';
    this.modelProvider = createSessionModelProvider(this, this.name);
    this.clientName = options.clientName ?? `acpilot-${this.name}-backend`;
    this.sessionTitlePrefix = options.sessionTitlePrefix ?? 'ACP Session';
    this.missingOptionsMessage = options.missingOptionsMessage
      ?? 'No ACP target selected. Add or select an ACP target in ACP Settings.';
    if (options.logger) {this.log = (m) => options.logger!.appendLine(`[${this.name}-backend] ${m}`);}
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  getUrl(): string | null {
    const options = this.activeOptions ?? this.options;
    if (options.remote?.url) {return options.remote.url;}
    if (options.local) {return 'local';}
    return null;
  }

  getStatus(): BackendServerStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  setOptionsProvider(provider: AcpBackendOptionsProvider): void {
    this.optionsProvider = provider;
  }

  async start(directory?: string): Promise<BackendResult<BackendServerInfo>> {
    // A stop owns the old connection until its bounded cleanup pass finishes.
    // Waiting here gives a replacement target a clean lifecycle boundary while
    // allowing the stale start operation to finish its local transport cleanup.
    while (this.stopping || this.stopPromise) {
      const stop = this.stopPromise;
      if (stop) {
        await stop.catch(() => undefined);
      } else {
        // stop() publishes its promise immediately after setting the flag;
        // yield once for the tiny re-entrant window before it is visible.
        await Promise.resolve();
      }
    }
    if (this.status === 'running') {
      return { data: { url: this.getUrl() ?? '', status: this.status } };
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const generation = ++this.startGeneration;
    const pending = this.doStart(directory, generation);
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) {
        this.startPromise = null;
      }
    }
  }

  private async doStart(
    directory: string | undefined,
    generation: number,
  ): Promise<BackendResult<BackendServerInfo>> {
    this.status = 'starting';
    let connection: { stream: Stream; dispose: () => void } | null = null;
    let clientConnection: ClientConnection | null = null;
    let app: ClientApp | null = null;
    let connectionDisposed = false;
    let rawConnectionDispose: (() => void) | undefined;
    const disposeConnection = (): void => {
      if (connectionDisposed) {return;}
      connectionDisposed = true;
      rawConnectionDispose?.();
    };
    const isCurrentStart = (): boolean =>
      generation === this.startGeneration && !this.stopping && this.status === 'starting';
    try {
      const options = await this.resolveOptions();
      if (!isCurrentStart()) {
        throw new Error('ACP backend start cancelled');
      }
      this.activeOptions = options;
      this.workingDirectory = directory;

      // 1. Establish the transport stream.
      let stream: Stream;
      let dispose: () => void;
      if (options.local) {
        const spawned = spawnAcpAgent({ ...options.local, cwd: options.local.cwd ?? directory });
        stream = spawned.stream;
        const child = spawned.process;
        dispose = () => { child.kill(); };
      } else if (options.remote?.url) {
        const remote = await connectAcpRemote(options.remote);
        // A remote connect can outlive stop() before it returns its stream.
        // Dispose that local result immediately and never publish it through
        // the shared runtime fields.
        if (!isCurrentStart()) {
          remote.dispose();
          throw new Error('ACP backend start cancelled');
        }
        stream = remote.stream;
        dispose = remote.dispose;
      } else {
        throw new Error(options.missingOptionsMessage ?? this.missingOptionsMessage);
      }
      if (!isCurrentStart()) {
        dispose();
        throw new Error('ACP backend start cancelled');
      }
      rawConnectionDispose = dispose;
      connection = { stream, dispose: disposeConnection };
      this.connection = connection;

      // 2. Build the client app + register the permission request handler.
      app = client({ name: options.clientName ?? this.clientName });
      this.app = app;

      // 3. Keep one ACP JSON-RPC connection for the lifetime of the backend.
      // `ClientApp.connectWith()` is intentionally scoped: it closes the
      // connection when its callback settles, which would invalidate every
      // ActiveSession returned from that callback. All session operations
      // below therefore use this persistent connection's agent context.
      clientConnection = app.connect(stream);
      const connectedClient = clientConnection;
      this.clientConnection = connectedClient;
      this.registerClientHandlers(connectedClient);
      void connectedClient.closed.then(() => {
        if (this.clientConnection !== connectedClient) {return;}
        const closedCapabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities;
        // Treat an unexpected close as a runtime transition. In-flight session
        // operations that captured the previous generation must not repopulate
        // maps after a replacement start.
        this.startGeneration += 1;
        this.clientConnection = null;
        if (this.connection === connection) {
          this.connection = null;
        }
        if (this.app === app) {
          this.app = null;
        }
        this.activeOptions = null;
        this.workingDirectory = undefined;
        this.initializeResponse = null;
        // A transport can close without going through stop(). Remove every
        // helper owned by that connection so a subsequent start cannot reuse
        // stale session ids or permission resolvers.
        for (const session of this.activeSessions.values()) {session.dispose();}
        this.activeSessions.clear();
        for (const record of [...this.transientSessions]) {
          if (record.connection === connectedClient) {
            this.transientSessions.delete(record);
          }
        }
        this.closedTransientConnections.add(connectedClient);
        this.maybeReleaseClosedTransientState(connectedClient);
        const pendingClosedCreates = [...this.pendingTransientCreates]
          .filter(item => item.connection === connectedClient);
        if (pendingClosedCreates.length > 0) {
          // A broken transport may leave session/new unresolved forever. Give
          // late results a bounded drain window, then detach the bookkeeping
          // so the closed connection can be reclaimed.
          void this.drainPendingTransientCreates(pendingClosedCreates).finally(() => {
            // Once the bounded drain expires, late session/new results cannot
            // use this closed connection. Drop the pending markers so the
            // connection-level bookkeeping is reclaimable; the create's own
            // finally block may still call delete() harmlessly later.
            for (const item of pendingClosedCreates) {
              this.pendingTransientCreates.delete(item);
            }
            this.maybeReleaseClosedTransientState(connectedClient);
          });
        }
        void this.cleanupDiscoveryRecords(
          [...this.discoverySessions].filter(record => record.connection === connectedClient),
          closedCapabilities,
        ).catch(error => {
          this.log(`closed connection discovery cleanup failed: ${formatError(error)}`);
        });
        this.sessionDirectories.clear();
        this.sessionConfigOptions.clear();
        this.sessionActivationPromises.clear();
        this.sessionActivationEpochs.clear();
        this.discoveredConfigOptions.clear();
        this.discoveredModes.clear();
        this.discoveryPromises.clear();
        for (const handles of this.openStreams.values()) {
          for (const handle of handles) {handle.dispose();}
        }
        this.openStreams.clear();
        this.permissionResolvers.clear();
        this.permissionResolverConnections.clear();
        this.attemptedDiscoveryDirectories.clear();
        if (this.status !== 'stopped') {this.status = 'error';}
        this.log('ACP connection closed unexpectedly');
        connection?.dispose();
      });
      const initializeResponse = await clientConnection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            // ACP model/mode selectors are returned as session config options.
            // Advertise support so conforming agents include those options.
            session: { configOptions: { boolean: {} } },
          },
        },
      );
      if (!isCurrentStart()
          || this.clientConnection !== clientConnection
          || this.connection !== connection) {
        throw new Error('ACP backend start cancelled');
      }
      this.initializeResponse = initializeResponse;

      this.status = 'running';
      this.log(`started (${options.local ? 'local' : 'remote'}: ${this.getUrl()})`);
      return { data: { url: this.getUrl() ?? '', status: 'running' } };
    } catch (err) {
      if (clientConnection) {
        try {
          clientConnection.close(err);
        } catch {
          // Connection cleanup is best effort while start is unwinding.
        }
        if (this.clientConnection === clientConnection) {
          this.clientConnection = null;
        }
      }
      disposeConnection();
      if (connection && this.connection === connection) {this.connection = null;}
      if (generation === this.startGeneration) {
        if (this.app === app) {this.app = null;}
        if (this.clientConnection === clientConnection) {this.clientConnection = null;}
        if (this.initializeResponse && this.clientConnection === null) {
          this.initializeResponse = null;
        }
        this.workingDirectory = undefined;
        this.status = 'stopped';
        this.activeOptions = null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`start failed: ${msg}`);
      return { error: msg };
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const pendingStop = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopPromise = pendingStop;
    this.stopping = true;
    void this.performStop().then(
      () => {
        this.stopping = false;
        resolveStop();
      },
      error => {
        this.stopping = false;
        rejectStop(error);
      },
    );
    try {
      await pendingStop;
    } finally {
      if (this.stopPromise === pendingStop) {
        this.stopPromise = null;
      }
    }
  }

  private async performStop(): Promise<void> {
    this.startGeneration += 1;
    // Invalidate in-flight resume/discovery work before awaiting any resource
    // disposal. Late requests must observe a non-running backend and avoid
    // attaching helpers to a connection that is being torn down.
    this.status = 'stopped';
    const pending = this.startPromise;
    // Detach the pending start from the shared slot. A replacement start that
    // begins after this stop completes must not receive the stale promise,
    // even if the old transport takes longer than the bounded drain.
    if (pending && this.startPromise === pending) {
      this.startPromise = null;
    }
    const clientConnection = this.clientConnection;
    const lateConnection = this.connection;
    const pendingTransientCreates = clientConnection
      ? [...this.pendingTransientCreates].filter(item => item.connection === clientConnection)
      : [];
    const pendingDiscoveryCreates = clientConnection
      ? [...this.pendingDiscoveryCreates].filter(item => item.connection === clientConnection)
      : [];
    const sessionCapabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities;
    const oldDiscoverySessions = clientConnection
      ? [...this.discoverySessions].filter(record => record.connection === clientConnection)
      : [];
    // Explicit release/delete may already have removed the local marker while
    // its keyed remote operation is still in flight. Capture those states too
    // so stop() waits for and shares the same operation instead of bypassing it.
    const oldTransientCleanupStates = clientConnection
      ? [...(this.transientCleanupStates.get(clientConnection)?.values() ?? [])]
      : [];

    // Detach the old runtime before awaiting remote cleanup. A replacement
    // target may start while cleanup is in flight; it must be free to publish
    // its own connection and state without being cleared by this stop call.
    this.clientConnection = null;
    this.connection = null;
    this.app = null;
    this.activeOptions = null;
    this.workingDirectory = undefined;
    this.initializeResponse = null;

    for (const session of this.activeSessions.values()) {session.dispose();}
    this.activeSessions.clear();
    // Keep markers belonging to a replacement connection intact. Old records
    // are removed after their cleanup attempt below.
    const oldTransientSessions = clientConnection
      ? [...this.transientSessions].filter(record => record.connection === clientConnection)
      : [];
    // Claim the old discovery records from the live set immediately. Their
    // object identity is retained for the cleanup pass, while a replacement
    // runtime can publish records into the set without being touched here.
    for (const record of oldDiscoverySessions) {
      this.discoverySessions.delete(record);
    }
    this.sessionDirectories.clear();
    this.sessionActivationPromises.clear();
    this.sessionActivationEpochs.clear();
    this.sessionConfigOptions.clear();
    this.discoveredConfigOptions.clear();
    this.discoveredModes.clear();
    for (const handles of this.openStreams.values()) {
      for (const h of handles) {h.dispose();}
    }
    this.openStreams.clear();
    this.permissionResolvers.clear();
    this.permissionResolverConnections.clear();
    this.discoveryPromises.clear();
    this.attemptedDiscoveryDirectories.clear();
    if (clientConnection) {
      await Promise.all([
        pendingTransientCreates.length > 0
          ? this.drainPendingTransientCreates(pendingTransientCreates)
          : Promise.resolve(),
        pendingDiscoveryCreates.length > 0
          ? this.drainPendingDiscoveryCreates(pendingDiscoveryCreates)
          : Promise.resolve(),
      ]);
    }
    if (clientConnection) {
      // Include records that were published while pending creation drained.
      const transientRecords = [
        ...oldTransientSessions,
        ...[...this.transientSessions].filter(record => record.connection === clientConnection),
      ];
      await this.cleanupTransientRecords(transientRecords, sessionCapabilities);
      // A concurrent release/delete can have claimed a record before the
      // snapshot above. Sweep the keyed state map as well; terminal states are
      // no-ops and in-flight states are shared without duplicate requests.
      const transientStates = [
        ...oldTransientCleanupStates,
        ...[...(this.transientCleanupStates.get(clientConnection)?.values() ?? [])],
      ];
      await this.cleanupTransientStates(transientStates, sessionCapabilities);
    }
    if (clientConnection) {
      // A discovery request may have completed and registered its session
      // while the bounded drain was running. Sweep once after the drain so the
      // old connection's records are cleaned before it is closed.
      const discoveryRecords = [
        ...oldDiscoverySessions,
        ...[...this.discoverySessions].filter(record => record.connection === clientConnection),
      ];
      await this.cleanupDiscoveryRecords(discoveryRecords, sessionCapabilities);
      // Keep replacement records in the shared set; only remove old records.
      for (const record of [...this.discoverySessions]) {
        if (record.connection === clientConnection) {
          this.discoverySessions.delete(record);
        }
      }
    }
    if (clientConnection) {
      this.closedTransientConnections.add(clientConnection);
      try {
        clientConnection.close();
      } catch {
        // The connection may already have closed due to a transport error.
      }
      this.maybeReleaseClosedTransientState(clientConnection);
    }
    if (lateConnection) {
      lateConnection.dispose();
    }
    this.log('stopped');
    if (pending) {
      try {
        await withTimeout(pending, START_DRAIN_TIMEOUT_MS);
      } catch {
        // A hung initialize/connect must not block replacement startup. The
        // stale doStart path retains its own generation/identity guards and
        // will dispose any late transport when it eventually settles.
      }
    }
    // A transport can finish connecting after stop() has run. The generation
    // guard in doStart prevents publication and its local cleanup closes that
    // late transport without touching a replacement runtime.
  }

  /**
   * Best-effort cleanup for native model-provider sessions before the replaced
   * ACP connection is closed. Participant sessions are deliberately excluded.
   */
  private async drainPendingTransientCreates(
    pending: readonly PendingTransientCreate[],
  ): Promise<void> {
    let timedOut = false;
    try {
      await withTimeout(
        Promise.allSettled(pending.map(item => item.promise)),
        TRANSIENT_CREATE_DRAIN_TIMEOUT_MS,
      );
    } catch (error) {
      // A hung session/new request must not prevent the old transport from
      // closing. Any late transient result is guarded by its connection
      // identity and will attempt cleanup against this captured connection.
      this.log(
        `pending transient session creation drain failed for ${this.name}: ${formatError(error)}`,
      );
      timedOut = true;
    } finally {
      if (timedOut) {
        for (const item of pending) {
          this.pendingTransientCreates.delete(item);
        }
        if (pending[0]) {
          this.maybeReleaseClosedTransientState(pending[0].connection);
        }
      }
    }
  }

  private async drainPendingDiscoveryCreates(
    pending: readonly PendingDiscoveryCreate[],
  ): Promise<void> {
    try {
      await withTimeout(
        Promise.allSettled(pending.map(item => item.promise)),
        DISCOVERY_CREATE_DRAIN_TIMEOUT_MS,
      );
    } catch (error) {
      // Discovery is best effort. A hung session/new must not hold the old
      // transport open indefinitely; its late completion still carries the
      // captured connection and will attempt cleanup independently.
      this.log(
        `pending discovery session creation drain failed for ${this.name}: ${formatError(error)}`,
      );
    }
  }

  private async cleanupDiscoveryRecords(
    records: readonly DiscoverySessionRecord[],
    capabilities: SessionCapabilities | null | undefined,
  ): Promise<void> {
    await Promise.all(records.map(async record => {
      if (record.cleanupClaimed) {
        return;
      }
      record.cleanupClaimed = true;
      this.discoverySessions.delete(record);
      await this.cleanupDiscoverySession(record.id, record.connection, capabilities);
    }));
  }

  private getTransientCleanupState(
    connection: ClientConnection,
    id: string,
  ): TransientCleanupState {
    let byId = this.transientCleanupStates.get(connection);
    if (!byId) {
      byId = new Map<string, TransientCleanupState>();
      this.transientCleanupStates.set(connection, byId);
    }
    let state = byId.get(id);
    if (!state) {
      state = {
        connection,
        id,
        deleteAttempted: false,
        deleteSucceeded: false,
        closeAttempted: false,
        closeSucceeded: false,
        terminal: false,
      };
      byId.set(id, state);
    }
    return state;
  }

  private findTransientCleanupState(
    connection: ClientConnection,
    id: string,
  ): TransientCleanupState | undefined {
    return this.transientCleanupStates.get(connection)?.get(id);
  }

  private getTransientCleanupResult(
    connection: ClientConnection,
    id: string,
  ): TransientCleanupResult | undefined {
    return this.transientCleanupResults.get(connection)?.get(id);
  }

  private clearTransientCleanupResult(connection: ClientConnection, id: string): void {
    const byId = this.transientCleanupResults.get(connection);
    if (!byId) {return;}
    byId.delete(id);
    if (byId.size === 0) {
      this.transientCleanupResults.delete(connection);
    }
  }

  private hasPendingTransientCreate(connection: ClientConnection): boolean {
    for (const pending of this.pendingTransientCreates) {
      if (pending.connection === connection) {return true;}
    }
    return false;
  }

  private hasTransientCleanupOperation(connection: ClientConnection): boolean {
    for (const state of this.transientCleanupStates.get(connection)?.values() ?? []) {
      if (state.operation) {return true;}
    }
    return false;
  }

  private hasTransientMarker(connection: ClientConnection, id: string): boolean {
    for (const record of this.transientSessions) {
      if (record.connection === connection && record.id === id) {return true;}
    }
    return false;
  }

  /**
   * Completed cleanup state can be dropped once no create/marker can still
   * publish the same key. Keep the result as a tombstone so repeated release,
   * delete, or stale-create cleanup calls remain no-ops rather than issuing a
   * second remote request. A new transient create explicitly clears it.
   */
  private maybePruneTransientCleanupState(state: TransientCleanupState): void {
    if (!state.terminal || this.hasTransientMarker(state.connection, state.id)
        || this.hasPendingTransientCreate(state.connection) || state.operation) {
      return;
    }
    const byId = this.transientCleanupStates.get(state.connection);
    if (byId?.get(state.id) !== state) {return;}
    byId.delete(state.id);
    if (byId.size === 0) {
      this.transientCleanupStates.delete(state.connection);
    }
    let results = this.transientCleanupResults.get(state.connection);
    if (!results) {
      results = new Map<string, TransientCleanupResult>();
      this.transientCleanupResults.set(state.connection, results);
    }
    results.set(state.id, state.result ?? this.transientCleanupResult(state));
    this.maybeReleaseClosedTransientState(state.connection);
  }

  private maybeReleaseClosedTransientState(connection: ClientConnection): void {
    if (!this.closedTransientConnections.has(connection)
        || this.hasPendingTransientCreate(connection)
        || this.hasTransientCleanupOperation(connection)
        || this.hasTransientMarkerForConnection(connection)) {
      return;
    }
    this.transientCleanupStates.delete(connection);
    this.transientCleanupResults.delete(connection);
    // Keep the weak closed marker. A late create may run after this sweep and
    // must still be prevented from starting a request on the dead connection.
  }

  private hasTransientMarkerForConnection(connection: ClientConnection): boolean {
    for (const record of this.transientSessions) {
      if (record.connection === connection) {return true;}
    }
    return false;
  }

  private registerTransientSession(
    connection: ClientConnection,
    id: string,
    record: TransientSessionRecord,
  ): void {
    // A recycled id represents a new remote resource. Only reset a prior
    // state after its operation reached a terminal result; an in-flight state
    // must continue to own the key so concurrent cleanup cannot split requests.
    const existing = this.findTransientCleanupState(connection, id);
    if (existing?.terminal) {
      this.transientCleanupStates.get(connection)?.delete(id);
    }
    this.clearTransientCleanupResult(connection, id);
    this.getTransientCleanupState(connection, id);
    this.transientSessions.add(record);
  }

  /** Claim every local marker for a key before awaiting a remote request. */
  private claimTransientSession(connection: ClientConnection, id: string): TransientCleanupState {
    const state = this.findTransientCleanupState(connection, id)
      ?? this.completedTransientCleanupState(connection, id)
      ?? this.getTransientCleanupState(connection, id);
    for (const record of [...this.transientSessions]) {
      if (record.connection === connection && record.id === id) {
        record.cleanupClaimed = true;
        this.transientSessions.delete(record);
      }
    }
    return state;
  }

  private completedTransientCleanupState(
    connection: ClientConnection,
    id: string,
  ): TransientCleanupState | undefined {
    const result = this.getTransientCleanupResult(connection, id);
    if (!result) {return undefined;}
    return {
      connection,
      id,
      deleteAttempted: result.deleteSucceeded || result.deleteError !== undefined,
      deleteSucceeded: result.deleteSucceeded,
      deleteError: result.deleteError,
      closeAttempted: result.closeSucceeded || result.closeError !== undefined,
      closeSucceeded: result.closeSucceeded,
      closeError: result.closeError,
      terminal: true,
      result,
    };
  }

  private transientCleanupResult(state: TransientCleanupState): TransientCleanupResult {
    if (state.result) {return state.result;}
    return {
      deleteSucceeded: state.deleteSucceeded,
      closeSucceeded: state.closeSucceeded,
      deleteError: state.deleteError,
      closeError: state.closeError,
    };
  }

  /**
   * Run one keyed transient cleanup operation. Delete is always attempted
   * first when advertised; close is only attempted as its fallback (or when
   * delete is unavailable). Both requests are individually time-bounded.
   */
  private runTransientCleanup(
    state: TransientCleanupState,
    capabilities: SessionCapabilities | null | undefined,
  ): Promise<TransientCleanupResult> {
    if (state.operation) {
      return state.operation;
    }
    if (state.terminal) {
      return Promise.resolve(this.transientCleanupResult(state));
    }

    const canDelete = capabilities?.delete !== undefined && capabilities.delete !== null;
    const canClose = capabilities?.close !== undefined && capabilities.close !== null;
    const operation = Promise.resolve().then(async () => {
      if (!canDelete && !canClose) {
        this.log(
          `left transient ACP session ${state.id} because the agent `
            + 'advertises neither session/delete nor session/close',
        );
        state.terminal = true;
        state.result = this.transientCleanupResult(state);
        this.maybePruneTransientCleanupState(state);
        return state.result;
      }

      if (canDelete) {
        state.deleteAttempted = true;
        const attempt = await this.requestTransientCleanup(
          state.connection,
          state.id,
          methods.agent.session.delete,
        );
        state.deleteSucceeded = attempt.ok;
        state.deleteError = attempt.error;
        if (attempt.ok) {
          state.terminal = true;
          state.result = this.transientCleanupResult(state);
          this.maybePruneTransientCleanupState(state);
          return state.result;
        }
        if (canClose) {
          this.log(
            `transient session delete failed for ${state.id}; trying close: `
              + formatError(attempt.error),
          );
        } else {
          this.log(`transient session delete failed for ${state.id}: ${formatError(attempt.error)}`);
        }
      }

      if (canClose) {
        state.closeAttempted = true;
        const attempt = await this.requestTransientCleanup(
          state.connection,
          state.id,
          methods.agent.session.close,
        );
        state.closeSucceeded = attempt.ok;
        state.closeError = attempt.error;
        if (!attempt.ok) {
          this.log(`transient session close failed for ${state.id}: ${formatError(attempt.error)}`);
        }
      }

      state.terminal = true;
      state.result = this.transientCleanupResult(state);
      this.maybePruneTransientCleanupState(state);
      return state.result;
    });
    state.operation = operation.catch(error => {
      state.terminal = true;
      this.log(`transient session cleanup failed for ${state.id}: ${formatError(error)}`);
      state.result = this.transientCleanupResult(state);
      return state.result;
    });
    const shared = state.operation;
    void shared.then(
      result => {
        // Keep only the terminal result after the request settles. This lets
        // closed connections release their keyed maps while callers that
        // already captured the promise continue to observe the result.
        state.result = result;
        if (state.operation === shared) {
          state.operation = undefined;
        }
        this.maybePruneTransientCleanupState(state);
        this.maybeReleaseClosedTransientState(state.connection);
      },
      () => {
        // `shared` normally never rejects, but retain the same release guard
        // if an unexpected promise implementation does reject.
        if (state.operation === shared) {
          state.operation = undefined;
        }
        state.terminal = true;
        this.maybeReleaseClosedTransientState(state.connection);
      },
    );
    return shared;
  }

  private async requestTransientCleanup(
    connection: ClientConnection,
    sessionId: string,
    method: typeof methods.agent.session.delete | typeof methods.agent.session.close,
  ): Promise<TransientCleanupAttempt> {
    try {
      await withTimeout(
        connection.agent.request(method, { sessionId }),
        TRANSIENT_SESSION_CLEANUP_TIMEOUT_MS,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private async cleanupTransientSessions(
    clientConnection: ClientConnection,
    sessionIds: readonly string[],
    capabilities: SessionCapabilities | null | undefined,
  ): Promise<void> {
    await Promise.all(sessionIds.map(sessionId => {
      // A late session/new result can arrive after stop() has detached and
      // closed its connection. There is no useful request to send then, and
      // creating a fresh state would retain the dead connection indefinitely.
      if (this.closedTransientConnections.has(clientConnection)) {
        return Promise.resolve();
      }
      const state = this.claimTransientSession(clientConnection, sessionId);
      return this.runTransientCleanup(state, capabilities);
    }));
  }

  private async cleanupTransientRecords(
    records: readonly TransientSessionRecord[],
    capabilities: SessionCapabilities | null | undefined,
  ): Promise<void> {
    // Deduplicate by remote identity and claim all keys synchronously before
    // starting any request. This closes the stop/release/delete race window.
    const unique = new Map<ClientConnection, Set<string>>();
    for (const record of records) {
      let ids = unique.get(record.connection);
      if (!ids) {
        ids = new Set<string>();
        unique.set(record.connection, ids);
      }
      ids.add(record.id);
    }
    const states: TransientCleanupState[] = [];
    for (const [connection, ids] of unique) {
      if (this.closedTransientConnections.has(connection)) {continue;}
      for (const id of ids) {
        states.push(this.claimTransientSession(connection, id));
      }
    }
    await Promise.all(states.map(state => this.runTransientCleanup(state, capabilities)));
  }

  private async cleanupTransientStates(
    states: readonly TransientCleanupState[],
    capabilities: SessionCapabilities | null | undefined,
  ): Promise<void> {
    const unique = new Map<ClientConnection, Set<string>>();
    for (const state of states) {
      let ids = unique.get(state.connection);
      if (!ids) {
        ids = new Set<string>();
        unique.set(state.connection, ids);
      }
      ids.add(state.id);
    }
    const selected: TransientCleanupState[] = [];
    for (const [connection, ids] of unique) {
      if (this.closedTransientConnections.has(connection)) {continue;}
      for (const id of ids) {
        selected.push(this.claimTransientSession(connection, id));
      }
    }
    await Promise.all(selected.map(state => this.runTransientCleanup(state, capabilities)));
  }

  private async resolveOptions(): Promise<AcpBackendOptions> {
    const provided = await this.optionsProvider?.();
    return provided ?? this.options;
  }

  /** Return the long-lived agent context for this backend connection. */
  private getAgentContext(): ClientContext {
    const connection = this.clientConnection;
    if (!connection) {
      throw new Error('ACP backend not connected');
    }
    return connection.agent;
  }

  private isCurrentConnection(connection: ClientConnection | null, generation: number): boolean {
    return connection !== null
      && this.clientConnection === connection
      && this.startGeneration === generation
      && !this.stopping;
  }

  // -------------------------------------------------------------------------
  // Client-side request handlers
  // -------------------------------------------------------------------------

  private registerClientHandlers(connection: ClientConnection): void {
    if (!this.app) {return;}
    this.app.onRequest(methods.client.session.requestPermission, async (ctx) => {
      const params = ctx.params;
      const resolver = this.permissionResolvers.get(params.sessionId);
      if (resolver && this.permissionResolverConnections.get(params.sessionId) === connection) {
        return resolver(params);
      }
      this.log(`permission request rejected without active UI resolver: ${params.toolCall.toolCallId}`);
      return { outcome: { outcome: 'cancelled' } };
    });
  }

  /** Register a permission resolver for a session (called by pipeline wiring). */
  setPermissionResolver(sessionId: string, resolver: (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>): void {
    this.permissionResolvers.set(sessionId, resolver);
    const connection = this.clientConnection;
    if (connection) {
      this.permissionResolverConnections.set(sessionId, connection);
    } else {
      this.permissionResolverConnections.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // createPipeline
  // -------------------------------------------------------------------------

  createPipeline(options: BackendPipelineOptions): BackendPipeline<ActiveSessionMessage> {
    const pipeline = new AcpPipeline(options);
    this.setPermissionResolver(options.sessionId, (params) => pipeline.resolvePermission(params));
    return pipeline;
  }

  // -------------------------------------------------------------------------
  // Session operations
  // -------------------------------------------------------------------------

  readonly sessions: BackendSessionOperations = {
    create: async (opts) => {
      const connection = this.clientConnection;
      const generation = this.startGeneration;
      const capabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities;
      if (!connection || this.status !== 'running') {
        return { error: 'ACP backend not running' };
      }
      let pendingTransientCreate: PendingTransientCreate | undefined;
      let resolvePendingTransientCreate: (() => void) | undefined;
      if (opts?.transient) {
        const completion = new Promise<void>(resolve => {
          resolvePendingTransientCreate = resolve;
        });
        pendingTransientCreate = { promise: completion, connection };
        this.pendingTransientCreates.add(pendingTransientCreate);
      }
      try {
        const sessionStart = Promise.resolve().then(() => connection.agent
          .buildSession(opts?.directory ?? process.cwd())
          .start());
        const session: ActiveSession = await sessionStart;
        // stop()/target replacement may have invalidated this request while
        // the remote session/new call was in flight. Never publish a helper
        // created on the stale connection into the replacement runtime.
        if (this.clientConnection !== connection
            || this.status !== 'running'
            || this.startGeneration !== generation) {
          session.dispose();
          if (opts?.transient) {
            await this.cleanupTransientSessions(connection, [session.sessionId], capabilities);
          }
          return { error: 'ACP backend stopped while creating session' };
        }
        this.activeSessions.set(session.sessionId, session);
        this.sessionActivationEpochs.delete(session.sessionId);
        this.sessionDirectories.set(session.sessionId, opts?.directory ?? process.cwd());
        this.sessionConfigOptions.set(session.sessionId, session.newSessionResponse.configOptions ?? []);
        if (opts?.transient) {
          // Create the keyed state before publishing the marker so a concurrent
          // stop/release/delete sees the same remote identity immediately.
          this.registerTransientSession(
            connection,
            session.sessionId,
            { id: session.sessionId, connection, cleanupClaimed: false },
          );
        } else {
          // A normal participant session must never inherit a marker from a
          // recycled backend session id.
          for (const record of [...this.transientSessions]) {
            if (record.connection === connection && record.id === session.sessionId) {
              this.transientSessions.delete(record);
            }
          }
          this.transientCleanupStates.get(connection)?.delete(session.sessionId);
          this.clearTransientCleanupResult(connection, session.sessionId);
        }
        return { data: { id: session.sessionId, title: opts?.title ?? `${this.sessionTitlePrefix} ${session.sessionId.slice(0, 8)}`, createdAt: new Date() } };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        resolvePendingTransientCreate?.();
        if (pendingTransientCreate) {
          this.pendingTransientCreates.delete(pendingTransientCreate);
          for (const state of this.transientCleanupStates.get(pendingTransientCreate.connection)?.values() ?? []) {
            this.maybePruneTransientCleanupState(state);
          }
        }
      }
    },

    prompt: async (id: string, text: string, directory?: string, promptOptions?) => {
      const connection = this.clientConnection;
      const generation = this.startGeneration;
      const hasActiveSession = this.activeSessions.has(id);
      if ((!connection || this.status !== 'running' || !this.isCurrentConnection(connection, generation))
          && !hasActiveSession) {
        return { error: 'ACP backend not running' };
      }
      // Record the directory before awaiting a resume so a concurrently
      // opened event stream can resolve the same session with the same cwd.
      if (directory) {
        this.sessionDirectories.set(id, directory);
      }
      const session = this.activeSessions.get(id)
        ?? await this.activateSession(id, directory, connection, generation);
      if (!session) {return { error: `No active session ${id}` };}
      if (connection && (this.status !== 'running' || !this.isCurrentConnection(connection, generation))) {
        return { error: 'ACP backend changed while preparing prompt' };
      }
      if ((promptOptions?.model || promptOptions?.agent) && !connection) {
        return { error: 'ACP backend not running' };
      }
      try {
        if (promptOptions?.model) {
          await this.setSessionModel(id, promptOptions.model.modelID, connection!, generation);
        }
        if (promptOptions?.agent) {
          await this.setSessionMode(id, promptOptions.agent, connection!, generation);
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      if (connection && (this.status !== 'running' || !this.isCurrentConnection(connection, generation))) {
        return { error: 'ACP backend changed while preparing prompt' };
      }
      // Closing a stream with an in-flight read can rebind the local
      // ActiveSession helper. Never send this prompt through the disposed
      // helper captured before that rebind.
      if (this.activeSessions.get(id) !== session) {
        return { error: 'ACP session helper changed while preparing prompt' };
      }
      // Await the protocol request instead of detaching it.  ActiveSession
      // queues the matching `stop` message when the request resolves and
      // rejects its update queue when the request fails.  Returning success
      // before observing that promise would make callers wait forever for a
      // stop event that can never arrive after a transport/agent error.
      const promptContent = toAcpPromptContent(
        text,
        promptOptions?.attachments,
        this.initializeResponse?.agentCapabilities?.promptCapabilities,
      );
      try {
        await session.prompt(promptContent);
        // The ACP response can arrive after stop()/target replacement has
        // detached this connection. Do not report a successful prompt for a
        // stale runtime: its stop message belongs to the old session helper
        // and must not be used to complete the new runtime's turn.
        if (connection && !this.isCurrentConnection(connection, generation)) {
          return { error: 'ACP backend changed while prompt was running' };
        }
        if (this.activeSessions.get(id) !== session) {
          return { error: 'ACP session helper changed while prompt was running' };
        }
        return { data: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`prompt error: ${message}`);
        return { error: message };
      }
    },

    abort: async (id: string) => {
      const connection = this.clientConnection;
      const generation = this.startGeneration;
      if (!connection || this.status !== 'running' || !this.isCurrentConnection(connection, generation)) {
        return { data: false };
      }
      try {
        await connection.agent.notify(methods.agent.session.cancel, { sessionId: id });
        return { data: true };
      } catch (err) {
        this.log(`cancel error: ${err instanceof Error ? err.message : String(err)}`);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    release: async (id: string) => {
      this.invalidateSessionActivation(id);
      const session = this.activeSessions.get(id);
      const connection = this.clientConnection;
      const generation = this.startGeneration;
      const capabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities;
      const transientRecord = connection
        ? [...this.transientSessions].find(record => record.connection === connection && record.id === id)
        : undefined;
      const transientState = connection
        ? this.findTransientCleanupState(connection, id)
        : undefined;
      const completedTransientState = connection
        ? this.completedTransientCleanupState(connection, id)
        : undefined;
      if (session) {
        session.dispose();
      }
      this.activeSessions.delete(id);
      this.sessionDirectories.delete(id);
      this.sessionConfigOptions.delete(id);
      this.permissionResolvers.delete(id);
      this.permissionResolverConnections.delete(id);
      const handles = this.openStreams.get(id);
      if (handles) {
        for (const handle of handles) {handle.dispose();}
        this.openStreams.delete(id);
      }
      // Native model-provider sessions are disposable. Their cleanup is keyed
      // by connection + id and therefore shares an in-flight delete/close with
      // stop() or an explicit delete() call.
      if (connection && this.isCurrentConnection(connection, generation)
          && (transientRecord !== undefined || transientState !== undefined
            || completedTransientState !== undefined)) {
        try {
          const state = this.claimTransientSession(connection, id);
          const result = await this.runTransientCleanup(state, capabilities);
          if (result.deleteError || result.closeError) {
            this.log(
              `transient session release cleanup failed for ${id}: `
                + formatError(result.deleteError ?? result.closeError),
            );
          }
        } catch (error) {
          // Cleanup is best effort; the keyed operation has its own timeout.
          this.log(`transient session release failed for ${id}: ${formatError(error)}`);
        }
      } else if (session && connection && this.isCurrentConnection(connection, generation)
          && capabilities?.close && !capabilities.delete) {
        // Durable participant sessions are only closed when delete is not
        // advertised; close deliberately preserves their durable record.
        try {
          await withTimeout(
            connection.agent.request(methods.agent.session.close, { sessionId: id }),
            TRANSIENT_SESSION_CLEANUP_TIMEOUT_MS,
          );
        } catch (error) {
          this.log(`session close failed for ${id}: ${formatError(error)}`);
        }
      }
    },

    delete: async (id: string) => {
      const connection = this.clientConnection;
      const generation = this.startGeneration;
      if (!connection || !this.isCurrentConnection(connection, generation)) {
        return { error: 'ACP backend not running' };
      }
      const capabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities;
      if (!capabilities?.delete) {
        this.log(`session ${id} cannot be deleted: agent does not advertise session/delete`);
        return { data: false };
      }
      try {
        const transientRecord = [...this.transientSessions]
          .find(record => record.connection === connection && record.id === id);
        const transientState = this.findTransientCleanupState(connection, id);
        const completedTransientState = this.completedTransientCleanupState(connection, id);
        if (transientRecord || transientState || completedTransientState) {
          const state = transientState ?? completedTransientState;
          const claimedState = state ?? this.claimTransientSession(connection, id);
          if (state) {
            this.claimTransientSession(connection, id);
          }
          const result = await this.runTransientCleanup(claimedState, capabilities);
          // Preserve the public delete error when delete failed, even if the
          // close fallback released the remote resources successfully.
          if (!result.deleteSucceeded) {
            return {
              error: formatError(
                result.deleteError ?? result.closeError ?? 'Transient session deletion failed',
              ),
            };
          }
          return { data: true };
        } else {
          await withTimeout(
            connection.agent.request(methods.agent.session.delete, { sessionId: id }),
            TRANSIENT_SESSION_CLEANUP_TIMEOUT_MS,
          );
        }
        return { data: true };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },

    revert: async () => ({ error: 'ACP revert not implemented' }),
    list: async (directory?: string) => {
      if (!this.clientConnection) {return { data: [] as BackendSessionInfo[] };}
      try {
        const response = await this.getAgentContext().request(
          methods.agent.session.list,
          { cwd: directory ?? process.cwd() },
        );
        return {
          data: response.sessions.map(item => ({
            id: item.sessionId,
            title: item.title ?? `${this.sessionTitlePrefix} ${item.sessionId.slice(0, 8)}`,
            createdAt: new Date(item.updatedAt ?? Date.now()),
          })),
        };
      } catch {
        return { data: [] as BackendSessionInfo[] };
      }
    },
    children: async () => ({ data: [] as BackendSessionInfo[] }),
    descendants: () => [] as string[],
    status: async () => ({ data: {} as Record<string, BackendSessionStatus> }),
    findAncestor: () => undefined,
    parent: () => undefined,
    get: async (id: string, directory?: string) => {
      const active = this.activeSessions.get(id);
      if (active) {
        return {
          data: {
            id,
            title: active.meta && typeof active.meta.title === 'string'
              ? active.meta.title
              : `${this.sessionTitlePrefix} ${id.slice(0, 8)}`,
            createdAt: new Date(),
          },
        };
      }
      if (!this.clientConnection || this.status !== 'running') {
        return { error: 'ACP backend not running' };
      }
      try {
        const response = await this.getAgentContext().request(
          methods.agent.session.list,
          {
            cwd: directory
              ?? this.sessionDirectories.get(id)
              ?? this.workingDirectory
              ?? process.cwd(),
          },
        );
        const item = response.sessions.find(session => session.sessionId === id);
        if (!item) {
          return { error: `Session not found: ${id}` };
        }
        return {
          data: {
            id: item.sessionId,
            title: item.title ?? `${this.sessionTitlePrefix} ${id.slice(0, 8)}`,
            createdAt: new Date(item.updatedAt ?? Date.now()),
          },
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    update: async (id: string, opts: { title?: string }) => ({ data: { id, title: opts?.title ?? id, createdAt: new Date() } }),
    messages: async () => ({ data: { items: [] } as BackendMessageHistory }),
  };

  // -------------------------------------------------------------------------
  // Config operations (ACP agents own their config; minimal stubs)
  // -------------------------------------------------------------------------

  readonly config: BackendConfigOperations = {
    models: async (directory?: string) => {
      await this.ensureDiscovery(directory);
      return { data: this.getAdvertisedModels(directory) };
    },
    agents: async (directory?: string) => {
      await this.ensureDiscovery(directory);
      return { data: this.getAdvertisedModes(directory) };
    },
    get: async () => ({ data: {} as BackendConfig }),
    update: async () => ({ data: undefined }),
    updateGlobal: async () => ({ data: undefined }),
  };

  // -------------------------------------------------------------------------
  // Event operations — pipeline ACP's pull-based nextUpdate() to AsyncIterable
  // -------------------------------------------------------------------------

  readonly events: BackendEventOperations<ActiveSessionMessage> = {
    openSessionStream: (sessionId: string): BackendEventStream<ActiveSessionMessage> => {
      let disposed = false;
      let session: ActiveSession | undefined;
      let pendingReads = 0;
      // A stream can consume an ordinary update and be closed before its next
      // read observes the queued stop message. Keep that distinction from a
      // fully completed stream so a stale stop cannot become the first event
      // of the next turn.
      let readStarted = false;
      let stopConsumed = false;
      let wakeDisposed!: () => void;
      const disposedSignal = new Promise<void>((resolve) => {
        wakeDisposed = resolve;
      });

      const removeHandle = (): void => {
        if (!handle) {return;}
        const handles = this.openStreams.get(sessionId);
        if (!handles) {return;}
        handles.delete(handle);
        if (handles.size === 0) {
          this.openStreams.delete(sessionId);
        }
      };

      const close = (): void => {
        if (disposed) {return;}
        disposed = true;
        wakeDisposed();
        // `nextUpdate()` cannot be cancelled. If this stream was closed while
        // a read was pending, or after it consumed an update but before the
        // turn's stop, dispose the poisoned helper and attach a fresh local
        // helper from the same session response. The latter case protects
        // against a stop already queued in the SDK's AsyncQueue.
        if (session && (pendingReads > 0 || (readStarted && !stopConsumed))) {
          this.rebindSessionAfterStreamClose(sessionId, session);
        }
        removeHandle();
      };

      const iterable: AsyncIterable<ActiveSessionMessage> = {
        [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (disposed) {return { value: undefined as unknown as ActiveSessionMessage, done: true };}
              // Let a caller that opens the stream immediately before
              // `sessions.prompt()` publish its directory/resume intent first.
              // This keeps the generic open-stream-then-prompt ordering while
              // still allowing restored sessions to be activated lazily.
              await Promise.resolve();
              if (disposed) {
                return { value: undefined as unknown as ActiveSessionMessage, done: true };
              }
              // Session streams may be opened before `sessions.prompt()`. This
              // is required by the generic pipeline contract, but a restored
              // ACP session is not active until it is resumed. Resolve it at
              // consumption time so the stream remains bound to the resumed
              // ActiveSession instead of terminating against an empty handle.
              session ??= await this.activateSession(
                sessionId,
                this.sessionDirectories.get(sessionId) ?? this.workingDirectory,
              );
              if (disposed || !session) {
                return { value: undefined as unknown as ActiveSessionMessage, done: true };
              }
              readStarted = true;
              pendingReads += 1;
              try {
                // `ActiveSession.dispose()` would cancel every consumer that
                // shares this helper. Race the current read against this
                // stream's private close signal instead, so closing one
                // pipeline wakes it without tearing down the durable session.
                const msg = await Promise.race([
                  session.nextUpdate(),
                  disposedSignal.then(() => undefined),
                ]);
                if (disposed || !msg) {
                  return { value: undefined as unknown as ActiveSessionMessage, done: true };
                }
                if (msg.kind === 'stop') {
                  stopConsumed = true;
                }
                return { value: msg, done: false };
              } catch {
                return { value: undefined as unknown as ActiveSessionMessage, done: true };
              } finally {
                pendingReads -= 1;
              }
            },
            return: async () => {
              close();
              return { value: undefined as unknown as ActiveSessionMessage, done: true };
            },
          }),
      };

      const handle: OpenStreamHandle = {
        stream: { stream: iterable },
        dispose: close,
      };
      let handles = this.openStreams.get(sessionId);
      if (!handles) {handles = new Set(); this.openStreams.set(sessionId, handles);}
      handles.add(handle);
      return handle.stream;
    },

    openGlobalStream: async () => {
      return { stream: (async function* empty() { /* ACP has no global stream */ })() };
    },

    closeSessionStream: (sessionId: string) => {
      const handles = this.openStreams.get(sessionId);
      if (handles) {
        for (const h of handles) {h.dispose();}
        handles.clear();
        this.openStreams.delete(sessionId);
      }
    },

    ensureStarted: async () => {
      // Connection established in start(); no-op here.
    },
  };

  /**
   * Replace an ActiveSession whose queue has an abandoned nextUpdate waiter.
   * The protocol session itself remains alive; only the local notification
   * router/queue is replaced. The identity check prevents an old stream from
   * disposing a helper that a newer activation already installed.
   */
  private rebindSessionAfterStreamClose(sessionId: string, poisoned: ActiveSession): void {
    if (this.activeSessions.get(sessionId) !== poisoned) {
      return;
    }
    const connection = this.clientConnection;
    const response = poisoned.newSessionResponse as unknown as Record<string, unknown>;
    poisoned.dispose();
    this.activeSessions.delete(sessionId);
    if (!connection || this.status !== 'running') {
      return;
    }
    const attach = (connection.agent as unknown as {
      attachSession?: (value: Record<string, unknown>) => ActiveSession;
    }).attachSession;
    if (typeof attach !== 'function') {
      return;
    }
    try {
      const replacement = attach.call(connection.agent, { ...response });
      if (this.clientConnection !== connection || this.status !== 'running') {
        replacement.dispose();
        return;
      }
      this.activeSessions.set(sessionId, replacement);
      this.sessionConfigOptions.set(sessionId, replacement.newSessionResponse.configOptions ?? []);
    } catch (error) {
      this.log(`session helper rebind failed for ${sessionId}: ${formatError(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Permission / Question / Auth operations
  // -------------------------------------------------------------------------
  //
  // ACP permissions are handled by the blocking request_permission handler.
  // The reply-style operations below are OpenCode-SSE artifacts; they are
  // no-ops here (the actual reply is the requestPermission handler resolution).

  readonly permissions: BackendPermissionOperations = {
    reply: async () => {},
  };

  readonly questions: BackendQuestionOperations = {
    reply: async () => ({ data: true }),
    reject: async () => ({ data: true }),
  };

  readonly auth: BackendAuthOperations = {
    setKey: async () => ({ data: undefined }),
    removeKey: async () => ({ data: undefined }),
  };

  /**
   * Return an active helper for a session, resuming it once when necessary.
   * The stream consumer and prompt caller can arrive in either order; sharing
   * this promise prevents two ActiveSession helpers from competing for the
   * same ACP notifications.
   */
  private async activateSession(
    id: string,
    directory?: string,
    expectedConnection?: ClientConnection | null,
    expectedGeneration?: number,
  ): Promise<ActiveSession | undefined> {
    const active = this.activeSessions.get(id);
    if (active) {return active;}

    const existing = this.sessionActivationPromises.get(id);
    if (existing) {return existing;}

    const connection = expectedConnection === undefined
      ? this.clientConnection
      : expectedConnection;
    const generation = expectedGeneration ?? this.startGeneration;
    if (!connection || this.status !== 'running' || !this.isCurrentConnection(connection, generation)) {return undefined;}
    const epoch = this.sessionActivationEpochs.get(id) ?? 0;
    const pending = this.resumeSessionOnConnection(id, directory, connection, epoch);
    this.sessionActivationPromises.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.sessionActivationPromises.get(id) === pending) {
        this.sessionActivationPromises.delete(id);
      }
    }
  }

  private async resumeSessionOnConnection(
    id: string,
    directory: string | undefined,
    connection: ClientConnection,
    epoch: number,
  ): Promise<ActiveSession | undefined> {
    if (this.clientConnection !== connection
        || this.status !== 'running'
        || (this.sessionActivationEpochs.get(id) ?? 0) !== epoch) {
      return undefined;
    }
    const cwd = directory ?? this.sessionDirectories.get(id) ?? this.workingDirectory ?? process.cwd();
    try {
      const ctx = connection.agent;
      let response: Record<string, unknown>;
      try {
        response = await ctx.request(methods.agent.session.resume, {
          sessionId: id,
          cwd,
          mcpServers: [],
        }) as Record<string, unknown>;
      } catch {
        response = await ctx.request(methods.agent.session.load, {
          sessionId: id,
          cwd,
          mcpServers: [],
        }) as Record<string, unknown>;
      }
      const attach = (ctx as unknown as {
        attachSession(value: Record<string, unknown>): ActiveSession;
      }).attachSession;
      if (typeof attach !== 'function') {return undefined;}
      const session = attach.call(ctx, { sessionId: id, ...response });
      if (!session) {return undefined;}
      // A stop/restart may have completed the request while it was in flight.
      // Do not attach a helper created on the stale connection to the new one.
      if (this.clientConnection !== connection
          || this.status !== 'running'
          || (this.sessionActivationEpochs.get(id) ?? 0) !== epoch) {
        session.dispose();
        return undefined;
      }
      this.activeSessions.set(id, session);
      this.sessionDirectories.set(id, cwd);
      this.sessionConfigOptions.set(id, session.newSessionResponse.configOptions ?? []);
      return session;
    } catch (err) {
      this.log(`resume failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private invalidateSessionActivation(id: string): void {
    this.sessionActivationEpochs.set(id, (this.sessionActivationEpochs.get(id) ?? 0) + 1);
    this.sessionActivationPromises.delete(id);
  }

  private async setSessionModel(
    sessionId: string,
    modelId: string,
    connection: ClientConnection,
    generation: number,
  ): Promise<void> {
    const options = this.sessionConfigOptions.get(sessionId) ?? [];
    const selector = options.find(option => option.type === 'select' && option.category === 'model');
    if (!selector || selector.type !== 'select' || selector.currentValue === modelId) {return;}
    const response = await this.requestSessionConfigOption(
      sessionId,
      selector.id,
      modelId,
      connection,
      generation,
    );
    if (!this.isCurrentConnection(connection, generation)) {
      throw new Error('ACP backend changed while selecting model');
    }
    this.sessionConfigOptions.set(sessionId, response.configOptions);
  }

  private async setSessionMode(
    sessionId: string,
    modeId: string,
    connection: ClientConnection,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentConnection(connection, generation)) {
      throw new Error('ACP backend changed while selecting mode');
    }
    await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId });
    if (!this.isCurrentConnection(connection, generation)) {
      throw new Error('ACP backend changed while selecting mode');
    }
  }

  private async requestSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
    connection: ClientConnection,
    generation: number,
  ) {
    if (!this.isCurrentConnection(connection, generation)) {
      throw new Error('ACP backend changed while selecting model');
    }
    return connection.agent.request(
      methods.agent.session.setConfigOption,
      { sessionId, configId, value },
    );
  }

  /**
   * ACP exposes model and mode choices as per-session config data rather than
   * through a global catalog endpoint. Create one discovery session per
   * connection/workspace so the Copilot model picker can populate before the
   * user opens a chat session. The session is never registered as active.
   */
  private async ensureDiscovery(directory?: string): Promise<void> {
    if (!this.clientConnection || this.status !== 'running') {
      return;
    }
    const cwd = normalizeDirectory(directory);
    if (this.attemptedDiscoveryDirectories.has(cwd)) {
      return;
    }
    const existing = this.discoveryPromises.get(cwd);
    if (existing) {
      await existing;
      return;
    }

    this.attemptedDiscoveryDirectories.add(cwd);
    const pending = this.discover(cwd);
    this.discoveryPromises.set(cwd, pending);
    try {
      await pending;
    } finally {
      if (this.discoveryPromises.get(cwd) === pending) {
        this.discoveryPromises.delete(cwd);
      }
    }
  }

  private async discover(directory: string): Promise<void> {
    let session: ActiveSession | undefined;
    let discoveryRecord: DiscoverySessionRecord | undefined;
    const clientConnection = this.clientConnection;
    // Keep the capability snapshot paired with the connection that created the
    // discovery session. A target switch clears initializeResponse, but the
    // old connection is still the only safe place to send its cleanup request.
    const sessionCapabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!clientConnection || this.status !== 'running') {
      return;
    }
    const cancellation = new AbortController();
    let resolvePendingDiscoveryCreate!: () => void;
    const pendingDiscoveryCreate: PendingDiscoveryCreate = {
      connection: clientConnection,
      promise: new Promise<void>(resolve => {
        resolvePendingDiscoveryCreate = resolve;
      }),
    };
    this.pendingDiscoveryCreates.add(pendingDiscoveryCreate);

    // Start asynchronously so a synchronous SDK error still follows the same
    // pending-create and cleanup bookkeeping as a rejected session/new call.
    const sessionStart = Promise.resolve().then(() =>
      clientConnection.agent.buildSession(directory).start({
        cancellationSignal: cancellation.signal,
      }),
    );
    let lateCleanup: Promise<unknown> | undefined;
    const settlePendingDiscoveryCreate = (): void => {
      resolvePendingDiscoveryCreate();
      this.pendingDiscoveryCreates.delete(pendingDiscoveryCreate);
    };

    const registerDiscoverySession = (value: ActiveSession): DiscoverySessionRecord => {
      const record: DiscoverySessionRecord = {
        id: value.sessionId,
        connection: clientConnection,
        cleanupClaimed: false,
      };
      this.discoverySessions.add(record);
      return record;
    };

    try {
      session = await withTimeout(sessionStart, DISCOVERY_TIMEOUT_MS);
      discoveryRecord = registerDiscoverySession(session);
      // A stop/restart may complete the request on a newer connection. Never
      // publish data learned from the stale connection into the new catalog.
      if (this.clientConnection === clientConnection && this.status === 'running') {
        this.discoveredConfigOptions.set(
          directory,
          session.newSessionResponse.configOptions ?? [],
        );
        this.discoveredModes.set(
          directory,
          session.modes?.availableModes ?? [],
        );
      }
    } catch (error) {
      // ACP cancellation is cooperative, so a timed-out request may still
      // resolve later. Dispose and clean that late helper without allowing it
      // to attach to the active connection or leak an ephemeral remote session.
      cancellation.abort();
      lateCleanup = sessionStart.then(
        lateSession => {
          lateSession.dispose();
          const record = registerDiscoverySession(lateSession);
          return this.cleanupDiscoveryRecords([record], sessionCapabilities);
        },
        () => {
          // The request may reject after the timeout/cancellation; it is
          // already represented by the original discovery failure.
        },
      );
      // Observe late cleanup failures and keep the pending marker alive until
      // the late session/new promise has settled (or stop()'s bounded drain
      // expires). This avoids an unhandled rejection without delaying the
      // caller past the discovery timeout.
      lateCleanup = lateCleanup.catch(lateError => {
        this.log(`late model discovery cleanup failed for ${directory}: ${formatError(lateError)}`);
      });
      // A backend may not implement session config options. Keep discovery
      // best-effort so ordinary ACP chat remains usable.
      // A replacement runtime may already have started discovery for the same
      // workspace. Only the connection that owns this failed attempt may
      // clear its retry marker.
      if (this.clientConnection === clientConnection && this.status === 'running') {
        this.attemptedDiscoveryDirectories.delete(directory);
      }
      this.log(`model discovery failed for ${directory}: ${formatError(error)}`);
      return;
    } finally {
      try {
        if (session) {
          session.dispose();
          if (discoveryRecord) {
            await this.cleanupDiscoveryRecords([discoveryRecord], sessionCapabilities);
          } else {
            // A stop may have claimed and removed the record while this finally
            // block was waiting. Do not issue a duplicate request.
          }
        }
      } finally {
        if (lateCleanup) {
          void lateCleanup.finally(() => {
            settlePendingDiscoveryCreate();
          });
        } else {
          settlePendingDiscoveryCreate();
        }
      }
    }
  }

  private async cleanupDiscoverySession(
    sessionId: string,
    clientConnection: ClientConnection,
    capabilities: SessionCapabilities | null | undefined,
  ): Promise<void> {
    const canDelete = capabilities?.delete !== undefined && capabilities.delete !== null;
    const canClose = capabilities?.close !== undefined && capabilities.close !== null;
    if (!canDelete && !canClose) {
      this.log(
        `model discovery session ${sessionId} left remote because the agent `
          + 'advertises neither session/delete nor session/close',
      );
      return;
    }

    // The captured connection is intentional. It prevents a reused session id
    // from being sent to a replacement target after a restart.
    if (canDelete) {
      try {
        await withTimeout(
          clientConnection.agent.request(methods.agent.session.delete, { sessionId }),
          2_000,
        );
        return;
      } catch (error) {
        if (!canClose) {
          this.log(
            `model discovery session cleanup failed for ${sessionId}: ${formatError(error)}`,
          );
          return;
        }
        this.log(
          `model discovery session delete failed for ${sessionId}; trying close: ${formatError(error)}`,
        );
      }
    }

    if (canClose) {
      try {
        await withTimeout(
          clientConnection.agent.request(methods.agent.session.close, { sessionId }),
          2_000,
        );
      } catch (error) {
        // Cleanup is deliberately best effort: some agents advertise a
        // capability but reject cleanup for ephemeral sessions.
        this.log(
          `model discovery session close failed for ${sessionId}: ${formatError(error)}`,
        );
      }
    }
  }

  private getAdvertisedModels(directory?: string) {
    const models = new Map<string, { id: string; name: string; provider: string }>();
    const cwd = directory ? normalizeDirectory(directory) : undefined;
    const discovered = cwd
      ? [this.discoveredConfigOptions.get(cwd) ?? []]
      : [...this.discoveredConfigOptions.values()];
    const active = cwd
      ? [...this.sessionConfigOptions.entries()]
          .filter(([sessionId]) => this.sessionDirectories.get(sessionId) === cwd)
          .map(([, options]) => options)
      : [...this.sessionConfigOptions.values()];
    for (const options of [...discovered, ...active]) {
      for (const option of options) {
        if (option.type !== 'select' || option.category !== 'model') {continue;}
        for (const item of flattenSelectOptions(option.options)) {
          models.set(item.value, { id: item.value, name: item.name, provider: this.name });
        }
      }
    }
    return [...models.values()];
  }

  private getAdvertisedModes(directory?: string) {
    const advertisedModes = new Map<string, { id: string; name: string; description?: string; mode: 'primary' }>();
    const cwd = directory ? normalizeDirectory(directory) : undefined;
    const discovered = cwd
      ? [this.discoveredModes.get(cwd) ?? []]
      : [...this.discoveredModes.values()];
    const active = [...this.activeSessions.entries()]
      .filter(([sessionId]) => !cwd || this.sessionDirectories.get(sessionId) === cwd)
      .map(([, session]) => session.modes?.availableModes ?? []);
    const allModeLists = [...discovered, ...active];
    for (const availableModes of allModeLists) {
      for (const mode of availableModes) {
        advertisedModes.set(mode.id, {
          id: mode.id,
          name: mode.name,
          description: mode.description ?? undefined,
          mode: 'primary',
        });
      }
    }
    return [...advertisedModes.values()];
  }
}

function flattenSelectOptions(options: Extract<SessionConfigOption, { type: 'select' }>['options']) {
  return options.flatMap(item => 'options' in item ? item.options : [item]);
}

interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/**
 * Convert the backend-neutral attachment shape into ACP prompt content.
 *
 * Resource links are part of ACP's baseline prompt capability, so they are
 * used for file/remote URLs and as a fallback when an agent has not opted in
 * to binary image/audio or embedded-resource blocks. Data URLs can be lifted
 * into binary blocks when the corresponding capability is advertised.
 */
function toAcpPromptContent(
  text: string,
  attachments: readonly BackendFileAttachment[] | undefined,
  capabilities: AcpPromptCapabilities | null | undefined,
): string | ContentBlock[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const blocks: ContentBlock[] = [];
  attachments.forEach((attachment, index) => {
    const url = attachment.url.trim();
    if (!url) {
      return;
    }
    const name = attachment.filename?.trim() || `attachment-${index + 1}`;
    const parsed = parseDataUri(url);
    const mimeType = attachment.mime.trim() || parsed?.mimeType || 'application/octet-stream';

    if (parsed && mimeType.toLowerCase().startsWith('image/') && capabilities?.image === true) {
      blocks.push({
        type: 'image',
        mimeType,
        data: parsed.data,
      });
      return;
    }
    if (parsed && mimeType.toLowerCase().startsWith('audio/') && capabilities?.audio === true) {
      blocks.push({
        type: 'audio',
        mimeType,
        data: parsed.data,
      });
      return;
    }
    if (parsed && capabilities?.embeddedContext === true) {
      blocks.push({
        type: 'resource',
        resource: {
          uri: `attachment://${encodeURIComponent(name)}`,
          blob: parsed.data,
          mimeType,
        },
      });
      return;
    }

    blocks.push({
      type: 'resource_link',
      uri: url,
      name,
      mimeType,
    });
  });

  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  }
  return blocks.length > 0 ? blocks : text;
}

interface ParsedDataUri {
  mimeType: string;
  data: string;
}

/** Parse a data URI and normalize its payload to ACP's base64 representation. */
function parseDataUri(value: string): ParsedDataUri | undefined {
  if (!value.toLowerCase().startsWith('data:')) {
    return undefined;
  }
  const comma = value.indexOf(',');
  if (comma < 0) {
    return undefined;
  }
  const metadata = value.slice(5, comma).split(';');
  const mimeType = metadata.shift()?.trim() || 'text/plain';
  const payload = value.slice(comma + 1);
  if (metadata.some(item => item.trim().toLowerCase() === 'base64')) {
    return { mimeType, data: payload.replace(/\s+/g, '') };
  }
  try {
    return {
      mimeType,
      data: Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64'),
    };
  } catch {
    return undefined;
  }
}

function normalizeDirectory(directory?: string): string {
  const value = directory?.trim();
  return value ? value : process.cwd();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
