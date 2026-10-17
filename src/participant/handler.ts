import * as vscode from 'vscode';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import { SerializableSessionStream } from '../backend/streaming/session-stream';
import { UserPromptSSP } from '../ssp/impl/user-prompt';
import { SessionTitleService, isPlaceholderSessionTitle } from './session-title';

import type { ExtensionState, TurnMapping, BackendContext } from '../types';
import type { BackendAgent, PermissionMode } from '../backend/types';
import { normalizePermissionMode } from '../backend/types';
import type { BackendPipelineResult } from '../backend/backend';
import type { SessionTitleSource } from '../backend/serializable/types';
import { extractAttachmentsFromReferences } from './references';

const HANDLER_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Let a backend operation settle for a short grace period during cleanup.
 * Cancellation must release Copilot even when a remote transport is wedged;
 * the operation is still observed after the timeout so late failures do not
 * become unhandled rejections.
 */
async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  logger?: { appendLine(message: string): void },
  label = 'operation',
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observed = operation.then(
    () => undefined,
    (error: unknown) => {
      logger?.appendLine(
        `[handler] ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  try {
    await Promise.race([
      observed,
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Clean up a backend session created for a request that lost the race to
 * cancellation. The operation is deliberately best effort: cancellation
 * must release Copilot even when a backend endpoint is slow or unavailable.
 * Callers provide a runtime predicate so a target transition never routes a
 * stale session id through a dynamically reconnected backend object.
 */
async function cleanupLateCreatedSession(
  ctx: BackendContext,
  sessionId: string,
  directory: string | undefined,
  isRuntimeCurrent: () => boolean,
  logger: { appendLine(message: string): void },
): Promise<void> {
  const run = async (
    label: string,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    if (!isRuntimeCurrent()) {
      return;
    }
    await settleWithin(
      Promise.resolve().then(() => {
        // Keep this check in the same microtask as the call. A transition can
        // happen between cleanup stages, in which case later stages must be
        // skipped rather than sent to the replacement connection.
        if (!isRuntimeCurrent()) {
          return undefined;
        }
        return operation();
      }).then(result => {
        if (result && typeof result === 'object' && 'error' in result) {
          const error = (result as { error?: unknown }).error;
          if (error !== undefined) {
            throw new Error(String(error));
          }
        }
      }),
      HANDLER_DRAIN_TIMEOUT_MS,
      logger,
      label,
    );
  };

  await run(
    `Late session abort (${sessionId})`,
    () => ctx.backend.sessions.abort(sessionId, directory),
  );
  if (!isRuntimeCurrent()) {
    return;
  }
  if (ctx.backend.sessions.delete) {
    await run(
      `Late session delete (${sessionId})`,
      () => ctx.backend.sessions.delete!(sessionId, directory),
    );
  }
  if (!isRuntimeCurrent()) {
    return;
  }
  await run(
    `Late session release (${sessionId})`,
    () => ctx.backend.sessions.release(sessionId, directory),
  );
}

// ---------------------------------------------------------------------------
// Native model sync
// ---------------------------------------------------------------------------

/**
 * Resolve the model to use for a prompt, preferring the VS Code native
 * language-model selection (`request.model`) over the extension's own
 * SelectionStore state.
 *
 * The VS Code Chat Participant API (stable) exposes `request.model:
 * LanguageModelChat` - an object carrying `.id`, `.vendor`, `.family`,
 * `.version` - which reflects whichever model the user picked in VS Code's
 * built-in model dropdown.  Prior to this function the extension only used
 * its own `SelectionStore` (populated by the experimental session-provider
 * option groups) which can go stale when the user changes the *native*
 * picker without touching the extension's own model dropdown.
 *
 * Native selections are resolved only through the current Copilot model catalog.
 * A request without a native model uses the backend's SelectionStore; once a
 * native model is present, an unregistered or foreign route is an error.
 */
export async function resolvePromptModel(
  request: vscode.ChatRequest,
  state: ExtensionState,
  ctx: BackendContext,
  runtimeGuard?: () => void,
): Promise<{ providerID: string; modelID: string } | undefined> {
  runtimeGuard?.();
  const nativeModel = request.model;

  // Fast path: no native model - use custom store
  if (!nativeModel) {
    return ctx.selection.get().model;
  }

  // The catalog's canonical Copilot id is the only native routing identity.
  const vendor = (nativeModel as vscode.LanguageModelChat).vendor;
  if (!vendor) {
    throw new Error(`Unable to resolve native model "${nativeModel.id}": vendor is missing.`);
  }
  const resolution = state.modelCatalog.resolve(
    ctx.id,
    vendor,
    nativeModel.id,
    ctx.instanceKey,
  );
  runtimeGuard?.();
  if (resolution.kind !== 'backend'
      || resolution.backendId !== ctx.id
      || resolution.backendInstanceKey !== ctx.instanceKey
      || !resolution.providerID
      || !resolution.modelID) {
    if (resolution.kind === 'backend' && resolution.backendId !== ctx.id) {
      state.outputChannel.appendLine(
        `[handler] Rejecting model route for backend ${resolution.backendId}; active backend is ${ctx.id}`,
      );
      throw new Error(
        `Model "${nativeModel.id}" belongs to backend "${resolution.backendId}" and cannot be used by backend "${ctx.id}".`,
      );
    }
    if (resolution.kind === 'backend' && resolution.backendInstanceKey !== ctx.instanceKey) {
      state.outputChannel.appendLine(
        `[handler] Rejecting model route for backend instance ${resolution.backendInstanceKey}; `
          + `active instance is ${ctx.instanceKey}`,
      );
      throw new Error(
        `Model "${nativeModel.id}" belongs to backend instance "${resolution.backendInstanceKey}" `
          + `and cannot be used by active instance "${ctx.instanceKey}".`,
      );
    }
    throw new Error(
      `Model "${nativeModel.id}" is not registered for backend "${ctx.id}" and vendor "${vendor}".`,
    );
  }

  // Sync the backend-local selection only after canonical resolution succeeds.
  const sel = ctx.selection.get();
  if (!sel.model ||
      sel.model.providerID !== resolution.providerID ||
      sel.model.modelID !== resolution.modelID) {
    runtimeGuard?.();
    await ctx.selection.setModel(resolution.providerID, resolution.modelID);
    runtimeGuard?.();
  }
  return { providerID: resolution.providerID, modelID: resolution.modelID };
}

/**
 * Validate the selected backend agent id before sending a prompt.
 */
export async function resolvePromptAgent(
  state: ExtensionState,
  ctx: BackendContext,
  directory?: string,
  runtimeGuard?: () => void,
): Promise<string | undefined> {
  runtimeGuard?.();
  const selected = ctx.selection.get().agent?.trim();
  if (!selected) {
    return undefined;
  }

  try {
    runtimeGuard?.();
    const result = await ctx.backend.config.agents(directory);
    runtimeGuard?.();
    const agents = result.data ?? [];
    if (agents.length === 0) {
      return selected;
    }

    if (agents.some((agent: BackendAgent) => agent.id === selected)) {return selected;}
    state.outputChannel.appendLine(
      `[handler] Agent id ${JSON.stringify(selected)} is not advertised by backend ${ctx.id}`,
    );
    return undefined;
  } catch (err) {
    // Preserve runtime-transition cancellation; only ordinary catalogue
    // failures are normalized to an absent agent.
    runtimeGuard?.();
    state.outputChannel.appendLine(
      `[handler] Agent selection normalization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Get the VSCode workspace root path for the first workspace folder.
 * Used as the project directory for OpenCode sessions.
 */
function getWorkspaceDirectory(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return workspaceFolders?.[0]?.uri?.fsPath;
}

/**
 * Prepend a short, machine-friendly header listing the non-image paths
 * the user referenced, so the model knows which files exist without us
 * having to inline their contents.
 */
function prependReferencedPaths(
  prompt: string,
  paths: readonly string[],
  logger?: { appendLine(m: string): void },
): string {
  if (paths.length === 0) {return prompt;}
  const list = paths.map((p) => `- ${p}`).join('\n');
  const header = `The user has referenced the following paths:\n${list}\n\n`;
  logger?.appendLine(`[handler] Prepended ${paths.length} path reference(s) to prompt`);
  return header + prompt;
}

/**
 * Ensure the OpenCode backend is running.
 * Starts the server lazily if not already running.
 * Returns true on success, false on failure.
 */
export async function ensureServer(
  state: ExtensionState,
  ctx: BackendContext,
  stream: vscode.ChatResponseStream,
  runtimeGuard?: () => void,
): Promise<boolean> {
  runtimeGuard?.();
  const status = ctx.backend.getStatus();
  if (status === 'running') {
    return true;
  }

  try {
    runtimeGuard?.();
    const backendName = ctx.displayName;
    stream.progress(status === 'starting' ? `${backendName} is starting...` : `Starting ${backendName} backend...`);
    const workspacePath = getWorkspaceDirectory();
    const result = await ctx.backend.start(workspacePath);
    runtimeGuard?.();
    if (result.error || !result.data) {
      const msg = typeof result.error === 'string' ? result.error : 'Unknown error';
      stream.markdown(`Failed to start backend: ${msg}`);
      return false;
    }
    state.outputChannel.appendLine(`[handler] Server started at ${result.data.url}`);
    stream.progress('Server ready');
    return true;
  } catch (err) {
    // A runtime transition is a cancellation boundary, not a backend-start
    // error to render into the new chat surface.
    runtimeGuard?.();
    const msg = err instanceof Error ? err.message : 'Unknown error';
    stream.markdown(`Failed to start backend: ${msg}`);
    return false;
  }
}

// -----------------------------------------------------------------------
// Session sync: VSCode chat session to backend session via request.sessionId
// -----------------------------------------------------------------------

/** Result of scanning chat history metadata for recoverable state */
interface RecoveredHistory {
  turnMap: TurnMapping[];
  backendSessionId: string | null;
}

/**
 * Recover turnMap and backend session id from previous ChatResponseTurn metadata in history.
 * Scans from newest to oldest, returns the first match with valid data.
 * Used for session recovery after VSCode restart and rewind/fork detection.
 */
function recoverFromHistory(context: vscode.ChatContext, instanceKey: string): RecoveredHistory {
  const history = context.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    // ChatResponseTurn is a proposed API - access metadata via type assertion
    const metadata = (turn as unknown as { metadata?: Record<string, unknown> })?.metadata;
    if (!metadata) {continue;}
    if (metadata.backendInstanceKey !== instanceKey) {continue;}

    const backendSessionId = (metadata.backendSessionId ?? metadata.sessionId) as string | undefined;
    const turnMapRaw = metadata.turnMap as Array<{ vscodeTurn: number; messageId: string }> | undefined;
    if (backendSessionId && turnMapRaw && Array.isArray(turnMapRaw)) {
      return { backendSessionId, turnMap: turnMapRaw };
    }
  }
  return { backendSessionId: null, turnMap: [] };
}

function getSessionResourceKey(request: vscode.ChatRequest): string | undefined {
  const sessionResource = request.sessionResource;
  if (!sessionResource) {
    return undefined;
  }

  try {
    return sessionResource.toString();
  } catch {
    return undefined;
  }
}

function aliasSessionState(
  state: ExtensionState,
  ctx: BackendContext,
  sourceKey: string | undefined,
  targetKey: string | undefined,
): void {
  if (!sourceKey || !targetKey || sourceKey === targetKey) {
    return;
  }

  const existing = ctx.sessions.get(sourceKey);
  if (existing && !ctx.sessions.has(targetKey)) {
    ctx.sessions.set(targetKey, existing);
  }
}

function getInitialSessionTitle(ctx: BackendContext, vscodeSessionId: string): string {
  const backendName = ctx.displayName;
  if (vscodeSessionId.includes('/untitled-')) {
    return `New ${backendName} Session`;
  }

  return `${backendName} Session ${vscodeSessionId.slice(0, 8)}`;
}

/**
 * Resolve or create an OpenCode session for this VSCode chat.
 *
 * Handles three cases:
 * 1. **New chat** - no prior state - create a fresh OpenCode session
 * 2. **Continue** - same number of history turns - reuse existing session
 * 3. **Rewind** - fewer history turns - revert to the matching message
 *
 * Returns the OpenCode session ID, or null on error.
 */
async function resolveSession(
  state: ExtensionState,
  ctx: BackendContext,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  vscodeSessionId: string,
  directory?: string,
  runtimeGuard?: () => void,
  isCancelled?: () => boolean,
): Promise<string | null> {
  runtimeGuard?.();
  // Get or create per-VSCode-chat state
  let chatState = ctx.sessions.get(vscodeSessionId);
  if (!chatState) {
    chatState = { backendSessionId: '', turnMap: [] };
    ctx.sessions.set(vscodeSessionId, chatState);
  }

  // Check for metadata recovery (VSCode restart / tab restore)
  if (!chatState.backendSessionId) {
    const recovered = recoverFromHistory(context, ctx.instanceKey);
    if (recovered.backendSessionId) {
      chatState.backendSessionId = recovered.backendSessionId;
      chatState.turnMap = recovered.turnMap;
      state.outputChannel.appendLine(
        `[handler] Recovered session from history: ${recovered.backendSessionId} (${recovered.turnMap.length} turns)`,
      );
    }
  }

  const history = context.history ?? [];
  const requestTurns = history.filter(
    (h): h is vscode.ChatRequestTurn => h instanceof vscode.ChatRequestTurn,
  );
  const currentTurnIndex = requestTurns.length;

  // --- Case 1: New chat (no prior session) ---
  if (!chatState.backendSessionId) {
    let createdSessionId: string | undefined;
    let cleanupStarted = false;
    const isRuntimeCurrent = (): boolean => {
      try {
        runtimeGuard?.();
        return true;
      } catch {
        return false;
      }
    };
    const clearAbandonedMapping = (): void => {
      if (ctx.sessions.get(vscodeSessionId) !== chatState) {
        return;
      }
      const remove = (ctx.sessions as unknown as {
        delete?: (key: string) => void;
      }).delete;
      if (typeof remove === 'function') {
        remove.call(ctx.sessions, vscodeSessionId);
        return;
      }
      // Test doubles and older embedders may not expose SessionManager.delete.
      // Reset the state in place so aliases cannot retain a usable stale id.
      chatState.backendSessionId = '';
      chatState.turnMap = [];
      chatState.title = undefined;
      chatState.titleSource = undefined;
      chatState.provisionalTitle = undefined;
      chatState.createdAt = undefined;
    };
    const cleanupAbandonedSession = async (): Promise<void> => {
      if (!createdSessionId || cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      try {
        await cleanupLateCreatedSession(
          ctx,
          createdSessionId,
          directory,
          isRuntimeCurrent,
          state.outputChannel,
        );
      } finally {
        clearAbandonedMapping();
      }
    };

    try {
      runtimeGuard?.();
      stream.progress('Creating new session...');
      const initialTitle = getInitialSessionTitle(ctx, vscodeSessionId);
      const result = await ctx.backend.sessions.create({
        title: initialTitle,
        directory,
      });
      // Retain a returned id even when the backend reports an error. A
      // malformed/partial response still represents a resource we must try to
      // dispose before surfacing the failure.
      createdSessionId = result.data?.id;
      runtimeGuard?.();
      if (result.error || !result.data) {
        stream.markdown('Failed to create session.');
        await cleanupAbandonedSession();
        return null;
      }
      if (isCancelled?.()) {
        await cleanupAbandonedSession();
        return null;
      }
      chatState.backendSessionId = result.data.id;
      chatState.title = result.data.title;
      chatState.titleSource = isPlaceholderSessionTitle(result.data.title) ? 'placeholder' : 'backend';
      chatState.createdAt = result.data.createdAt;
      // ACP backends advertise model and mode options when a session is created.
      // Refresh the shared catalog now that those backend-scoped capabilities exist.
      void Promise.resolve().then(async () => {
        runtimeGuard?.();
        await state.modelCatalog.refresh(directory);
        runtimeGuard?.();
        state.bus.emit('models-changed', { backendId: ctx.id });
      })
        .catch(err => {
          state.outputChannel.appendLine(
            `[handler] Model catalog refresh failed for ${ctx.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      stream.progress('Session ready');
      // Write session metadata before title lifecycle patches can run. If this is
      // left fire-and-forget, the initial placeholder write can race with the
      // first-prompt provisional title update and overwrite it.
      try {
        runtimeGuard?.();
        await ctx.sessionStore.writeMeta(result.data.id, {
          id: result.data.id,
          title: result.data.title ?? initialTitle,
          titleSource: chatState.titleSource,
          titleUpdatedAt: new Date().toISOString(),
          createdAt: result.data.createdAt?.toISOString() ?? new Date().toISOString(),
          backendName: ctx.id,
          backendInstanceKey: ctx.instanceKey,
        });
        runtimeGuard?.();
      } catch (err) {
        // Do not turn a stale-runtime write into a successful session setup.
        runtimeGuard?.();
        state.outputChannel.appendLine(`[handler] writeMeta failed: ${err}`);
      }
      if (isCancelled?.()) {
        await cleanupAbandonedSession();
        return null;
      }
      runtimeGuard?.();
      state.bus.emit('session-list-changed', { backendId: ctx.id });
      state.outputChannel.appendLine(
        `[handler] Created new session ${chatState.backendSessionId} for VSCode chat ${vscodeSessionId}`,
      );
      return chatState.backendSessionId;
    } catch (error) {
      // A runtime transition can happen while sessions.create() or metadata
      // persistence is pending. The outer request race may already have
      // returned, so cleanup must happen here when the late promise settles.
      await cleanupAbandonedSession();
      throw error;
    }
  }

  // A cancelled turn deliberately has no backend message mapping.  Count the
  // highest explicit VS Code turn instead of relying on array length so a
  // later request can continue across that gap without manufacturing a fake
  // backend message id.
  const recordedTurnCount = chatState.turnMap.reduce((count, entry) => {
    return Number.isInteger(entry.vscodeTurn) && entry.vscodeTurn >= 0
      ? Math.max(count, entry.vscodeTurn + 1)
      : count;
  }, 0);

  // --- Case 2: Continue (same or later turn count) ---
  if (currentTurnIndex >= recordedTurnCount) {
    stream.progress('Reusing existing session...');
    state.outputChannel.appendLine(
      `[handler] Reusing session ${chatState.backendSessionId} for VSCode chat ${vscodeSessionId} (turn ${currentTurnIndex}) ` +
      `turnMap=${chatState.turnMap.length}, recordedTurnCount=${recordedTurnCount}`,
    );
    return chatState.backendSessionId;
  }

  // --- Case 3: Rewind (fewer turns than recorded) - revert ---
  if (currentTurnIndex < recordedTurnCount) {
    const priorTurnMap = chatState.turnMap.filter(entry => entry.vscodeTurn < currentTurnIndex);
    const entriesToRevert = chatState.turnMap
      .filter(entry => entry.vscodeTurn >= currentTurnIndex)
      .sort((a, b) => b.vscodeTurn - a.vscodeTurn);
    if (currentTurnIndex > 0) {
      stream.progress('Rewinding conversation...');
      state.outputChannel.appendLine(
        `[handler] Rewind detected: reverting session ${chatState.backendSessionId} from turn ${currentTurnIndex} ` +
        `(turnMap had ${chatState.turnMap.length} entries, keeping ${priorTurnMap.length})`,
      );
      // Revert each extraneous message from back to front (oldest first)
      let allSucceeded = true;
      let revertCount = 0;
      for (const entry of entriesToRevert) {
        if (entry?.messageId) {
          runtimeGuard?.();
          const revertResult = await ctx.backend.sessions.revert(
            chatState.backendSessionId,
            entry.messageId,
            undefined,
            directory,
          );
          runtimeGuard?.();
          revertCount++;
          if (revertResult.error) {
            state.outputChannel.appendLine(
              `[handler] Revert failed for message ${entry.messageId}: ${JSON.stringify(revertResult.error)}`,
            );
            allSucceeded = false;
            break;
          }
        }
      }
      state.outputChannel.appendLine(
        `[handler] Reverted ${revertCount} messages, allSucceeded=${allSucceeded}`,
      );
      if (!allSucceeded) {
        state.outputChannel.appendLine('[handler] Revert failure - creating new session as fallback');
        runtimeGuard?.();
        const createResult = await ctx.backend.sessions.create({ directory });
        runtimeGuard?.();
        if (createResult.error || !createResult.data) {
          stream.markdown('Failed to create session after revert failure.');
          return null;
        }
        chatState.backendSessionId = createResult.data.id;
        chatState.turnMap = [];
        chatState.title = createResult.data.title;
        chatState.titleSource = isPlaceholderSessionTitle(createResult.data.title) ? 'placeholder' : 'backend';
        chatState.createdAt = createResult.data.createdAt;
        return chatState.backendSessionId;
      }
    } else {
      state.outputChannel.appendLine(
        `[handler] Full rewind for session ${chatState.backendSessionId} - no revert needed`,
      );
    }
    chatState.turnMap = priorTurnMap;
  }
  state.outputChannel.appendLine(
    `[handler] Reusing session ${chatState.backendSessionId} for VSCode chat ${vscodeSessionId} (turn ${currentTurnIndex}) ` +
    `turnMap=${chatState.turnMap.length}`,
  );
  return chatState.backendSessionId;
}

/**
 * Options for creating a participant handler.
 *
 * A surface callback can outlive a backend target transition. In that case
 * the handler must keep using the context captured when the callback was
 * created, while consulting the mutable owner context to notice that the
 * captured runtime is no longer valid. The default owner is the context
 * itself, which preserves the normal participant behaviour.
 */
export interface ParticipantHandlerOptions {
  readonly runtimeOwner?: BackendContext;
}

/** Create the shared request handler for one backend context. */
export function createParticipantHandler(
  state: ExtensionState,
  backendContext: BackendContext,
  options: ParticipantHandlerOptions = {},
): vscode.ChatRequestHandler {
  const runtimeOwner = options.runtimeOwner ?? backendContext;
  return async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    // Target switches replace runtime objects on the shared context. Keep one
    // immutable snapshot for the lifetime of this request so old work cannot
    // write into the newly selected target's stores.
    const ctx: BackendContext = { ...backendContext };
    let cancelDisposable: vscode.Disposable | undefined;
    let resolvedBackendSessionId: string | undefined;
    let cancelRequested = false;
    let resolveCancellation!: () => void;
    const cancellationSignal = new Promise<void>(resolve => {
      resolveCancellation = resolve;
    });
    let closeActiveEventStream: () => void = () => {};
    let abortSessionTree: (() => Promise<void>) | undefined;
    let cancellationDrainPromise: Promise<void> | undefined;
    let onSessionCancellation: (() => void) | undefined;

    class HandlerCancellationError extends Error {
      constructor() {
        super('Turn cancelled');
        this.name = 'HandlerCancellationError';
      }
    }

    class HandlerRuntimeChangedError extends HandlerCancellationError {
      constructor() {
        super();
        this.message = `Backend instance changed while the turn was running (${ctx.instanceKey}).`;
        this.name = 'HandlerRuntimeChangedError';
      }
    }

    const isHandlerCancellation = (error: unknown): boolean =>
      error instanceof HandlerCancellationError;
    const cancellationError = (): HandlerCancellationError => new HandlerCancellationError();
    const isRequestRuntimeCurrent = (): boolean =>
      runtimeOwner.acceptingRequests
      && runtimeOwner.runtimeGeneration === ctx.runtimeGeneration
      && runtimeOwner.instanceKey === ctx.instanceKey
      && runtimeOwner.storageNamespace === ctx.storageNamespace
      && runtimeOwner.backend === ctx.backend
      && runtimeOwner.selection === ctx.selection
      && runtimeOwner.sessions === ctx.sessions
      && runtimeOwner.sessionStore === ctx.sessionStore;
    const assertRequestRuntimeCurrent = (): void => {
      if (!isRequestRuntimeCurrent()) {
        throw new HandlerRuntimeChangedError();
      }
    };
    const requestCancellation = (message: string): void => {
      if (cancelRequested) {
        return;
      }
      cancelRequested = true;
      state.outputChannel.appendLine(message);
      resolveCancellation();
      onSessionCancellation?.();
      closeActiveEventStream();
    };
    const raceCancellation = async <T>(operation: Promise<T>): Promise<T> => {
      assertRequestRuntimeCurrent();
      if (cancelRequested || token.isCancellationRequested) {
        throw cancellationError();
      }
      const result = await Promise.race([
        operation,
        cancellationSignal.then(() => { throw cancellationError(); }),
      ]);
      assertRequestRuntimeCurrent();
      return result;
    };

    // A target switch or extension shutdown must wake a request even when the
    // backend promise itself never settles. The event is scoped by backend id
    // and monotonically increasing runtime generation, so a stale notification
    // cannot cancel a request created for a later runtime.
    const disposeRuntimeChanging = state.bus.on('backend-runtime-changing', event => {
      if (event.backendId !== ctx.id || event.runtimeGeneration <= ctx.runtimeGeneration) {
        return;
      }
      requestCancellation(
        `[handler] Backend runtime changing (${ctx.instanceKey} -> ${event.instanceKey}); cancelling turn`,
      );
    });

    try {
      assertRequestRuntimeCurrent();
      // 1. Early cancellation check
      if (token.isCancellationRequested) {
        return { metadata: {} };
      }

      // Promote this backend to the active one in the status bar so, with
      // multiple backends assembled, the bar reflects the backend actually
      // being used rather than whichever backend started last.
      state.statusBar.setActiveBackend(ctx.id);

      // 2. Slash command routing
      if (request.command) {
        return await raceCancellation(
          Promise.resolve().then(() => {
            assertRequestRuntimeCurrent();
            return routeCommand(request.command!, state, ctx, stream, token);
          }),
        );
      }

      // 3. Empty prompt check
      if (isEmptyPrompt(request.prompt)) {
        stream.markdown(ErrorMessages.EMPTY_PROMPT);
        return { metadata: {} };
      }

      // Subscribe before starting the backend or resolving a session. The
      // session-specific abort action is attached once resolveSession() gives
      // us an id; cancellation during this early phase is still remembered and
      // immediately acted on when that id becomes available.
      cancelDisposable = token.onCancellationRequested(() => {
        requestCancellation('[handler] Cancellation requested before session setup');
      });
      if (token.isCancellationRequested) {
        requestCancellation('[handler] Cancellation was already requested before session setup');
      }
      if (cancelRequested) {
        throw new HandlerCancellationError();
      }

      // 4. Start server if needed
      const ready = await raceCancellation(
        Promise.resolve().then(() => {
          assertRequestRuntimeCurrent();
          return ensureServer(state, ctx, stream, assertRequestRuntimeCurrent);
        }),
      );
      if (!ready) {return { metadata: {} };}
      if (cancelRequested || token.isCancellationRequested) {
        throw new HandlerCancellationError();
      }

      // 4b. Compute workspace directory for session/prompt API calls
      const directory = getWorkspaceDirectory();

      // 5. Resolve session (handles rewind via revert)
      // request.sessionId from chatParticipantPrivate identifies the VSCode chat
      const vscodeSessionId = request.sessionId ?? 'unknown';
      const sessionResourceKey = getSessionResourceKey(request);

      // Session-target switches can restore state under the provider resource URI
      // before the first follow-up prompt arrives with a VSCode chat sessionId.
      // Alias that restored state so the request handler reuses the selected
      // session instead of creating a detached one.
      aliasSessionState(state, ctx, sessionResourceKey, vscodeSessionId);

      const backendSessionId = await raceCancellation(
        resolveSession(
          state,
          ctx,
          context,
          stream,
          vscodeSessionId,
          directory,
          assertRequestRuntimeCurrent,
          () => cancelRequested || token.isCancellationRequested,
        ),
      );
      if (!backendSessionId) {return { metadata: {} };}
      resolvedBackendSessionId = backendSessionId;

      // Install cancellation handling as soon as the backend session is known.
      // This covers model/attachment resolution and SSS setup, not only the
      // event-pipeline portion of a turn.
      let abortPromise: Promise<void> | undefined;
      const abortSessionTreeOnce = (): Promise<void> => {
        if (abortPromise) {
          return abortPromise;
        }
        // A target transition owns teardown of the old transport. Once the
        // context generation changes, calling abort by session id could hit a
        // newly connected target that happens to reuse that id.
        if (!isRequestRuntimeCurrent()) {
          return Promise.resolve();
        }

        let sessionIds: string[];
        try {
          // Capture descendants before closing the event stream. OpenCode's
          // close operation clears the child-parent correlation index.
          sessionIds = [backendSessionId, ...ctx.backend.sessions.descendants(backendSessionId)];
        } catch (error: unknown) {
          sessionIds = [backendSessionId];
          state.outputChannel.appendLine(
            `[handler] Descendant lookup failed during abort: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        abortPromise = Promise.all(sessionIds.map(async (sessionId) => {
          try {
            const result = await ctx.backend.sessions.abort(sessionId, directory);
            state.outputChannel.appendLine(
              `[handler] Abort ${sessionId === backendSessionId ? 'parent' : 'descendant'} result: ${JSON.stringify(result?.data)}`,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            state.outputChannel.appendLine(
              `[handler] Abort ${sessionId === backendSessionId ? 'parent' : `descendant ${sessionId}`} error: ${msg}`,
            );
          }
        })).then(() => undefined);
        return abortPromise;
      };
      abortSessionTree = abortSessionTreeOnce;
      const drainAbort = (): Promise<void> => {
        if (cancellationDrainPromise) {
          return cancellationDrainPromise;
        }
        cancellationDrainPromise = settleWithin(
          abortSessionTreeOnce(),
          HANDLER_DRAIN_TIMEOUT_MS,
          state.outputChannel,
          'Cancellation abort',
        );
        return cancellationDrainPromise;
      };
      onSessionCancellation = (): void => {
        state.outputChannel.appendLine(
          `[handler] Cancellation requested, aborting session ${backendSessionId} and descendants`,
        );
        // Start the abort while the hierarchy index is still intact, then
        // close the active stream to wake any pipeline consumer immediately.
        void drainAbort();
        closeActiveEventStream();
      };
      if (cancelRequested) {
        // The listener may have fired while resolveSession() was awaiting.
        // Attach the id now and immediately perform the deferred cascade.
        onSessionCancellation();
      }

      aliasSessionState(state, ctx, vscodeSessionId, sessionResourceKey);

      const titleService = new SessionTitleService(state, ctx);
      const activeChatState = ctx.sessions.get(vscodeSessionId);
      if (activeChatState) {
        activeChatState.createdAt = activeChatState.createdAt ?? new Date();
      }

      const shouldInitializeTitle =
        !!activeChatState &&
        activeChatState.turnMap.length === 0 &&
        (isPlaceholderSessionTitle(activeChatState.title) || !!activeChatState.provisionalTitle) &&
        !isPlaceholderSessionTitle(request.prompt);
      if (shouldInitializeTitle) {
        if (cancelRequested) {
          throw cancellationError();
        }
        const provisionalTitle = request.prompt.length > 60
          ? `${request.prompt.slice(0, 57).trimEnd()}...`
          : request.prompt;
        await raceCancellation(titleService.applyProvisional({
          backendSessionId,
          vscodeSessionId,
          title: provisionalTitle,
          directory,
          updateBackend: true,
          createdAt: activeChatState.createdAt,
        }));
        if (cancelRequested) {
          throw cancellationError();
        }
        state.outputChannel.appendLine(
          `[handler] Applied provisional first-prompt title: "${provisionalTitle}"`,
        );
      }

      // Generate the final title while the first turn is running.  The
      // provisional title above is intentional: External Edit and the
      // backend event pipeline need a stable title immediately, while the LM
      // request may take longer than the first response.  Applying the result
      // through SessionTitleService keeps the backend, SSS metadata, and the
      // Copilot session mapping in sync.
      const earlyTitlePromise: Promise<string | undefined> = shouldInitializeTitle
        ? (async (): Promise<string | undefined> => {
          // The native picker model is authoritative for this turn. Prefer it
          // directly because VS Code may not have refreshed the global model
          // pool yet when title generation starts.
          const generated = await titleService.generateFromPrompt(request.prompt, request.model);
          if (!generated || isPlaceholderSessionTitle(generated)) {
            state.outputChannel.appendLine(
              `[handler] LM title unavailable for ${backendSessionId}; keeping provisional title`,
            );
            return undefined;
          }
          const applied = await titleService.applyFinal({
            backendSessionId,
            vscodeSessionId,
            title: generated,
            directory,
            updateBackend: true,
            overwrite: false,
            source: 'copilot-style',
          });
          if (applied) {
            state.outputChannel.appendLine(
              `[handler] Applied generated first-prompt title: "${applied}"`,
            );
          }
          return applied;
        })().catch((err: unknown) => {
          state.outputChannel.appendLine(
            `[handler] Early title generation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        })
        : Promise.resolve(undefined);

      if (cancelRequested) {
        return {
          metadata: {
            sessionId: backendSessionId,
            backendSessionId,
            backendInstanceKey: ctx.instanceKey,
            turnMap: ctx.sessions.get(vscodeSessionId)?.turnMap ?? [],
          },
        };
      }

      const executeTurnWithPipeline = async (): Promise<void> => {
        if (cancelRequested || token.isCancellationRequested) {
          throw cancellationError();
        }
        // Resolve prompt inputs before opening the stream.  Once the stream is
        // opened, the pipeline is started before the first prompt is sent.
        stream.progress('Preparing message...');
        state.outputChannel.appendLine(
          `[handler] Preparing prompt for session ${backendSessionId}: ${request.prompt.substring(0, 50)}`,
        );

        // Debug: log available request properties and toolReferences for attachment debugging
        const reqKeys = Object.keys(request).filter(k => !k.startsWith('_')).join(',');
        state.outputChannel.appendLine(`[handler] request keys: ${reqKeys}`);
        const toolRefs = (request as { toolReferences?: readonly unknown[] }).toolReferences;
        state.outputChannel.appendLine(
          `[handler] toolReferences: ${toolRefs?.length ?? 0} items`,
        );
        if (toolRefs?.length) {
          for (let ti = 0; ti < toolRefs.length; ti++) {
            const tr = toolRefs[ti] as Record<string, unknown>;
            state.outputChannel.appendLine(
              `[handler]  toolRef[${ti}] name="${tr.name}" keys=${Object.keys(tr).join(',')}`,
            );
          }
        }

        // Also check for any attachments-like property on the request
        const maybeAttachments = (request as { attachments?: unknown }).attachments;
        state.outputChannel.appendLine(
          `[handler] request.attachments: ${maybeAttachments === undefined ? 'undefined' : Array.isArray(maybeAttachments) ? `array[${maybeAttachments.length}]` : typeof maybeAttachments}`,
        );

        // Extract image attachments and non-image path references from
        // VSCode chat references.  Images become binary attachments that
        // the backend embeds; non-image files/dirs are surfaced as plain
        // paths in the prompt text so the model can read them with tools
        // instead of having the backend slurp the bytes and base64-encode
        // them.
        const { attachments, paths } = extractAttachmentsFromReferences(
          request.references,
          directory,
          state.outputChannel,
        );
        if (attachments.length > 0) {
          state.outputChannel.appendLine(
            `[handler] Extracted ${attachments.length} image attachment(s) from request references`,
          );
        }
        if (paths.length > 0) {
          state.outputChannel.appendLine(
            `[handler] Extracted ${paths.length} path reference(s) from request references`,
          );
        }

        // Build prompt options from agent selection, native model sync, and attachments.
        // Model resolution prefers request.model (native VS Code picker) over the
        // extension's own SelectionStore to avoid stale custom state.
        const promptOptions: {
          model?: { providerID: string; modelID: string };
          agent?: string;
          permissionMode: PermissionMode;
          attachments?: typeof attachments;
        } = {
          permissionMode: normalizePermissionMode(ctx.selection.get().permissionMode),
        };
        const resolvedAgent = await raceCancellation(
          Promise.resolve().then(() => {
            assertRequestRuntimeCurrent();
            return resolvePromptAgent(state, ctx, directory, assertRequestRuntimeCurrent);
          }),
        );
        if (resolvedAgent) {
          promptOptions.agent = resolvedAgent;
        }
        // Resolve model: SelectionStore only when no native picker model exists;
        // a present native model must resolve through the current backend catalog.
        const resolvedModel = await raceCancellation(
          Promise.resolve().then(() => {
            assertRequestRuntimeCurrent();
            return resolvePromptModel(request, state, ctx, assertRequestRuntimeCurrent);
          }),
        );
        if (resolvedModel) {
          promptOptions.model = resolvedModel;
        }
        if (attachments.length > 0) {
          promptOptions.attachments = attachments;
        }
        state.outputChannel.appendLine(
          `[handler] Prompt options: ${JSON.stringify({ ...promptOptions, attachments: attachments.length > 0 ? `[${attachments.length} items]` : undefined })}`,
        );

        // Inject referenced paths into the prompt so the model knows about
        // them without us having to ship their bytes.
        const promptText = paths.length > 0
          ? prependReferencedPaths(request.prompt, paths, state.outputChannel)
          : request.prompt;

        // Continuation loop: after subagent tasks complete, the orchestrator needs
        // additional prompts to continue. We reopen the event stream and run the
        // pipeline again until no more subagent tasks are detected.
        let userMessageId: string | null = null;
        let needsContinue = true;
        let sessionTitleFromPipeline: string | undefined;
        let sessionTitleSourceFromPipeline: SessionTitleSource | undefined;
        const liveTurnIndex = (context.history ?? []).filter(
          (h): h is vscode.ChatRequestTurn => h instanceof vscode.ChatRequestTurn,
        ).length;
        let titleUpdateChain: Promise<void> = Promise.resolve();

        // SSS persistence (v2 architecture)
        const workspaceRoot = getWorkspaceDirectory() ?? '';
        state.outputChannel.appendLine(
          `[handler] workspaceRoot="${workspaceRoot}" backend="${ctx.backend.name}" ` +
          `backendSessionId="${backendSessionId}" requestId="${request.id}" turn=${liveTurnIndex}`,
        );
        const sessionStream = new SerializableSessionStream(stream, {
          workspaceRoot,
          backendName: ctx.storageNamespace,
          sessionId: backendSessionId,
          turnIndex: liveTurnIndex,
          requestId: request.id,
          onTitleChanged: (update) => {
            if (cancelRequested || token.isCancellationRequested || !isRequestRuntimeCurrent()) {
              return;
            }
            sessionTitleFromPipeline = update.title;
            sessionTitleSourceFromPipeline = update.source;
            titleUpdateChain = titleUpdateChain
              .catch(() => undefined)
              .then(async () => {
                if (cancelRequested || token.isCancellationRequested || !isRequestRuntimeCurrent()) {
                  return;
                }
                const applied = await titleService.applyFinal({
                  backendSessionId,
                  vscodeSessionId,
                  title: update.title,
                  directory,
                  updateBackend: false,
                  overwrite: false,
                  source: update.source,
                });
                if (applied) {
                  state.outputChannel.appendLine(
                    `[handler] Applied live SSS session title (${update.source}): "${applied}"`,
                  );
                }
              })
              .catch((err: unknown) => {
                state.outputChannel.appendLine(
                  `[handler] live SSS title update failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          },
        });
        let sssInitialized = false;

        let nextPromptText = promptText;
        let nextPromptOptions: typeof promptOptions | undefined = promptOptions;
        let turnCompleted = false;
        let initializationPromise: Promise<void> | undefined;
        try {
          assertRequestRuntimeCurrent();
          initializationPromise = sessionStream.initialize();
          await raceCancellation(initializationPromise);
          sssInitialized = true;
          state.outputChannel.appendLine(`[handler] SSS initialized`);
          assertRequestRuntimeCurrent();
          sessionStream.recordFirstPrompt(request.prompt);

          // Push user message before pipeline.run (first record of the turn)
          assertRequestRuntimeCurrent();
          sessionStream.push(new UserPromptSSP({
            text: request.prompt,
            command: request.command,
            partId: `user-${backendSessionId}`,
          }));
          // SSS.initialize() already writes the session header. Title
          // lifecycle methods persist their own metadata patches, so a second
          // snapshot here would race with the provisional/generated title and
          // replay the placeholder over it.
          state.outputChannel.appendLine(`[handler] UserPromptSSP pushed`);

          while (needsContinue && !token.isCancellationRequested && !cancelRequested) {
            state.outputChannel.appendLine(`[handler] pipeline run start for session ${backendSessionId}`);
            stream.progress('Waiting for response...');

            // Register the per-session channel before starting the backend
            // transport.  This closes the fast-response gap where an event can
            // otherwise be emitted before a consumer exists.
            assertRequestRuntimeCurrent();
            const events = ctx.backend.events.openSessionStream(backendSessionId);
            assertRequestRuntimeCurrent();
            let eventStreamClosed = false;
            const closeEventStream = (): void => {
              if (eventStreamClosed) {return;}
              eventStreamClosed = true;
              if (!isRequestRuntimeCurrent()) {return;}
              try {
                ctx.backend.events.closeSessionStream(backendSessionId);
              } catch (err: unknown) {
                state.outputChannel.appendLine(
                  `[handler] Event stream close failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            };
            closeActiveEventStream = closeEventStream;

            let pipelinePromise: Promise<BackendPipelineResult> | undefined;
            let promptPromise: Promise<{ error?: unknown; data?: unknown }> | undefined;
            let ensurePromise: Promise<void> | undefined;
            try {
              stream.progress('Connecting to event stream...');
              // ensureStarted is intentionally repeated for every iteration:
              // a global transport can reconnect or be replaced between the
              // initial prompt and a continuation prompt.
              ensurePromise = Promise.resolve().then(() => {
                assertRequestRuntimeCurrent();
                return ctx.backend.events.ensureStarted();
              });
              await raceCancellation(ensurePromise);
              if (token.isCancellationRequested || cancelRequested) {
                throw cancellationError();
              }

              assertRequestRuntimeCurrent();
              const pipeline = ctx.backend.createPipeline({
                sessionId: backendSessionId,
                directory,
                stream: sessionStream,
                logger: state.outputChannel,
                permissionMode: nextPromptOptions?.permissionMode,
              });
              state.outputChannel.appendLine(`[handler] Pipeline created, SSS bound`);

              // Start consuming before invoking prompt.  The backend may emit
              // the first event synchronously from prompt(), so this ordering is
              // part of the Copilot-to-Agent application contract.
              state.outputChannel.appendLine('[handler] pipeline.run() starting...');
              try {
                pipelinePromise = Promise.resolve().then(() => {
                  assertRequestRuntimeCurrent();
                  return pipeline.run(events.stream, token);
                });
              } catch (err) {
                pipelinePromise = Promise.reject(err);
              }
              // Observe an early pipeline rejection while prompt() is still
              // in flight; the actual rejection is rethrown below.
              void pipelinePromise.catch(() => undefined);

              promptPromise = Promise.resolve().then(() => {
                assertRequestRuntimeCurrent();
                return ctx.backend.sessions.prompt(
                  backendSessionId,
                  nextPromptText,
                  directory,
                  nextPromptOptions,
                );
              });
              let promptResult: { error?: unknown; data?: unknown };
              try {
                state.outputChannel.appendLine(
                  `[handler] Prompting session ${backendSessionId} with: ${nextPromptText.substring(0, 50)}`,
                );
                promptResult = await raceCancellation(promptPromise);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                state.outputChannel.appendLine(`[handler] Prompt error: ${msg}`);
                throw err;
              }
              if (promptResult.error !== undefined) {
                const msg = String(promptResult.error);
                state.outputChannel.appendLine(`[handler] Prompt error: ${msg}`);
                throw new Error(`Backend prompt failed: ${msg}`);
              }
              state.outputChannel.appendLine('[handler] Prompt accepted by backend');

              const pipelineResult = await raceCancellation(pipelinePromise);
              await raceCancellation(sessionStream.flush());
              state.outputChannel.appendLine(`[handler] pipeline.run() completed.`);

              if (!pipelineResult.completed && !token.isCancellationRequested && !cancelRequested) {
                throw new Error(pipelineResult.error ?? 'Backend pipeline ended before the session became idle');
              }
              if (token.isCancellationRequested || cancelRequested) {
                throw cancellationError();
              }

              // Capture userMessageId from the first pipeline run
              if (!userMessageId) {
                userMessageId = pipelineResult.userMessageId;
              }

              // Capture backend-generated session title from the first pipeline run.
              if (!sessionTitleFromPipeline) {
                const title = pipelineResult.sessionTitle;
                state.outputChannel.appendLine(
                  `[handler] pipeline result sessionTitle = ${JSON.stringify(title)}`,
                );
                if (title) {
                  sessionTitleFromPipeline = title;
                  sessionTitleSourceFromPipeline = pipelineResult.sessionTitleSource ?? 'backend';
                }
              }

              // After subagent tasks completed, send a continuation prompt on a
              // fresh pipeline iteration.  That iteration repeats the same
              // channel-before-prompt ordering.
              if (pipelineResult.hadSubagentTasks && !token.isCancellationRequested && !cancelRequested) {
                state.outputChannel.appendLine('[handler] Subagent tasks completed - scheduling continuation prompt');
                nextPromptText = '';
                nextPromptOptions = { permissionMode: promptOptions.permissionMode };
              } else {
                needsContinue = false;
                turnCompleted = pipelineResult.completed
                  && !token.isCancellationRequested
                  && !cancelRequested;
              }
          } catch (err) {
            const cancelled = cancelRequested || token.isCancellationRequested || isHandlerCancellation(err);
            // Start abort before closing so the descendant snapshot is taken
            // while the event broker still knows the session hierarchy.
            const pendingAbort = abortSessionTreeOnce();
            closeEventStream();
            const pendingOperations: Promise<unknown>[] = [pendingAbort];
            if (ensurePromise) {pendingOperations.push(ensurePromise);}
            if (promptPromise) {pendingOperations.push(promptPromise);}
            if (pipelinePromise) {pendingOperations.push(pipelinePromise);}
            if (cancelled) {void drainAbort();}
            await settleWithin(
              Promise.allSettled(pendingOperations).then(() => undefined),
              HANDLER_DRAIN_TIMEOUT_MS,
              state.outputChannel,
              cancelled ? 'Cancellation drain' : 'Turn drain',
            );
            if (cancelled) {
              throw cancellationError();
            }
              throw err;
            } finally {
              closeEventStream();
              if (closeActiveEventStream === closeEventStream) {
                closeActiveEventStream = () => {};
              }
            }
          }
        } finally {
          closeActiveEventStream();
          if (initializationPromise) {
            await settleWithin(
              initializationPromise,
              HANDLER_DRAIN_TIMEOUT_MS,
              state.outputChannel,
              'SSS initialization',
            );
          }
          await settleWithin(
            sessionStream.drain(),
            HANDLER_DRAIN_TIMEOUT_MS,
            state.outputChannel,
            'SSS drain',
          );
          await settleWithin(
            titleUpdateChain,
            HANDLER_DRAIN_TIMEOUT_MS,
            state.outputChannel,
            'Session title update',
          );
          // Do not leave a title request running after the turn has released
          // its event stream.  It is still bounded so a provider that never
          // settles cannot hold Copilot's response indefinitely.
          await settleWithin(
            earlyTitlePromise,
            HANDLER_DRAIN_TIMEOUT_MS,
            state.outputChannel,
            'Early session title generation',
          );
          // Close even when initialize() failed part-way through. The stream
          // implementation is idempotent and writes a matching turn boundary
          // whenever its paths were established.
          if (sssInitialized || sessionStream.getSessionPath() !== null) {
            sessionStream.close();
          }
          await settleWithin(
            sessionStream.flush(),
            HANDLER_DRAIN_TIMEOUT_MS,
            state.outputChannel,
            'SSS flush',
          );
        }

        if (!turnCompleted || cancelRequested || token.isCancellationRequested) {
          throw cancellationError();
        }
        assertRequestRuntimeCurrent();

        // Resolve titles before recording the backend message mapping. If title
        // reconciliation is cancelled or fails, the turn remains unmapped and
        // can be retried without asking the backend to revert a phantom entry.
        const chatState = ctx.sessions.get(vscodeSessionId);
        // Resolve session title. Priority:
        // 1. Backend auto-generates title (via session.updated event)
        // 2. sessions.get() returns a meaningful title
        // 3. Derive from first prompt + push to backend via sessions.update()
        const reconciledTitle = await raceCancellation(titleService.resolveFinalTurnTitle({
          backendSessionId,
          directory,
          pipelineTitle: sessionTitleFromPipeline,
          pipelineTitleSource: sessionTitleSourceFromPipeline,
          chatState,
        }));

        // Persist resolved title across backend/sessionMap/SessionStore.
        if (reconciledTitle) {
          await raceCancellation(titleService.applyFinal({
            backendSessionId,
            vscodeSessionId,
            title: reconciledTitle.title,
            directory,
            updateBackend: false,
            overwrite: false,
            source: reconciledTitle.source,
          }));
          state.outputChannel.appendLine(
            `[handler] Applied reconciled session title (${reconciledTitle.source}): "${reconciledTitle.title}"`,
          );
        }

        if (!turnCompleted || cancelRequested || token.isCancellationRequested) {
          throw cancellationError();
        }
        assertRequestRuntimeCurrent();

        // Record user message ID only after all turn-level asynchronous work
        // has completed successfully.
        state.outputChannel.appendLine(
          `[handler] User message ID for turn: ${!!chatState && !!userMessageId} (${userMessageId})`,
        );
        if (chatState && userMessageId) {
          const wasFirstTurn = chatState.turnMap.length === 0 && liveTurnIndex === 0;
          chatState.turnMap.push({
            vscodeTurn: liveTurnIndex,
            messageId: userMessageId,
          });
          state.outputChannel.appendLine(
            `[handler] Recorded turn ${chatState.turnMap.length - 1}: messageID=${userMessageId} (total turns=${chatState.turnMap.length})`,
          );

          if (wasFirstTurn) {
            state.outputChannel.appendLine(
              `[handler] First turn completed for session ${backendSessionId}`,
            );
          }
        }

        state.outputChannel.appendLine(`[handler] Refreshing Session list for session ${backendSessionId}`);
        state.bus.emit('session-list-changed', { backendId: ctx.id });
      };

      // 11. Execute turn
      await executeTurnWithPipeline();
      assertRequestRuntimeCurrent();

      // 12. Return metadata for future turn recovery
      return {
        metadata: {
          sessionId: backendSessionId,
          backendSessionId,
          backendInstanceKey: ctx.instanceKey,
          turnMap: ctx.sessions.get(vscodeSessionId)?.turnMap ?? [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      const cancelled = cancelRequested || token.isCancellationRequested || isHandlerCancellation(err);
      if (!cancelled) {
        stream.markdown(msg);
        state.outputChannel.appendLine(`[handler] Error: ${msg}`);
      } else {
        state.outputChannel.appendLine('[handler] Turn cancellation completed');
      }
      // Preserve the session binding after a failed turn so Copilot can retry
      // or restore the same Agent Session instead of silently detaching it.
      return {
        metadata: resolvedBackendSessionId
          ? {
              sessionId: resolvedBackendSessionId,
              backendSessionId: resolvedBackendSessionId,
              backendInstanceKey: ctx.instanceKey,
              turnMap: ctx.sessions.get(request.sessionId ?? 'unknown')?.turnMap ?? [],
            }
          : {},
      };
    } finally {
      // A cancellation can happen while resolving model inputs or initializing
      // SSS, before the per-iteration cleanup path exists. Wait briefly for
      // the shared abort promise so the backend receives the cancellation while
      // still guaranteeing that Copilot is released.
      if (cancelRequested && abortSessionTree) {
        // `drainAbort` is normally exercised by the cancellation callback or
        // the per-iteration catch. This fallback covers tokens that expose a
        // changed flag without firing their event.
        cancellationDrainPromise ??= settleWithin(
          abortSessionTree(),
          HANDLER_DRAIN_TIMEOUT_MS,
          state.outputChannel,
          'Cancellation abort',
        );
        await cancellationDrainPromise;
      }
      cancelDisposable?.dispose();
      disposeRuntimeChanging();
    }
  };
}

