/**
 * OpenCode backend adapter - concrete Backend implementation.
 *
 * Maps every ACP operation to the OpenCode SDK, reusing
 * OpenCodeServerManager for lifecycle and GlobalEventBroker
 * for event multiplexing. No VSCode imports.
 */

import { OpenCodeServerManager } from '../../opencode/server';
import { GlobalEventBroker } from './event-broker';
import type {
  Backend,
  BackendPipeline,
  BackendPipelineOptions,
  BackendSessionOperations,
  BackendConfigOperations,
  BackendEventOperations,
  BackendPermissionOperations,
  BackendQuestionOperations,
  BackendEventStream,
  BackendAuthOperations,
  BackendModelProvider,
  BackendModelOptions,
} from '../../backend/backend';
import type { PermissionMode } from '../../backend/types';
import type {
  BackendServerInfo,
  BackendServerStatus,
  BackendSessionInfo,
  BackendModel,
  BackendAgent,
  BackendConfig,
  BackendFileAttachment,
  BackendResult,
  BackendPermissionResponse,
  BackendMessageHistory,
  BackendHistoryMessage,
} from '../../backend/types';
import type { OpenCodeStreamEvent } from './sdk-events';
import type { OpenCodeClient, SdkAgentData, SdkProvider } from './sdk-types';
import { OpenCodePipeline } from './pipeline';
import { OpenCodeSettingsProvider } from './settings';
import { createSessionModelProvider } from '../../backend/session-model-provider';

// ===========================================================================
// Helpers
// ===========================================================================

function toAcpSessionInfo(data: { id?: string; title?: string; time?: { created?: number } }): BackendSessionInfo {
  return {
    id: data.id ?? '',
    title: data.title ?? '',
    createdAt: new Date(data.time?.created ?? Date.now()),
  };
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') {
      return record.message;
    }
    if (typeof record.code === 'string') {
      return record.code;
    }
  }

  return fallback;
}

