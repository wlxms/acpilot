import type {
  Backend,
  BackendModelInvocationRequest,
  BackendModelInvocationResult,
  BackendModelProvider,
  BackendPipelineResult,
  BackendPipelineToken,
  BackendRuntimeGuard,
} from './backend';
import { BackendRuntimeChangedError } from './backend';
import type { BackendModel, BackendResult } from './types';

const INVOCATION_DRAIN_TIMEOUT_MS = 2_000;
/** Maximum time spent waiting for one best-effort session cleanup operation. */
export const SESSION_MODEL_CLEANUP_TIMEOUT_MS = 2_000;

export interface SessionModelProviderOptions {
  /** Override the host model-catalog timeout for this backend provider. */
  readonly listModelsTimeoutMs?: number;
}

const CLEANUP_TIMEOUT = Symbol('session-model-cleanup-timeout');

type CleanupOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

type BackendStartResult<TEvent> = Awaited<ReturnType<Backend<TEvent>['start']>>;

interface BackendStartupState<TEvent> {
  readonly runtimeKey: string;
  readonly promise: Promise<BackendStartResult<TEvent>>;
  readonly leases: Set<BackendStartupLease<TEvent>>;
  settled: boolean;
  started: boolean;
  sessionClaimed: boolean;
  stopRequested: boolean;
  stopAllowed: boolean;
  readonly stopGuards: Set<() => boolean>;
  stopPromise?: Promise<void>;
  appendLog?: (message: string) => void;
}

interface BackendStartupLease<TEvent> {
  readonly state: BackendStartupState<TEvent>;
  readonly canStop: () => boolean;
  readonly appendLog: (message: string) => void;
  released: boolean;
}

/**
 * Coordinates lazy starts shared by concurrent native model invocations.
 * Backends coalesce `start()` calls internally, so a request that cancels must
 * not stop a runtime another request is still using. The lease lives only
 * until that invocation creates its first session (or exits before creation).
 */
class BackendStartupCoordinator<TEvent> {
  private state: BackendStartupState<TEvent> | undefined;

  constructor(private readonly backend: Backend<TEvent>) {}

  acquire(
    start: () => Promise<BackendStartResult<TEvent>>,
    runtimeKey: string,
    canStop: () => boolean,
    appendLog: (message: string) => void,
  ): BackendStartupLease<TEvent> | undefined {
    let state = this.state;
    const canJoin = state !== undefined
      && state.runtimeKey === runtimeKey
      && state.stopPromise === undefined
      && (state.leases.size > 0 || !state.settled);
    if (!canJoin) {
      const priorStop = state?.stopPromise;
      if (!priorStop && this.backend.isRunning()) {
        return undefined;
      }
      const promise = priorStop
        ? priorStop.then(start)
        : Promise.resolve().then(start);
      const createdState: BackendStartupState<TEvent> = {
        runtimeKey,
        promise,
        leases: new Set(),
        settled: false,
        started: false,
        sessionClaimed: false,
        stopRequested: false,
        stopAllowed: true,
        stopGuards: new Set(),
      };
      state = createdState;
      this.state = createdState;
      void promise.then(
        result => {
          createdState.settled = true;
          createdState.started = result.error === undefined;
          this.maybeStop(createdState);
          this.prune(createdState);
        },
        error => {
          createdState.settled = true;
          createdState.started = false;
          // The invocation race already observes this rejection. This handler
          // keeps the shared promise observed for every late-cancel path.
          for (const lease of createdState.leases) {
            lease.appendLog(`backend start rejected late: ${formatError(error)}`);
          }
          this.prune(createdState);
        },
      );
    }

    // A running backend returns without a lease above; every other path must
    // have installed a startup state before reaching this point.
    if (state === undefined) {
      throw new Error('Backend startup coordinator did not create a state');
    }

    const lease: BackendStartupLease<TEvent> = {
      state,
      canStop,
      appendLog,
      released: false,
    };
    state.leases.add(lease);
    return lease;
  }

