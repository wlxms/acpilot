import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createRuntimeTestApi } from "../test-control/runtime-api";
import { AppEventBus } from "../backend/app-event-bus";
import { canonicalCopilotModelId } from "../surfaces/vscode/model-catalog";
import type { Backend } from "../backend/backend";
import type { ExtensionState, BackendContext } from "../types";

vi.mock("../backend/streaming/deserialize", () => ({
  readAllStreamParts: vi.fn(async () => []),
}));

const streamMock = vi.hoisted(() => ({
  initialize: undefined as (() => Promise<void>) | undefined,
  flush: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../backend/streaming/session-stream", () => ({
  SerializableSessionStream: class {
    async initialize(): Promise<void> {
      await streamMock.initialize?.();
    }
    recordFirstPrompt(_text: string): void {}
    push(_part: unknown): void {}
    writeMeta(_meta: unknown): void {}
    async flush(): Promise<void> {
      await streamMock.flush?.();
    }
    close(): void {}
    getSessionPath(): string {
      return "D:/workspace/session.jsonl";
    }
  },
}));

afterEach(() => {
  streamMock.initialize = undefined;
  streamMock.flush = undefined;
  vi.useRealTimers();
});

vi.mock("../ssp/impl/user-prompt", () => ({
  UserPromptSSP: class {
    constructor(_value: unknown) {}
  },
}));

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pendingEventStream(): {
  stream: AsyncIterable<unknown>;
  started: Promise<void>;
  rejectNext(error: unknown): void;
  wasReturned(): boolean;
} {
  let resolveStarted!: () => void;
  let rejectNext!: (error: unknown) => void;
  let returned = false;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: vi.fn(() => {
        resolveStarted();
        return new Promise<IteratorResult<unknown>>((_resolve, reject) => {
          rejectNext = reject;
        });
      }),
      return: vi.fn(async () => {
        returned = true;
        return { value: undefined, done: true };
      }),
    }),
  };
  return {
    stream,
    started,
    rejectNext: error => rejectNext(error),
    wasReturned: () => returned,
  };
}

function createState(backend: Backend): ExtensionState {
  const context: BackendContext = {
    id: "opencode",
    instanceKey: "opencode",
    runtimeGeneration: 0,
    acceptingRequests: true,
    storageNamespace: "opencode",
    displayName: "OpenCode",
    scheme: "acpilot.opencode",
    vendor: "acpilot-opencode",
    backend,
    selection: {} as BackendContext["selection"],
    sessions: {} as BackendContext["sessions"],
    sessionStore: {
      getSessionPath: vi.fn(() => "D:/workspace/session.jsonl"),
    } as unknown as BackendContext["sessionStore"],
  };
  return {
    backends: new Map([[context.id, context]]),
    modelCatalog: {
      refresh: vi.fn(async () => undefined),
      list: vi.fn(() => []),
    } as unknown as ExtensionState["modelCatalog"],
    outputChannel: { appendLine: vi.fn() } as unknown as ExtensionState["outputChannel"],
    statusBar: {} as ExtensionState["statusBar"],
    bus: { emit: vi.fn() } as unknown as ExtensionState["bus"],
  };
}

function createBackend(
  overrides: {
    create?: Backend["sessions"]["create"];
    prompt?: Backend["sessions"]["prompt"];
    abort?: Backend["sessions"]["abort"];
    delete?: Backend["sessions"]["delete"];
    release?: Backend["sessions"]["release"];
    run?: () => Promise<unknown>;
  } = {},
): Backend {
  const backend = {
    name: "opencode",
    isRunning: () => true,
    start: vi.fn(async () => ({
      data: { url: "http://localhost", status: "running" as const },
    })),
    stop: vi.fn(async () => undefined),
    getStatus: () => "running" as const,
    getUrl: () => "http://localhost",
    sessions: {
      create:
        overrides.create ??
        vi.fn(async () => ({
          data: { id: "temporary", title: "temp", createdAt: new Date() },
        })),
      prompt: overrides.prompt ?? vi.fn(async () => ({ data: true })),
      abort: overrides.abort ?? vi.fn(async () => ({ data: true })),
      delete: overrides.delete ?? vi.fn(async () => ({ data: true })),
      release: overrides.release ?? vi.fn(async () => undefined),
    },
    events: {
      ensureStarted: vi.fn(async () => undefined),
      openSessionStream: vi.fn(() => ({ stream: (async function* () {})() })),
      closeSessionStream: vi.fn(),
      openGlobalStream: vi.fn(),
    },
    config: { models: vi.fn(async () => ({ data: [] })) },
    permissions: { reply: vi.fn() },
    questions: { reply: vi.fn(), reject: vi.fn() },
    auth: { setKey: vi.fn(), removeKey: vi.fn() },
    createPipeline: vi.fn(() => ({
      run: overrides.run ?? (async () => ({ completed: true })),
    })),
  } as unknown as Backend;
  return backend;
}