function getResultError(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return (value as Record<string, unknown>).error;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatResultError(value: unknown, fallback: string): string {
  return `${extractErrorMessage(value, fallback)} | raw=${safeStringify(value)}`;
}

const TRANSIENT_SESSION_CLEANUP_TIMEOUT_MS = 2_000;
const TRANSIENT_CREATE_DRAIN_TIMEOUT_MS = 2_000;
const START_DRAIN_TIMEOUT_MS = 2_000;

/**
 * OpenCode can report a successful but empty provider catalog immediately
 * after its server becomes healthy, while provider discovery is still being
 * initialized. There are three total requests: the initial request plus two
 * short retries. The provider advertises a larger catalog timeout below so
 * this warm-up can complete inside one Copilot refresh.
 */
const MODEL_DISCOVERY_RETRY_DELAYS_MS = [100, 250] as const;
const MODEL_DISCOVERY_RUNTIME_CHANGED_ERROR =
  'OpenCode backend runtime changed while discovering models';
/** OpenCode's first provider discovery can include CLI/provider boot time. */
export const OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS = 8_000;

interface ModelDiscoveryRuntime {
  readonly client: OpenCodeClient;
  readonly generation: number;
}

interface TransientSessionRef {
  readonly id: string;
  readonly client: OpenCodeClient;
  readonly directory?: string;
  /** Runtime generation that created this remote session. */
  readonly generation: number;
  /** Cleanup state shared by every owner of this remote identity. */
  readonly cleanupState: TransientCleanupState;
}

interface PendingTransientCreate {
  readonly client: OpenCodeClient;
  readonly generation: number;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
}

interface TransientCleanupResult {
  readonly ok: boolean;
  readonly data?: boolean;
  readonly error?: unknown;
  readonly timedOut?: boolean;
}

interface TransientCleanupState {
  readonly client: OpenCodeClient;
  readonly id: string;
  readonly directory?: string;
  /** Keep a replacement runtime from joining an old client's cleanup. */
  readonly generation: number;
  operation?: Promise<TransientCleanupResult>;
  /** Set only once the underlying SDK request has settled. */
  terminal: boolean;
  result?: TransientCleanupResult;
}

/**
 * Translate the opaque common model options into OpenCode's request shape.
 *
 * OpenCode v2 currently exposes only `variant` as a per-request model option,
 * and it is a top-level prompt field rather than part of `model`. Unknown
 * options are intentionally ignored at this protocol boundary so they cannot
 * accidentally be sent to a backend that does not understand them.
 */
function mapModelOptions(options: BackendModelOptions | undefined): { variant?: string } {
  if (!options || typeof options.variant !== 'string' || options.variant.length === 0) {
    return {};
  }
  return { variant: options.variant };
}

/** OpenCode's request-level tool gate for the shared read-only mode. */
const READ_ONLY_OPENCODE_TOOLS: Record<string, boolean> = {
  '*': false,
  read: true,
  glob: true,
  grep: true,
  list: true,
  lsp: true,
  webfetch: true,
  websearch: true,
};

/** Convert one OpenCode provider response into backend-neutral model entries. */
function mapProviderModels(providers: readonly SdkProvider[]): BackendModel[] {
  const models: BackendModel[] = [];
  for (const provider of providers) {
    for (const m of Object.values(provider.models ?? {})) {
      const rawM = m as unknown as Record<string, unknown>;
      const capRecord = rawM.capabilities as Record<string, unknown> | undefined;
      const limitRecord = rawM.limit as Record<string, number> | undefined;
      const modelApi = m.api;
      const mapped: BackendModel = {
        id: m.id,
        name: m.name ?? m.id,
        provider: provider.id,
        providerName: provider.name,
        capabilitiesRaw: capRecord,
        maxInputTokens: limitRecord?.context,
        maxOutputTokens: limitRecord?.output,
      };
      const providerURL = typeof modelApi?.url === 'string'
        ? modelApi.url
        : provider.api?.url
        ?? (typeof provider.options?.baseURL === 'string' ? provider.options.baseURL : undefined);
      if (providerURL) {mapped.apiBaseURL = providerURL;}
      const configuredKey = typeof provider.options?.apiKey === 'string'
        ? provider.options.apiKey
        : typeof provider.key === 'string'
          ? provider.key
          : undefined;
      if (configuredKey) {mapped.apiKey = configuredKey;}
      const apiKind = inferApiKind(modelApi ?? provider.api);
      if (apiKind !== 'openai-compatible') {mapped.apiKind = apiKind;}
      models.push(mapped);
    }
  }
  return models;
}

function inferApiKind(api: { type?: unknown; npm?: unknown; package?: unknown } | undefined): BackendModel['apiKind'] {
  const type = `${api?.type ?? ''} ${api?.npm ?? ''} ${api?.package ?? ''}`.toLowerCase();
  if (type.includes('anthropic')) {return 'anthropic';}
  if (type.includes('google') || type.includes('gemini')) {return 'google';}
  return 'openai-compatible';
}

// ===========================================================================
// Adapter
// ===========================================================================

export class OpenCodeBackend implements Backend<OpenCodeStreamEvent> {
  readonly name = 'opencode';
  readonly modelProvider: BackendModelProvider = createSessionModelProvider(this, 'opencode', {
    listModelsTimeoutMs: OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS,
  });

  private readonly serverManager = new OpenCodeServerManager();
  private readonly eventBroker = new GlobalEventBroker();
  private rawClient: OpenCodeClient | null = null;
  /** Native model-provider sessions owned by this backend runtime. */
  private readonly transientSessions = new Set<TransientSessionRef>();
  /** In-flight native model-provider session creates on each runtime. */
  private readonly pendingTransientCreates = new Set<PendingTransientCreate>();
  /**
   * Cleanup state is keyed by client + runtime generation + session id.  The
   * session reference object is only an owner marker; using it as the map key
   * lets two markers for the same remote session issue duplicate deletes.
   * Successful terminal states are retained as tombstones until a new
   * transient create reuses the key, so stop/delete races cannot resurrect a
   * cleanup request. Failed requests remain retryable.
   */
  private readonly transientCleanupStates = new Map<
    OpenCodeClient,
    Map<number, Map<string, TransientCleanupState>>
  >();
  /** Invalidated synchronously at stop() entry so late creates cannot be kept. */
  private runtimeGeneration = 0;
  /** Coalesce concurrent starts against one server-manager operation. */
  private startPromise: Promise<BackendResult<BackendServerInfo>> | null = null;
  /** Serializes a backend stop with a subsequent start. */
  private stopPromise: Promise<void> | null = null;
  /** Set synchronously at stop entry, including before its promise is exposed. */
  private stopping = false;

  // =======================================================================
  // Lifecycle
  // =======================================================================

  async start(directory?: string): Promise<BackendResult<BackendServerInfo>> {
    // A stop owns the old client until its transient-session cleanup and
    // server teardown finish. Do not let start() reuse that client midway
    // through shutdown.
    while (this.stopping || this.stopPromise) {
      if (this.stopPromise) {
        await this.stopPromise;
      } else {
        // The stop method publishes its promise immediately after setting the
        // flag; yield once for a re-entrant caller in that tiny window.
        await Promise.resolve();
      }
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const pending = this.performStart(directory);
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) {
        this.startPromise = null;
      }
    }
  }

  private async performStart(directory?: string): Promise<BackendResult<BackendServerInfo>> {
    const generation = this.runtimeGeneration;
    try {
      const url = await this.serverManager.start(directory);
      const rawClient = this.serverManager.getClient();
      if (!rawClient) {
        return { error: 'OpenCode client not available after start' };
      }
      if (generation !== this.runtimeGeneration || this.stopping) {
        // stop() invalidated this start while the server manager was
        // connecting. The stop path owns teardown of the stale instance.
        return { error: 'OpenCode backend start cancelled' };
      }
      if (this.rawClient !== rawClient) {
        this.runtimeGeneration += 1;
      }
      this.rawClient = rawClient;
      return {
        data: {
          url,
          status: 'running',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const pending = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopPromise = pending;
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
      await pending;
    } finally {
      if (this.stopPromise === pending) {
        this.stopPromise = null;
      }
    }
  }

  private async performStop(): Promise<void> {
    const stoppingGeneration = this.runtimeGeneration;
    this.runtimeGeneration += 1;
    const stopGeneration = this.runtimeGeneration;
    const stoppingClient = this.rawClient;
    const pendingStart = this.startPromise;
    // A replacement start must not inherit a stale adapter promise if the
    // underlying server connect never settles. The old performStart keeps its
    // own generation checks and will clean up when it eventually returns.
    if (pendingStart && this.startPromise === pendingStart) {
      this.startPromise = null;
    }
    const pendingTransientCreates = [...this.pendingTransientCreates].filter(item =>
      item.generation === stoppingGeneration
      && (stoppingClient === null || item.client === stoppingClient));
    const transientSessions = [...this.transientSessions].filter(session =>
      session.generation === stoppingGeneration
      && (stoppingClient === null || session.client === stoppingClient));
    // Make the mutable adapter boundary unavailable immediately. Cleanup
    // below uses the client captured in each transient record.
    this.rawClient = null;
    try {
      if (pendingTransientCreates.length > 0) {
        await this.drainPendingTransientCreates(pendingTransientCreates);
      }
      if (transientSessions.length > 0) {
        await this.cleanupTransientSessions(transientSessions);
      }
      await this.eventBroker.stop();
      // A future runtime must never be cleared by this stop operation. The
      // adapter currently serializes start/stop, but retain the identity guard
      // for callers that replace the transport directly in tests/hosts.
      await this.serverManager.stop();
      if (pendingStart) {
        await this.drainPendingStart(pendingStart);
      }
    } finally {
      // Keep records visible while cleanup is in flight so an explicit delete
      // can join the same operation. Remove only after the old runtime has
      // finished its cleanup pass.
      for (const session of transientSessions) {
        this.transientSessions.delete(session);
      }
      if (this.runtimeGeneration === stopGeneration && this.rawClient === stoppingClient) {
        this.rawClient = null;
      }
    }
  }

  /** Wait briefly for a stale adapter start, without blocking replacement. */
  private async drainPendingStart(pending: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep observing a late rejection after the bound expires.
    void pending.catch(() => undefined);
    try {
      await Promise.race([
        pending.then(() => undefined, () => undefined),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, START_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Give in-flight transient creates a bounded opportunity to finish. Their
   * completion includes stale-runtime cleanup, so a resolved drain means the
   * resulting remote session has already been handed to cleanup before the
   * server is torn down.
   */
  private async drainPendingTransientCreates(
    pending: readonly PendingTransientCreate[],
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending.map(item => item.completion)),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, TRANSIENT_CREATE_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Delete backend-owned model sessions before tearing down the OpenCode
   * server. A broken or unresponsive delete endpoint must not prevent server
   * shutdown, so each request is isolated and bounded.
   */
  private async cleanupTransientSessions(
    sessions: readonly TransientSessionRef[],
  ): Promise<void> {
    // Multiple marker objects can refer to the same client/runtime/session.
    // De-duplicate before starting any remote request; callers still share the
    // same state when an explicit delete races this shutdown sweep.
    const states = new Set<TransientCleanupState>();
    for (const session of sessions) {
      states.add(session.cleanupState);
    }
    await Promise.all([...states].map(state => this.deleteTransientSession(state)));
  }

  /**
   * Run one bounded remote delete and share it with all concurrent callers.
   * The map entry is retained until the underlying request settles, even when
   * the bounded wait times out, so a late response cannot trigger a duplicate
   * delete from a second cleanup path.
   */
  private deleteTransientSession(state: TransientCleanupState): Promise<TransientCleanupResult> {
    if (state.operation) {
      return state.operation;
    }
    if (state.terminal) {
      if (state.result?.ok) {
        return Promise.resolve(state.result);
      }
      // A failed OpenCode delete has no close fallback. Keep the marker and
      // permit the next cleanup owner (for example stop()) to retry it.
      state.terminal = false;
      state.result = undefined;
    }

    const request = Promise.resolve().then(() => state.client.session.delete({
      sessionID: state.id,
      directory: state.directory,
    }));
    // Observe a late rejection after the bounded wait wins.
    void request.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.race([
      request.then(result => {
        const error = getResultError(result);
        return error === undefined
          ? { ok: true, data: result?.data ?? true } satisfies TransientCleanupResult
          : { ok: false, error } satisfies TransientCleanupResult;
      }),
      new Promise<TransientCleanupResult>(resolve => {
        timer = setTimeout(() => {
          resolve({ ok: false, timedOut: true });
        }, TRANSIENT_SESSION_CLEANUP_TIMEOUT_MS);
      }),
    ]).catch(error => ({ ok: false, error } satisfies TransientCleanupResult)).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });

    state.operation = pending;
    // Keep the state as a tombstone after the SDK request settles. A later
    // stop/delete for the same marker joins the completed result; a new
    // transient create explicitly replaces this state with a fresh one.
    void request.then(
      result => {
        const error = getResultError(result);
        state.result = error === undefined
          ? { ok: true, data: result?.data ?? true }
          : { ok: false, error };
        state.terminal = true;
        state.operation = state.result.ok
          ? Promise.resolve(state.result)
          : undefined;
      },
      error => {
        state.result = { ok: false, error };
        state.terminal = true;
        state.operation = undefined;
      },
    );
    return pending;
  }

  private getTransientCleanupState(
    client: OpenCodeClient,
    id: string,
    directory: string | undefined,
    generation: number,
  ): TransientCleanupState {
    let byGeneration = this.transientCleanupStates.get(client);
    if (!byGeneration) {
      byGeneration = new Map();
      this.transientCleanupStates.set(client, byGeneration);
    }
    let byId = byGeneration.get(generation);
    if (!byId) {
      byId = new Map();
      byGeneration.set(generation, byId);
    }
    const existing = byId.get(id);
    // An in-flight state owns this remote identity. Reusing it prevents a
    // concurrent marker (or stop/delete caller) from issuing a second delete.
    if (existing && (!existing.terminal || existing.result?.ok === false)) {
      return existing;
    }
    const state: TransientCleanupState = {
      client,
      id,
      directory,
      generation,
      terminal: false,
    };
    // Replacing a terminal state is the tombstone boundary for a new remote
    // resource that happens to reuse the same protocol session id.
    byId.set(id, state);
    return state;
  }

  private clearTransientCleanupTombstone(
    client: OpenCodeClient,
    id: string,
    generation: number,
  ): void {
    const byGeneration = this.transientCleanupStates.get(client);
    const byId = byGeneration?.get(generation);
    const state = byId?.get(id);
    if (!state || !state.terminal) {
      return;
    }
    byId!.delete(id);
    if (byId!.size === 0) {byGeneration!.delete(generation);}
    if (byGeneration!.size === 0) {this.transientCleanupStates.delete(client);}
  }

  /** Find a keyed cleanup state even after its marker object was removed. */
  private findTransientCleanupState(
    client: OpenCodeClient,
    id: string,
    generation: number,
    includeOlderGenerations = false,
  ): TransientCleanupState | undefined {
    const byGeneration = this.transientCleanupStates.get(client);
    if (!byGeneration) {return undefined;}
    const current = byGeneration.get(generation)?.get(id);
    if (current) {return current;}
    if (!includeOlderGenerations) {return undefined;}
    // During stop(), runtimeGeneration has already advanced. Prefer an
    // in-flight old-runtime state, then the newest terminal tombstone.
    const candidates = [...byGeneration.entries()]
      .filter(([, byId]) => byId.has(id))
      .sort(([left], [right]) => right - left)
      .map(([, byId]) => byId.get(id)!);
    return candidates.find(state => !state.terminal) ?? candidates[0];
  }

  getStatus(): BackendServerStatus {
    if (this.stopping) {
      return 'stopped';
    }
    return this.serverManager.getStatus();
  }

  getUrl(): string | null {
    return this.serverManager.getUrl();
  }

  isRunning(): boolean {
    return !this.stopping && this.serverManager.isRunning();
  }

  /**
   * Keep a model-discovery request bound to the client/runtime it captured.
   * OpenCode target restarts reuse this adapter object, so checking only
   * `isRunning()` would allow a late response from the previous client to be
   * mistaken for the replacement runtime's catalog.
   */
  private isCurrentModelDiscoveryRuntime(runtime: ModelDiscoveryRuntime): boolean {
    return !this.stopping
      && this.runtimeGeneration === runtime.generation
      && this.rawClient === runtime.client
      && this.serverManager.getClient() === runtime.client;
  }

  /** @inheritdoc */
  createPipeline(options: BackendPipelineOptions): BackendPipeline<OpenCodeStreamEvent> {
    return new OpenCodePipeline(this, options);
  }

  // =======================================================================
  // Internal: typed reference to the SDK client
  // =======================================================================

  private get sdk(): OpenCodeClient {
    if (this.stopping) {throw new Error('Server not running');}
    const c = this.serverManager.getClient();
    if (!c) {throw new Error('Server not running');}
    return c;
  }

  // =======================================================================
  // Sessions
  // =======================================================================

  readonly sessions: BackendSessionOperations = {
    create: async (options?): Promise<BackendResult<BackendSessionInfo>> => {
      let pendingTransientCreate: PendingTransientCreate | undefined;
      try {
        const client = this.rawClient ?? this.serverManager.getClient();
        if (!client || this.stopping || this.stopPromise || !this.isRunning()) {
          return { error: 'OpenCode backend not running' };
        }
        const generation = this.runtimeGeneration;
        if (options?.transient) {
          let resolve!: () => void;
          const completion = new Promise<void>(resolveCompletion => {
            resolve = resolveCompletion;
          });
          pendingTransientCreate = { client, generation, completion, resolve };
          this.pendingTransientCreates.add(pendingTransientCreate);
        }
        const result = await client.session.create({
          directory: options?.directory,
          title: options?.title,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session not created') };
        }
        if (!result.data?.id) {
          return { error: 'Session not created' };
        }
        const sessionInfo = toAcpSessionInfo(result.data);
        const staleRuntime = this.runtimeGeneration !== generation
          || this.rawClient !== client
          || this.stopping
          || this.stopPromise !== null
          || !this.isRunning();
        if (options?.transient) {
          const cleanupState = this.getTransientCleanupState(
            client,
            sessionInfo.id,
            options.directory,
            generation,
          );
          const session = {
            id: sessionInfo.id,
            client,
            directory: options.directory,
            generation,
            cleanupState,
          } satisfies TransientSessionRef;
          if (!staleRuntime) {
            this.transientSessions.add(session);
          } else {
            // The backend was stopped/replaced while create() was in flight.
            // Do not publish the stale id into the new runtime's ownership map;
            // dispose it through the client that created it instead.
            await this.cleanupTransientSessions([session]);
          }
        } else if (staleRuntime) {
          return { error: 'OpenCode backend stopped while creating session' };
        } else {
          // A durable participant session may legitimately reuse a protocol
          // id after a transient resource was deleted. Do not let the old
          // cleanup tombstone affect that new session.
          this.clearTransientCleanupTombstone(client, sessionInfo.id, generation);
        }
        return { data: sessionInfo };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (pendingTransientCreate) {
          pendingTransientCreate.resolve();
          this.pendingTransientCreates.delete(pendingTransientCreate);
        }
      }
    },

    get: async (id: string, directory?: string): Promise<BackendResult<BackendSessionInfo>> => {
      try {
        const result = await this.sdk.session.get({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session not found') };
        }
        if (!result.data) {
          return { error: 'Session not found' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    update: async (id: string, options: { title?: string; directory?: string }): Promise<BackendResult<BackendSessionInfo>> => {
      try {
        const result = await this.sdk.session.update({
          sessionID: id,
          directory: options.directory,
          title: options.title,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session update failed') };
        }
        if (!result.data) {
          return { error: 'Session update failed' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    delete: async (id: string, directory?: string): Promise<BackendResult<boolean>> => {
      try {
        const client = this.rawClient ?? this.serverManager.getClient();
        if (!client) {
          return { error: 'Server not running' };
        }

        const generation = this.runtimeGeneration;
        // Join a tracked transient delete when one exists. During shutdown
        // `runtimeGeneration` has already advanced, so the stopping flag is
        // intentionally accepted to find the old runtime's record.
        const tracked = [...this.transientSessions].find(session =>
          session.id === id
          && session.client === client
          && (session.generation === generation || this.stopping),
        );
        const keyedState = tracked?.cleanupState
          ?? this.findTransientCleanupState(client, id, generation, this.stopping);
        if (keyedState) {
          const cleanup = await this.deleteTransientSession(keyedState);
          if (!cleanup.ok) {
            return {
              error: cleanup.timedOut
                ? 'Session deletion timed out'
                : extractErrorMessage(cleanup.error, 'Session deletion failed'),
            };
          }
          // Remove every marker for this remote identity. They all share one
          // keyed cleanup operation and must not trigger a second stop sweep.
          for (const remaining of [...this.transientSessions]) {
            if (remaining.client === client && remaining.id === id
                && (remaining.generation === keyedState.generation || this.stopping)) {
              this.transientSessions.delete(remaining);
            }
          }
          return { data: cleanup.data ?? true };
        }

        const result = await client.session.delete({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session deletion failed') };
        }
        for (const remaining of [...this.transientSessions]) {
          if (remaining.id === id && remaining.client === client && remaining.generation === generation) {
            this.transientSessions.delete(remaining);
          }
        }
        return { data: result.data ?? true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    // OpenCode session resources are remote; delete owns their lifecycle.
    release: async () => {},

    children: async (id: string, directory?: string) => {
      try {
        const result = await this.sdk.session.children({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get children') };
        }
        return {
          data: (result.data ?? []).map(s => ({ id: s.id ?? '', parentID: s.parentID ?? '' })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    status: async (directory?: string) => {
      try {
        const result = await this.sdk.session.status({ directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get session status') };
        }
        return { data: result.data ?? {} };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    prompt: async (
      id: string,
      text: string,
      directory?: string,
      options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        tools?: Record<string, boolean>;
        permissionMode?: PermissionMode;
        modelOptions?: BackendModelOptions;
        attachments?: BackendFileAttachment[];
      },
    ): Promise<BackendResult<unknown>> => {
      try {
        const parts: unknown[] = [{ type: 'text', text }];

        // Convert file attachments to SDK FilePartInput[] and prepend them
        // so the text part remains the last/user-like part.
        if (options?.attachments?.length) {
          const fileParts = options.attachments.map((att) => ({
            type: 'file' as const,
            mime: att.mime,
            filename: att.filename,
            url: att.url,
          }));
          parts.unshift(...fileParts);
        }

        const request: {
          sessionID: string;
          directory?: string;
          parts: unknown[];
          model?: { providerID: string; modelID: string };
          agent?: string;
          tools?: Record<string, boolean>;
          variant?: string;
        } = {
          sessionID: id,
          directory,
          parts,
          model: options?.model,
          agent: options?.agent,
        };
        const modelOptions = mapModelOptions(options?.modelOptions);
        if (modelOptions.variant !== undefined) {
          request.variant = modelOptions.variant;
        }
        if (options?.permissionMode === 'read-only') {
          request.tools = {
            ...(options.tools ?? {}),
            ...READ_ONLY_OPENCODE_TOOLS,
          };
        } else if (options?.tools) {
          request.tools = options.tools;
        }
        const result = await this.sdk.session.promptAsync(request);
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: formatResultError(error, 'Prompt failed') };
        }
        return { data: result };
      } catch (err) {
        return {
          error: formatResultError(err, 'Prompt failed'),
        };
      }
    },

    revert: async (id: string, messageId: string, partId?: string, directory?: string): Promise<BackendResult<unknown>> => {
      try {
        const result = await this.sdk.session.revert({
          sessionID: id,
          directory,
          messageID: messageId,
          partID: partId,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Revert failed') };
        }
        return { data: result };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    abort: async (id: string, directory?: string): Promise<BackendResult<boolean>> => {
      try {
        const result = await this.sdk.session.abort({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Abort failed') };
        }
        return { data: result?.data ?? true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    list: async (directory?: string): Promise<BackendResult<BackendSessionInfo[]>> => {
      try {
        const result = await this.sdk.session.list({ directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List sessions failed') };
        }
        return { data: (result.data ?? []).map(toAcpSessionInfo) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    // -- Hierarchy navigation (delegates to GlobalEventBroker) --

    descendants: (parentId: string): string[] => {
      return this.eventBroker.getDescendantSessions(parentId);
    },

    findAncestor: (sessionId: string, candidateIds: Set<string>): string | undefined => {
      return this.eventBroker.findAncestorIn(sessionId, candidateIds);
    },

    parent: (sessionId: string): string | undefined => {
      return this.eventBroker.getParentSession(sessionId);
    },

    messages: async (id: string, directory?: string): Promise<BackendResult<BackendMessageHistory>> => {
      try {
        const result = await this.sdk.session.messages({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get messages') };
        }

        const items = result.data ?? [];
        const mapped: BackendHistoryMessage[] = [];

        for (const item of items) {
          if (item.info.role === 'user') {
            // UserMessage: text is in the parts (type='text')
            const text = item.parts
              .filter((p): p is typeof p & { type: 'text'; text: string } =>
                p.type === 'text' && typeof (p as { text?: unknown }).text === 'string'
              )
              .map(p => p.text)
              .join('\n');
            mapped.push({
              id: item.info.id,
              role: 'user',
              text: text || '(no text)',
            });
          } else if (item.info.role === 'assistant') {
            // AssistantMessage: join text parts, collect tool call summaries
            const textParts: string[] = [];
            const toolCalls: Array<{ toolName: string; callId?: string }> = [];

            for (const part of item.parts) {
              if (part.type === 'text') {
                textParts.push((part as { type: 'text'; text: string }).text);
              } else if (part.type === 'tool') {
                const tp = part as { type: 'tool'; tool: string; callID?: string };
                toolCalls.push({ toolName: tp.tool, callId: tp.callID });
              }
            }

            mapped.push({
              id: item.info.id,
              role: 'assistant',
              text: textParts.join('\n'),
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              metadata: {
                sessionId: item.info.sessionID,
                cost: item.info.cost,
              },
            });
          }
        }

        return { data: { items: mapped } };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // =======================================================================
  // Config
  // =======================================================================

  readonly config: BackendConfigOperations = {
    models: async (directory?: string): Promise<BackendResult<BackendModel[]>> => {
      try {
        // The SDK may return a successful empty catalog for a short period
        // immediately after the server reports `running`. Capture the client
        // and generation once so retries can never cross a stop/restart.
        const runtime: ModelDiscoveryRuntime = {
          client: this.sdk,
          generation: this.runtimeGeneration,
        };
        let lastError: unknown;

        for (let attempt = 0; attempt <= MODEL_DISCOVERY_RETRY_DELAYS_MS.length; attempt += 1) {
          if (!this.isCurrentModelDiscoveryRuntime(runtime)) {
            return { error: MODEL_DISCOVERY_RUNTIME_CHANGED_ERROR };
          }

          let result: Awaited<ReturnType<OpenCodeClient['config']['providers']>> | undefined;
          try {
            result = await runtime.client.config.providers({ directory });
          } catch (error) {
            lastError = error;
          }

          if (!this.isCurrentModelDiscoveryRuntime(runtime)) {
            return { error: MODEL_DISCOVERY_RUNTIME_CHANGED_ERROR };
          }

          if (result !== undefined) {
            const error = getResultError(result);
            if (error === undefined) {
              const providers = Array.isArray(result.data?.providers)
                ? result.data.providers
                : [];
              const models = mapProviderModels(providers);
              if (models.length > 0 || attempt === MODEL_DISCOVERY_RETRY_DELAYS_MS.length) {
                return { data: models };
              }
              // A successful but empty result is the expected warm-up case.
              lastError = undefined;
            } else {
              // Treat an SDK error during the same warm-up window as
              // transient. The final attempt still returns the error.
              lastError = error;
            }
          }

          if (attempt >= MODEL_DISCOVERY_RETRY_DELAYS_MS.length) {
            break;
          }
          await new Promise<void>(resolve => {
            setTimeout(resolve, MODEL_DISCOVERY_RETRY_DELAYS_MS[attempt]);
          });
        }

        return lastError === undefined
          ? { data: [] }
          : { error: extractErrorMessage(lastError, 'List models failed') };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    agents: async (directory?: string): Promise<BackendResult<BackendAgent[]>> => {
      try {
        const result = await this.sdk.app.agents({
          directory,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List agents failed') };
        }
        const agents: BackendAgent[] = (result.data ?? []).map((a: SdkAgentData) => ({
          id: a.id ?? a.name ?? '',
          name: a.name ?? a.id,
          description: a.description,
          model: typeof a.model === 'object' && a.model !== null
            ? (a.model.modelID ?? String(a.model))
            : a.model,
          mode: a.mode as BackendAgent['mode'],
          hidden: a.hidden,
        }));
        return { data: agents };
      } catch (err) {
        return { error: extractErrorMessage(err, 'List agents failed') };
      }
    },

    get: async (directory?: string): Promise<BackendResult<BackendConfig>> => {
      try {
        const configResult = await this.sdk.config.get({
          directory,
        });
        const error = getResultError(configResult);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Get config failed') };
        }
        const raw = configResult.data ?? {};
        const config: BackendConfig = {
          model: raw.model,
          small_model: raw.small_model,
          default_agent: raw.default_agent,
          disabled_providers: raw.disabled_providers,
          enabled_providers: raw.enabled_providers,
          agent: raw.agent as BackendConfig['agent'],
          provider: raw.provider as BackendConfig['provider'],
        };
        return { data: config };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Get config failed') };
      }
    },

    update: async (config: Partial<BackendConfig>, directory?: string): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.config.update({
          directory,
          config,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Update config failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Update config failed') };
      }
    },

    updateGlobal: async (config: Partial<BackendConfig>): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.global.config.update({ config });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Update global config failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Update global config failed') };
      }
    },
  };

  // =======================================================================
  // Settings provider - declarative backend-specific settings UI
  // =======================================================================

  readonly settingsProvider = new OpenCodeSettingsProvider(this.config);

  // =======================================================================
  // Events - delegates raw OpenCode stream multiplexing to GlobalEventBroker
  // =======================================================================

  readonly events: BackendEventOperations<OpenCodeStreamEvent> = {
    openSessionStream: (sessionId: string): BackendEventStream<OpenCodeStreamEvent> => {
      return this.eventBroker.openSessionStream(sessionId);
    },

    openGlobalStream: async (): Promise<BackendEventStream<OpenCodeStreamEvent>> => {
      return await this.sdk.global.event();
    },

    closeSessionStream: (sessionId: string): void => {
      this.eventBroker.closeSessionStream(sessionId);
    },

    ensureStarted: async (): Promise<void> => {
      const c = this.rawClient;
      if (c) {
        await this.eventBroker.ensureStarted(c);
      }
    },
  };

  // =======================================================================
  // Permissions
  // =======================================================================

  readonly permissions: BackendPermissionOperations = {
    reply: async (
      sessionId: string,
      permissionId: string,
      response: BackendPermissionResponse,
      directory?: string,
    ): Promise<void> => {
      const result = await this.sdk.permission.reply({
        requestID: permissionId,
        directory,
        reply: response,
      });
      if (result.error) {
        throw new Error(`Permission reply failed: ${extractErrorMessage(result.error, 'Unknown error')}`);
      }
    },

  };

  // =======================================================================
  // Questions
  // =======================================================================

  readonly questions: BackendQuestionOperations = {
    reply: async (
      sessionId: string,
      requestId: string,
      answers: Array<Array<string>>,
      directory?: string,
    ): Promise<BackendResult<boolean>> => {
      try {
        const result = await this.sdk.question.reply({
          requestID: requestId,
          directory,
          answers,
        });
        if (result.data !== undefined) {
          return { data: true };
        }
        return { error: `Question reply failed: ${JSON.stringify(result.error)}` };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Failed to reply to question') };
      }
    },

    reject: async (
      sessionId: string,
      requestId: string,
      directory?: string,
    ): Promise<BackendResult<boolean>> => {
      try {
        const result = await this.sdk.question.reject({
          requestID: requestId,
          directory,
        });
        if (result.data !== undefined) {
          return { data: true };
        }
        return { error: `Question reject failed: ${JSON.stringify(result.error)}` };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Failed to reject question') };
      }
    },

  };

  // =======================================================================
  // Auth - delegates to v2 SDK auth.set / auth.remove
  // =======================================================================

  readonly auth: BackendAuthOperations = {
    setKey: async (providerID: string, key: string): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.auth.set({
          providerID,
          auth: { type: 'api', key },
        });
        if (result.error) {
          return { error: extractErrorMessage(result.error, 'Auth set failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Auth set failed') };
      }
    },

    removeKey: async (providerID: string): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.auth.remove({ providerID });
        if (result.error) {
          return { error: extractErrorMessage(result.error, 'Auth remove failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Auth remove failed') };
      }
    },
  };
}