  /** Mark that this invocation now owns a disposable session on the runtime. */
  claimSession(lease: BackendStartupLease<TEvent>): void {
    if (lease.released) {
      return;
    }
    lease.state.sessionClaimed = true;
  }

  /** Release one invocation's startup lease and possibly stop an orphan start. */
  release(
    lease: BackendStartupLease<TEvent>,
    options: { stopIfUnclaimed: boolean; runtimeInvalidated: boolean },
  ): Promise<void> {
    if (lease.released) {
      return lease.state.stopPromise ?? Promise.resolve();
    }
    lease.released = true;
    const state = lease.state;
    state.leases.delete(lease);
    if (options.stopIfUnclaimed && !state.sessionClaimed) {
      state.stopRequested = true;
      state.stopGuards.add(lease.canStop);
      if (options.runtimeInvalidated || !lease.canStop()) {
        state.stopAllowed = false;
      }
      state.appendLog ??= lease.appendLog;
    }
    this.maybeStop(state);
    this.prune(state);
    return state.stopPromise ?? Promise.resolve();
  }

  private maybeStop(state: BackendStartupState<TEvent>): void {
    if (!state.settled || !state.started || !state.stopRequested
      || state.leases.size > 0 || state.sessionClaimed || !state.stopAllowed
      || state.stopPromise) {
      return;
    }
    state.stopPromise = bestEffortCleanup(
      () => {
        if (state.sessionClaimed || state.leases.size > 0 || !state.stopAllowed
          || !this.canStop(state)) {
          state.stopAllowed = false;
          return;
        }
        return this.backend.stop();
      },
      'late backend stop',
      state.appendLog ?? (() => {}),
    ).then(outcome => {
      if (outcome.status === 'error') {
        state.appendLog?.(`late backend stop failed: ${formatError(outcome.error)}`);
      }
    });
    const stopPromise = state.stopPromise;
    void stopPromise.finally(() => {
      if (state.stopPromise === stopPromise) {
        state.stopPromise = undefined;
      }
      this.prune(state);
    }).catch(() => undefined);
  }