function createApi(backend: Backend) {
  return createRuntimeTestApi(
    createState(backend),
    {} as vscode.ExtensionContext,
    "D:/workspace",
    {
      selectAcpTarget: vi.fn(async () => undefined),
    },
  );
}

function createApiFixture(backend: Backend) {
  const state = createState(backend);
  state.bus = new AppEventBus();
  return {
    state,
    api: createRuntimeTestApi(
      state,
      {} as vscode.ExtensionContext,
      "D:/workspace",
      { selectAcpTarget: vi.fn(async () => undefined) },
    ),
  };
}

describe("runtime turn lifecycle", () => {
  it("rejects unknown backends before creating runtime operations", async () => {
    const api = createApi(createBackend());

    await expect(api.startPrompt("missing", "session-1", "hello")).rejects.toThrow(
      "Unknown backend: missing",
    );
    await expect(api.startTurn("missing", undefined, "hello")).rejects.toThrow(
      "Unknown backend: missing",
    );
    await expect(api.startModelRequest("missing", "model-1", "hello")).rejects.toThrow(
      "Unknown backend: missing",
    );
  });

  it("aborts, closes and disposes an auto-created session after prompt failure", async () => {
    const order: string[] = [];
    const pipeline = deferred<unknown>();
    const backend = createBackend({
      prompt: vi.fn(async () => {
        order.push("prompt");
        return { error: "prompt failed" };
      }),
      abort: vi.fn(async () => {
        order.push("abort");
        pipeline.resolve({ completed: false });
        return { data: true };
      }),
      delete: vi.fn(async () => {
        order.push("delete");
        return { data: true };
      }),
      release: vi.fn(async () => {
        order.push("release");
      }),
      run: () => pipeline.promise,
    });
    const api = createApi(backend);

    const started = await api.startTurn("opencode", undefined, "hello");
    const finished = await api.waitTurn((started as { id: string }).id, 5_000);

    expect(finished).toMatchObject({
      status: "failed",
      sessionId: "temporary",
    });
    expect(order).toEqual(["prompt", "abort", "delete", "release"]);
    expect(backend.events.closeSessionStream).toHaveBeenCalledWith("temporary");
  });

  it("cancels an in-flight prompt and closes its event stream", async () => {
    const gate = deferred<void>();
    const abort = vi.fn(async () => ({ data: true }));
    const close = vi.fn();
    const backend = createBackend({ abort });
    backend.events.ensureStarted = vi.fn(() => gate.promise);
    backend.events.closeSessionStream = close;
    const api = createApi(backend);

    const started = await api.startPrompt("opencode", "session-1", "hello");
    const cancelled = await api.cancelPrompt((started as { id: string }).id);
    expect(cancelled).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(abort).toHaveBeenCalledWith("session-1", "D:/workspace");
    expect(close).toHaveBeenCalledWith("session-1");

    // A second cancellation while the first one is still unwinding must not
    // issue another backend abort request.
    await api.cancelPrompt((started as { id: string }).id);
    expect(abort).toHaveBeenCalledTimes(1);

    gate.resolve();
    const finished = await api.waitPrompt((started as { id: string }).id, 5_000);
    expect(finished).toMatchObject({ status: "cancelled", cancelRequested: true });
  });

  it("wakes a pending event iterator when a prompt is cancelled", async () => {
    const pending = pendingEventStream();
    const backend = createBackend();
    backend.events.openSessionStream = vi.fn(() => ({ stream: pending.stream }));
    const api = createApi(backend);

    const started = await api.startPrompt("opencode", "session-1", "hello");
    await pending.started;
    const operationId = (started as { id: string }).id;

    await api.cancelPrompt(operationId);
    const finished = await api.waitPrompt(operationId, 100);
    expect(finished).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(pending.wasReturned()).toBe(true);

    // The source may reject after cancellation has already completed. The
    // runtime API must have an observer attached so this does not become an
    // unhandled rejection.
    pending.rejectNext(new Error("late iterator failure"));
    await Promise.resolve();
  });

  it("wakes a pending event iterator when the backend runtime changes", async () => {
    const pending = pendingEventStream();
    const backend = createBackend();
    backend.events.openSessionStream = vi.fn(() => ({ stream: pending.stream }));
    const { api, state } = createApiFixture(backend);

    const started = await api.startPrompt("opencode", "session-1", "hello");
    await pending.started;
    const operationId = (started as { id: string }).id;
    const ctx = state.backends.get("opencode")!;
    ctx.runtimeGeneration += 1;
    ctx.instanceKey = "opencode:replacement";
    ctx.acceptingRequests = false;
    state.bus.emit("backend-runtime-changing", {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: ctx.instanceKey,
    });

    const finished = await api.waitPrompt(operationId, 100);
    expect(finished).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(pending.wasReturned()).toBe(true);
    pending.rejectNext(new Error("late runtime iterator failure"));
    await Promise.resolve();
  });

  it("does not abort or close a replacement runtime when cancelling an old prompt", async () => {
    const gate = deferred<void>();
    const abort = vi.fn(async () => ({ data: true }));
    const close = vi.fn();
    const backend = createBackend({ abort });
    backend.events.ensureStarted = vi.fn(() => gate.promise);
    backend.events.closeSessionStream = close;
    const { api, state } = createApiFixture(backend);

    const started = await api.startPrompt("opencode", "old-session", "hello");
    const ctx = state.backends.get("opencode")!;
    ctx.runtimeGeneration += 1;
    ctx.instanceKey = "opencode:replacement";
    ctx.acceptingRequests = false;
    state.bus.emit("backend-runtime-changing", {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: ctx.instanceKey,
    });

    await api.cancelPrompt((started as { id: string }).id);
    expect(abort).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    gate.resolve();
    await expect(api.waitPrompt((started as { id: string }).id, 100)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
    });
  });

  it("bounds diagnostic cancellation when backend abort hangs", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const backend = createBackend({ abort: vi.fn(() => never) });
      const { api } = createApiFixture(backend);
      const started = await api.startPrompt("opencode", "session-1", "hello");
      const cancellation = api.cancelPrompt((started as { id: string }).id);
      await vi.advanceTimersByTimeAsync(2_100);
      await expect(cancellation).resolves.toMatchObject({
        status: "cancelled",
        cancelRequested: true,
        promptError: "Prompt cancelled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a prompt when its event stream ends without a terminal event", async () => {
    const backend = createBackend();
    backend.events.openSessionStream = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "message.part.updated",
          properties: { sessionID: "session-1", part: { type: "text" } },
        };
      })(),
    }));
    const api = createApi(backend);

    const started = await api.startPrompt("opencode", "session-1", "hello");
    const finished = await api.waitPrompt((started as { id: string }).id, 5_000);

    expect(finished).toMatchObject({
      status: "failed",
      promptAccepted: true,
      promptError: "Backend event stream ended before a terminal event",
    });
    expect(backend.events.closeSessionStream).toHaveBeenCalledWith("session-1");
  });

  it("fails a prompt when the backend reports a session error", async () => {
    const backend = createBackend();
    backend.events.openSessionStream = vi.fn(() => ({
      stream: (async function* () {
        yield { type: "session.error", properties: { sessionID: "session-1" } };
      })(),
    }));
    const api = createApi(backend);

    const started = await api.startPrompt("opencode", "session-1", "hello");
    const finished = await api.waitPrompt((started as { id: string }).id, 5_000);

    expect(finished).toMatchObject({
      status: "failed",
      promptAccepted: true,
      promptError: "Backend session reported an error",
    });
  });

  it("cancels a turn through backend abort and stream closure", async () => {
    const gate = deferred<void>();
    const abort = vi.fn(async () => ({ data: true }));
    const close = vi.fn();
    const backend = createBackend({ abort });
    backend.events.ensureStarted = vi.fn(() => gate.promise);
    backend.events.closeSessionStream = close;
    const api = createApi(backend);

    const started = await api.startTurn("opencode", "session-1", "hello");
    const cancelled = await api.cancelTurn((started as { id: string }).id);
    expect(cancelled).toMatchObject({ status: "cancelling", cancelRequested: true });
    expect(abort).toHaveBeenCalledWith("session-1", "D:/workspace");
    expect(close).toHaveBeenCalledWith("session-1");

    // Cancellation is idempotent while the turn is still in flight.
    await api.cancelTurn((started as { id: string }).id);
    expect(abort).toHaveBeenCalledTimes(1);

    gate.resolve();
    const finished = await api.waitTurn((started as { id: string }).id, 5_000);
    expect(finished).toMatchObject({ status: "cancelled", cancelRequested: true });
  });

  it("does not clean an auto-created turn through a replacement runtime", async () => {
    const prompt = deferred<{ data: boolean }>();
    const pipeline = deferred<unknown>();
    const abort = vi.fn(async () => ({ data: true }));
    const remove = vi.fn(async () => ({ data: true }));
    const release = vi.fn(async () => undefined);
    const close = vi.fn();
    const backend = createBackend({
      prompt: vi.fn(() => prompt.promise),
      abort,
      delete: remove,
      release,
      run: () => pipeline.promise,
    });
    backend.events.closeSessionStream = close;
    const { api, state } = createApiFixture(backend);
    const started = await api.startTurn("opencode", undefined, "hello");
    await vi.waitFor(() => expect(backend.sessions.prompt).toHaveBeenCalledOnce());

    const ctx = state.backends.get("opencode")!;
    ctx.runtimeGeneration += 1;
    ctx.instanceKey = "opencode:replacement";
    ctx.acceptingRequests = false;
    state.bus.emit("backend-runtime-changing", {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: ctx.instanceKey,
    });
    prompt.resolve({ data: true });
    pipeline.resolve({ completed: false });

    await expect(api.waitTurn((started as { id: string }).id, 5_000)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      sessionId: "temporary",
    });
    expect(abort).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("does not open an old turn stream when SSS initialization crosses a runtime transition", async () => {
    const initializeGate = deferred<void>();
    let initializeEntered = false;
    streamMock.initialize = async () => {
      initializeEntered = true;
      await initializeGate.promise;
    };
    const backend = createBackend();
    const openStream = vi.fn(backend.events.openSessionStream);
    backend.events.openSessionStream = openStream;
    const { api, state } = createApiFixture(backend);

    const started = await api.startTurn("opencode", "session-1", "hello");
    await vi.waitFor(() => expect(initializeEntered).toBe(true));

    const ctx = state.backends.get("opencode")!;
    ctx.runtimeGeneration += 1;
    ctx.instanceKey = "opencode:replacement";
    ctx.acceptingRequests = false;
    state.bus.emit("backend-runtime-changing", {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: ctx.instanceKey,
    });
    initializeGate.resolve();

    await expect(api.waitTurn((started as { id: string }).id, 5_000)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
    });
    expect(openStream).not.toHaveBeenCalled();
    expect(backend.sessions.prompt).not.toHaveBeenCalled();
  });

  it("does not release an auto-created session after delete crosses a runtime transition", async () => {
    const deleteGate = deferred<{ data: boolean }>();
    const remove = vi.fn(() => deleteGate.promise);
    const release = vi.fn(async () => undefined);
    const backend = createBackend({
      delete: remove,
      release,
    });
    const { api, state } = createApiFixture(backend);

    const started = await api.startTurn("opencode", undefined, "hello");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("temporary", "D:/workspace"));

    const ctx = state.backends.get("opencode")!;
    ctx.runtimeGeneration += 1;
    ctx.instanceKey = "opencode:replacement";
    ctx.acceptingRequests = false;
    state.bus.emit("backend-runtime-changing", {
      backendId: ctx.id,
      runtimeGeneration: ctx.runtimeGeneration,
      instanceKey: ctx.instanceKey,
    });
    deleteGate.resolve({ data: true });

    await expect(api.waitTurn((started as { id: string }).id, 5_000)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
    });
    expect(release).not.toHaveBeenCalled();
  });

  it("cancels prompt and turn operations when their waits time out", async () => {
    const promptGate = deferred<void>();
    const promptAbort = vi.fn(async () => ({ data: true }));
    const promptBackend = createBackend({ abort: promptAbort });
    promptBackend.events.ensureStarted = vi.fn(() => promptGate.promise);
    const promptApi = createApi(promptBackend);
    const prompt = await promptApi.startPrompt("opencode", "session-1", "hello");
    const promptWait = promptApi.waitPrompt((prompt as { id: string }).id, 0);
    await vi.waitFor(() => expect(promptAbort).toHaveBeenCalledWith("session-1", "D:/workspace"));
    promptGate.resolve();
    const promptResult = await promptWait;
    expect(promptResult).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(promptAbort).toHaveBeenCalledWith("session-1", "D:/workspace");

    const turnGate = deferred<void>();
    const turnAbort = vi.fn(async () => ({ data: true }));
    const turnBackend = createBackend({ abort: turnAbort });
    turnBackend.events.ensureStarted = vi.fn(() => turnGate.promise);
    const turnApi = createApi(turnBackend);
    const turn = await turnApi.startTurn("opencode", "session-1", "hello");
    const turnWait = turnApi.waitTurn((turn as { id: string }).id, 0);
    await vi.waitFor(() => expect(turnAbort).toHaveBeenCalledWith("session-1", "D:/workspace"));
    turnGate.resolve();
    const turnResult = await turnWait;
    expect(turnResult).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(turnAbort).toHaveBeenCalledWith("session-1", "D:/workspace");
  });

  it("aborts an auto-created session when the pipeline reports incomplete", async () => {
    const order: string[] = [];
    const backend = createBackend({
      abort: vi.fn(async () => {
        order.push("abort");
        return { data: true };
      }),
      delete: vi.fn(async () => {
        order.push("delete");
        return { data: true };
      }),
      release: vi.fn(async () => {
        order.push("release");
      }),
      run: async () => ({ completed: false }),
    });
    const api = createApi(backend);

    const started = await api.startTurn("opencode", undefined, "hello");
    const finished = await api.waitTurn((started as { id: string }).id, 5_000);

    expect(finished).toMatchObject({
      status: "failed",
      sessionId: "temporary",
    });
    expect(order).toEqual(["abort", "delete", "release"]);
    expect(backend.events.closeSessionStream).toHaveBeenCalledWith("temporary");
  });

  it("releases and deletes an auto-created session after success", async () => {
    const order: string[] = [];
    const backend = createBackend({
      delete: vi.fn(async () => {
        order.push("delete");
        return { data: true };
      }),
      release: vi.fn(async () => {
        order.push("release");
      }),
    });
    const api = createApi(backend);

    const started = await api.startTurn("opencode", undefined, "hello");
    const finished = await api.waitTurn((started as { id: string }).id, 5_000);

    expect(finished).toMatchObject({
      status: "completed",
      sessionId: "temporary",
    });
    expect(order).toEqual(["delete", "release"]);
    expect(backend.sessions.abort).not.toHaveBeenCalled();
    expect(backend.events.closeSessionStream).toHaveBeenCalledWith("temporary");
  });

  it("does not dispose a session when automatic creation fails", async () => {
    const abort = vi.fn(async () => ({ data: true }));
    const remove = vi.fn(async () => ({ data: true }));
    const release = vi.fn(async () => undefined);
    const backend = createBackend({
      create: vi.fn(async () => ({ error: "create failed" })),
      abort,
      delete: remove,
      release,
    });
    const api = createApi(backend);

    const started = await api.startTurn("opencode", undefined, "hello");
    const finished = await api.waitTurn((started as { id: string }).id, 5_000);

    expect(finished).toMatchObject({ status: "failed", sessionId: "" });
    expect(abort).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(backend.events.closeSessionStream).not.toHaveBeenCalled();
  });

  it("bounds turn stream flush, delete and release cleanup", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    streamMock.flush = () => never;
    const backend = createBackend({
      delete: vi.fn(() => never),
      release: vi.fn(() => never),
    });
    const api = createApi(backend);

    const started = await api.startTurn("opencode", undefined, "hello");
    const operationId = (started as { id: string }).id;
    const wait = api.waitTurn(operationId, 0);

    // Two bounded stream flushes plus delete and release each get their own
    // two-second budget. Advance all four windows without waiting in real time.
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(wait).resolves.toMatchObject({
      // The endpoint returns after its bounded cancellation wait even when
      // backend cleanup itself remains stuck.
      status: "cancelling",
      cancelRequested: true,
    });
    expect(backend.sessions.delete).toHaveBeenCalledWith("temporary", "D:/workspace");
    expect(backend.sessions.release).toHaveBeenCalledWith("temporary", "D:/workspace");
    await expect(api.getTurn(operationId)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
    });
  });

  it("returns an empty model listing when the VS Code model registry is unavailable", async () => {
    const api = createApi(createBackend());
    vi.spyOn(vscode.lm, "selectChatModels").mockRejectedValueOnce(
      new Error("model registry unavailable"),
    );

    await expect(api.listLanguageModels("opencode")).resolves.toEqual([]);
  });

  it("does not queue a newer model request behind a hanging catalog refresh", async () => {
    const backend = createBackend();
    const state = createState(backend);
    state.bus = new AppEventBus();
    const ctx = state.backends.get("opencode")!;
    const modelId = canonicalCopilotModelId("acpilot-opencode", "provider", "model-1");
    const catalogEntry = {
      backendId: "opencode",
      backendInstanceKey: ctx.instanceKey,
      vendor: ctx.vendor,
      role: "agent" as const,
      copilotModelId: modelId,
      modelId: "model-1",
      providerID: "provider",
      displayName: "Model 1",
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
      capabilities: {},
    };
    state.modelCatalog.list = vi.fn(() => [catalogEntry]);
    let refreshCount = 0;
    let releaseFirst!: () => void;
    const firstRefresh = new Promise<void>((resolve) => { releaseFirst = resolve; });
    state.modelCatalog.refresh = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 1) {
        await firstRefresh;
      }
    });
    const sendRequest = vi.fn(async () => ({
      stream: (async function* () {})(),
    }));
    const select = vi.spyOn(vscode.lm, "selectChatModels").mockResolvedValue([
      {
        id: modelId,
        vendor: ctx.vendor,
        family: "Test",
        name: "Model 1",
        sendRequest,
      } as unknown as vscode.LanguageModelChat,
    ]);
    const api = createRuntimeTestApi(
      state,
      {} as vscode.ExtensionContext,
      "D:/workspace",
      { selectAcpTarget: vi.fn(async () => undefined) },
    );

    try {
      const first = await api.startModelRequest("opencode", modelId, "first");
      const second = await api.startModelRequest("opencode", modelId, "second");
      await vi.waitFor(() => expect(refreshCount).toBe(2));

      const secondResult = await api.waitModelRequest((second as { id: string }).id, 5_000);
      expect(secondResult).toMatchObject({ status: "completed" });
      expect(sendRequest).toHaveBeenCalledOnce();

      await api.cancelModelRequest((first as { id: string }).id);
      const firstResult = await api.waitModelRequest((first as { id: string }).id, 5_000);
      expect(firstResult).toMatchObject({ status: "cancelled" });
    } finally {
      releaseFirst();
      select.mockRestore();
    }
  });

  it("cancels a model request when its captured backend runtime changes", async () => {
    const backend = createBackend();
    const state = createState(backend);
    state.bus = new AppEventBus();
    const ctx = state.backends.get("opencode")!;
    const modelId = canonicalCopilotModelId("acpilot-opencode", "provider", "model-1");
    state.modelCatalog.list = vi.fn(() => [{
      backendId: "opencode",
      backendInstanceKey: ctx.instanceKey,
      vendor: ctx.vendor,
      role: "agent" as const,
      copilotModelId: modelId,
      modelId: "model-1",
      providerID: "provider",
      displayName: "Model 1",
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
      capabilities: {},
    }]);
    let releaseRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    state.modelCatalog.refresh = vi.fn(() => pendingRefresh);
    const sendRequest = vi.fn(async () => ({ stream: (async function* () {})() }));
    const select = vi.spyOn(vscode.lm, "selectChatModels").mockResolvedValue([
      {
        id: modelId,
        vendor: ctx.vendor,
        family: "Test",
        name: "Model 1",
        sendRequest,
      } as unknown as vscode.LanguageModelChat,
    ]);
    const api = createRuntimeTestApi(
      state,
      {} as vscode.ExtensionContext,
      "D:/workspace",
      { selectAcpTarget: vi.fn(async () => undefined) },
    );

    try {
      const started = await api.startModelRequest("opencode", modelId, "hello");
      await vi.waitFor(() => expect(state.modelCatalog.refresh).toHaveBeenCalledOnce());
      ctx.runtimeGeneration += 1;
      ctx.acceptingRequests = false;
      state.bus.emit("backend-runtime-changing", {
        backendId: ctx.id,
        runtimeGeneration: ctx.runtimeGeneration,
        instanceKey: ctx.instanceKey,
      });

      const finished = await api.waitModelRequest((started as { id: string }).id, 5_000);
      expect(finished).toMatchObject({ status: "cancelled", cancelRequested: true });
      expect(sendRequest).not.toHaveBeenCalled();
    } finally {
      releaseRefresh();
      select.mockRestore();
    }
  });

  it("cancels a model request while its response stream read is pending", async () => {
    const backend = createBackend();
    const state = createState(backend);
    state.bus = new AppEventBus();
    const ctx = state.backends.get("opencode")!;
    const modelId = canonicalCopilotModelId("acpilot-opencode", "provider", "model-1");
    state.modelCatalog.list = vi.fn(() => [{
      backendId: "opencode",
      backendInstanceKey: ctx.instanceKey,
      vendor: ctx.vendor,
      role: "agent" as const,
      copilotModelId: modelId,
      modelId: "model-1",
      providerID: "provider",
      displayName: "Model 1",
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
      capabilities: {},
    }]);

    let rejectPendingRead!: (reason?: unknown) => void;
    const next = vi.fn(() => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
      rejectPendingRead = reject;
    }));
    const close = vi.fn(() => Promise.reject(new Error("late iterator close failure")));
    const iterator = {
      next,
      return: close,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const sendRequest = vi.fn(async () => ({ stream: iterator }));
    const select = vi.spyOn(vscode.lm, "selectChatModels").mockResolvedValue([
      {
        id: modelId,
        vendor: ctx.vendor,
        family: "Test",
        name: "Model 1",
        sendRequest,
      } as unknown as vscode.LanguageModelChat,
    ]);
    const api = createRuntimeTestApi(
      state,
      {} as vscode.ExtensionContext,
      "D:/workspace",
      { selectAcpTarget: vi.fn(async () => undefined) },
    );

    try {
      const started = await api.startModelRequest("opencode", modelId, "hello");
      const operationId = (started as { id: string }).id;
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());

      await expect(api.cancelModelRequest(operationId)).resolves.toMatchObject({
        status: "cancelling",
        cancelRequested: true,
      });
      await expect(api.waitModelRequest(operationId, 5_000)).resolves.toMatchObject({
        status: "cancelled",
        cancelRequested: true,
      });
      expect(close).toHaveBeenCalledOnce();

      // The source may reject its already-pending read after cancellation.
      // This must remain observed and must not change the terminal result.
      rejectPendingRead(new Error("late response stream failure"));
      await Promise.resolve();
      await expect(api.getModelRequest(operationId)).resolves.toMatchObject({
        status: "cancelled",
      });
    } finally {
      select.mockRestore();
    }
  });
});
