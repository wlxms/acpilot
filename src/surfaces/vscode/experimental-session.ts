/**
 * Chat-session-provider surface for VS Code's proposed API.
 *
 * The provider restores persisted chat history and delegates new requests to
 * the shared participant handler. Event rendering is owned by the Pipeline/SSP
 * pipeline; this surface only asks that pipeline to rebuild response turns.
 *
 * Runtime checks gate proposed VS Code APIs so the extension can fall back to
 * the stable participant surface when the session-provider API is unavailable.
 *
 * @module
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionState, BackendContext } from '../../types';
import type { SessionState } from '../../types';
import { assertSessionResourcePath } from '../../backend/backend-instance';
import type {
  SerializableRequestDetails,
  SerializableSessionMeta,
} from '../../backend/serializable/types';
import type { FileSnapshotRecord, StreamPartRecord as SerializableStreamPart } from '../../ssp/types';
import { createParticipantHandler } from '../../participant/handler';
import { isUserSelectableAgent } from '../../backend/types';
import { normalizePermissionMode } from '../../backend/types';


import { CollectorStream } from '../../backend/streaming/collector-stream';
import {
  createSSPFromRecord,
  finalizeIncompleteStates,
  materializeRecords,
  readAllSnapshots,
  readAllStreamParts,
  readMetaIndex,
  readSubsessionRecords,
  type SubsessionRecordSet,
} from '../../backend/streaming/deserialize';
import {
  requestDetailsFromStreamParts,
} from '../../backend/serializable/stream-parts';
import type { StreamPartRecord } from '../../ssp/types';
import { getCheckpointApproval, snapshotTurnIndex } from '../../backend/checkpoint/approval-state';
import { pushSnapshotTextEditParts, replaySnapshotsToWorkspace } from '../../backend/checkpoint/replay';
import { SessionTitleService } from '../../participant/session-title';
import type { SessionTitleSource } from '../../backend/serializable/types';

// ---------------------------------------------------------------------------
// Internal types for session content restoration
// ---------------------------------------------------------------------------

interface RestoredSessionHistory {
  history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[];
  snapshots: FileSnapshotRecord[];
  pendingReplaySnapshots: FileSnapshotRecord[];
  restoreReplaySnapshots: FileSnapshotRecord[];
  meta?: SerializableSessionMeta;
}

type ToolIdEditMap = Map<string, string>;

type RestoredRequestIdSource = 'request-details' | 'stream-parts' | 'unavailable';

interface RestoredRequestId {
  id?: string;
  source: RestoredRequestIdSource;
}

interface StreamRecordEntry {
  record: StreamPartRecord;
  metaIndex: ReadonlyMap<string, Record<string, unknown>>;
  streamNode: 'root' | 'subsession';
}

interface SessionListEntry {
  id: string;
  title: string;
  createdAt: Date;
  description?: string;
  status?: vscode.ChatSessionStatus;
  archived?: boolean;
  changeApprovalState?: SerializableSessionMeta['changeApprovalState'];
  resource?: vscode.Uri;
  source: 'persisted' | 'runtime';
  hasLiveTurns?: boolean;
}


// ---------------------------------------------------------------------------
// Content provider factory
// ---------------------------------------------------------------------------

function getWorkspaceDirectory(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
}

function createSessionResource(ctx: BackendContext, sessionId: string): vscode.Uri {
  const instancePath = ctx.instanceKey === ctx.id
    ? ''
    : `${encodeURIComponent(ctx.instanceKey)}/`;
  return vscode.Uri.parse(`${ctx.scheme}:/${instancePath}${encodeURIComponent(sessionId)}`);
}

/**
 * Create a `vscode.ChatSessionContentProvider` that registers OpenCode
 * as a session target in VS Code's chat view.
 *
 * == Picker Architecture ==
 * We create a `ChatSessionItemController` alongside the content provider.
 * The controller's `getChatSessionInputState` creates tracked inputState
 * objects via `controller.createChatSessionInputState()`. VSCode monitors
 * these objects, so `inputState.onDidChange` actually fires when the user
 * changes picker selections; unlike inputState received from the content
 * provider's context, which is NOT tracked by VSCode.
 *
 * Flow:
 * 1. Controller's `getChatSessionInputState` creates tracked inputState
 * 2. VSCode tracks it, fires `onDidChange` when user changes picker
 * 3. We subscribe to `onDidChange`, parse groups, and update selection via ctx.selection.setAgent
 * 4. Handler reads ctx.selection.get() at prompt time
 *
 * @param state - The global extension state.
 * @param context - The extension context (for subscriptions).
 * @returns Object with `provider` (ChatSessionContentProvider) and
 *          `controller` (ChatSessionItemController), both ready for registration.
 */
/**
 * Returns true if `title` is a placeholder/auto-generated session title
 * that carries no meaningful information (e.g. "New OpenCode Session",
 * "OpenCode Session abc", "Session abc", or empty).
 */
export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? '';
  return !normalized
    || normalized === 'New OpenCode Session'
    || normalized === 'New ACP Agent Session'
    || normalized === 'New Reasonix Session'
    || normalized.startsWith('OpenCode Session ')
    || normalized.startsWith('ACP Session ')
    || normalized.startsWith('ACP Agent Session ')
    || normalized.startsWith('Reasonix Session ')
    || normalized.startsWith('Session ');
}