  private canStop(state: BackendStartupState<TEvent>): boolean {
    for (const guard of state.stopGuards) {
      try {
        if (!guard()) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private prune(state: BackendStartupState<TEvent>): void {
    if (state.leases.size > 0 || !state.settled || state.stopPromise) {
      return;
    }
    if (this.state === state) {
      this.state = undefined;
    }
  }
}

/**
 * Default model capability for backends whose native model API is a session
 * prompt plus an event stream.  The backend remains the owner of both the
 * protocol event pipeline and the temporary session lifecycle.
 */
export function createSessionModelProvider<TEvent>(
  backend: Backend<TEvent>,
  vendor: string,
  options: SessionModelProviderOptions = {},
): BackendModelProvider {
  const startupCoordinator = new BackendStartupCoordinator(backend);
  return {
    vendor,
    listModelsTimeoutMs: options.listModelsTimeoutMs,

    async listModels(directory?: string): Promise<BackendResult<BackendModel[]>> {
      const result = await backend.config.models(directory);
      if (result.error !== undefined) {
        return { error: result.error };
      }

      // A model without both selectors cannot be passed to sessions.prompt.
      // Keep the provider contract honest instead of exposing picker entries
      // that can never be invoked.
      return {
        data: (result.data ?? [])
          .filter(model =>
            typeof model.id === 'string'
            && model.id.length > 0
            && typeof model.provider === 'string'
            && model.provider.length > 0,
          )
          .map(model => ({
            ...model,
            // A session-backed provider owns the tool loop inside its
            // backend pipeline. Backends may omit native per-model
            // capabilities, including by returning an empty object. Treat
            // that omission as tool support so VS Code's Agent picker can
            // use the model; preserve an explicit false declaration.
            capabilitiesRaw: addDefaultToolCallingCapability(model.capabilitiesRaw),
          })),
      };
    },

    invoke(request: BackendModelInvocationRequest): Promise<BackendModelInvocationResult> {
      return invokeSessionModel(backend, request, startupCoordinator);
    },
  };
}

function addDefaultToolCallingCapability(
  capabilitiesRaw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (capabilitiesRaw === undefined) {
    return { toolCalling: true };
  }
  const declaredToolCapability = [capabilitiesRaw.toolcall, capabilitiesRaw.toolCalling]
    .some(value => value === true
      || value === false
      || (typeof value === 'number' && Number.isFinite(value)));
  if (declaredToolCapability) {
    return capabilitiesRaw;
  }
  return { ...capabilitiesRaw, toolCalling: true };
}

async function invokeSessionModel<TEvent>(
  backend: Backend<TEvent>,
  request: BackendModelInvocationRequest,
  startupCoordinator: BackendStartupCoordinator<TEvent>,
): Promise<BackendModelInvocationResult> {
  const directory = request.directory;
  let sessionId: string | undefined;
  let streamOpened = false;
  let streamClosed = false;
  let abortPromise: Promise<void> | undefined;
  let cancellationTimer: ReturnType<typeof setInterval> | undefined;
  let primaryError: unknown;
  let invocationResult: BackendModelInvocationResult | undefined;
  let pipelinePromise: Promise<BackendPipelineResult> | undefined;
  let promptPromise: Promise<BackendResult<unknown>> | undefined;
  let ensurePromise: Promise<void> | undefined;
  let startupLease: BackendStartupLease<TEvent> | undefined;
  let runtimeInvalidated = false;
  let cancellationReason: 'user' | 'runtime' = 'user';
  let resolveCancellation!: () => void;
  const cancellation = new Promise<void>(resolve => {
    resolveCancellation = resolve;
  });
  let cancellationSignalled = false;

  const runtime: BackendRuntimeGuard | undefined = request.runtime;
  const isRuntimeCurrent = (): boolean => {
    if (runtimeInvalidated || !runtime) {return !runtimeInvalidated;}
    try {
      return runtime.isCurrent();
    } catch {
      return false;
    }
  };
  const cancellationError = (): Error => cancellationReason === 'runtime'
    ? new BackendRuntimeChangedError(runtime?.instanceKey ?? 'unknown')
    : new Error('Model invocation cancelled');
  const appendLog = (message: string): void => {
    try {
      request.logger?.appendLine(message);
    } catch {
      // Logging must never change the invocation or cleanup outcome.
    }
  };

  const abortOnce = (): Promise<void> => {
    // A runtime transition tears down the old backend connection. Calling the
    // mutable backend object after that boundary could address a replacement
    // connection (and even a reused session id), so cleanup is host-owned in
    // that case and must not issue abort on the new runtime.
    if (!sessionId || runtimeInvalidated || !isRuntimeCurrent()) {
      if (!isRuntimeCurrent()) {runtimeInvalidated = true;}
      return Promise.resolve();
    }
    if (!abortPromise) {
      const id = sessionId;
      abortPromise = Promise.resolve().then(() => {
        if (runtimeInvalidated || !isRuntimeCurrent()) {
          return;
        }
        return backend.sessions.abort(id, directory).then(result => {
          if (result.error !== undefined) {
            throw new Error(`Backend session abort failed: ${formatError(result.error)}`);
          }
        });
      });
    }
    return abortPromise;
  };

  const signalCancellation = (reason: 'user' | 'runtime' = 'user'): void => {
    if (reason === 'runtime') {
      runtimeInvalidated = true;
    }
    if (cancellationSignalled) {
      return;
    }
    cancellationSignalled = true;
    cancellationReason = reason;
    if (reason !== 'runtime') {
      // Wake the operation immediately. Cleanup awaits the shared abort promise.
      void abortOnce().catch(() => undefined);
    }
    resolveCancellation();
  };

  const pollCancellation = (): void => {
    if (!isRuntimeCurrent()) {
      signalCancellation('runtime');
      return;
    }
    if (request.token.isCancellationRequested) {
      signalCancellation();
    }
  };

  const assertRuntimeCurrent = (): void => {
    if (!isRuntimeCurrent()) {
      signalCancellation('runtime');
      throw cancellationError();
    }
  };

  // Subscribe before the first backend await so a target switch wakes an
  // in-flight request immediately; polling below remains a fallback for hosts
  // that provide a guard without an invalidation event.
  const runtimeDispose = runtime?.onInvalidated?.(() => {
    signalCancellation('runtime');
  });

  const raceCancellation = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await Promise.race([
      operation,
      cancellation.then(() => { throw cancellationError(); }),
    ]);
    return result;
  };

  const cleanupLateSession = async (lateSessionId: string): Promise<void> => {
    if (runtimeInvalidated) {
      return;
    }
    let cleanupError: unknown;
    const aborted = await bestEffortCleanup(
      () => Promise.resolve().then(() => {
        if (runtimeInvalidated || !isRuntimeCurrent()) {return;}
        return backend.sessions.abort(lateSessionId, directory);
      }).then(result => {
        if (!result) {return;}
        if (result.error !== undefined) {
          throw new Error(`Backend session abort failed: ${formatError(result.error)}`);
        }
      }),
      `late session abort (${lateSessionId})`,
      appendLog,
    );
    if (aborted.status === 'error') {
      cleanupError = aborted.error;
    }
    if (backend.sessions.delete) {
      const deleted = await bestEffortCleanup(
        () => {
          if (runtimeInvalidated || !isRuntimeCurrent()) {return { data: false };}
          return backend.sessions.delete!(lateSessionId, directory);
        },
        `late session delete (${lateSessionId})`,
        appendLog,
      );
      if (deleted.status === 'error') {
        cleanupError ??= deleted.error;
      } else if (deleted.status === 'ok' && deleted.value.error !== undefined) {
        cleanupError ??= new Error(`Backend session cleanup failed: ${formatError(deleted.value.error)}`);
      }
    }
    if (backend.sessions.release) {
      const released = await bestEffortCleanup(
        () => {
          if (runtimeInvalidated || !isRuntimeCurrent()) {return;}
          return backend.sessions.release!(lateSessionId, directory);
        },
        `late session release (${lateSessionId})`,
        appendLog,
      );
      if (released.status === 'error') {
        cleanupError ??= released.error;
      }
    }
    if (cleanupError !== undefined) {
      appendLog(
        `[model-provider:${request.model.providerID}/${request.model.modelID}] late session cleanup failed: ${formatError(cleanupError)}`,
      );
    }
  };

  const stopAndDelete = async (): Promise<void> => {
    if (!sessionId) {
      // A model request can be cancelled before session creation, including
      // while a lazy backend start is still pending. Request stop now so
      // adapters that support cancelling startup can tear down immediately;
      // the late-start observer above handles adapters whose start resolves
      // after this cleanup path returns.
      if (startupLease) {
        const lease = startupLease;
        startupLease = undefined;
        await startupCoordinator.release(lease, {
          stopIfUnclaimed: primaryError !== undefined || cancellationSignalled
            || request.token.isCancellationRequested,
          runtimeInvalidated,
        });
      }
      return;
    }

    // The transition owner is responsible for tearing down the old runtime.
    // Do not use the shared backend object after its lease has expired: a
    // dynamic ACP adapter may already be pointing at the replacement target.
    if (runtimeInvalidated || !isRuntimeCurrent()) {
      await drainInvocationOperations();
      return;
    }

    const cleanupErrors: unknown[] = [];
    const shouldAbort = request.token.isCancellationRequested
      || primaryError !== undefined
      || invocationResult?.completed === false;
    if (shouldAbort) {
      const aborted = await bestEffortCleanup(
        () => abortOnce(),
        `session abort (${sessionId})`,
        appendLog,
      );
      if (aborted.status === 'error') {
        cleanupErrors.push(aborted.error);
      }
    } else if (abortPromise) {
      const aborted = await bestEffortCleanup(
        () => abortPromise!,
        `session abort (${sessionId})`,
        appendLog,
      );
      if (aborted.status === 'error') {
        cleanupErrors.push(aborted.error);
      }
    }

    if (runtimeInvalidated || !isRuntimeCurrent()) {
      await drainInvocationOperations();
      return;
    }

    // Abort wakes the backend event stream, but a pipeline may still be
    // unwinding after the invocation race has already rejected. Drain both
    // operations before closing/deleting the session so their final handlers
    // cannot write into a still-live native LM stream.
    await drainInvocationOperations();

    if (streamOpened && !streamClosed) {
      try {
        if (!runtimeInvalidated && isRuntimeCurrent()) {
          backend.events.closeSessionStream(sessionId);
          streamClosed = true;
        } else {
          runtimeInvalidated = true;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (backend.sessions.delete) {
      const deleted = await bestEffortCleanup(
        () => {
          if (runtimeInvalidated || !isRuntimeCurrent()) {
            runtimeInvalidated = true;
            return { data: false };
          }
          return backend.sessions.delete!(sessionId!, directory);
        },
        `session delete (${sessionId})`,
        appendLog,
      );
      if (deleted.status === 'error') {
        cleanupErrors.push(deleted.error);
      } else if (deleted.status === 'ok' && deleted.value.error !== undefined) {
        cleanupErrors.push(new Error(`Backend session cleanup failed: ${formatError(deleted.value.error)}`));
      }
    }
    if (backend.sessions.release) {
      const released = await bestEffortCleanup(
        () => {
          if (runtimeInvalidated || !isRuntimeCurrent()) {
            runtimeInvalidated = true;
            return;
          }
          return backend.sessions.release!(sessionId!, directory);
        },
        `session release (${sessionId})`,
        appendLog,
      );
      if (released.status === 'error') {
        cleanupErrors.push(released.error);
      }
    }
    // A native LM request has already produced its primary result at this
    // point. Cleanup is deliberately best-effort: a backend-side close/delete
    // failure must not replace a successful model response (or hide the
    // original prompt/pipeline error). Keep the failure observable in logs.
    for (const cleanupError of cleanupErrors) {
      appendLog(
        `[model-provider:${request.model.providerID}/${request.model.modelID}] cleanup failed: ${formatError(cleanupError)}`,
      );
    }
  };

  try {
    cancellationTimer = setInterval(() => {
      pollCancellation();
    }, 25);
    assertRuntimeCurrent();
    pollCancellation();

    startupLease = startupCoordinator.acquire(
      () => {
        assertRuntimeCurrent();
        return backend.start(directory);
      },
      runtime ? `${runtime.generation}:${runtime.instanceKey}` : 'default',
      () => !runtimeInvalidated && isRuntimeCurrent(),
      appendLog,
    );
    if (startupLease) {
      if (cancellationSignalled || request.token.isCancellationRequested) {
        throw cancellationError();
      }
      const started = await raceCancellation(startupLease.state.promise);
      if (started.error !== undefined) {
        throw new Error(`Backend start failed: ${formatError(started.error)}`);
      }
    }
    assertRuntimeCurrent();
    pollCancellation();
    if (cancellationSignalled || request.token.isCancellationRequested) {
      throw cancellationError();
    }

    const createPromise = Promise.resolve().then(() => {
      assertRuntimeCurrent();
      return backend.sessions.create({
        directory,
        title: request.title ?? 'LM Provider Chat',
        transient: true,
      });
    });
    let created: Awaited<ReturnType<Backend<TEvent>['sessions']['create']>>;
    try {
      created = await raceCancellation(createPromise);
    } catch (error) {
      if (cancellationSignalled || request.token.isCancellationRequested) {
        void createPromise.then(result => {
          const lateSessionId = result.data?.id;
          if (lateSessionId) {
            void cleanupLateSession(lateSessionId).catch(lateCleanupError => {
              appendLog(
                `[model-provider:${request.model.providerID}/${request.model.modelID}] late session cleanup failed: ${formatError(lateCleanupError)}`,
              );
            });
          } else {
            appendLog(
              `[model-provider:${request.model.providerID}/${request.model.modelID}] late session creation failed: ${formatError(result.error ?? 'unknown error')}`,
            );
          }
        }, lateError => {
          appendLog(
            `[model-provider:${request.model.providerID}/${request.model.modelID}] late session creation failed: ${formatError(lateError)}`,
          );
        });
      }
      throw error;
    }
    assertRuntimeCurrent();
    // Retain an id even if a malformed backend response contains both an error
    // and data, so the disposable session is still cleaned up.
    sessionId = created.data?.id;
    if (sessionId && startupLease) {
      startupCoordinator.claimSession(startupLease);
      await startupCoordinator.release(startupLease, {
        stopIfUnclaimed: false,
        runtimeInvalidated: false,
      });
      startupLease = undefined;
    }
    if (created.error !== undefined || !sessionId) {
      throw new Error(`Backend session creation failed: ${formatError(created.error ?? 'unknown error')}`);
    }
    const createdSessionId = sessionId;
    pollCancellation();
    if (cancellationSignalled || request.token.isCancellationRequested) {
      throw cancellationError();
    }

    // Open the per-session channel before starting the global/event transport.
    // This ordering prevents a fast backend response from being emitted before
    // the pipeline has a channel to consume it.
    assertRuntimeCurrent();
    const eventStream = backend.events.openSessionStream(createdSessionId);
    streamOpened = true;
    ensurePromise = Promise.resolve().then(() => {
      assertRuntimeCurrent();
      return backend.events.ensureStarted();
    });
    // `raceCancellation` can return before transport startup settles. Attach a
    // logger now so a late startup failure remains observable without turning
    // into an unhandled rejection.
    void ensurePromise.catch(error => {
      appendLog(
        `[model-provider:${request.model.providerID}/${request.model.modelID}] ensureStarted failed: ${formatError(error)}`,
      );
    });
    await raceCancellation(ensurePromise);
    assertRuntimeCurrent();
    pollCancellation();
    if (cancellationSignalled || request.token.isCancellationRequested) {
      throw cancellationError();
    }

    assertRuntimeCurrent();
    const pipeline = backend.createPipeline({
      sessionId: createdSessionId,
      directory,
      stream: request.stream,
      logger: request.logger,
      permissionMode: request.permissionMode,
      allowUserInteraction: request.allowUserInteraction,
      suppressTitleGeneration: request.purpose === 'title-generation',
    });
    const pipelineToken: BackendPipelineToken = runtime
      ? {
          get isCancellationRequested(): boolean {
            return request.token.isCancellationRequested || runtimeInvalidated || !isRuntimeCurrent();
          },
        }
      : request.token;
    pipelinePromise = Promise.resolve().then(() => {
      assertRuntimeCurrent();
      return pipeline.run(eventStream.stream, pipelineToken);
    });

    // Copy readonly attachments at this boundary because adapters may map or
    // reorder the array while constructing their protocol request.
    const attachments = request.prompt.attachments
      ? [...request.prompt.attachments]
      : undefined;
    promptPromise = Promise.resolve().then(() => {
      assertRuntimeCurrent();
      return backend.sessions.prompt(
        createdSessionId,
        request.prompt.text,
        directory,
        {
          model: request.model,
          agent: request.agent,
          permissionMode: request.permissionMode,
          modelOptions: request.modelOptions === undefined
            ? undefined
            : { ...request.modelOptions },
          attachments,
        },
      );
    }).then(result => {
      if (result.error !== undefined) {
        throw new Error(`Backend prompt failed: ${formatError(result.error)}`);
      }
      return result;
    });

    pipelinePromise.catch(() => {
      void abortOnce().catch(() => {});
    });
    promptPromise.catch(() => {
      void abortOnce().catch(() => {});
    });

    // A terminally incomplete pipeline is authoritative: it means the event
    // stream has already ended without a successful turn boundary. Do not
    // wait for a prompt request that may be stuck in the transport; abort the
    // backend session and let bounded cleanup drain the late prompt promise.
    // A successful pipeline still waits for the prompt request to settle so a
    // prompt-side error is not silently converted into a successful result.
    const pipelineOutcome = pipelinePromise.then(result => ({
      kind: 'pipeline' as const,
      result,
    }));
    const promptOutcome = promptPromise.then(result => ({
      kind: 'prompt' as const,
      result,
    }));
    const firstOutcome = await raceCancellation(Promise.race([pipelineOutcome, promptOutcome]));
    let pipelineResult: BackendPipelineResult;
    if (firstOutcome.kind === 'pipeline') {
      pipelineResult = firstOutcome.result;
      if (!pipelineResult.completed) {
        void abortOnce().catch(() => {});
      } else {
        await raceCancellation(promptPromise);
      }
    } else {
      // The prompt settled first. Preserve the existing all-or-nothing
      // behavior by waiting for the pipeline before publishing the result.
      pipelineResult = await raceCancellation(pipelinePromise);
      if (!pipelineResult.completed) {
        void abortOnce().catch(() => {});
      }
    }
    assertRuntimeCurrent();
    pollCancellation();
    if (cancellationSignalled || request.token.isCancellationRequested) {
      throw cancellationError();
    }
    invocationResult = {
      completed: pipelineResult.completed && !request.token.isCancellationRequested,
      sessionId,
      pipeline: pipelineResult,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (cancellationTimer !== undefined) {
      clearInterval(cancellationTimer);
    }
    try {
      await stopAndDelete();
    } catch (cleanupError) {
      // Keep cleanup failures out of the request result. Individual cleanup
      // steps are already isolated, but retain this guard for unexpected
      // adapter errors while unwinding.
      appendLog(
        `[model-provider:${request.model.providerID}/${request.model.modelID}] cleanup failed: ${formatError(cleanupError)}`,
      );
    }
    runtimeDispose?.();
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (!invocationResult) {
    throw new Error('Backend model invocation ended without a result');
  }
  return invocationResult;

  async function drainInvocationOperations(): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    if (pipelinePromise !== undefined) {pending.push(pipelinePromise);}
    if (promptPromise !== undefined) {pending.push(promptPromise);}
    // `ensureStarted()` may still be establishing the global transport when
    // cancellation wins. Observe it before returning so a late rejection is
    // handled and the backend cannot outlive the transient invocation unseen.
    if (ensurePromise !== undefined) {pending.push(ensurePromise);}
    if (pending.length === 0) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, INVOCATION_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

/**
 * Run a cleanup operation without allowing an unresponsive backend to hold up
 * the native LM request. The original promise is always observed so a later
 * rejection cannot become an unhandled rejection after the timeout wins.
 */
async function bestEffortCleanup<T>(
  operationFactory: () => Promise<T> | T,
  label: string,
  appendLog: (message: string) => void,
): Promise<CleanupOutcome<T>> {
  const operation = Promise.resolve().then(operationFactory);
  let timedOut = false;
  // Keep a rejection handler attached for the entire lifetime of the backend
  // operation, including after the timeout branch below has returned.
  void operation.then(
    () => undefined,
    error => {
      if (timedOut) {
        appendLog(`[model-provider] ${label} rejected after timeout: ${formatError(error)}`);
      }
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<T | typeof CLEANUP_TIMEOUT>([
      operation,
      new Promise<typeof CLEANUP_TIMEOUT>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(CLEANUP_TIMEOUT);
        }, SESSION_MODEL_CLEANUP_TIMEOUT_MS);
      }),
    ]);
    if (result === CLEANUP_TIMEOUT) {
      appendLog(`[model-provider] ${label} timed out after ${SESSION_MODEL_CLEANUP_TIMEOUT_MS}ms`);
      return { status: 'timeout' };
    }
    return { status: 'ok', value: result };
  } catch (error) {
    return { status: 'error', error };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}
