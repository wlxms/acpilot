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
 *   sync `AcpEventStream` wrapping an `AsyncIterable<TEvent>`. ACP's model is
 *   pull-based (`nextUpdate()`), so the adapter bridges by holding the
 *   `ActiveSession` per session id and exposing its `nextUpdate()` as an async
 *   iterable that yields `ActiveSessionMessage` until `stop`.
 * - Permissions: ACP's `session/request_permission` is a blocking JSON-RPC
 *   request the agent awaits. The handler is registered via
 *   `client().onRequest(methods.client.session.requestPermission, ...)` and
 *   resolves when the ExternalEditSSP baseline capture completes (see
 *   AcpBridge). This reuses the OpenCode-origin snapshot mechanism with the
 *   filepath sourced from the tool call input (filepath-resolver.ts).
 *
 * @module
 */

import {
  client,
  PROTOCOL_VERSION,
  methods,
  type ClientApp,
  type ClientContext,
  type Stream,
  type ActiveSession,
  type ActiveSessionMessage,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  BackendBridge,
  Backend,
  BackendSessionOperations,
  BackendConfigOperations,
  AcpEventOperations,
  AcpEventStream,
  BackendPermissionOperations,
  BackendQuestionOperations,
  BackendAuthOperations,
} from '../../backend/backend';
import type {
  BackendResult,
  BackendServerInfo,
  BackendSessionInfo,
  BackendSessionStatus,
  BackendConfig,
  BackendMessageHistory,
  BackendServerStatus,
} from '../../backend/types';
import { AcpBridge } from './bridge';
import { spawnAcpAgent, connectAcpRemote, type LocalSpawnOptions, type RemoteConnectOptions } from './transport';

export interface AcpBackendOptions {
  /** Local spawn configuration (mutually exclusive with `remote`).). */
  local?: LocalSpawnOptions;
  /** Remote WebSocket configuration (mutually exclusive with `local`). */
  remote?: RemoteConnectOptions;
  /** Logger sink (defaults to no-op). */
  logger?: { appendLine(message: string): void };
}

interface OpenStreamHandle {
  stream: AcpEventStream<ActiveSessionMessage>;
  dispose: () => void;
}

export class AcpBackend implements Backend<ActiveSessionMessage> {
  readonly name = 'acp';
  private log: (m: string) => void = () => {};

  private app: ClientApp | null = null;
  private connection: { stream: Stream; dispose: () => void } | null = null;
  private status: BackendServerStatus = 'stopped';

  /** Active sessions keyed by session id (for event streaming + prompt/cancel). */
  private readonly activeSessions = new Map<string, ActiveSession>();

  /** Per-session open stream handles (sessionId → handles). */
  private readonly openStreams = new Map<string, Set<OpenStreamHandle>>();