export function createSessionContentProvider(
  state: ExtensionState,
  ctx: BackendContext,
  context: vscode.ExtensionContext,
): {
  provider: vscode.ChatSessionContentProvider;
  controller: vscode.ChatSessionItemController | undefined;
} {
  const logger = state.outputChannel;
  const directory = getWorkspaceDirectory();
  const backendDisplayName = ctx.displayName;
  const backendThemeIcon = new vscode.ThemeIcon(ctx.id === 'opencode' ? 'opencode-logo' : 'acpilot-a');
  const newSessionTitle = `New ${backendDisplayName} Session`;
  const offlineSessionTitle = `${backendDisplayName} (offline)`;

  /**
   * Runtime objects are replaced in-place when an ACP target changes. A
   * provider callback can outlive that replacement, so every async callback
   * works from a shallow snapshot and validates it before committing results.
   * The shared `ctx` remains the authority used by request handlers; these
   * snapshots are only for provider-side work that must stay instance-bound.
   */
  class RuntimeChangedError extends Error {
    constructor() {
      super(`Backend instance changed while the session provider was running (${ctx.instanceKey}).`);
      this.name = 'RuntimeChangedError';
    }
  }

  const captureRuntime = (): BackendContext => ({ ...ctx });
  const isRuntimeCurrent = (runtime: BackendContext): boolean =>
    ctx.runtimeGeneration === runtime.runtimeGeneration
    && ctx.instanceKey === runtime.instanceKey
    && ctx.storageNamespace === runtime.storageNamespace
    && ctx.selection === runtime.selection
    && ctx.sessions === runtime.sessions
    && ctx.sessionStore === runtime.sessionStore;
  const sameRuntime = (left: BackendContext, right: BackendContext): boolean =>
    left.runtimeGeneration === right.runtimeGeneration
    && left.instanceKey === right.instanceKey
    && left.storageNamespace === right.storageNamespace
    && left.selection === right.selection
    && left.sessions === right.sessions
    && left.sessionStore === right.sessionStore;
  const isRuntimeAccepting = (runtime: BackendContext): boolean =>
    isRuntimeCurrent(runtime) && ctx.acceptingRequests !== false;
  const assertRuntimeCurrent = (runtime: BackendContext, requireAccepting = false): void => {
    if (!isRuntimeCurrent(runtime) || (requireAccepting && ctx.acceptingRequests === false)) {
      throw new RuntimeChangedError();
    }
  };
  const isRuntimeChangedError = (error: unknown): error is RuntimeChangedError =>
    error instanceof RuntimeChangedError;
  const titleServiceFor = (runtime: BackendContext): SessionTitleService =>
    new SessionTitleService(state, runtime);

  /**
   * Await an operation that belongs to one runtime without allowing a target
   * transition to strand the provider forever. Backend startup and transport
   * setup are external operations and may fail to settle after their runtime
   * has been torn down; the generation event is the authoritative cancellation
   * boundary for those waits.
   */
  const awaitRuntimeOperation = async <T>(
    runtime: BackendContext,
    operation: Promise<T>,
  ): Promise<T> => {
    assertRuntimeCurrent(runtime);
    let dispose: (() => void) | undefined;
    const invalidated = new Promise<never>((_, reject) => {
      dispose = state.bus.on('backend-runtime-changing', event => {
        if (event.backendId !== runtime.id
          || (event.runtimeGeneration < runtime.runtimeGeneration)
          || (event.runtimeGeneration === runtime.runtimeGeneration
            && event.instanceKey === runtime.instanceKey)) {
          return;
        }
        dispose?.();
        reject(new RuntimeChangedError());
      });
    });
    try {
      // The event cannot interleave with this synchronous setup, but the
      // assertion documents and enforces the boundary if a caller supplied an
      // already-invalid runtime snapshot.
      assertRuntimeCurrent(runtime);
      return await Promise.race([operation, invalidated]);
    } finally {
      dispose?.();
    }
  };

  // Local session cache
  const SESSION_CACHE_KEY = 'acp.sessionItems';
  interface CachedSessionItem { id: string; title: string; createdAt: number; }

  // Guard against concurrent refreshSessionItems() calls that can race
  // when both the handler post-turn and VS Code's refreshHandler fire
  // simultaneously, causing controller.items.replace() to overwrite a
  // complete list with a partial one.
  let sessionRefreshInFlight: { runtime: BackendContext; promise: Promise<void> } | null = null;

  // -- Option Groups: Agent picker ----------------------------------------

  const onDidChangeOptionsEmitter = new vscode.EventEmitter<void>();
  let cachedOptionGroups: vscode.ChatSessionProviderOptionGroup[] = [];

  /**
   * VS Code re-queries provider options after onDidChange fires. Comparing
   * the array by identity is not sufficient because every backend refresh
   * builds a new array, even when the visible choices are unchanged. Keep a
   * compact semantic signature so identical option groups do not create a
   * provider-refresh loop.
   */
  const optionGroupsSignature = (
    groups: readonly vscode.ChatSessionProviderOptionGroup[],
  ): string => JSON.stringify(groups.map(group => ({
    id: group.id,
    name: group.name,
    selected: group.selected?.id,
    items: group.items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      default: item.default,
    })),
  })));

  const replaceCachedOptionGroups = (
    groups: vscode.ChatSessionProviderOptionGroup[],
  ): boolean => {
    if (optionGroupsSignature(cachedOptionGroups) === optionGroupsSignature(groups)) {
      return false;
    }
    cachedOptionGroups = groups;
    onDidChangeOptionsEmitter.fire();
    return true;
  };

  /** Guard against re-entrant refreshOptionGroups() calls (e.g. event fire -> VSCode re-query loop) */
  let optionGroupsRefreshInFlight: { runtime: BackendContext; promise: Promise<void> } | null = null;
  let backendStartInFlight: { runtime: BackendContext; promise: Promise<void> } | null = null;
  let backendStartFailure: { runtime: BackendContext } | null = null;
  let loggedOfflineOptionGroups = false;
  /**
   * Reference to the most recently created inputState.
   * VSCode's provideChatSessionProviderOptions only affects NEW sessions;
   * to update the picker text in an ALREADY-OPEN session we must push
   * new groups into the existing inputState object directly.
   */
  let currentInputState: any = undefined;
  let synchronizingInputState = false;

  const syncCurrentInputState = (): void => {
    if (!currentInputState) {
      return;
    }
    synchronizingInputState = true;
    try {
      currentInputState.groups = cachedOptionGroups;
    } finally {
      synchronizingInputState = false;
    }
  };

  const CONNECTING_OPTION_GROUPS: vscode.ChatSessionProviderOptionGroup[] = [
    {
      id: 'agents',
      name: 'Agent',
      items: [{ id: 'agent-connecting', name: '--', description: 'Waiting for backend' }],
      selected: { id: 'agent-connecting', name: '--', description: 'Waiting for backend' },
    },
    {
      id: 'permission-mode',
      name: 'Permissions',
      items: [
        { id: 'permission-full-edit', name: 'Full access', description: 'Allow editing, execution, and subagents without prompting' },
        { id: 'permission-approval', name: 'Ask', description: 'Ask before editing, execution, and subagent operations' },
        { id: 'permission-read-only', name: 'Read-only', description: 'Disallow editing, execution, and subagent operations' },
      ],
      selected: { id: 'permission-approval', name: 'Ask', description: 'Ask before editing, execution, and subagent operations' },
    },
  ];

  const permissionModeItems = (): vscode.ChatSessionProviderOptionItem[] => [
    { id: 'permission-full-edit', name: 'Full access', description: 'Allow editing, execution, and subagents without prompting' },
    { id: 'permission-approval', name: 'Ask', description: 'Ask before editing, execution, and subagent operations' },
    { id: 'permission-read-only', name: 'Read-only', description: 'Disallow editing, execution, and subagent operations' },
  ];

  /** Placeholder option groups shown while the backend is not yet running */
  function buildConnectingOptionGroups(runtime = captureRuntime()): vscode.ChatSessionProviderOptionGroup[] {
    const permissionMode = normalizePermissionMode(runtime.selection.get().permissionMode);
    return CONNECTING_OPTION_GROUPS.map(group => group.id === 'permission-mode'
      ? {
        ...group,
        selected: group.items.find(item => item.id === `permission-${permissionMode}`) ?? group.selected,
      }
      : group);
  }

  /** Check whether cached option groups are still placeholder/stub groups */
  function isPlaceholderGroups(groups: vscode.ChatSessionProviderOptionGroup[]): boolean {
    return groups.length > 0 && (groups[0]?.selected?.id?.endsWith('-connecting') ?? false);
  }

  /** Build option groups from backend config */
  async function refreshOptionGroups(runtime = captureRuntime()): Promise<void> {
    // Guard: if a refresh is already in-flight for this runtime, return the
    // existing promise. A different runtime gets its own refresh so a stale
    // request cannot block the newly selected target.
    if (optionGroupsRefreshInFlight && sameRuntime(optionGroupsRefreshInFlight.runtime, runtime)) {
      return optionGroupsRefreshInFlight.promise;
    }

    const promise = doRefreshOptionGroups(runtime);
    optionGroupsRefreshInFlight = { runtime, promise };
    try {
      await promise;
    } finally {
      if (optionGroupsRefreshInFlight?.promise === promise) {
        optionGroupsRefreshInFlight = null;
      }
    }
  }

  /** Actual work; separated so the guard can deduplicate calls */
  async function doRefreshOptionGroups(runtime: BackendContext): Promise<void> {
    const runtimeCtx = runtime;
    try {
      assertRuntimeCurrent(runtimeCtx);
      // If backend is not running, show placeholder groups without calling backend
      if (!runtimeCtx.backend.isRunning()) {
        assertRuntimeCurrent(runtimeCtx);
        replaceCachedOptionGroups(buildConnectingOptionGroups(runtimeCtx));
        if (loggedOfflineOptionGroups) {
          return;
        }
        loggedOfflineOptionGroups = true;
        logger.appendLine('[session-provider] Backend not running; showing "Connecting" option groups');
        return;
      }

      loggedOfflineOptionGroups = false;
      logger.appendLine(`[session-provider] Refreshing option groups (backend running=true)...`);

      // Fetch agents (model selection is delegated to VS Code's native model picker)
      const agentsResult = await awaitRuntimeOperation(
        runtimeCtx,
        Promise.resolve().then(() => runtimeCtx.backend.config.agents(directory)),
      );
      assertRuntimeCurrent(runtimeCtx);

      const agents = (agentsResult.data ?? []).filter((a: { hidden?: boolean; mode?: string }) => isUserSelectableAgent(a as any));

      logger.appendLine(
        `[session-provider] Backend returned: ${agentsResult.data?.length ?? 0} agents (error=${agentsResult.error ?? 'none'})`,
      );

      const sel = runtimeCtx.selection.get();
      const permissionMode = normalizePermissionMode(sel.permissionMode);

      // Build agent option items
      const agentItems: vscode.ChatSessionProviderOptionItem[] = (agents as any[]).map((a: any) => ({
        id: `agent-${a.id}`,
        name: a.name ?? a.id,
        description: a.description,
        default: a.id === sel.agent,
      }));

      // Find selected agent item
      const currentAgentId = sel.agent;
      const selectedAgent = agentItems.find(i => i.id === `agent-${currentAgentId}`) ?? agentItems[0];
      const permissionItems = permissionModeItems().map(item => ({
        ...item,
        default: item.id === `permission-${permissionMode}`,
      }));
      const selectedPermission = permissionItems.find(item => item.id === `permission-${permissionMode}`)
        ?? permissionItems[0];

      assertRuntimeCurrent(runtimeCtx);
      const nextOptionGroups = [
        ...(agentItems.length > 0 ? [{
          id: 'agents',
          name: 'Agent',
          items: agentItems,
          selected: selectedAgent,
        }] : []),
        {
          id: 'permission-mode',
          name: 'Permissions',
          items: permissionItems,
          selected: selectedPermission,
        },
      ];

      replaceCachedOptionGroups(nextOptionGroups);
      logger.appendLine(
        `[session-provider] Option groups refreshed: ${agentItems.length} agents`,
      );
    } catch (err) {
      if (isRuntimeChangedError(err)) {
        return;
      }
      logger.appendLine(
        `[session-provider] Failed to refresh option groups: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function ensureBackendRunning(runtime = captureRuntime()): Promise<void> {
    const runtimeCtx = runtime;
    assertRuntimeCurrent(runtimeCtx);
    if (runtimeCtx.backend.getStatus() === 'running') {
      return;
    }
    if (backendStartInFlight && sameRuntime(backendStartInFlight.runtime, runtimeCtx)) {
      await awaitRuntimeOperation(runtimeCtx, backendStartInFlight.promise);
      assertRuntimeCurrent(runtimeCtx);
      return;
    }
    if (backendStartInFlight) {
      // A prior-generation start may still be settling on the shared backend
      // object. Let it finish before attempting to start the new runtime.
      await awaitRuntimeOperation(runtimeCtx, backendStartInFlight.promise.catch(() => {}));
      assertRuntimeCurrent(runtimeCtx);
      if (runtimeCtx.backend.getStatus() === 'running') {
        return;
      }
    }

    const promise = (async () => {
      assertRuntimeCurrent(runtimeCtx);
      const result = await awaitRuntimeOperation(
        runtimeCtx,
        Promise.resolve().then(() => runtimeCtx.backend.start(directory)),
      );
      assertRuntimeCurrent(runtimeCtx);
      if (result.error) {
        throw new Error(typeof result.error === 'string' ? result.error : 'Failed to start backend');
      }
    })();
    backendStartInFlight = { runtime: runtimeCtx, promise };

    try {
      await promise;
    } finally {
      if (backendStartInFlight?.promise === promise) {
        backendStartInFlight = null;
      }
    }
  }

  function kickBackendStart(reason: string): void {
    const runtime = captureRuntime();
    if (!isRuntimeAccepting(runtime)) {
      return;
    }
    const status = runtime.backend.getStatus();
    if (status === 'running' || status === 'starting') {
      return;
    }
    // A failed lazy start is surfaced through the placeholder option groups.
    // Do not immediately retry every time VS Code re-queries those groups;
    // that feedback loop can make the workbench unresponsive. A backend
    // runtime transition (for example selecting a new ACP target) creates a
    // new runtime snapshot and clears this guard below.
    if (backendStartFailure && sameRuntime(backendStartFailure.runtime, runtime)) {
      return;
    }

    logger.appendLine(`[session-provider] Backend ${status}; starting backend (${reason})`);
    ensureBackendRunning(runtime)
      .then(() => {
        if (!isRuntimeAccepting(runtime)) {
          return;
        }
        backendStartFailure = null;
        logger.appendLine('[session-provider] Backend ready from provider startup');
        state.bus.emit('backend-ready', { backendId: runtime.id });
      })
      .catch((err) => {
        if (isRuntimeCurrent(runtime)) {
          backendStartFailure = { runtime };
        }
        logger.appendLine(`[session-provider] Backend provider startup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  function collectRuntimeSessions(runtime: BackendContext = captureRuntime()): SessionListEntry[] {
    const runtimeSessions = new Map<string, SessionListEntry>();

    for (const [stateKey, chatState] of runtime.sessions.entries()) {
      if (!chatState.backendSessionId) {
        continue;
      }
      const resource = stateKey.startsWith(runtime.scheme + ':')
        ? vscode.Uri.parse(stateKey)
        : createSessionResource(runtime, stateKey);

      const existing = runtimeSessions.get(chatState.backendSessionId);
      const newTitle = chatState.title ?? '';
      const hasLiveTurns = chatState.turnMap.length > 0;

      // Prefer non-placeholder titles when multiple sessionMap entries share
      // the same sessionId (e.g. untitled-N vs acpilot.opencode:/ses_xxx).
      if (existing) {
        const existingIsPlaceholder = isPlaceholderSessionTitle(existing.title);
        const newIsPlaceholder = isPlaceholderSessionTitle(newTitle);
        if (existingIsPlaceholder && !newIsPlaceholder) {
          runtimeSessions.set(chatState.backendSessionId, {
            id: chatState.backendSessionId,
            title: newTitle,
            createdAt: chatState.createdAt ?? existing.createdAt,
            resource,
            source: 'runtime',
            hasLiveTurns,
          });
        } else if (hasLiveTurns && !existing.hasLiveTurns) {
          existing.hasLiveTurns = true;
        }
      } else {
        runtimeSessions.set(chatState.backendSessionId, {
          id: chatState.backendSessionId,
          title: newTitle,
          createdAt: chatState.createdAt ?? new Date(),
          resource,
          source: 'runtime',
          hasLiveTurns,
        });
      }
    }

    return Array.from(runtimeSessions.values());
  }

  function getSessionLabel(session: { title: string; id: string }): string {
    const title = session.title.trim();
    return title.length > 0 ? title : `Session ${session.id.slice(0, 8)}`;
  }

  function getSessionDescription(session: SessionListEntry): string | undefined {
    return session.description;
  }

  function toChatSessionStatus(status: SerializableSessionMeta['status']): vscode.ChatSessionStatus | undefined {
    switch (status) {
      case 'inProgress':
        return vscode.ChatSessionStatus.InProgress;
      case 'needsInput':
        return vscode.ChatSessionStatus.NeedsInput;
      case 'failed':
        return vscode.ChatSessionStatus.Failed;
      case 'completed':
        return vscode.ChatSessionStatus.Completed;
      default:
        return undefined;
    }
  }

  function maxSnapshotTurn(snapshots: readonly FileSnapshotRecord[]): number | undefined {
    if (snapshots.length === 0) {
      return undefined;
    }
    return Math.max(...snapshots.map(snapshotTurnIndex));
  }

  function getRestoreReplaySnapshots(
    snapshots: readonly FileSnapshotRecord[],
    meta?: SerializableSessionMeta,
  ): FileSnapshotRecord[] {
    const acceptedThroughTurn = meta?.checkpointCursor?.acceptedThroughTurn;
    const lastAccepted = typeof acceptedThroughTurn === 'number' && Number.isFinite(acceptedThroughTurn)
      ? acceptedThroughTurn
      : -1;
    return snapshots.filter(snapshot => snapshotTurnIndex(snapshot) > lastAccepted);
  }

  function getMergedRequestDetails(
    meta: SerializableSessionMeta | undefined,
    streamParts: readonly SerializableStreamPart[] | undefined,
    metaIndex?: ReadonlyMap<string, Record<string, unknown>>,
  ): SerializableRequestDetails[] {
    const result: SerializableRequestDetails[] = [];
    const append = (details: SerializableRequestDetails): void => {
      const existing = result.find(item =>
        (details.turnIndex !== undefined && item.turnIndex === details.turnIndex) ||
        item.vscodeRequestId === details.vscodeRequestId
      );
      if (existing) {
        existing.turnIndex = details.turnIndex ?? existing.turnIndex;
        existing.vscodeRequestId = details.vscodeRequestId || existing.vscodeRequestId;
        existing.backendRequestId = details.backendRequestId ?? existing.backendRequestId;
        existing.toolIdEditMap = {
          ...existing.toolIdEditMap,
          ...(details.toolIdEditMap ?? {}),
        };
        return;
      }
      result.push({
        ...details,
        toolIdEditMap: { ...(details.toolIdEditMap ?? {}) },
      });
    };

    for (const details of meta?.requestDetails ?? []) {
      append(details);
    }
    for (const details of requestDetailsFromStreamParts(streamParts ?? [], metaIndex)) {
      append(details);
    }
    return result;
  }

  function getToolIdEditMap(
    meta?: SerializableSessionMeta,
    streamParts?: readonly SerializableStreamPart[],
    streamEntries?: readonly StreamRecordEntry[],
    metaIndex?: ReadonlyMap<string, Record<string, unknown>>,
  ): ToolIdEditMap {
    const result: ToolIdEditMap = new Map();
    for (const details of getMergedRequestDetails(meta, streamParts, metaIndex)) {
      for (const [toolCallId, editId] of Object.entries(details.toolIdEditMap ?? {})) {
        if (editId) {
          result.set(toolCallId, editId);
        }
      }
    }
    for (const entry of streamEntries ?? []) {
      addExternalEditRecordToMap(result, entry);
    }
    return result;
  }

  function addExternalEditRecordToMap(
    result: ToolIdEditMap,
    entry: StreamRecordEntry,
  ): void {
    const { record, metaIndex } = entry;
    if (record.kind !== 'externalEdit') {
      return;
    }

    const payload = record.payload as Record<string, unknown> | undefined;
    const directMeta = metaIndex?.get(record.id);
    let toolCallId = nonEmptyString(payload?.toolCallId)
      ?? nonEmptyString(record.meta?.toolCallId)
      ?? getToolCallIdFromExternalEditRecordId(record.id)
      ?? nonEmptyString(directMeta?.toolCallId);
    const partMeta = directMeta ?? (toolCallId ? metaIndex?.get(`externalEdit:${toolCallId}`) : undefined);
    toolCallId ??= nonEmptyString(partMeta?.toolCallId);
    const editId = nonEmptyString(payload?.editId)
      ?? nonEmptyString(payload?.undoStopId)
      ?? nonEmptyString(record.meta?.editId)
      ?? nonEmptyString(partMeta?.editId)
      ?? nonEmptyString(partMeta?.undoStopId);

    if (toolCallId && editId) {
      result.set(recordEditScopeKey(entry, toolCallId), editId);
      if (!result.has(toolCallId)) {
        result.set(toolCallId, editId);
      }
    }
  }

  function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  function getToolCallIdFromExternalEditRecordId(id: string): string | undefined {
    const prefix = 'externalEdit:';
    return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : undefined;
  }

  function getRestoredTurnMetadata(
    snapshots: readonly FileSnapshotRecord[],
    toolIdEditMap: ToolIdEditMap,
  ): Record<string, unknown> {
    const turnToolIdEditMap: Record<string, string> = {};
    for (const snapshot of snapshots) {
      if (!snapshot.toolCallId || turnToolIdEditMap[snapshot.toolCallId]) {
        continue;
      }
      const editId = getEditIdForSnapshot(snapshot, toolIdEditMap);
      if (editId) {
        turnToolIdEditMap[snapshot.toolCallId] = editId;
      }
    }
    return Object.keys(turnToolIdEditMap).length > 0
      ? { toolIdEditMap: turnToolIdEditMap }
      : {};
  }

  function getEditIdForSnapshot(
    snapshot: FileSnapshotRecord | undefined,
    toolIdEditMap: ToolIdEditMap,
  ): string | undefined {
    if (!snapshot?.toolCallId) {
      return undefined;
    }
    if (snapshot.scope) {
      const scoped = toolIdEditMap.get(snapshotScopeKey(snapshot.scope));
      if (scoped) {
        return scoped;
      }
    }
    return toolIdEditMap.get(snapshot.toolCallId) ?? snapshot.undoStopId;
  }

  function getRestoredRequestIdByTurnIndex(
    meta?: SerializableSessionMeta,
    streamParts?: readonly SerializableStreamPart[],
    metaIndex?: ReadonlyMap<string, Record<string, unknown>>,
  ): Map<number, RestoredRequestId> {
    const result = new Map<number, RestoredRequestId>();
    const add = (details: SerializableRequestDetails, source: RestoredRequestIdSource) => {
      result.set(details.turnIndex, { id: details.vscodeRequestId, source });
    };

    for (const details of meta?.requestDetails ?? []) {
      add(details, 'request-details');
    }
    for (const details of requestDetailsFromStreamParts(streamParts ?? [], metaIndex)) {
      if (result.has(details.turnIndex)) {
        continue;
      }
      add(details, 'stream-parts');
    }
    for (const part of streamParts ?? []) {
      const turnIndex = part.meta?.turnIndex;
      const requestId = part.meta?.requestId;
      if (Number.isFinite(turnIndex) && requestId && !result.has(turnIndex)) {
        result.set(turnIndex, { id: requestId, source: 'stream-parts' });
      }
    }
    return result;
  }

  function getRestoredRequestId(
    turnIndex: number,
    requestIdByTurnIndex: ReadonlyMap<number, RestoredRequestId>,
  ): RestoredRequestId {
    const persisted = requestIdByTurnIndex.get(turnIndex);
    if (persisted) {
      return persisted;
    }
    return { source: 'unavailable' };
  }

  function filterSnapshotsWithRestoredEditRecords(
    snapshots: readonly FileSnapshotRecord[],
    toolIdEditMap: ToolIdEditMap,
  ): FileSnapshotRecord[] {
    if (toolIdEditMap.size === 0) {
      return [];
    }
    return snapshots.filter(snapshot => !!snapshot.toolCallId && toolIdEditMap.has(snapshot.toolCallId));
  }

  function excludeSnapshots(
    snapshots: readonly FileSnapshotRecord[],
    excluded: readonly FileSnapshotRecord[],
  ): FileSnapshotRecord[] {
    if (snapshots.length === 0 || excluded.length === 0) {
      return [...snapshots];
    }
    const excludedSet = new Set(excluded);
    return snapshots.filter(snapshot => !excludedSet.has(snapshot));
  }

  function isRestoredEditToolName(toolName: string | undefined): boolean {
    return toolName === 'edit' || toolName === 'write';
  }

  function logRestorableEditSnapshotSummary(
    sessionId: string,
    snapshots: readonly FileSnapshotRecord[],
    toolIdEditMap: ToolIdEditMap,
  ): void {
    if (snapshots.length === 0) {
      logger.appendLine(
        `[session-provider] Restored edit snapshot summary for ${sessionId}: none ` +
        `(toolIdEditMap=${toolIdEditMap.size})`,
      );
      return;
    }

    const byToolCall = new Map<string, FileSnapshotRecord[]>();
    for (const snapshot of snapshots) {
      const key = snapshot.toolCallId || '(missing-tool-call)';
      const entries = byToolCall.get(key) ?? [];
      entries.push(snapshot);
      byToolCall.set(key, entries);
    }

    for (const [toolCallId, entries] of byToolCall) {
      const after = entries.find(snapshot => snapshot.phase === 'after');
      const before = entries.find(snapshot => snapshot.phase === 'before');
      logger.appendLine(
      `[session-provider] Restored edit snapshot summary for ${sessionId}: ` +
        `toolCallId=${toolCallId} editId=${getEditIdForSnapshot(after ?? before, toolIdEditMap) ?? '(none)'} ` +
        `turn=${after?.turnIndex ?? before?.turnIndex ?? '(none)'} ` +
        `editIndex=${after?.editIndex ?? before?.editIndex ?? '(none)'} ` +
        `uri=${after?.uri ?? before?.uri ?? '(none)'}`,
      );
    }
  }

  async function replayPendingSnapshotsForSession(
    runtime: BackendContext,
    sessionId: string,
    pendingSnapshots: readonly FileSnapshotRecord[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    assertRuntimeCurrent(runtime);
    if (pendingSnapshots.length === 0) {
      return;
    }

    const result = await replaySnapshotsToWorkspace(pendingSnapshots, logger, {
      stream,
      token,
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });
    assertRuntimeCurrent(runtime);
    await persistPendingReplayResult(runtime, sessionId, pendingSnapshots, result);
  }

  async function persistPendingReplayResult(
    runtime: BackendContext,
    sessionId: string,
    pendingSnapshots: readonly FileSnapshotRecord[],
    result: Awaited<ReturnType<typeof replaySnapshotsToWorkspace>>,
  ): Promise<void> {
    const maxTurn = maxSnapshotTurn(pendingSnapshots);
    const hasConflicts = result.conflicts.length > 0;
    const update: Partial<SerializableSessionMeta> = {
      changeApprovalState: hasConflicts ? 'partial' : 'pending',
      checkpointCursor: {
        acceptedThroughTurn: -1,
        replayedThroughTurn: maxTurn,
        lastConflictTurn: hasConflicts ? maxTurn : undefined,
      },
      replaySummary: {
        appliedFiles: result.applied,
        skippedFiles: result.skipped,
        appliedHunks: result.appliedHunks,
        skippedHunks: result.skippedHunks,
        conflicts: result.conflicts,
      },
    };

    try {
      assertRuntimeCurrent(runtime);
      const current = await runtime.sessionStore.readMeta(sessionId);
      assertRuntimeCurrent(runtime);
      const acceptedThroughTurn = current?.checkpointCursor?.acceptedThroughTurn ?? -1;
      const previousReplayedThroughTurn = current?.checkpointCursor?.replayedThroughTurn;
      update.checkpointCursor = {
        acceptedThroughTurn,
        replayedThroughTurn: hasConflicts ? previousReplayedThroughTurn : maxTurn,
        lastConflictTurn: hasConflicts ? maxTurn : current?.checkpointCursor?.lastConflictTurn,
      };
      if (!hasConflicts && maxTurn !== undefined && acceptedThroughTurn >= maxTurn) {
        update.changeApprovalState = 'accepted';
      }
      await runtime.sessionStore.updateMeta(sessionId, update);
      assertRuntimeCurrent(runtime);
      logger.appendLine(
        `[session-provider] Replayed ${result.applied} checkpoint file(s) for ${sessionId} via active response ` +
        `(external=${result.externalEdits}, fallback=${result.fallbackEdits}, conflicts=${result.conflicts.length})`,
      );
    } catch (err) {
      logger.appendLine(
        `[session-provider] Failed to persist checkpoint replay state for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function pushSnapshotsForRestoredEditTools(
    sessionId: string,
    restoreSnapshots: readonly FileSnapshotRecord[],
    stream: { parts?: readonly unknown[]; markdown?: (value: string) => void; push?: (part: unknown) => void },
    toolIdEditMap: ToolIdEditMap,
  ): void {
    if (restoreSnapshots.length === 0) {
      return;
    }

    hideRestoredEditToolParts(restoreSnapshots, stream.parts);
    const snapshotsWithEditIds = restoreSnapshots.map(snapshot => {
      const editId = getEditIdForSnapshot(snapshot, toolIdEditMap);
      return editId && snapshot.phase === 'after'
        ? { ...snapshot, undoStopId: editId }
        : snapshot;
    });
    const result = pushSnapshotTextEditParts(snapshotsWithEditIds, stream, logger);
    logger.appendLine(
      `[session-provider] Pushed ${result.pushed} restored text edit part(s) for ${sessionId} in restored history ` +
      `(skipped=${result.skipped}, conflicts=${result.conflicts.length})`,
    );
  }

  function hideRestoredEditToolParts(
    restoreSnapshots: readonly FileSnapshotRecord[],
    parts: readonly unknown[] | undefined,
  ): void {
    if (!parts?.length) {
      return;
    }
    const callIds = new Set(restoreSnapshots.map(snapshot => snapshot.toolCallId).filter(Boolean));
    for (const part of parts) {
      const toolPart = part as { toolCallId?: string; presentation?: 'hidden' | 'hiddenAfterComplete' };
      if (toolPart.toolCallId && callIds.has(toolPart.toolCallId)) {
        toolPart.presentation = 'hidden';
      }
    }
  }

  async function toSessionListEntry(meta: SerializableSessionMeta): Promise<SessionListEntry> {
    return {
      id: meta.id,
      title: meta.title ?? meta.id,
      createdAt: new Date(meta.createdAt ?? Date.now()),
      description: meta.description,
      status: toChatSessionStatus(meta.status) ?? vscode.ChatSessionStatus.Completed,
      archived: meta.archived,
      changeApprovalState: meta.changeApprovalState,
      source: 'persisted',
    };
  }

  function mergeSessions(
    listedSessions: readonly SessionListEntry[],
    runtimeSessions: readonly SessionListEntry[],
  ): SessionListEntry[] {
    const merged = new Map<string, SessionListEntry>();

    for (const session of listedSessions) {
      merged.set(session.id, session);
    }

    for (const session of runtimeSessions) {
      const existing = merged.get(session.id);
      if (!existing) {
        merged.set(session.id, session);
        continue;
      }

      merged.set(session.id, {
        id: session.id,
        title: !isPlaceholderSessionTitle(existing.title) ? existing.title : session.title,
        createdAt: existing.createdAt ?? session.createdAt,
        description: existing.description ?? session.description,
        status: existing.status ?? session.status,
        archived: existing.archived ?? session.archived,
        changeApprovalState: existing.changeApprovalState ?? session.changeApprovalState,
        resource: session.resource ?? existing.resource,
        source: 'runtime',
        hasLiveTurns: session.hasLiveTurns,
      });
    }

    return Array.from(merged.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  function publishSessionItems(
    controller: vscode.ChatSessionItemController,
    sessions: readonly SessionListEntry[],
    runtime: BackendContext,
  ): void {
    const sessionThemeIcon = backendThemeIcon;
    const items = sessions.map((session) => {
      const resource = session.resource ?? createSessionResource(runtime, session.id);
      const item = controller.createChatSessionItem(resource, getSessionLabel(session));
      item.iconPath = sessionThemeIcon;
      item.description = getSessionDescription(session);
      item.archived = session.archived ?? false;
      if (session.changeApprovalState === 'pending' || session.changeApprovalState === 'partial') {
        item.badge = session.changeApprovalState === 'partial' ? 'Partial' : 'Changes';
      }
      item.status = session.status ?? vscode.ChatSessionStatus.Completed;
      item.timing = { created: session.createdAt.getTime() };
      item.tooltip = session.id;
      return item;
    });

    controller.items.replace(items);
    logger.appendLine(`[session-provider] Published ${items.length} session item(s) to Session list`);

    try {
      const cached: CachedSessionItem[] = sessions.map(s => ({
        id: s.id, title: s.title, createdAt: s.createdAt.getTime(),
      }));
      context.globalState.update(SESSION_CACHE_KEY, cached);
    } catch { /* non-critical */ }
  }

  async function refreshSessionItems(runtime = captureRuntime()): Promise<void> {
    if (!controller) {
      return;
    }
    if (!isRuntimeCurrent(runtime)) {
      return;
    }

    // Skip session list refresh when backend is not running.
    // This preserves VSCode's default session list (user can navigate back)
    // instead of replacing it with an empty list.
    if (!runtime.backend.isRunning()) {
      logger.appendLine('[session-provider] Backend not running; skipping session list refresh');
      return;
    }

    // ---- Re-entrancy guard ----
    // Refreshes for the same runtime share one promise. A target switch gets
    // a separate task, so an old filesystem read cannot block or overwrite the
    // newly selected instance's list.
    if (sessionRefreshInFlight && sameRuntime(sessionRefreshInFlight.runtime, runtime)) {
      await sessionRefreshInFlight.promise;
      return;
    }

    const refreshPromise = (async () => {
      assertRuntimeCurrent(runtime);
      // Use filesystem-backed SessionStore (single source of truth)
      const sessions = await awaitRuntimeOperation(
        runtime,
        Promise.resolve().then(() => runtime.sessionStore.listSessions()),
      );
      assertRuntimeCurrent(runtime);

      logger.appendLine(
        `[session-provider] Refreshing Session list from SessionStore (count=${sessions.length})`,
      );

      const listedItems = await Promise.all(sessions.map(toSessionListEntry));
      assertRuntimeCurrent(runtime);
      const items = mergeSessions(listedItems, [
        ...collectRuntimeSessions(runtime),
      ]);
      assertRuntimeCurrent(runtime);

      publishSessionItems(controller!, items, runtime);
    })();
    sessionRefreshInFlight = { runtime, promise: refreshPromise };
    try {
      await refreshPromise;
    } finally {
      if (sessionRefreshInFlight?.promise === refreshPromise) {
        sessionRefreshInFlight = null;
      }
    }
  }

  // Kick off initial option groups load (non-blocking).
  // When backend is not running this will show "Connecting" placeholders.
  // When backend IS already running this will populate real data.
  refreshOptionGroups().catch(err => {
    logger.appendLine(`[session-provider] Initial option groups load failed: ${err}`);
  });

  // Register a one-shot callback so that when the backend finishes starting,
  // we immediately refresh option groups + session list with real data.
  // This avoids polling: no repeated requests while backend is offline.
  const onBackendReadyHandler = (e: { backendId: string }) => {
    if (e.backendId !== ctx.id) {return;}
    const runtime = captureRuntime();
    if (!isRuntimeAccepting(runtime)) {return;}
    logger.appendLine('[session-provider] Backend ready; refreshing option groups and session list');
    refreshOptionGroups(runtime).catch(err => {
      logger.appendLine(`[session-provider] Backend-ready option groups refresh failed: ${err}`);
    });
    refreshSessionItems(runtime).catch(err => {
      logger.appendLine(
        `[session-provider] Backend-ready session list refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  const backendReadyDispose = state.bus.on('backend-ready', onBackendReadyHandler);
  const selectionChangedDispose = state.bus.on('selection-changed', (e) => {
    if (e.backendId !== ctx.id) {return;}
    const runtime = captureRuntime();
    if (!isRuntimeAccepting(runtime)) {return;}
    refreshOptionGroups(runtime).catch(err => {
      logger.appendLine(`[session-provider] Selection option refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // Invalidate provider-local caches as soon as a target switch begins. The
  // shared context is mutated later in the transition, but clearing the
  // picker here prevents the old target's choices from being presented during
  // that window. In-flight callbacks are rejected by their runtime snapshot.
  const runtimeChangingDispose = state.bus.on('backend-runtime-changing', (e) => {
    if (e.backendId !== ctx.id || e.runtimeGeneration < ctx.runtimeGeneration) {
      return;
    }
    backendStartFailure = null;
    const changed = replaceCachedOptionGroups(buildConnectingOptionGroups());
    loggedOfflineOptionGroups = false;
    if (changed && currentInputState) {
      syncCurrentInputState();
    }
  });

  async function createNewSessionItemFromInitialRequest(
    ctrl: vscode.ChatSessionItemController,
    request: { readonly prompt: string; readonly command?: string },
    runtime: BackendContext,
  ): Promise<vscode.ChatSessionItem> {
    assertRuntimeCurrent(runtime, true);
    const sessionDirectory = getWorkspaceDirectory();
    const title = SessionTitleService.createProvisionalTitleFromPrompt(request.prompt, 'new');
    const result = await awaitRuntimeOperation(
      runtime,
      Promise.resolve().then(() => runtime.backend.sessions.create({
        title,
        directory: sessionDirectory,
      })),
    );
    assertRuntimeCurrent(runtime, true);
    if (result.error || !result.data) {
      const message = String(result.error ?? 'unknown error');
      logger.appendLine(`[session-provider] Failed to create new session item: ${message}`);
      throw new Error(`Failed to create new session item: ${message}`);
    }

    const sessionId = result.data.id;
    const createdAt = result.data.createdAt ?? new Date();
    const resource = createSessionResource(runtime, sessionId);
    const resolvedTitle = result.data.title?.trim() || title;
    const titleSource: SessionTitleSource = isPlaceholderSessionTitle(resolvedTitle) ? 'placeholder' : 'history';
    const provisionalTitle = !isPlaceholderSessionTitle(resolvedTitle);
    const chatState = {
      backendSessionId: sessionId,
      turnMap: [],
      title: resolvedTitle,
      titleSource,
      provisionalTitle,
      createdAt,
    };

    runtime.sessions.set(sessionId, chatState);
    runtime.sessions.set(resource.toString(), chatState);
    await runtime.sessionStore.writeMeta(sessionId, {
      id: sessionId,
      title: resolvedTitle,
      titleSource,
      titleUpdatedAt: new Date().toISOString(),
      provisionalTitle,
      createdAt: createdAt.toISOString(),
      backendName: runtime.id,
      backendInstanceKey: runtime.instanceKey,
    });
    assertRuntimeCurrent(runtime, true);
    await state.modelCatalog.refresh(sessionDirectory);
    assertRuntimeCurrent(runtime, true);
    state.bus.emit('models-changed', { backendId: runtime.id });
    assertRuntimeCurrent(runtime, true);

    const item = ctrl.createChatSessionItem(resource, resolvedTitle);
    item.iconPath = backendThemeIcon;
    item.status = vscode.ChatSessionStatus.InProgress;
    item.timing = { created: createdAt.getTime() };
    item.tooltip = sessionId;
    ctrl.items.add(item);

    logger.appendLine(
      `[session-provider] Created new session item ${sessionId} from initial request resource=${resource.toString()}`,
    );
    return item;
  }

  // -- ChatSessionItemController: Picker Tracking --------------------------
  // The controller creates tracked inputState objects via createChatSessionInputState().
  // VSCode monitors these objects, so onDidChange actually fires when the user
  // changes picker selections. Without the controller, inputState.onDidChange
  // is dead (VSCode only tracks inputStates from controllers).

  const chat = vscode.chat as Record<string, unknown>;
  const hasControllerAPI = typeof chat.createChatSessionItemController === 'function';

  let controller: vscode.ChatSessionItemController | undefined;
  let sessionListChangedDispose: (() => void) | undefined;
  let sessionItemStateChangedDispose: { dispose(): void } | undefined;

  if (hasControllerAPI) {
    controller = (vscode.chat as any).createChatSessionItemController(
      ctx.scheme,
      async (_token: vscode.CancellationToken) => {
        const runtime = captureRuntime();
        await Promise.all([
          refreshOptionGroups(runtime),
          refreshSessionItems(runtime).catch((err) => {
            logger.appendLine(
              `[session-provider] Session item refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            // Do NOT replace items with []; that wipes VSCode's default
            // session list and traps the user in an empty view. The
            // onBackendReady callback will populate items once the backend
            // is available.
          }),
        ]);
      },
    ) as vscode.ChatSessionItemController;

    controller.newChatSessionItemHandler = async (handlerContext, token) => {
      if (token.isCancellationRequested) {
        throw new Error('New session creation cancelled');
      }
      return createNewSessionItemFromInitialRequest(
        controller!,
        handlerContext.request,
        captureRuntime(),
      );
    };

    sessionListChangedDispose = state.bus.on('session-list-changed', (e) => {
      if (e.backendId !== ctx.id) {return;}
      const runtime = captureRuntime();
      if (!isRuntimeAccepting(runtime)) {return;}
      refreshSessionItems(runtime).catch((err) => {
        logger.appendLine(
          `[session-provider] Session list refresh on event failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    sessionItemStateChangedDispose = controller.onDidChangeChatSessionItemState?.((item) => {
      const runtime = captureRuntime();
      if (!isRuntimeAccepting(runtime)) {
        return;
      }
      try {
        assertSessionResourcePath(item.resource.path, runtime.id, runtime.instanceKey);
      } catch {
        // The item belongs to a previous ACP target/runtime.
        return;
      }
      const sessionId = resolveOpenCodeSessionId(item.resource, runtime) ?? extractSessionId(item.resource);
      if (!sessionId || sessionId === 'new' || sessionId.startsWith('untitled-')) {
        return;
      }

      runtime.sessionStore.updateMeta(sessionId, { archived: !!item.archived }).catch((err) => {
        logger.appendLine(
          `[session-provider] Failed to persist archived state for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    controller.getChatSessionInputState = (
      _sessionResource: vscode.Uri | undefined,
      _context: { readonly previousInputState: vscode.ChatSessionInputState | undefined },
      _token: vscode.CancellationToken,
    ): vscode.ChatSessionInputState => {
      // Create a tracked inputState from our option groups.
      // VSCode monitors this object; when the user changes a picker selection,
      // onDidChange fires on the returned inputState.
      const inputState = controller!.createChatSessionInputState(cachedOptionGroups);

      // Keep a reference so we can push group updates to an already-open session
      // when the backend connects (VSCode won't re-query a live inputState).
      currentInputState = inputState;

      // Listen for option-group refreshes and push new groups into
      // this inputState so the picker text updates in real time.
      const syncListener = onDidChangeOptionsEmitter.event(() => {
        if (currentInputState && !isPlaceholderGroups(cachedOptionGroups)) {
          // [debug] logger.appendLine('[session-provider] Pushing updated groups to current inputState');
          syncCurrentInputState();
        }
      });

      // Subscribe to changes and update selection in real-time.
      const inputRuntime = captureRuntime();
      inputState.onDidChange(() => {
        if (synchronizingInputState || !isRuntimeAccepting(inputRuntime)) {
          return;
        }
        const groups = inputState.groups ?? [];
        // [debug] logger.appendLine(
        //   `[session-provider] Picker changed: ${groups.length} groups` +
        //   groups.map(g => ` [${g.id}] selected=${g.selected?.id ?? '(none)'}`).join(''),
        // );

        for (const group of groups) {
          const selected = group.selected;
          if (!selected) { continue; }

          // Skip placeholder items; they shouldn't leak into state
          if (selected.id.endsWith('-connecting')) {
            // [debug] logger.appendLine(`[session-provider] Picker ignored placeholder selection: ${selected.id}`);
            continue;
          }

          if (group.id === 'agents') {
            const agentId = selected.id.replace(/^agent-/, '');
            inputRuntime.selection.setAgent(agentId).catch((err: unknown) => {
              logger.appendLine(`[session-provider] Failed to set agent: ${err}`);
            });
            // [debug] logger.appendLine(`[session-provider] Picker set currentAgent=${agentId}`);
          }
          if (group.id === 'permission-mode') {
            const permissionModeId = selected.id.replace(/^permission-/, '');
            const permissionMode = normalizePermissionMode(permissionModeId);
            inputRuntime.selection.setPermissionMode(permissionMode).catch((err: unknown) => {
              logger.appendLine(`[session-provider] Failed to set permission mode: ${err}`);
            });
          }
        }
      });

      inputState.onDidDispose(() => {
        logger.appendLine(`[session-provider] InputState disposed for ${_sessionResource?.toString() ?? 'new session'}`);
        syncListener.dispose();
        if (currentInputState === inputState) {
          currentInputState = undefined;
        }
      });

      return inputState;
    };

    logger.appendLine(`[session-provider] ChatSessionItemController created (id=${controller.id})`);

    // -- forkHandler: enables edit/rewind/fork UI buttons in the chat view ------
    // Without this, VS Code sets hasForkHandler=false which hides the fork UI.
    // This handler creates a child session and registers it as a new session item.
    controller.forkHandler = createForkHandler(controller);

  } else {
    logger.appendLine('[session-provider] ChatSessionItemController API not available; picker changes will NOT propagate');
  }

  // Session-level forkHandler: attached to every ChatSession returned by
  // provideChatSessionContent() so VSCode shows edit/rewind/fork buttons
  // for sessions loaded through the session target (including untitled sessions
  // that have no ChatSessionItem in the controller's item list).
  const sessionForkHandler = controller?.forkHandler;

  context.subscriptions.push({
    dispose: () => {
      backendReadyDispose();
      selectionChangedDispose();
      runtimeChangingDispose();
      sessionListChangedDispose?.();
      sessionItemStateChangedDispose?.dispose();
    },
  });

  // -- Session History Restoration -----------------------------------------

  /**
   * Extract session ID from the resource URI.
   * URI format: acpilot.opencode:/<sessionId>
   */
  function extractSessionId(resource: vscode.Uri): string {
    const segments = resource.path.split('/').filter(Boolean);
    const encodedSessionId = segments.at(-1) ?? '';
    try {
      return decodeURIComponent(encodedSessionId);
    } catch {
      return encodedSessionId;
    }
  }

  function assertActiveInstanceResource(
    resource: vscode.Uri,
    runtime: BackendContext = captureRuntime(),
  ): void {
    assertSessionResourcePath(resource.path, runtime.id, runtime.instanceKey);
  }

  /**
   * Resolve the real OpenCode session ID from a session resource URI.
   *
   * For untitled sessions, the URI contains the VSCode-generated ID (e.g.
   * "untitled-xxx") which must be mapped to the OpenCode session ID via
   * `ctx.sessions`. For real sessions (from the session list), the URI
   * already contains the OpenCode session ID.
   */
  function resolveOpenCodeSessionId(
    sessionResource: vscode.Uri,
    runtime: BackendContext = captureRuntime(),
  ): string | undefined {
    const rawId = extractSessionId(sessionResource);

    // Real OpenCode session IDs (from session.list) are used directly
    if (rawId && !rawId.startsWith('untitled-') && rawId !== 'new') {
      return rawId;
    }

    // Untitled sessions: look up the OpenCode session ID via sessions
    if (rawId) {
      const chatState = runtime.sessions.get(rawId);
      if (chatState?.backendSessionId) {
        return chatState.backendSessionId;
      }

      // Also check by the full URI string (sessionResource-based keys)
      const uriKey = sessionResource.toString();
      const uriState = runtime.sessions.get(uriKey);
      if (uriState?.backendSessionId) {
        return uriState.backendSessionId;
      }
    }

    return undefined;
  }

  function findLiveSessionEntryByBackendId(
    sessionId: string,
    runtime: BackendContext = captureRuntime(),
  ): { key: string; state: SessionState } | undefined {
    for (const [key, chatState] of runtime.sessions.entries()) {
      if (chatState.backendSessionId === sessionId && chatState.turnMap.length > 0) {
        return { key, state: chatState };
      }
    }
    return undefined;
  }

  function getSessionStreamPath(sessionDir: string): string {
    return path.join(sessionDir, 'session.jsonl');
  }

  function getSessionMetaStreamPath(sessionDir: string): string {
    return path.join(sessionDir, 'meta.jsonl');
  }

  function dedupeSnapshots(snapshots: readonly FileSnapshotRecord[]): FileSnapshotRecord[] {
    const seen = new Set<string>();
    const result: FileSnapshotRecord[] = [];
    for (const snapshot of snapshots) {
      const key = [
        snapshot.uri,
        snapshot.toolCallId,
        snapshot.phase,
        snapshot.editIndex,
        snapshot.turnIndex,
        snapshot.timestamp,
      ].join('\0');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(snapshot);
    }
    return result;
  }

  function sortStreamRecordsWithinNode(records: readonly StreamPartRecord[]): StreamPartRecord[] {
    return [...records].sort((a, b) => {
      const turnDelta = (a.meta?.turnIndex ?? 0) - (b.meta?.turnIndex ?? 0);
      if (turnDelta !== 0) {return turnDelta;}
      const sequenceDelta = (a.meta?.sequence ?? 0) - (b.meta?.sequence ?? 0);
      if (sequenceDelta !== 0) {return sequenceDelta;}
      return (a.meta?.createdAt ?? '').localeCompare(b.meta?.createdAt ?? '');
    });
  }

  function getRecordTurnIndex(record: StreamPartRecord): number {
    return typeof record.meta?.turnIndex === 'number' && Number.isFinite(record.meta.turnIndex)
      ? record.meta.turnIndex
      : 0;
  }

  function getRecordSubAgentInvocationId(record: StreamPartRecord): string | undefined {
    const payload = record.payload as { subAgentInvocationId?: unknown } | undefined;
    const fromPayload = payload?.subAgentInvocationId;
    if (typeof fromPayload === 'string' && fromPayload.length > 0) {
      return fromPayload;
    }
    const fromMeta = record.meta?.subAgentInvocationId;
    return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : undefined;
  }

  function getNodeSessionStatus(
    fallbackStatus: string,
    metaIndex: ReadonlyMap<string, Record<string, unknown>>,
  ): string {
    const streamedStatus = metaIndex.get('session')?.status;
    return typeof streamedStatus === 'string' ? streamedStatus : fallbackStatus;
  }

  function materializeStreamNodeEntries(
    records: readonly StreamPartRecord[],
    metaIndex: ReadonlyMap<string, Record<string, unknown>>,
    sessionStatus: string,
    streamNode: StreamRecordEntry['streamNode'],
  ): StreamRecordEntry[] {
    return finalizeIncompleteStates(
      materializeRecords(sortStreamRecordsWithinNode(records).filter(record => record.kind !== 'userPrompt')),
      sessionStatus,
    ).map(record => ({ record, metaIndex, streamNode }));
  }

  function expandStreamRecordsByTree(
    mainRecords: readonly StreamPartRecord[],
    subsessions: readonly SubsessionRecordSet[],
    rootMetaIndex: ReadonlyMap<string, Record<string, unknown>>,
    rootSessionStatus: string,
  ): StreamRecordEntry[] {
    const subsByParent = new Map<string | undefined, SubsessionRecordSet[]>();
    for (const sub of subsessions) {
      const entries = subsByParent.get(sub.parentSubAgentInvocationId) ?? [];
      entries.push(sub);
      subsByParent.set(sub.parentSubAgentInvocationId, entries);
    }
    for (const entries of subsByParent.values()) {
      entries.sort((a, b) =>
        a.subAgentPath.join('\0').localeCompare(b.subAgentPath.join('\0')) ||
        a.filePath.localeCompare(b.filePath)
      );
    }

    const consumed = new Set<string>();
    const appendSubtree = (sub: SubsessionRecordSet, output: StreamRecordEntry[]): void => {
      const key = sub.subAgentPath.join('\0');
      if (consumed.has(key)) {return;}
      consumed.add(key);

      const childByTrigger = new Map<string, SubsessionRecordSet[]>();
      for (const child of subsByParent.get(sub.subAgentInvocationId) ?? []) {
        const entries = childByTrigger.get(child.subAgentInvocationId) ?? [];
        entries.push(child);
        childByTrigger.set(child.subAgentInvocationId, entries);
      }

      const subSessionStatus = getNodeSessionStatus(rootSessionStatus, sub.metaIndex);
      for (const entry of materializeStreamNodeEntries(sub.records, sub.metaIndex, subSessionStatus, 'subsession')) {
        output.push(entry);
        const { record } = entry;
        const triggered = getRecordSubAgentInvocationId(record);
        if (!triggered) {continue;}
        for (const child of childByTrigger.get(triggered) ?? []) {
          appendSubtree(child, output);
        }
        childByTrigger.delete(triggered);
      }

      for (const remaining of childByTrigger.values()) {
        for (const child of remaining) {
          appendSubtree(child, output);
        }
      }
    };

    const rootsByTrigger = new Map<string, SubsessionRecordSet[]>();
    for (const sub of subsByParent.get(undefined) ?? []) {
      const entries = rootsByTrigger.get(sub.subAgentInvocationId) ?? [];
      entries.push(sub);
      rootsByTrigger.set(sub.subAgentInvocationId, entries);
    }

    const output: StreamRecordEntry[] = [];
    for (const entry of materializeStreamNodeEntries(mainRecords, rootMetaIndex, rootSessionStatus, 'root')) {
      output.push(entry);
      const { record } = entry;
      const triggered = getRecordSubAgentInvocationId(record);
      if (!triggered) {continue;}
      for (const sub of rootsByTrigger.get(triggered) ?? []) {
        appendSubtree(sub, output);
      }
      rootsByTrigger.delete(triggered);
    }

    for (const remaining of rootsByTrigger.values()) {
      for (const sub of remaining) {
        appendSubtree(sub, output);
      }
    }
    for (const sub of subsessions) {
      appendSubtree(sub, output);
    }

    return output;
  }

  function groupStreamRecordEntriesByTurn(entries: readonly StreamRecordEntry[]): Map<number, StreamRecordEntry[]> {
    const grouped = new Map<number, StreamRecordEntry[]>();
    for (const entry of entries) {
      const turnIndex = getRecordTurnIndex(entry.record);
      const turnEntries = grouped.get(turnIndex) ?? [];
      turnEntries.push(entry);
      grouped.set(turnIndex, turnEntries);
    }
    return grouped;
  }

  function shouldRenderRestoredEntry(entry: StreamRecordEntry): boolean {
    if (entry.streamNode !== 'subsession') {
      return true;
    }
    return entry.record.kind !== 'assistantText' && entry.record.kind !== 'reasoning';
  }

  function groupPromptsByTurn(records: readonly StreamPartRecord[]): Map<number, StreamPartRecord[]> {
    const grouped = new Map<number, StreamPartRecord[]>();
    for (const record of sortStreamRecordsWithinNode(records)) {
      if (record.kind !== 'userPrompt') {
        continue;
      }
      const turnIndex = getRecordTurnIndex(record);
      const entries = grouped.get(turnIndex) ?? [];
      entries.push(record);
      grouped.set(turnIndex, entries);
    }
    return grouped;
  }

  function getPromptFromStreamRecords(records: readonly StreamPartRecord[]): string | undefined {
    const promptRecord = records.find(record => record.kind === 'userPrompt');
    const payload = promptRecord?.payload as { text?: unknown } | undefined;
    return typeof payload?.text === 'string' && payload.text.length > 0
      ? payload.text
      : undefined;
  }

  type RestoreRecordSource = StreamPartRecord | StreamRecordEntry | RestoreRecordEntry;

  function getToolCompleteReplaySnapshotsForRecords(
    snapshots: readonly FileSnapshotRecord[],
    entriesOrRecords: readonly RestoreRecordSource[],
  ): FileSnapshotRecord[] {
    const records = normalizeRestoreRecordEntries(entriesOrRecords);
    if (snapshots.length === 0 || records.length === 0) {
      return [];
    }

    const snapshotsByCallId = groupSnapshotsByToolCallId(snapshots);
    const consumedSnapshotKeys = new Set<string>();
    const appendScopedSnapshots = (callId: string, entry: RestoreRecordEntry, target: FileSnapshotRecord[]): boolean => {
      const matched = getScopedSnapshotsForRecord(snapshotsByCallId, callId, entry)
        .filter(snapshot => {
          const key = snapshotIdentityKey(snapshot);
          if (consumedSnapshotKeys.has(key)) {
            return false;
          }
          consumedSnapshotKeys.add(key);
          return true;
        });
      if (matched.length === 0) {
        return false;
      }
      target.push(...matched);
      return true;
    };

    const result: FileSnapshotRecord[] = [];
    const appendedScopes = new Set<string>();
    for (const entry of records) {
      const { record } = entry;
      if (record.kind !== 'toolInvocation') {continue;}
      const payload = record.payload as {
        toolName?: string;
        callId?: string;
        partId?: string;
        state?: { status?: string };
      };
      const status = payload.state?.status;
      if (status !== 'completed' && status !== 'error') {continue;}
      if (!isRestoredEditToolName(payload.toolName)) {continue;}
      const callId = payload.callId ?? payload.partId;
      if (!callId) {continue;}
      const scopeKey = recordEditScopeKey(entry, callId);
      if (appendedScopes.has(scopeKey)) {continue;}
      if (appendScopedSnapshots(callId, entry, result)) {
        appendedScopes.add(scopeKey);
      }
    }

    return result;
  }

  function groupSnapshotsByToolCallId(
    snapshots: readonly FileSnapshotRecord[],
  ): Map<string, FileSnapshotRecord[]> {
    const snapshotsByCallId = new Map<string, FileSnapshotRecord[]>();
    for (const snapshot of snapshots) {
      if (!snapshot.toolCallId) {continue;}
      const entries = snapshotsByCallId.get(snapshot.toolCallId) ?? [];
      entries.push(snapshot);
      snapshotsByCallId.set(snapshot.toolCallId, entries);
    }
    return snapshotsByCallId;
  }

  function getRestoreSnapshotsForToolCompleteRecord(
    snapshots: readonly FileSnapshotRecord[],
    entryOrRecord: RestoreRecordSource,
  ): FileSnapshotRecord[] {
    const entry = normalizeRestoreRecordEntry(entryOrRecord);
    const callId = getRestoredEditSnapshotCallId(entry.record);
    if (!callId) {
      return [];
    }
    const snapshotsByCallId = groupSnapshotsByToolCallId(snapshots);
    return getScopedSnapshotsForRecord(snapshotsByCallId, callId, entry);
  }

  function getRestoredEditSnapshotCallId(record: StreamPartRecord): string | undefined {
    if (record.kind === 'externalEdit') {
      const payload = record.payload as { toolCallId?: unknown } | undefined;
      return nonEmptyString(payload?.toolCallId)
        ?? nonEmptyString(record.meta?.toolCallId)
        ?? getToolCallIdFromExternalEditRecordId(record.id);
    }

    if (record.kind !== 'toolInvocation') {
      return undefined;
    }
    const payload = record.payload as {
      toolName?: string;
      callId?: unknown;
      partId?: unknown;
      state?: { status?: string };
    };
    const status = payload.state?.status;
    if (status !== 'completed' && status !== 'error') {
      return undefined;
    }
    if (!isRestoredEditToolName(payload.toolName)) {
      return undefined;
    }
    return nonEmptyString(payload.callId) ?? nonEmptyString(payload.partId);
  }

  type RestoreRecordEntry = {
    record: StreamPartRecord;
    metaIndex?: ReadonlyMap<string, Record<string, unknown>>;
    streamNode?: StreamRecordEntry['streamNode'];
  };

  function normalizeRestoreRecordEntries(
    entriesOrRecords: readonly RestoreRecordSource[],
  ): RestoreRecordEntry[] {
    return entriesOrRecords.map(entryOrRecord => normalizeRestoreRecordEntry(entryOrRecord));
  }

  function normalizeRestoreRecordEntry(
    entryOrRecord: RestoreRecordSource,
  ): RestoreRecordEntry {
    if ('record' in entryOrRecord) {
      return entryOrRecord;
    }
    return { record: entryOrRecord };
  }

  function getScopedSnapshotsForRecord(
    snapshotsByCallId: ReadonlyMap<string, readonly FileSnapshotRecord[]>,
    callId: string,
    entry: RestoreRecordEntry,
  ): FileSnapshotRecord[] {
    const candidates = snapshotsByCallId.get(callId) ?? [];
    return candidates.filter(snapshot => isSnapshotInRecordScope(snapshot, entry, callId));
  }

  function isSnapshotInRecordScope(
    snapshot: FileSnapshotRecord,
    entry: RestoreRecordEntry,
    callId: string,
  ): boolean {
    if (snapshot.toolCallId !== callId) {
      return false;
    }
    const snapshotScope = snapshot.scope;
    if (!snapshotScope) {
      return false;
    }
    if (snapshotScope.toolCallId !== callId) {
      return false;
    }
    const record = entry.record;
    const recordMeta = record.meta;
    const recordStreamNode = entry.streamNode;
    if (snapshotScope.sessionId && recordMeta.sessionId && snapshotScope.sessionId !== recordMeta.sessionId) {
      return false;
    }
    if (recordStreamNode && snapshotScope.streamNode !== recordStreamNode) {
      return false;
    }
    if (snapshotScope.subAgentInvocationId || recordMeta.subAgentInvocationId) {
      if (snapshotScope.subAgentInvocationId !== recordMeta.subAgentInvocationId) {
        return false;
      }
    }
    if (snapshotScope.parentSubAgentInvocationId || recordMeta.parentSubAgentInvocationId) {
      if (snapshotScope.parentSubAgentInvocationId !== recordMeta.parentSubAgentInvocationId) {
        return false;
      }
    }
    if (snapshotScope.subAgentPath || recordMeta.subAgentPath) {
      if (!sameStringArray(snapshotScope.subAgentPath, recordMeta.subAgentPath)) {
        return false;
      }
    }
    if (
      typeof snapshotScope.turnIndex === 'number' &&
      typeof recordMeta.turnIndex === 'number' &&
      snapshotScope.turnIndex !== recordMeta.turnIndex
    ) {
      return false;
    }
    if (snapshotScope.requestId && recordMeta.requestId && snapshotScope.requestId !== recordMeta.requestId) {
      return false;
    }
    return true;
  }

  function recordEditScopeKey(entry: RestoreRecordEntry, toolCallId: string): string {
    const meta = entry.record.meta;
    return editScopeKeyParts({
      sessionId: meta.sessionId,
      streamNode: entry.streamNode,
      subAgentInvocationId: meta.subAgentInvocationId,
      subAgentPath: meta.subAgentPath,
      turnIndex: meta.turnIndex,
      requestId: meta.requestId,
      toolCallId,
    }).join('\0');
  }

  function snapshotScopeKey(scope: NonNullable<FileSnapshotRecord['scope']>): string {
    return editScopeKeyParts(scope).join('\0');
  }

  function editScopeKeyParts(scope: {
    sessionId?: string;
    streamNode?: string;
    subAgentInvocationId?: string;
    subAgentPath?: readonly string[];
    turnIndex?: number;
    requestId?: string;
    toolCallId: string;
  }): string[] {
    return [
      scope.sessionId ?? '',
      scope.streamNode ?? '',
      scope.subAgentInvocationId ?? '',
      (scope.subAgentPath ?? []).join('/'),
      scope.turnIndex ?? '',
      scope.requestId ?? '',
      scope.toolCallId,
    ].map(value => String(value));
  }

  function snapshotIdentityKey(snapshot: FileSnapshotRecord): string {
    return [
      snapshot.scope ? snapshotScopeKey(snapshot.scope) : '',
      snapshot.phase ?? '',
      snapshot.timestamp,
    ].join('\0');
  }

  function sameStringArray(
    left: readonly string[] | undefined,
    right: readonly string[] | undefined,
  ): boolean {
    if (!left && !right) {return true;}
    if (!left || !right || left.length !== right.length) {return false;}
    return left.every((value, index) => value === right[index]);
  }

  function hasRestorableExternalEditRecord(
    entriesOrRecords: readonly RestoreRecordSource[],
    toolCallId: string,
    targetEntry?: RestoreRecordEntry,
  ): boolean {
    return normalizeRestoreRecordEntries(entriesOrRecords).some(entry => {
      const { record } = entry;
      if (record.kind !== 'externalEdit') {
        return false;
      }
      if (getRestoredEditSnapshotCallId(record) !== toolCallId) {
        return false;
      }
      return !targetEntry || recordEditScopeKey(entry, toolCallId) === recordEditScopeKey(targetEntry, toolCallId);
    });
  }

  function getToolCompleteReplaySnapshotsForRestoredRecords(
    snapshots: readonly FileSnapshotRecord[],
    entriesOrRecords: readonly RestoreRecordSource[],
  ): FileSnapshotRecord[] {
    const entries = normalizeRestoreRecordEntries(entriesOrRecords);
    const fromToolCompletion = getToolCompleteReplaySnapshotsForRecords(snapshots, entries);
    if (snapshots.length === 0 || entries.length === 0) {
      return fromToolCompletion;
    }

    const snapshotsByCallId = groupSnapshotsByToolCallId(snapshots);
    const appendedScopes = new Set(fromToolCompletion.map(snapshot =>
      snapshot.scope ? snapshotScopeKey(snapshot.scope) : ''
    ));
    const extra: FileSnapshotRecord[] = [];
    for (const entry of entries) {
      const callId = getRestoredEditSnapshotCallId(entry.record);
      if (!callId || !hasRestorableExternalEditRecord(entries, callId, entry)) {
        continue;
      }
      const scoped = getScopedSnapshotsForRecord(snapshotsByCallId, callId, entry);
      const scopedKey = recordEditScopeKey(entry, callId);
      if (scoped.length > 0 && !appendedScopes.has(scopedKey)) {
        appendedScopes.add(scopedKey);
        extra.push(...scoped);
      }
    }
    return [...fromToolCompletion, ...extra];
  }

  function getSessionStatusForRestore(
    meta: SerializableSessionMeta | undefined,
    metaIndex: ReadonlyMap<string, Record<string, unknown>>,
  ): string {
    const streamedStatus = metaIndex.get('session')?.status;
    if (typeof streamedStatus === 'string') {
      return streamedStatus;
    }
    return meta?.status ?? 'completed';
  }

  /**
   * Create a forkHandler function for use by both the ChatSessionItemController
   * and the ChatSession objects returned by provideChatSessionContent().
   *
   * The handler resolves the correct OpenCode session ID (mapping VSCode untitled
   * IDs to backend session IDs), creates a child session, and registers it as a
   * new session item in the controller.
   */
  function createForkHandler(
    ctrl: vscode.ChatSessionItemController,
  ): ((
    sessionResource: vscode.Uri,
    request: vscode.ChatRequestTurn | undefined,
    _token: vscode.CancellationToken,
  ) => Promise<vscode.ChatSessionItem>) {
    return async (
      sessionResource: vscode.Uri,
      request: vscode.ChatRequestTurn | undefined,
      _token: vscode.CancellationToken,
    ): Promise<vscode.ChatSessionItem> => {
      const runtime = captureRuntime();
      assertRuntimeCurrent(runtime, true);
      assertActiveInstanceResource(sessionResource, runtime);
      const rawSessionId = extractSessionId(sessionResource);
      const sessionId = resolveOpenCodeSessionId(sessionResource, runtime);

      const derivedLabel = request?.prompt
        ? `Fork: ${request.prompt.slice(0, 40).trimEnd()}`
        : 'Forked Session';
      const title = derivedLabel.length > 0 ? derivedLabel : 'Forked Session';

      logger.appendLine(
        `[session-provider] Fork requested for raw=${rawSessionId}, backend=${sessionId ?? 'unknown'} (title="${title}")`,
      );

      if (!sessionId) {
        const msg = `Cannot fork session: unable to resolve OpenCode session ID for resource ${sessionResource.toString()}`;
        logger.appendLine(`[session-provider] ${msg}`);
        throw new Error(msg);
      }

      const result = await awaitRuntimeOperation(
        runtime,
        Promise.resolve().then(() => runtime.backend.sessions.create({
          parentId: sessionId,
          directory,
          title,
        })),
      );
      assertRuntimeCurrent(runtime, true);

      if (result.error || !result.data?.id) {
        const msg = `Failed to create forked session: ${result.error ?? 'no id'}`;
        logger.appendLine(`[session-provider] ${msg}`);
        throw new Error(msg);
      }

      const newSessionId = result.data.id;
      const newResource = createSessionResource(runtime, newSessionId);

      const item = ctrl.createChatSessionItem(newResource, getSessionLabel({ id: newSessionId, title }));
      item.status = vscode.ChatSessionStatus.Completed;
      item.archived = false;
      item.timing = { created: Date.now() };
      ctrl.items.add(item);

      logger.appendLine(
        `[session-provider] Forked session ${newSessionId} created from ${sessionId}`,
      );

      // Refresh the session list so the new forked session appears
      if (isRuntimeCurrent(runtime)) {
        refreshSessionItems(runtime).catch(() => {});
      }

      return item;
    };
  }

  /**
   * Fetch message history from the backend and map to VSCode turn format.
   *
   * Replays persisted SSP records through a CollectorStream instead of fetching
   * from the backend API directly. This keeps restore on the same SSP rendering
   * contract as the original live session.
   */
  async function fetchSessionHistory(
    runtime: BackendContext,
    sessionId: string,
    token: vscode.CancellationToken,
    options?: { replayPendingChanges?: boolean },
  ): Promise<RestoredSessionHistory> {
    assertRuntimeCurrent(runtime);
    const sessionDir = runtime.sessionStore.getSessionDir(sessionId);
    const sessionStreamPath = getSessionStreamPath(sessionDir);
    const metaStreamPath = getSessionMetaStreamPath(sessionDir);
    const meta = await awaitRuntimeOperation(
      runtime,
      Promise.resolve().then(() => runtime.sessionStore.readMeta(sessionId)),
    );
    assertRuntimeCurrent(runtime);

    const mainRecords = await awaitRuntimeOperation(
      runtime,
      Promise.resolve().then(() => readAllStreamParts(sessionStreamPath)),
    );
    assertRuntimeCurrent(runtime);
    if (mainRecords.length > 0) {
      const subsessions = await awaitRuntimeOperation(
        runtime,
        Promise.resolve().then(() => readSubsessionRecords(sessionDir)),
      );
      assertRuntimeCurrent(runtime);
      const rootMetaIndex = await awaitRuntimeOperation(
        runtime,
        Promise.resolve().then(() => readMetaIndex(metaStreamPath)),
      );
      assertRuntimeCurrent(runtime);
      const sessionStatus = getSessionStatusForRestore(meta, rootMetaIndex);
      const responseEntries = expandStreamRecordsByTree(
        mainRecords,
        subsessions,
        rootMetaIndex,
        sessionStatus,
      );
      const allRawRecords = [
        ...mainRecords,
        ...subsessions.flatMap(sub => sub.records),
      ];
      const streamParts = allRawRecords as SerializableStreamPart[];
      const snapshots = dedupeSnapshots([
        ...await awaitRuntimeOperation(
          runtime,
          Promise.resolve().then(() => readAllSnapshots(sessionStreamPath)),
        ),
        ...subsessions.flatMap(sub => sub.snapshots),
      ]).filter((snapshot): snapshot is FileSnapshotRecord & { scope: NonNullable<FileSnapshotRecord['scope']> } => !!snapshot.scope);
      assertRuntimeCurrent(runtime);
      const toolIdEditMap = getToolIdEditMap(meta, streamParts, responseEntries, rootMetaIndex);
      const restoreReplaySnapshots = getToolCompleteReplaySnapshotsForRestoredRecords(snapshots, responseEntries);
      const restorableMappedEditSnapshots = filterSnapshotsWithRestoredEditRecords(restoreReplaySnapshots, toolIdEditMap);
      const restorableSnapshotEditCallIds = new Set(
        restoreReplaySnapshots
          .filter(snapshot => snapshot.phase === 'after' && !!snapshot.undoStopId && snapshot.toolCallId)
          .map(snapshot => snapshot.toolCallId!),
      );
      const restorableSnapshotEditSnapshots = restoreReplaySnapshots.filter(snapshot =>
        !!snapshot.toolCallId && restorableSnapshotEditCallIds.has(snapshot.toolCallId)
      );
      const restorableEditSnapshots = restorableMappedEditSnapshots.length > 0
        ? restorableMappedEditSnapshots
        : restorableSnapshotEditSnapshots;
      const pendingReplaySnapshots = options?.replayPendingChanges === false
        ? []
        : excludeSnapshots(getRestoreReplaySnapshots(snapshots, meta), restorableEditSnapshots);
      const checkpointApproval = getCheckpointApproval(snapshots, meta);
      const requestIdByTurnIndex = getRestoredRequestIdByTurnIndex(meta, streamParts, rootMetaIndex);
      const grouped = groupStreamRecordEntriesByTurn(responseEntries);
      const promptsByTurn = groupPromptsByTurn(mainRecords);
      const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] = [];

      const makeRequestTurn = (
        prompt: string,
        requestId: RestoredRequestId,
        turnIndex: number,
      ): vscode.ChatRequestTurn => {
        logger.appendLine(
          `[session-provider] Restored request id for ${sessionId}: ` +
          `turn=${turnIndex} requestId=${requestId.id ?? '<none>'} source=${requestId.source}`,
        );
        return createRequestTurn(prompt, undefined, [], runtime.scheme, requestId.id);
      };

      const buildResponseTurn = (
        entriesForResponse: readonly StreamRecordEntry[],
        snapshotsForResponse: readonly FileSnapshotRecord[],
      ): vscode.ChatResponseTurn | undefined => {
        const collector = new CollectorStream();
        const pushedRestoredEditScopes = new Set<string>();

        for (const entry of entriesForResponse) {
          if (token.isCancellationRequested) {break;}
          if (shouldRenderRestoredEntry(entry)) {
            createSSPFromRecord(entry.record, entry.metaIndex).render(collector as never);
          }
          const restoredEditCallId = getRestoredEditSnapshotCallId(entry.record);
          const restoredEditScopeKey = restoredEditCallId
            ? recordEditScopeKey(entry, restoredEditCallId)
            : undefined;
          if (restoredEditScopeKey && pushedRestoredEditScopes.has(restoredEditScopeKey)) {
            continue;
          }
          const entryRestoreSnapshots = getRestoreSnapshotsForToolCompleteRecord(snapshotsForResponse, entry);
          pushSnapshotsForRestoredEditTools(
            sessionId,
            entryRestoreSnapshots,
            collector,
            toolIdEditMap,
          );
          if (restoredEditCallId && entryRestoreSnapshots.length > 0) {
            pushedRestoredEditScopes.add(restoredEditScopeKey ?? restoredEditCallId);
          }
        }

        return collector.parts.length > 0
          ? collector.buildTurn(getRestoredTurnMetadata(snapshotsForResponse, toolIdEditMap), runtime.scheme)
          : undefined;
      };

      const turnIndexes = [...new Set([
        ...promptsByTurn.keys(),
        ...grouped.keys(),
      ])].sort((a, b) => a - b);

      for (const turnIndex of turnIndexes) {
        if (token.isCancellationRequested) {break;}
        const prompt = getPromptFromStreamRecords(promptsByTurn.get(turnIndex) ?? []);
        if (prompt) {
          history.push(makeRequestTurn(prompt, getRestoredRequestId(turnIndex, requestIdByTurnIndex), turnIndex));
        }
        const entries = grouped.get(turnIndex) ?? [];
        const responseTurn = buildResponseTurn(
          entries,
          getToolCompleteReplaySnapshotsForRestoredRecords(snapshots, entries),
        );
        if (responseTurn) {
          history.push(responseTurn);
        }
      }

      logRestorableEditSnapshotSummary(sessionId, restorableEditSnapshots, toolIdEditMap);
      logger.appendLine(
        `[session-provider] fetchSessionHistory: sspRecords=${allRawRecords.length} ` +
        `renderedRecords=${responseEntries.length} ` +
        `subsessions=${subsessions.length} snapshots=${snapshots.length} from ${sessionStreamPath} ` +
        `(source=ssp-v2, acceptedThroughTurn=${checkpointApproval.acceptedThroughTurn}, ` +
        `pending=${checkpointApproval.pendingSnapshots.length}, restoreReplay=${restoreReplaySnapshots.length}, ` +
        `editRecords=${toolIdEditMap.size}, replayPending=${options?.replayPendingChanges !== false})`,
      );

      logger.appendLine(
        `[session-provider] Restored ${history.length} turns for session ${sessionId}`,
      );

      return { history, snapshots, pendingReplaySnapshots, restoreReplaySnapshots, meta };
    }

    logger.appendLine(
      `[session-provider] fetchSessionHistory: no SSP stream-part records for session ${sessionId}; ` +
      `returning empty history.`,
    );
    return { history: [], snapshots: [], pendingReplaySnapshots: [], restoreReplaySnapshots: [], meta };
  }

  // -- The Provider --------------------------------------------------------
  // Following the Copilot CLI pattern: the session provider only provides content
  // (history, title) and manages option groups (agent picker).
  // All request handling is delegated to the same ChatParticipant handler used
  // by the stable surface (participant/handler.ts), ensuring a shared session
  // lifecycle. Picker changes update selection via the
  // controller's tracked inputState.onDidChange, and the handler reads from
  // state at prompt time.

  const provider: vscode.ChatSessionContentProvider = {
    /**
      * Called by VSCode at registration time and whenever
      * onDidChangeChatSessionProviderOptions fires.
      * Returns the option groups (agent picker).
     */
    provideChatSessionProviderOptions(
      _token: vscode.CancellationToken,
    ): Thenable<vscode.ChatSessionProviderOptions> {
      const runtime = captureRuntime();
      if (!isRuntimeAccepting(runtime)) {
        return Promise.resolve({ optionGroups: buildConnectingOptionGroups() });
      }
      // If we have real data cached, return immediately.
      if (cachedOptionGroups.length > 0 && !isPlaceholderGroups(cachedOptionGroups)) {
        return Promise.resolve({ optionGroups: cachedOptionGroups });
      }

      kickBackendStart('provider options requested');

      // If a refresh is already in-flight, return the in-flight promise.
      // This prevents re-entrant loops where fire() -> VSCode re-query -> refresh again.
      if (optionGroupsRefreshInFlight && sameRuntime(optionGroupsRefreshInFlight.runtime, runtime)) {
        return optionGroupsRefreshInFlight.promise.then(() => ({
          optionGroups: isRuntimeCurrent(runtime) ? cachedOptionGroups : buildConnectingOptionGroups(),
        }));
      }

      // Backend might be running now; if so, fetch real data.
      // If still offline, refreshOptionGroups() returns placeholders.
      return refreshOptionGroups(runtime).then(() => ({
        optionGroups: isRuntimeCurrent(runtime) ? cachedOptionGroups : buildConnectingOptionGroups(),
      }));
    },

    /**
     * Fired when option groups change (backend starts, config changes).
     * VSCode will re-call provideChatSessionProviderOptions.
     */
    onDidChangeChatSessionProviderOptions: onDidChangeOptionsEmitter.event,

    provideChatSessionContent(
      resource: vscode.Uri,
      token: vscode.CancellationToken,
      _providerContext: { readonly inputState: vscode.ChatSessionInputState },
    ): Thenable<vscode.ChatSession> {
      const runtime = captureRuntime();
      assertRuntimeCurrent(runtime, true);
      assertActiveInstanceResource(resource, runtime);
      const sessionId = extractSessionId(resource);
      logger.appendLine(
        `[session-provider] provideChatSessionContent called for ${resource.toString()} (sessionId=${sessionId})`,
      );

      // Refresh option groups if they haven't been populated yet.
      // This handles the case where the backend wasn't running during
      // provider creation but is now available (user just selected the target).
      if (cachedOptionGroups.length === 0 && runtime.backend.isRunning()) {
        refreshOptionGroups(runtime).catch(() => { /* already logged */ });
      }

      // NOTE: Picker selection changes are handled by the ChatSessionItemController's
      // getChatSessionInputState -> onDidChange subscription (set up above).
      // We no longer need to read inputState here; the controller keeps
      // selection updated in real-time.

      // New session; no history to restore
      // VSCode generates untitled-* URIs for fresh sessions; only real OpenCode
      // session IDs (e.g. from session.list()) should trigger history fetch.
      if (!sessionId || sessionId === 'new') {
        return Promise.resolve({
          title: newSessionTitle,
          history: [],
          requestHandler: createParticipantHandler(state, runtime, { runtimeOwner: ctx }),
          ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
        });
      }

      // For untitled-* sessions (VSCode-managed), look up the OpenCode session
      // that was previously created via requestHandler. The sessions key is
      // request.sessionId which matches the untitled-* ID from the URI path.
      if (sessionId.startsWith('untitled-')) {
        const chatState = runtime.sessions.get(sessionId);
        if (chatState?.backendSessionId) {
          const backendSessionId = chatState.backendSessionId;
          logger.appendLine(
            `[session-provider] Found existing OpenCode session ${backendSessionId} for VSCode session ${sessionId}`,
          );

          // Fetch history from the OpenCode backend
          return (async (): Promise<vscode.ChatSession> => {
            try {
              await ensureBackendRunning(runtime);
              assertRuntimeCurrent(runtime, true);

              const { history, meta } = await fetchSessionHistory(runtime, backendSessionId, token, {
                replayPendingChanges: false,
              });
              assertRuntimeCurrent(runtime, true);
              let backendTitle: string | undefined;
              try {
                const sessionInfo = await runtime.backend.sessions.get(backendSessionId);
                assertRuntimeCurrent(runtime, true);
                backendTitle = sessionInfo.data?.title;
              } catch (err) {
                if (isRuntimeChangedError(err)) {
                  throw err;
                }
                backendTitle = undefined;
              }
              const resolvedTitle = await titleServiceFor(runtime).applyRestoredTitle({
                backendSessionId,
                history,
                meta,
                backendTitle,
                overwrite: false,
                emitListChanged: false,
              });
              assertRuntimeCurrent(runtime, true);

              return {
                title: resolvedTitle.title,
                history,
                requestHandler: createParticipantHandler(state, runtime, { runtimeOwner: ctx }),
                ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
              };
            } catch (err) {
              if (isRuntimeChangedError(err)) {
                throw err;
              }
              logger.appendLine(
                `[session-provider] Failed to restore session history: ${err instanceof Error ? err.message : String(err)}`,
              );
              return {
                title: chatState.title?.trim() || offlineSessionTitle,
                history: [],
                requestHandler: createParticipantHandler(state, runtime, { runtimeOwner: ctx }),
                ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
              };
            }
          })();
        }

        // No existing OpenCode session for this untitled tab; it's genuinely new
        return Promise.resolve({
          title: newSessionTitle,
          history: [],
          requestHandler: createParticipantHandler(state, runtime, { runtimeOwner: ctx }),
          ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
        });
      }

      // Existing session; fetch history from backend
      return (async (): Promise<vscode.ChatSession> => {
        try {
          await ensureBackendRunning(runtime);
          assertRuntimeCurrent(runtime, true);

          // Get session info for title
          const sessionInfo = await runtime.backend.sessions.get(sessionId);
          assertRuntimeCurrent(runtime, true);
          const vscodeSessionKey = resource.toString();
          const liveEntry = findLiveSessionEntryByBackendId(sessionId, runtime);
          const isLiveInMemory = !!liveEntry;
          if (liveEntry && !runtime.sessions.has(vscodeSessionKey)) {
            runtime.sessions.set(vscodeSessionKey, liveEntry.state);
            logger.appendLine(
              `[session-provider] Aliased provider resource ${vscodeSessionKey} to live session ${sessionId} from ${liveEntry.key}`,
            );
          }

          // Fetch message history
          const { history, pendingReplaySnapshots, meta } = await fetchSessionHistory(runtime, sessionId, token, {
            replayPendingChanges: !isLiveInMemory,
          });
          assertRuntimeCurrent(runtime, true);
          const resolvedTitle = await titleServiceFor(runtime).applyRestoredTitle({
            backendSessionId: sessionId,
            history,
            meta,
            backendTitle: sessionInfo.data?.title,
            createdAt: sessionInfo.data?.createdAt,
            overwrite: false,
            emitListChanged: false,
          });
          assertRuntimeCurrent(runtime, true);

          // Store in session map for request handler continuity
          const existingState = runtime.sessions.get(vscodeSessionKey);
          if (existingState) {
            existingState.backendSessionId = sessionId;
            if (existingState.title !== resolvedTitle.title || existingState.titleSource !== resolvedTitle.source) {
              existingState.title = resolvedTitle.title;
              existingState.titleSource = resolvedTitle.source;
            }
            existingState.createdAt = sessionInfo.data?.createdAt ?? existingState.createdAt ?? new Date();
          } else {
            runtime.sessions.set(vscodeSessionKey, {
              backendSessionId: sessionId,
              turnMap: [],
              title: resolvedTitle.title,
              titleSource: resolvedTitle.source,
              createdAt: sessionInfo.data?.createdAt ?? new Date(),
            });
          }

          return {
            title: resolvedTitle.title,
            history,
            requestHandler: createParticipantHandler(state, runtime, { runtimeOwner: ctx }),
            ...(pendingReplaySnapshots.length > 0
              ? {
                  activeResponseCallback: async (
                    stream: vscode.ChatResponseStream,
                    activeToken: vscode.CancellationToken,
                  ) => {
                    await replayPendingSnapshotsForSession(runtime, sessionId, pendingReplaySnapshots, stream, activeToken);
                  },
                }
              : {}),
            ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
          };
        } catch (err) {
          if (isRuntimeChangedError(err)) {
            throw err;
          }
          logger.appendLine(
            `[session-provider] Failed to fetch session history: ${err instanceof Error ? err.message : String(err)}`,
          );
          return {
            title: offlineSessionTitle,
            history: [],
            requestHandler: createParticipantHandler(state, runtime, { runtimeOwner: ctx }),
            ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
          };
        }
      })();
    },
  };

  return { provider, controller };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Create a ChatRequestTurn for session history restoration.
 *
 * VSCode's internal ChatRequestTurn constructor requires 5 arguments:
 *   (prompt, command, references, participant, toolReferences)
 * The proposed ChatRequestTurn2 form also accepts restored metadata after
 * those arguments, including the stable request id used by edit sessions.
 * The stable @types/vscode hides the constructor, but the proposed
 * chatSessionsProvider API permits construction at runtime.
 */
function createRequestTurn(
  prompt: string,
  command: string | undefined,
  references: readonly vscode.ChatPromptReference[],
  participantId: string,
  requestId?: string,
): vscode.ChatRequestTurn {
  const Ctor = vscode.ChatRequestTurn as unknown as new (
    p: string,
    c: string | undefined,
    r: readonly vscode.ChatPromptReference[],
    participant: string,
    toolReferences: readonly vscode.ChatLanguageModelToolReference[],
    editedFileEvents: readonly unknown[] | undefined,
    id: string | undefined,
  ) => vscode.ChatRequestTurn;
  return new Ctor(prompt, command, references, participantId, [], undefined, requestId);
}

/**
 * Create a ChatResponseTurn for session history restoration.
 *
 * VSCode's internal ChatResponseTurn constructor requires 3 or 4 arguments:
 *   (response, result, participant, command?)
 * Missing the `participant` parameter causes VS Code to reject or silently
 * drop the turn during rendering.
 */
