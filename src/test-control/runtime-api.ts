import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ExtensionState, BackendContext } from "../types";
import type { StreamPartRecord } from "../ssp/types";
import { readAllStreamParts } from "../backend/streaming/deserialize";
import { SerializableSessionStream } from "../backend/streaming/session-stream";
import { UserPromptSSP } from "../ssp/impl/user-prompt";
import { backendOwnsCopilotModel } from "../surfaces/vscode/model-catalog";
import { SessionTitleService } from "../participant/session-title";
import { evictTerminalOperations } from "../runtime/operation-eviction";
import {
  loadAcpTargetState,
} from "../settings/state-persistence";
import type { RuntimeTestApi } from "./server";

type PromptStatus = "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
type TurnStatus = "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
type ModelRequestStatus =
  "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

/** Bound diagnostic cleanup so a disconnected agent cannot hang the control API. */
const OPERATION_CLEANUP_TIMEOUT_MS = 2_000;

interface PromptEventSummary {
  type?: string;
  kind?: string;
  sessionId?: string;
  partType?: string;
  toolCallId?: string;
  status?: string;
}

interface PromptOperation {
  id: string;
  backendId: string;
  sessionId: string;
  status: PromptStatus;
  startedAt: string;
  finishedAt?: string;
  promptAccepted: boolean;
  cancelRequested: boolean;
  active: boolean;
  promptError?: string;
  result?: unknown;
  events: PromptEventSummary[];
  waiters: Array<() => void>;
  runtimeGeneration: number;
  runtimeInstanceKey: string;
  /** Internal wake-up hook for a pending event iterator read. */
  wake?: () => void;
}

interface RenderSummary {
  method: string;
  text?: string;
  id?: string;
  name?: string;
  status?: string;
}

interface TurnOperation {
  id: string;
  backendId: string;
  sessionId: string;
  status: TurnStatus;
  startedAt: string;
  finishedAt?: string;
  createdSession: boolean;
  promptAccepted: boolean;
  cancelRequested: boolean;
  active: boolean;
  promptResult?: unknown;
  promptError?: string;
  pipelineResult?: unknown;
  turnIndex?: number;
  sessionPath?: string;
  parts?: Record<string, unknown>[];
  renderedCount: number;
  renders: RenderSummary[];
  waiters: Array<() => void>;
  runtimeGeneration: number;
  runtimeInstanceKey: string;
}

interface ModelPartSummary {
  type: string;
  text?: string;
  name?: string;
  callId?: string;
  status?: string;
}

interface ModelRequestOperation {
  id: string;
  backendId: string;
  modelId: string;
  status: ModelRequestStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  cancelRequested: boolean;
  active: boolean;
  tokenSource: vscode.CancellationTokenSource;
  parts: ModelPartSummary[];
  waiters: Array<() => void>;
}

export interface RuntimeTestApiDependencies {
  selectAcpTarget(
    state: ExtensionState,
    context: vscode.ExtensionContext,
    workspacePath: string | undefined,
    targetId: string,
  ): Promise<void>;
}