  /** Per-session permission resolvers (set by bridge wiring). */
  private readonly permissionResolvers = new Map<string, (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>>();

  constructor(private readonly options: AcpBackendOptions) {
    if (options.logger) {this.log = (m) => options.logger!.appendLine(`[acp-backend] ${m}`);}
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  getUrl(): string | null {
    return this.options.remote?.url ?? 'local';
  }

  getStatus(): BackendServerStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  async start(directory?: string): Promise<BackendResult<BackendServerInfo>> {
    if (this.status === 'running' || this.status === 'starting') {
      return { data: { url: this.getUrl() ?? '', status: this.status } };
    }
    this.status = 'starting';
    try {
      // 1. Establish the transport stream.
      let stream: Stream;
      let dispose: () => void;
      if (this.options.local) {
        const spawned = spawnAcpAgent({ ...this.options.local, cwd: this.options.local.cwd ?? directory });
        stream = spawned.stream;
        const child = spawned.process;
        dispose = () => { child.kill(); };
      } else if (this.options.remote) {
        stream = await connectAcpRemote(this.options.remote);
        dispose = () => { /* WS streams close on GC */ };
      } else {
        throw new Error('AcpBackend requires either `local` or `remote` transport options');
      }
      this.connection = { stream, dispose };

      // 2. Build the client app + register the permission request handler.
      this.app = client({ name: 'acpilot-acp-backend' });
      this.registerClientHandlers();

      // 3. Connect and initialize.
      await this.app.connectWith(stream, async (ctx: ClientContext) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        });
      });

      this.status = 'running';
      this.log(`started (${this.options.local ? 'local' : 'remote'}: ${this.getUrl()})`);
      return { data: { url: this.getUrl() ?? '', status: 'running' } };
    } catch (err) {
      this.status = 'stopped';
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`start failed: ${msg}`);
      return { error: msg };
    }
  }

  async stop(): Promise<void> {
    for (const session of this.activeSessions.values()) {session.dispose();}
    this.activeSessions.clear();
    for (const handles of this.openStreams.values()) {
      for (const h of handles) {h.dispose();}
    }
    this.openStreams.clear();
    if (this.connection) {this.connection.dispose(); this.connection = null;}
    this.app = null;
    this.status = 'stopped';
    this.log('stopped');
  }

  // -------------------------------------------------------------------------
  // Client-side request handlers
  // -------------------------------------------------------------------------

  private registerClientHandlers(): void {
    if (!this.app) {return;}
    this.app.onRequest(methods.client.session.requestPermission, async (ctx) => {
      const params = ctx.params;
      const resolver = this.permissionResolvers.get(params.sessionId);
      if (resolver) {return resolver(params);}
      // No resolver: auto-accept the first allow option, else cancel.
      const allowOption = params.options.find(o => o.kind.startsWith('allow')) ?? params.options[0];
      if (!allowOption) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
    });
  }

  /** Register a permission resolver for a session (called by bridge wiring). */
  setPermissionResolver(sessionId: string, resolver: (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>): void {
    this.permissionResolvers.set(sessionId, resolver);
  }

  // -------------------------------------------------------------------------
  // createBridge
  // -------------------------------------------------------------------------

  createBridge(sessionId: string, _directory?: string): BackendBridge<ActiveSessionMessage> {
    return new AcpBridge(sessionId);
  }

  // -------------------------------------------------------------------------
  // Session operations
  // -------------------------------------------------------------------------

  readonly sessions: BackendSessionOperations = {
    create: async (opts) => {
      if (!this.app || !this.connection || this.status !== 'running') {
        return { error: 'ACP backend not running' };
      }
      try {
        const session = await this.app.connectWith(this.connection.stream, async (ctx: ClientContext) => {
          return ctx.buildSession(opts?.directory ?? process.cwd()).start();
        });
        this.activeSessions.set(session.sessionId, session);
        return { data: { id: session.sessionId, title: opts?.title ?? `ACP Session ${session.sessionId.slice(0, 8)}`, createdAt: new Date() } };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    prompt: async (id: string, text: string) => {
      const session = this.activeSessions.get(id);
      if (!session) {return { error: `No active session ${id}` };}
      // Fire the prompt; updates arrive via nextUpdate() (events stream).
      void session.prompt(text).catch((e) => this.log(`prompt error: ${e instanceof Error ? e.message : String(e)}`));
      return { data: true };
    },

    abort: async (id: string) => {
      if (!this.app || !this.connection) {return { data: false };}
      try {
        await this.app.connectWith(this.connection.stream, async (ctx: ClientContext) => {
          await ctx.notify(methods.agent.session.cancel, { sessionId: id });
        });
        return { data: true };
      } catch (err) {
        this.log(`cancel error: ${err instanceof Error ? err.message : String(err)}`);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    revert: async () => ({ error: 'ACP revert not implemented' }),
    list: async () => ({ data: [] as BackendSessionInfo[] }),
    children: async () => ({ data: [] as BackendSessionInfo[] }),
    descendants: () => [] as string[],
    status: async () => ({ data: {} as Record<string, BackendSessionStatus> }),
    findAncestor: () => undefined,
    parent: () => undefined,
    get: async (id: string) => ({ data: { id, title: `ACP Session ${id.slice(0, 8)}`, createdAt: new Date() } }),
    update: async (id: string, opts: { title?: string }) => ({ data: { id, title: opts?.title ?? id, createdAt: new Date() } }),
    messages: async () => ({ data: { items: [] } as BackendMessageHistory }),
  };

  // -------------------------------------------------------------------------
  // Config operations (ACP agents own their config; minimal stubs)
  // -------------------------------------------------------------------------

  readonly config: BackendConfigOperations = {
    models: async () => ({ data: [] }),
    agents: async () => ({ data: [] }),
    get: async () => ({ data: {} as BackendConfig }),
    update: async () => ({ data: undefined }),
    updateGlobal: async () => ({ data: undefined }),
  };

  // -------------------------------------------------------------------------
  // Event operations — bridge ACP's pull-based nextUpdate() to AsyncIterable
  // -------------------------------------------------------------------------

  readonly events: AcpEventOperations<ActiveSessionMessage> = {
    openSessionStream: (sessionId: string): AcpEventStream<ActiveSessionMessage> => {
      const session = this.activeSessions.get(sessionId);
      let disposed = false;

      const iterable: AsyncIterable<ActiveSessionMessage> = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              if (disposed || !session) {return { value: undefined as unknown as ActiveSessionMessage, done: true };}
              try {
                const msg = await session.nextUpdate();
                return { value: msg, done: false };
              } catch {
                return { value: undefined as unknown as ActiveSessionMessage, done: true };
              }
            },
            return: async () => {
              disposed = true;
              return { value: undefined as unknown as ActiveSessionMessage, done: true };
            },
          };
        },
      };

      const handle: OpenStreamHandle = {
        stream: { stream: iterable },
        dispose: () => { disposed = true; },
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
      }
    },

    ensureStarted: async () => {
      // Connection established in start(); no-op here.
    },
  };

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
}