export function createRuntimeTestApi(
  extensionState: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  dependencies: RuntimeTestApiDependencies,
): RuntimeTestApi {
  const promptOperations = new Map<string, PromptOperation>();
  const turnOperations = new Map<string, TurnOperation>();
  const modelRequestOperations = new Map<string, ModelRequestOperation>();

  const getContext = (backendId: string): BackendContext => {
    const ctx = extensionState.backends.get(backendId);
    if (!ctx) {
      throw new Error(`Unknown backend: ${backendId}`);
    }
    return ctx;
  };
  const getOperation = (operationId: string): PromptOperation => {
    const operation = promptOperations.get(operationId);
    if (!operation) {
      throw new Error(`Unknown prompt operation: ${operationId}`);
    }
    return operation;
  };
  const getTurnOperation = (operationId: string): TurnOperation => {
    const operation = turnOperations.get(operationId);
    if (!operation) {
      throw new Error(`Unknown turn operation: ${operationId}`);
    }
    return operation;
  };
  const getModelRequestOperation = (
    operationId: string,
  ): ModelRequestOperation => {
    const operation = modelRequestOperations.get(operationId);
    if (!operation) {
      throw new Error(`Unknown model request operation: ${operationId}`);
    }
    return operation;
  };

  const operationRuntimeCurrent = (
    operation: Pick<PromptOperation | TurnOperation, "runtimeGeneration" | "runtimeInstanceKey">,
    ctx: BackendContext,
  ): boolean => {
    const owner = extensionState.backends.get(ctx.id);
    return (owner === undefined || owner === ctx)
      && ctx.runtimeGeneration === operation.runtimeGeneration
      && ctx.instanceKey === operation.runtimeInstanceKey
      && ctx.acceptingRequests !== false;
  };

  const watchOperationRuntime = (
    operation: PromptOperation | TurnOperation,
    ctx: BackendContext,
  ): (() => void) => {
    if (typeof extensionState.bus.on !== "function") {return () => {};}
    return extensionState.bus.on("backend-runtime-changing", event => {
      if (event.backendId !== ctx.id
        || (event.runtimeGeneration <= operation.runtimeGeneration
          && event.instanceKey === operation.runtimeInstanceKey)) {
        return;
      }
      operation.cancelRequested = true;
      if (operation.status !== "completed" && operation.status !== "failed"
        && operation.status !== "cancelled") {
        operation.status = "cancelling";
      }
      if ("wake" in operation) {
        operation.wake?.();
      }
    });
  };

  const operationSnapshot = (
    operation: PromptOperation,
  ): Record<string, unknown> => ({
    id: operation.id,
    backendId: operation.backendId,
    sessionId: operation.sessionId,
    status: operation.status,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    promptAccepted: operation.promptAccepted,
    cancelRequested: operation.cancelRequested,
    promptError: operation.promptError,
    result: operation.result,
    eventCount: operation.events.length,
    events: operation.events,
  });
  const turnSnapshot = (operation: TurnOperation): Record<string, unknown> => ({
    id: operation.id,
    backendId: operation.backendId,
    sessionId: operation.sessionId,
    status: operation.status,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    createdSession: operation.createdSession,
    promptAccepted: operation.promptAccepted,
    cancelRequested: operation.cancelRequested,
    promptResult: operation.promptResult,
    promptError: operation.promptError,
    pipelineResult: operation.pipelineResult,
    turnIndex: operation.turnIndex,
    sessionPath: operation.sessionPath,
    partCount: operation.parts?.length ?? 0,
    parts: operation.parts,
    renderedCount: operation.renderedCount,
    renders: operation.renders,
  });
  const modelRequestSnapshot = (
    operation: ModelRequestOperation,
  ): Record<string, unknown> => ({
    id: operation.id,
    backendId: operation.backendId,
    modelId: operation.modelId,
    status: operation.status,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    error: operation.error,
    cancelRequested: operation.cancelRequested,
    partCount: operation.parts.length,
    parts: operation.parts,
  });
  const finish = <
    T extends {
      status: string;
      finishedAt?: string;
      waiters: Array<() => void>;
    },
  >(
    operation: T,
    status: T["status"],
  ): void => {
    operation.status = status;
    operation.finishedAt = new Date().toISOString();
    for (const resolve of operation.waiters.splice(0)) {
      resolve();
    }
  };
  const finishModelRequest = (
    operation: ModelRequestOperation,
    status: Exclude<ModelRequestStatus, "starting" | "running" | "cancelling">,
  ): void => {
    operation.status = operation.cancelRequested ? "cancelled" : status;
    operation.finishedAt = new Date().toISOString();
    for (const resolve of operation.waiters.splice(0)) {
      resolve();
    }
  };
  const isModelTerminal = (operation: ModelRequestOperation): boolean =>
    operation.status === "completed" ||
    operation.status === "failed" ||
    operation.status === "cancelled";
  const cancelModelRequestOperation = (
    operation: ModelRequestOperation,
  ): void => {
    if (isModelTerminal(operation) || operation.status === "cancelling") {
      return;
    }
    operation.cancelRequested = true;
    operation.status = "cancelling";
    operation.tokenSource.cancel();
  };
  const waitForCompletion = async (
    waiters: Array<() => void>,
    isComplete: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    if (isComplete()) {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveWaiter: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
      waiters.push(resolve);
    });
    // Re-check after registering the waiter.  A completion callback can run
    // between the initial snapshot and this registration (for example when a
    // caller resolves an operation from a synchronous mock).  Resolve the
    // waiter immediately instead of sleeping until the timeout in that case.
    if (isComplete()) {
      resolveWaiter?.();
    }
    try {
      return await Promise.race([
        completion.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (resolveWaiter) {
        const index = waiters.indexOf(resolveWaiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
      }
    }
  };
  const summarizeModelPart = (part: unknown): ModelPartSummary => {
    if (!isRecord(part)) {
      return { type: typeof part };
    }
    const summary: ModelPartSummary = {
      type:
        typeof part.constructor?.name === "string"
          ? part.constructor.name
          : "response-part",
    };
    if (typeof part.value === "string") {
      summary.text = part.value;
    }
    if (typeof part.text === "string") {
      summary.text = part.text;
    }
    if (typeof part.name === "string") {
      summary.name = part.name;
    }
    if (typeof part.callId === "string") {
      summary.callId = part.callId;
    }
    if (typeof part.status === "string") {
      summary.status = part.status;
    }
    return summary;
  };

  const runModelRequest = async (
    operation: ModelRequestOperation,
    ctx: BackendContext,
    text: string,
    options: unknown,
  ): Promise<void> => {
    let outcome: "completed" | "failed" = "completed";
    const runtimeGeneration = ctx.runtimeGeneration;
    const runtimeInstanceKey = ctx.instanceKey;
    let runtimeInvalidated = false;
    let resolveRuntimeInvalidation!: () => void;
    const runtimeInvalidation = new Promise<void>((resolve) => {
      resolveRuntimeInvalidation = resolve;
    });
    // Keep the response iterator and the currently pending read visible to
    // the outer cleanup path. A language-model stream may block forever in
    // `next()` even after its request token has been cancelled.
    let responseIterator: AsyncIterator<unknown> | undefined;
    let responseNext: Promise<IteratorResult<unknown>> | undefined;
    let responseCompleted = false;
    const runtimeChangedError = (): Error => new Error(
      `Model request runtime changed (instance "${runtimeInstanceKey}")`,
    );
    const isRuntimeCurrent = (): boolean => {
      if (runtimeInvalidated || ctx.runtimeGeneration !== runtimeGeneration
        || ctx.instanceKey !== runtimeInstanceKey
        || ctx.acceptingRequests === false) {
        return false;
      }
      const owner = extensionState.backends.get(ctx.id);
      return owner === undefined || owner === ctx;
    };
    const invalidateRuntime = (): void => {
      if (runtimeInvalidated) {return;}
      runtimeInvalidated = true;
      operation.cancelRequested = true;
      operation.status = "cancelling";
      operation.tokenSource.cancel();
      resolveRuntimeInvalidation();
    };
    const runtimeDispose = typeof extensionState.bus.on === "function"
      ? extensionState.bus.on("backend-runtime-changing", (event) => {
          if (event.backendId === ctx.id
            && (event.runtimeGeneration > runtimeGeneration
              || event.instanceKey !== runtimeInstanceKey)) {
            invalidateRuntime();
          }
        })
      : undefined;
    const assertRuntimeCurrent = (): void => {
      if (operation.cancelRequested) {
        throw runtimeInvalidated ? runtimeChangedError() : new Error("Model request cancelled");
      }
      if (!isRuntimeCurrent()) {
        invalidateRuntime();
        throw runtimeChangedError();
      }
    };
    const awaitModelOperation = async <T>(pending: Promise<T>): Promise<T> => {
      // Build the race before the check so a promise that rejects while a
      // transition is observed still has a rejection handler attached.
      const runtimeAbort = runtimeInvalidation.then(() => {
        throw runtimeChangedError();
      });
      let cancellationDisposable: { dispose(): void } | undefined;
      const cancellation = new Promise<never>((_, reject) => {
        const token = operation.tokenSource.token;
        if (token.isCancellationRequested) {
          reject(operation.cancelRequested
            ? (runtimeInvalidated ? runtimeChangedError() : new Error("Model request cancelled"))
            : new Error("Model request cancelled"));
          return;
        }
        cancellationDisposable = token.onCancellationRequested(() => {
          reject(runtimeInvalidated ? runtimeChangedError() : new Error("Model request cancelled"));
        });
      });
      const raced = Promise.race([pending, runtimeAbort, cancellation]);
      try {
        assertRuntimeCurrent();
        return await raced;
      } finally {
        cancellationDisposable?.dispose();
      }
    };
    try {
      assertRuntimeCurrent();
      if (!ctx.backend.isRunning()) {
        const started = await awaitModelOperation(ctx.backend.start(workspacePath));
        assertRuntimeCurrent();
        if (started.error) {
          throw new Error(String(started.error));
        }
      }
      assertRuntimeCurrent();
      // Catalog refreshes are independently latest-only; adding another
      // runtime-wide queue here would let a hung old request block new model
      // requests before they can reach the provider.
      await awaitModelOperation(extensionState.modelCatalog.refresh(workspacePath));
      assertRuntimeCurrent();
      extensionState.bus.emit("models-changed", { backendId: ctx.id });
      const models = await awaitModelOperation(
        Promise.resolve(vscode.lm.selectChatModels({ vendor: ctx.vendor })),
      );
      assertRuntimeCurrent();
      const catalog = extensionState.modelCatalog.list();
      const entry = catalog.find(
        (item) =>
          item.backendId === ctx.id &&
          item.vendor === ctx.vendor &&
          item.copilotModelId === operation.modelId,
      );
      const target =
        entry &&
        models.find(
          (model) =>
            model.vendor === ctx.vendor &&
            backendOwnsCopilotModel(catalog, ctx.id, ctx.vendor, model.id, ctx.instanceKey) &&
            model.id === entry.copilotModelId,
        );
      if (!target) {
        throw new Error(
          `Language model not found in backend catalog for vendor "${ctx.vendor}": ${operation.modelId}`,
        );
      }
      assertRuntimeCurrent();
      operation.modelId = target.id;
      operation.status = operation.cancelRequested ? "cancelling" : "running";
      const response = await awaitModelOperation(
        Promise.resolve(target.sendRequest!(
          [vscode.LanguageModelChatMessage.User(text)],
          isRecord(options)
            ? (options as vscode.LanguageModelChatRequestOptions)
            : undefined,
          operation.tokenSource.token,
        )),
      );
      responseIterator = response.stream[Symbol.asyncIterator]();
      while (true) {
        // Promise.resolve().then() also turns a synchronous iterator.next()
        // throw into a promise so the same cancellation/runtime race handles
        // both sync and async iterator implementations.
        const nextPromise = Promise.resolve().then(() => responseIterator!.next());
        responseNext = nextPromise;
        const result = await awaitModelOperation(nextPromise);
        responseNext = undefined;
        assertRuntimeCurrent();
        if (result.done) {
          responseCompleted = true;
          break;
        }
        if (operation.parts.length < 2000) {
          operation.parts.push(summarizeModelPart(result.value));
        }
      }
    } catch (error) {
      operation.error = error instanceof Error ? error.message : String(error);
      outcome = "failed";
    } finally {
      operation.tokenSource.dispose();
      runtimeDispose?.();
      if (responseNext) {
        // `awaitModelOperation` already races this promise, but keep an
        // explicit rejection observer for a late iterator failure after
        // cancellation/runtime invalidation wins the race.
        void responseNext.catch(() => undefined);
      }
      if (responseIterator && !responseCompleted && responseIterator.return) {
        // Async generators can queue return() behind a pending next(). Do not
        // await cleanup here: the request must finish even when the source is
        // unresponsive. Its rejection is still observed to avoid an
        // unhandled-rejection in the extension host.
        try {
          void Promise.resolve(responseIterator.return()).catch(() => undefined);
        } catch {
          // Iterator cleanup is best effort; the request has already ended.
        }
      }
      operation.active = false;
      finishModelRequest(
        operation,
        operation.cancelRequested ? "cancelled" : outcome,
      );
      evictTerminalOperations(modelRequestOperations);
    }
  };

  const summarizeEvent = (event: unknown): PromptEventSummary => {
    if (!isRecord(event)) {
      return {};
    }
    const properties = isRecord(event.properties)
      ? event.properties
      : undefined;
    const notification = isRecord(event.notification)
      ? event.notification
      : undefined;
    const part =
      properties && isRecord(properties.part) ? properties.part : undefined;
    return {
      type: typeof event.type === "string" ? event.type : undefined,
      kind: typeof event.kind === "string" ? event.kind : undefined,
      sessionId: firstString(
        properties?.sessionID,
        properties?.sessionId,
        notification?.sessionId,
        event.sessionId,
      ),
      partType: typeof part?.type === "string" ? part.type : undefined,
      toolCallId: firstString(part?.callID, part?.callId, event.toolCallId),
      status: firstString(
        isRecord(part?.state) ? part.state.status : undefined,
        event.stopReason,
      ),
    };
  };
  const isTerminalEvent = (event: unknown): boolean =>
    isRecord(event) &&
    (event.kind === "stop" ||
      event.type === "session.idle" ||
      event.type === "session.error");

  const runPromptOperation = async (
    operation: PromptOperation,
    ctx: BackendContext,
    text: string,
    options: unknown,
  ): Promise<void> => {
    let terminalSeen = false;
    let terminalError = false;
    let iterator: AsyncIterator<unknown> | undefined;
    let pendingNext: Promise<IteratorResult<unknown>> | undefined;
    let wakeResolver: (() => void) | undefined;
    let wakeSignalled = false;
    const wake = new Promise<void>(resolve => { wakeResolver = resolve; });
    const WAKE = Symbol("prompt-operation-wake");
    const signalWake = (): void => {
      if (wakeSignalled) {return;}
      wakeSignalled = true;
      wakeResolver?.();
    };
    const awaitOrWake = async <T>(pending: Promise<T>): Promise<T | typeof WAKE> =>
      Promise.race([
        pending,
        wake.then(() => WAKE as typeof WAKE),
      ]) as Promise<T | typeof WAKE>;
    operation.wake = signalWake;
    const runtimeDispose = watchOperationRuntime(operation, ctx);
    try {
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Prompt runtime changed");}
      // Register the session channel before connecting the backend transport.
      // This mirrors the production turn contract and prevents a fast backend
      // response from being emitted before the runtime probe starts reading.
      const stream = ctx.backend.events.openSessionStream(
        operation.sessionId,
      ) as { stream: AsyncIterable<unknown> };
      const started = await awaitOrWake(
        Promise.resolve().then(() => ctx.backend.events.ensureStarted()),
      );
      if (started === WAKE) {throw new Error("Prompt cancelled");}
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Prompt runtime changed");}
      if (operation.cancelRequested) {throw new Error("Prompt cancelled");}
      const result = await awaitOrWake(
        Promise.resolve().then(() => ctx.backend.sessions.prompt(
          operation.sessionId,
          text,
          workspacePath,
          isRecord(options) ? (options as never) : undefined,
        )),
      );
      if (result === WAKE) {throw new Error("Prompt cancelled");}
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Prompt runtime changed");}
      if (result.error) {
        operation.promptError = String(result.error);
        finish(operation, operation.cancelRequested ? "cancelled" : "failed");
        return;
      }
      if (operation.cancelRequested) {throw new Error("Prompt cancelled");}
      operation.promptAccepted = true;
      operation.result = result.data;
      operation.status = "running";
      iterator = stream.stream[Symbol.asyncIterator]();
      while (!operation.cancelRequested) {
        // A backend event stream may leave next() pending forever after a
        // disconnect. Race each read against the operation wake signal so
        // cancellation/runtime replacement can finish the diagnostic request.
        pendingNext = Promise.resolve().then(() => iterator!.next());
        const outcome = await Promise.race([
          pendingNext.then(iteratorResult => ({ kind: "event" as const, result: iteratorResult })),
          wake.then(() => ({ kind: "wake" as const })),
        ]);
        if (outcome.kind === "wake") {
          // Keep observing a late iterator rejection after the wake wins.
          void pendingNext.catch(() => undefined);
          break;
        }
        pendingNext = undefined;
        if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Prompt runtime changed");}
        if (outcome.result.done) {break;}
        const event = outcome.result.value;
        if (operation.events.length < 2000) {
          operation.events.push(summarizeEvent(event));
        }
        if (isTerminalEvent(event)) {
          terminalSeen = true;
          terminalError = isRecord(event) && event.type === "session.error";
          break;
        }
      }
      if (!terminalSeen) {
        operation.promptError = "Backend event stream ended before a terminal event";
        finish(operation, operation.cancelRequested ? "cancelled" : "failed");
      } else if (terminalError) {
        operation.promptError = "Backend session reported an error";
        finish(operation, operation.cancelRequested ? "cancelled" : "failed");
      } else {
        finish(operation, operation.cancelRequested ? "cancelled" : "completed");
      }
    } catch (error) {
      operation.promptError =
        error instanceof Error ? error.message : String(error);
      finish(operation, operation.cancelRequested ? "cancelled" : "failed");
    } finally {
      try {
        operation.wake = undefined;
        if (iterator?.return) {
          try {
            // Iterator cleanup is detached even after a normal terminal
            // event.  A broken backend may make return() wait on the same
            // transport that just ended; diagnostic completion must not be
            // held hostage by that cleanup path.
            const cleanup = Promise.resolve(iterator.return());
            void cleanup.catch(() => undefined);
          } catch {
            // Iterator cleanup is best effort; cancellation must not block.
          }
        }
        if (operationRuntimeCurrent(operation, ctx)) {
          ctx.backend.events.closeSessionStream(operation.sessionId);
        }
      } finally {
        runtimeDispose();
        operation.active = false;
        evictTerminalOperations(promptOperations);
      }
    }
  };

  const runTurnOperation = async (
    operation: TurnOperation,
    ctx: BackendContext,
    text: string,
    options: unknown,
  ): Promise<void> => {
    let sss: SerializableSessionStream | undefined;
    let streamOpened = false;
    let pipelinePromise: Promise<unknown> | undefined;
    let pipelineSettled = false;
    let abortPromise: Promise<void> | undefined;
    let cleanupRequired = false;
    let terminalStatus: Exclude<TurnStatus, "starting" | "running"> =
      "completed";
    const runtimeDispose = watchOperationRuntime(operation, ctx);

    const recordFailure = (error: unknown): void => {
      terminalStatus = operation.cancelRequested ? "cancelled" : "failed";
      operation.promptError ??=
        error instanceof Error ? error.message : String(error);
    };
    const abortOnce = async (): Promise<void> => {
      if (!operation.sessionId || !operationRuntimeCurrent(operation, ctx)) {
        return;
      }
      abortPromise ??= Promise.resolve().then(async () => {
        const result = await ctx.backend.sessions.abort(
          operation.sessionId,
          workspacePath,
        );
        if (result.error) {
          throw new Error(String(result.error));
        }
      });
      await abortPromise;
    };
    const drainPipeline = async (): Promise<void> => {
      if (!pipelinePromise || pipelineSettled) {
        return;
      }
      await Promise.race([
        pipelinePromise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    };

    try {
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (!ctx.backend.isRunning()) {
        const started = await ctx.backend.start(workspacePath);
        if (started.error) {
          throw new Error(String(started.error));
        }
      }
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      await ctx.backend.events.ensureStarted();
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      if (!operation.sessionId) {
        const created = await ctx.backend.sessions.create({
          directory: workspacePath,
        });
        if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
        operation.sessionId = created.data?.id ?? "";
        operation.createdSession = operation.sessionId.length > 0;
        if (created.error || !operation.sessionId) {
          throw new Error(String(created.error ?? "Session creation failed"));
        }
      }
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      const existing = await readAllStreamParts(
        ctx.sessionStore.getSessionPath(operation.sessionId),
      );
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      const indexes = existing
        .map((record) => record.meta?.turnIndex)
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        );
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      operation.turnIndex = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
      const pushRender = (render: RenderSummary): void => {
        operation.renderedCount += 1;
        if (operation.renders.length < 2000) {
          operation.renders.push(render);
        }
      };
      const fakeStream = {
        markdown: (value: unknown) =>
          pushRender({
            method: "markdown",
            text:
              typeof value === "string"
                ? value
                : isRecord(value) && typeof value.value === "string"
                  ? value.value
                  : undefined,
          }),
        progress: (value: string) =>
          pushRender({ method: "progress", text: value }),
        push: (part: unknown) =>
          pushRender({ method: "push", name: part?.constructor?.name }),
        thinkingProgress: (value: unknown) =>
          pushRender({
            method: "thinkingProgress",
            text:
              isRecord(value) && typeof value.text === "string"
                ? value.text
                : typeof value === "string"
                  ? value
                  : undefined,
          }),
        beginToolInvocation: (id: string, name: string) =>
          pushRender({ method: "beginToolInvocation", id, name }),
        updateToolInvocation: (id: string, data: unknown) =>
          pushRender({
            method: "updateToolInvocation",
            id,
            status:
              isRecord(data) && typeof data.invocationMessage === "string"
                ? data.invocationMessage
                : undefined,
          }),
        reference: () => pushRender({ method: "reference" }),
        anchor: () => pushRender({ method: "anchor" }),
        button: () => pushRender({ method: "button" }),
        filetree: () => pushRender({ method: "filetree" }),
        questionCarousel: async () => undefined,
        externalEdit: async (
          _target: unknown,
          callback: () => PromiseLike<unknown>,
        ) => {
          await callback();
          return `runtime-undo-${operation.id}`;
        },
      };
      sss = new SerializableSessionStream(
        fakeStream as unknown as vscode.ChatResponseStream,
        {
          workspaceRoot: workspacePath ?? "",
          backendName: ctx.storageNamespace,
          sessionId: operation.sessionId,
          turnIndex: operation.turnIndex,
          requestId: operation.id,
        },
      );
      await sss.initialize();
      // SSS initialization can perform filesystem work.  Re-check the lease
      // before appending records so a target switch cannot let an old turn
      // continue into the replacement runtime's event channel.
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      sss.recordFirstPrompt(text);
      sss.push(
        new UserPromptSSP({
          text,
          partId: `user-${operation.id}`,
          sessionId: operation.sessionId,
        }),
      );
      sss.writeMeta({
        id: operation.sessionId,
        backendName: ctx.backend.name,
        createdAt: new Date().toISOString(),
      });
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      const events = ctx.backend.events.openSessionStream(operation.sessionId);
      streamOpened = true;
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      const pipeline = ctx.backend.createPipeline({
        sessionId: operation.sessionId,
        directory: workspacePath,
        stream: sss,
        logger: extensionState.outputChannel,
        permissionMode: isRecord(options)
          && (options.permissionMode === 'read-only'
            || options.permissionMode === 'approval'
            || options.permissionMode === 'full-edit')
          ? options.permissionMode
          : undefined,
      });
      operation.status = "running";
      pipelinePromise = Promise.resolve(
        pipeline.run(events.stream, {
          get isCancellationRequested() {return operation.cancelRequested;},
        }),
      );
      void pipelinePromise.then(
        () => {
          pipelineSettled = true;
        },
        () => {
          pipelineSettled = true;
        },
      );
      const promptResult = await ctx.backend.sessions.prompt(
        operation.sessionId,
        text,
        workspacePath,
        isRecord(options) ? (options as never) : undefined,
      );
      if (!operationRuntimeCurrent(operation, ctx)) {throw new Error("Turn runtime changed");}
      if (operation.cancelRequested) {throw new Error("Turn cancelled");}
      if (promptResult.error) {
        operation.promptError = String(promptResult.error);
        cleanupRequired = true;
        try {
          await abortOnce();
        } catch (error) {
          recordFailure(error);
        }
        await drainPipeline();
        terminalStatus = "failed";
      } else {
        operation.promptAccepted = true;
        operation.promptResult = promptResult.data;
        try {
          operation.pipelineResult = await pipelinePromise;
          if (
            !isRecord(operation.pipelineResult) ||
            operation.pipelineResult.completed !== true
          ) {
            operation.promptError = "Backend pipeline did not complete";
            cleanupRequired = true;
            terminalStatus = "failed";
            try {
              await abortOnce();
            } catch (error) {
              recordFailure(error);
            }
          }
        } catch (error) {
          cleanupRequired = true;
          recordFailure(error);
          try {
            await abortOnce();
          } catch (abortError) {
            recordFailure(abortError);
          }
        }
      }
    } catch (error) {
      cleanupRequired = true;
      recordFailure(error);
      if (!operation.cancelRequested) {
        try {
          await abortOnce();
        } catch (abortError) {
          recordFailure(abortError);
        }
      }
    } finally {
      try {
        if (cleanupRequired) {
          if (!operation.cancelRequested) {
            try {
              await abortOnce();
            } catch (error) {
              recordFailure(error);
            }
          }
        }
        await drainPipeline();
        if (sss) {
          // The diagnostic endpoint must not stay occupied forever when an
          // SSS write queue (or a backend-owned cleanup call) is stuck.  Use a
          // truthy sentinel because a successful `flush()` resolves to
          // `undefined`, which is also the timeout value returned by
          // boundedOperation.
          const flushOnce = async (label: string): Promise<boolean> => {
            const outcome = await boundedOperation(
              Promise.resolve().then(() => sss!.flush()).then(() => true),
              OPERATION_CLEANUP_TIMEOUT_MS,
            );
            if (outcome === undefined) {
              recordFailure(new Error(`${label} timed out`));
              return false;
            }
            return true;
          };
          try {
            await flushOnce("Session stream flush");
            sss.close();
            await flushOnce("Session stream final flush");
          } catch (error) {
            recordFailure(error);
          }
          operation.sessionPath = sss.getSessionPath() ?? undefined;
        }
        if (streamOpened && operationRuntimeCurrent(operation, ctx)) {
          try {
            ctx.backend.events.closeSessionStream(operation.sessionId);
          } catch (error) {
            recordFailure(error);
          }
        }
        if (operation.sessionPath) {
          try {
            operation.parts = (
              await readAllStreamParts(operation.sessionPath)
            ).map(summarizeSerializedPart);
          } catch (error) {
            recordFailure(error);
          }
        }
        if (operation.createdSession && operation.sessionId && operationRuntimeCurrent(operation, ctx)) {
          if (ctx.backend.sessions.delete) {
            try {
              const deleted = await boundedOperation(
                Promise.resolve().then(() => ctx.backend.sessions.delete!(
                  operation.sessionId,
                  workspacePath,
                )),
                OPERATION_CLEANUP_TIMEOUT_MS,
              );
              if (deleted === undefined) {
                recordFailure(new Error("Backend session delete timed out"));
              } else if (deleted.error) {
                recordFailure(new Error(String(deleted.error)));
              }
            } catch (error) {
              recordFailure(error);
            }
          }
          // A delete can await a remote response long enough for a target
          // transition to replace the runtime.  Do not release through that
          // replacement; it may now refer to a different ACP session.
          if (operationRuntimeCurrent(operation, ctx)) {
            try {
              const released = await boundedOperation(
                Promise.resolve().then(() => ctx.backend.sessions.release(
                  operation.sessionId,
                  workspacePath,
                )).then(() => true),
                OPERATION_CLEANUP_TIMEOUT_MS,
              );
              if (released === undefined) {
                recordFailure(new Error("Backend session release timed out"));
              }
            } catch (error) {
              recordFailure(error);
            }
          }
        }
        operation.status = operation.cancelRequested ? "cancelled" : terminalStatus;
        operation.finishedAt = new Date().toISOString();
      } finally {
        runtimeDispose();
        operation.active = false;
        for (const resolve of operation.waiters.splice(0)) {
          resolve();
        }
        evictTerminalOperations(turnOperations);
      }
    }
  };

  const boundedOperation = async <T>(pending: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
      void pending.catch(() => undefined);
    }
  };

  const cancelPromptOperation = async (operation: PromptOperation, ctx: BackendContext): Promise<void> => {
    if (operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled" || operation.status === "cancelling") {
      return;
    }
    operation.cancelRequested = true;
    operation.status = "cancelling";
    operation.wake?.();
    try {
      if (operation.sessionId && operationRuntimeCurrent(operation, ctx)) {
        const result = await boundedOperation(
          ctx.backend.sessions.abort(operation.sessionId, workspacePath),
          OPERATION_CLEANUP_TIMEOUT_MS,
        );
        if (result === undefined) {
          operation.promptError ??= "Backend session abort timed out";
          return;
        }
        if (result.error) {operation.promptError ??= String(result.error);}
      }
    } catch (error) {
      operation.promptError ??= error instanceof Error ? error.message : String(error);
    } finally {
      try {
        if (operationRuntimeCurrent(operation, ctx)) {
          ctx.backend.events.closeSessionStream(operation.sessionId);
        }
      } catch {
        // Stream closure is best effort while cancellation is in flight.
      }
    }
  };

  const cancelTurnOperation = async (operation: TurnOperation, ctx: BackendContext): Promise<void> => {
    if (operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled" || operation.status === "cancelling") {
      return;
    }
    operation.cancelRequested = true;
    operation.status = "cancelling";
    try {
      if (operation.sessionId && operationRuntimeCurrent(operation, ctx)) {
        const result = await boundedOperation(
          ctx.backend.sessions.abort(operation.sessionId, workspacePath),
          OPERATION_CLEANUP_TIMEOUT_MS,
        );
        if (result === undefined) {
          operation.promptError ??= "Backend session abort timed out";
          return;
        }
        if (result.error) {operation.promptError ??= String(result.error);}
      }
    } catch (error) {
      operation.promptError ??= error instanceof Error ? error.message : String(error);
    } finally {
      try {
        if (operationRuntimeCurrent(operation, ctx)) {
          ctx.backend.events.closeSessionStream(operation.sessionId);
        }
      } catch {
        // Stream closure is best effort while cancellation is in flight.
      }
    }
  };

  return {
    snapshot: async () => ({
      backends: [...extensionState.backends.values()].map((ctx) => ({
        id: ctx.id,
        instanceKey: ctx.instanceKey,
        storageNamespace: ctx.storageNamespace,
        status: ctx.backend.getStatus(),
        selection: ctx.selection.get(),
      })),
      exposedModels: extensionState.modelCatalog.list(),
    }),
    inspectBackend: async (backendId: string) => {
      const ctx = getContext(backendId);
      return {
        id: ctx.id,
        instanceKey: ctx.instanceKey,
        storageNamespace: ctx.storageNamespace,
        status: ctx.backend.getStatus(),
        url: ctx.backend.getUrl(),
        running: ctx.backend.isRunning(),
        selection: ctx.selection.get(),
      };
    },
    inspectSession: async (backendId: string, sessionId: string) => {
      const result = await getContext(backendId).backend.sessions.get(
        sessionId,
        workspacePath,
      );
      if (result.error || !result.data) {
        throw new Error(String(result.error ?? "Session not found"));
      }
      return result.data;
    },
    listModels: async (backendId: string) => {
      const ctx = getContext(backendId);
      const result = ctx.backend.modelProvider
        ? await ctx.backend.modelProvider.listModels(workspacePath)
        : await ctx.backend.config.models(workspacePath);
      if (result.error) {
        throw new Error(String(result.error));
      }
      return result.data ?? [];
    },
    listAcpTargets: async () => loadAcpTargetState(context),
    selectAcpTarget: async (targetId: string) => {
      await dependencies.selectAcpTarget(
        extensionState,
        context,
        workspacePath,
        targetId,
      );
      return { instanceKey: getContext("acp").instanceKey };
    },
    startBackend: async (backendId: string) => {
      const ctx = getContext(backendId);
      const result = await ctx.backend.start(workspacePath);
      if (result.error) {
        throw new Error(String(result.error));
      }
      await ctx.selection.resolveDefaults();
      extensionState.bus.emit("backend-ready", { backendId });
      return result.data;
    },
    stopBackend: async (backendId: string) => {
      const ctx = getContext(backendId);
      await ctx.backend.stop();
      return { status: ctx.backend.getStatus() };
    },
    createSession: async (backendId: string) => {
      const result = await getContext(backendId).backend.sessions.create({
        directory: workspacePath,
      });
      if (result.error || !result.data) {
        throw new Error(String(result.error ?? "Session creation failed"));
      }
      return result.data;
    },
    listSessions: async (backendId: string) => {
      const result =
        await getContext(backendId).backend.sessions.list(workspacePath);
      if (result.error) {
        throw new Error(String(result.error));
      }
      return result.data ?? [];
    },
    startPrompt: async (
      backendId: string,
      sessionId: string,
      text: string,
      options?: unknown,
    ) => {
      if (!text.trim()) {
        throw new Error("Prompt text must be non-empty");
      }
      const ctx = getContext(backendId);
      const operation: PromptOperation = {
        id: `prompt-${randomUUID()}`,
        backendId,
        sessionId,
        status: "starting",
        startedAt: new Date().toISOString(),
        promptAccepted: false,
        cancelRequested: false,
        active: true,
        events: [],
        waiters: [],
        runtimeGeneration: ctx.runtimeGeneration,
        runtimeInstanceKey: ctx.instanceKey,
      };
      promptOperations.set(operation.id, operation);
      void runPromptOperation(operation, ctx, text, options);
      return operationSnapshot(operation);
    },
    getPrompt: async (operationId: string) =>
      operationSnapshot(getOperation(operationId)),
    waitPrompt: async (operationId: string, timeoutMs = 10_000) => {
      const operation = getOperation(operationId);
      const timedOut = await waitForCompletion(
        operation.waiters,
        () => operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled",
        Math.max(0, Math.min(timeoutMs, 30_000)),
      );
      if (timedOut) {
        await cancelPromptOperation(operation, getContext(operation.backendId));
        await waitForCompletion(
          operation.waiters,
          () => operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled",
          OPERATION_CLEANUP_TIMEOUT_MS,
        );
      }
      return operationSnapshot(operation);
    },
    cancelPrompt: async (operationId: string) => {
      const operation = getOperation(operationId);
      await cancelPromptOperation(operation, getContext(operation.backendId));
      return operationSnapshot(operation);
    },
    startTurn: async (
      backendId: string,
      sessionId: string | undefined,
      text: string,
      options?: unknown,
    ) => {
      if (!text.trim()) {
        throw new Error("Turn text must be non-empty");
      }
      const ctx = getContext(backendId);
      const operation: TurnOperation = {
        id: `turn-${randomUUID()}`,
        backendId,
        sessionId: sessionId ?? "",
        status: "starting",
        startedAt: new Date().toISOString(),
        createdSession: false,
        promptAccepted: false,
        cancelRequested: false,
        active: true,
        renderedCount: 0,
        renders: [],
        waiters: [],
        runtimeGeneration: ctx.runtimeGeneration,
        runtimeInstanceKey: ctx.instanceKey,
      };
      turnOperations.set(operation.id, operation);
      void runTurnOperation(operation, ctx, text, options);
      return turnSnapshot(operation);
    },
    getTurn: async (operationId: string) =>
      turnSnapshot(getTurnOperation(operationId)),
    waitTurn: async (operationId: string, timeoutMs = 30_000) => {
      const operation = getTurnOperation(operationId);
      const timedOut = await waitForCompletion(
        operation.waiters,
        () => operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled",
        Math.max(0, Math.min(timeoutMs, 30_000)),
      );
      if (timedOut) {
        await cancelTurnOperation(operation, getContext(operation.backendId));
        await waitForCompletion(
          operation.waiters,
          () => operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled",
          OPERATION_CLEANUP_TIMEOUT_MS,
        );
      }
      return turnSnapshot(operation);
    },
    cancelTurn: async (operationId: string) => {
      const operation = getTurnOperation(operationId);
      await cancelTurnOperation(operation, getContext(operation.backendId));
      return turnSnapshot(operation);
    },
    listLanguageModels: async (backendId: string) => {
      const ctx = getContext(backendId);
      const vendor = ctx.vendor;
      try {
        if (!ctx.backend.isRunning()) {
          const started = await ctx.backend.start(workspacePath);
          if (started.error) {
            throw new Error(String(started.error));
          }
        }
        await extensionState.modelCatalog.refresh(workspacePath);

        const catalog = extensionState.modelCatalog.list();
        const models = await vscode.lm.selectChatModels({ vendor });
        return models
          .filter(
            (model) =>
              model.vendor === vendor &&
              backendOwnsCopilotModel(catalog, ctx.id, vendor, model.id, ctx.instanceKey),
          )
          .map((model, index) => {
            // LanguageModelChat intentionally exposes a smaller public shape
            // than the provider information used by VS Code's picker. Join it
            // back to the canonical catalog so the control endpoint reports
            // the same Agent eligibility fields that the picker evaluates.
            const catalogEntry = catalog.find(entry =>
              entry.backendId === ctx.id
              && entry.backendInstanceKey === ctx.instanceKey
              && entry.vendor === vendor
              && entry.copilotModelId === model.id,
            );
            return {
              id: model.id,
              name: model.name,
              vendor: model.vendor,
              family: model.family,
              version: model.version,
              maxInputTokens: model.maxInputTokens,
              maxOutputTokens: catalogEntry?.maxOutputTokens,
              capabilities: catalogEntry?.capabilities,
              isUserSelectable: true,
              targetChatSessionType: ctx.scheme,
              isDefault: index === 0 ? true : undefined,
            };
          });
      } catch (error) {
        extensionState.outputChannel.appendLine(
          `[runtime-control] Model listing unavailable for ${backendId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    },
    generateTitle: async (backendId: string, prompt: string) => {
      const ctx = getContext(backendId);
      const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const allModels = await vscode.lm.selectChatModels();
      const title = await SessionTitleService.generateWithVsCodeLm(
        prompt,
        extensionState,
        ctx.vendor,
      );
      const access = (vscode.lm as typeof vscode.lm & {
        languageModelAccessInformation?: {
          canSendRequest(model: vscode.LanguageModelChat): boolean | undefined;
        };
      }).languageModelAccessInformation;
      return {
        title,
        copilotModels: copilotModels.map(model => ({
          id: model.id,
          vendor: model.vendor,
          name: model.name,
          canSendRequest: access?.canSendRequest(model),
        })),
        allModels: allModels.map(model => ({
          id: model.id,
          vendor: model.vendor,
          name: model.name,
          canSendRequest: access?.canSendRequest(model),
        })),
      };
    },
    startModelRequest: async (
      backendId: string,
      modelId: string,
      text: string,
      options?: unknown,
    ) => {
      if (!text.trim()) {
        throw new Error("Model request text must be non-empty");
      }
      const ctx = getContext(backendId);
      const operation: ModelRequestOperation = {
        id: `model-request-${randomUUID()}`,
        backendId,
        modelId,
        status: "starting",
        startedAt: new Date().toISOString(),
        parts: [],
        waiters: [],
        cancelRequested: false,
        active: true,
        tokenSource: new vscode.CancellationTokenSource(),
      };
      modelRequestOperations.set(operation.id, operation);
      void runModelRequest(operation, ctx, text, options);
      return modelRequestSnapshot(operation);
    },
    getModelRequest: async (operationId: string) =>
      modelRequestSnapshot(getModelRequestOperation(operationId)),
    waitModelRequest: async (operationId: string, timeoutMs = 30_000) => {
      const operation = getModelRequestOperation(operationId);
      const timedOut = await waitForCompletion(
        operation.waiters,
        isModelTerminal.bind(undefined, operation),
        Math.max(0, Math.min(timeoutMs, 30_000)),
      );
      if (timedOut) {
        cancelModelRequestOperation(operation);
        await waitForCompletion(
          operation.waiters,
          () => isModelTerminal(operation),
          OPERATION_CLEANUP_TIMEOUT_MS,
        );
      }
      return modelRequestSnapshot(operation);
    },
    cancelModelRequest: async (operationId: string) => {
      const operation = getModelRequestOperation(operationId);
      cancelModelRequestOperation(operation);
      return modelRequestSnapshot(operation);
    },
    refreshModels: async () => {
      await extensionState.modelCatalog.refresh(workspacePath);
      for (const backendId of extensionState.backends.keys()) {
        extensionState.bus.emit("models-changed", { backendId });
      }
      return extensionState.modelCatalog.list();
    },
    shutdownHost: async () => {
      setTimeout(() => {
        void vscode.commands.executeCommand("workbench.action.quit");
      }, 100);
      return { scheduled: true };
    },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
function summarizeSerializedPart(
  record: StreamPartRecord,
): Record<string, unknown> {
  const payload = isRecord(record.payload) ? record.payload : {};
  const toolState = isRecord(payload.state) ? payload.state : undefined;
  const summary: Record<string, unknown> = {
    id: record.id,
    kind: record.kind,
    version: record.version,
    turnIndex: record.meta?.turnIndex,
    sequence: record.meta?.sequence,
    source: record.meta?.source,
    sourceType: record.meta?.sourceType,
    subAgentInvocationId: record.meta?.subAgentInvocationId,
  };
  if (typeof payload.text === "string") {
    summary.text = payload.text;
  }
  if (typeof payload.toolName === "string") {
    summary.toolName = payload.toolName;
  }
  if (typeof payload.callId === "string") {
    summary.toolCallId = payload.callId;
  }
  if (typeof payload.status === "string") {
    summary.status = payload.status;
  } else if (typeof toolState?.status === "string") {
    summary.status = toolState.status;
  }
  return summary;
}
