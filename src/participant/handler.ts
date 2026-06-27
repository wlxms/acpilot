import * as vscode from 'vscode';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import { SerializableSessionStream } from '../acp/streaming/session-stream';
import { UserPromptSSP } from '../ssp/impl/user-prompt';
import { applyProvisionalSessionTitle, applySessionTitle, isPlaceholderSessionTitle } from './session-title';

import type { ExtensionState, TurnMapping, BackendContext } from '../types';
import type { AcpChildSessionInfo, AcpSessionStatus, AcpResult, AcpModel, AcpAgent } from '../acp/types';
import type { AcpEvent } from '../acp/types';
import type { SessionTitleSource } from '../acp/serializable/types';
import { collectOpenFileUris } from './checkpoint';
import { extractAttachmentsFromReferences } from './references';

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
 * Resolution order:
 *  1. If `request.model` is present, attempt a fuzzy match against the
 *     backend model catalogue (by `model.id`, then `model.family`, then
 *     `model.name`).
 *  2. On match, sync the match into `SelectionStore` so the custom UI
 *     (status bar, option groups) stays consistent with the native picker.
 *  3. On no match, fall back to the existing `SelectionStore` model.
 *
 * LIMITATION: `LanguageModelChat.id` is an opaque identifier assigned by
 * the model contributor (e.g. `"gpt-4o"`).  It does NOT carry a provider
 * prefix, so we cannot distinguish between identically-named models from
 * different providers.  The heuristic matches the first backend model whose
 * `id` or `name` overlaps.  If the heuristic cannot resolve a unique match
 * we keep the SelectionStore value unchanged rather than guessing.
 */
export async function resolvePromptModel(
  request: vscode.ChatRequest,
  state: ExtensionState,
  ctx: BackendContext,
): Promise<{ providerID: string; modelID: string } | undefined> {
  const nativeModel = request.model;

  // Fast path: no native model - use custom store
  if (!nativeModel) {
    return ctx.selection.get().model;
  }

  // ACPModels primary resolution
  const vendor = (nativeModel as vscode.LanguageModelChat).vendor;
  if (vendor && state.acpModels) {
    // Strip our "vendor/modelId" prefix if present (the LM provider
    // registers models as "opencode/big-pickle", but the resolver
    // expects the bare modelId "big-pickle").
    let modelId = nativeModel.id;
    if (modelId.startsWith(vendor + '/')) {
      modelId = modelId.substring(vendor.length + 1);
    }
    const resolution = state.acpModels.resolve(vendor, modelId);
    if (resolution.kind === 'backend' && resolution.providerID && resolution.modelID) {
      // Unique match - sync to SelectionStore and return
      const sel = ctx.selection.get();
      if (!sel.model ||
          sel.model.providerID !== resolution.providerID ||
          sel.model.modelID !== resolution.modelID) {
        await ctx.selection.setModel(resolution.providerID, resolution.modelID);
      }
      return { providerID: resolution.providerID, modelID: resolution.modelID };
    }
  }

  // Legacy: fuzzy match against backend model catalogue
  // Falls through if ACPModels didn't resolve (passthrough / not-found / no sync)

  // Fetch the backend model catalogue for matching.
  // Errors are non-fatal - fall back to SelectionStore on failure.
  const modelsResult = await ctx.backend.config.models();
  const backendModels: AcpModel[] = modelsResult.data ?? [];

  if (backendModels.length === 0) {
    // No catalogue to match against - use SelectionStore
    return ctx.selection.get().model;
  }

  // Strip vendor prefix (e.g. "opencode-cli/") from nativeModel.id so that
  // the legacy fuzzy match compares against the bare model identifier that
  // backend models report (e.g. "deepseek-v4-flash-free").
  const modelIdForMatch = vendor && nativeModel.id.startsWith(vendor + '/')
    ? nativeModel.id.substring(vendor.length + 1)
    : nativeModel.id;

  // Attempt matching: native model.id to backend model.id
  // LanguageModelChat.id is opaque but often matches the model's common ID.
  // We also try .family and .name as fallbacks.
  type ModelRef = { providerID: string; modelID: string };
  const candidates: ModelRef[] = [];

  for (const bm of backendModels) {
    const providerID = bm.provider ?? 'default';
    // Match by id (exact)
    if (bm.id === modelIdForMatch) {
      candidates.push({ providerID, modelID: bm.id });
    }
    // Match by name (exact, case-insensitive)
    else if (bm.name && bm.name.toLowerCase() === modelIdForMatch.toLowerCase()) {
      candidates.push({ providerID, modelID: bm.id });
    }
    // Match by family (exact, case-insensitive)
    else if (bm.id.toLowerCase() === (nativeModel as vscode.LanguageModelChat).family?.toLowerCase()) {
      candidates.push({ providerID, modelID: bm.id });
    }
    // Partial match: native id is a substring of backend model id (or vice versa)
    else if (
      modelIdForMatch.length >= 3 &&
      (bm.id.toLowerCase().includes(modelIdForMatch.toLowerCase()) ||
       modelIdForMatch.toLowerCase().includes(bm.id.toLowerCase()))
    ) {
      candidates.push({ providerID, modelID: bm.id });
    }
  }

  // Deduplicate candidates (same providerID + modelID)
  const unique = new Map<string, ModelRef>();
  for (const c of candidates) {
    unique.set(`${c.providerID}/${c.modelID}`, c);
  }

  const uniqueCandidates = [...unique.values()];

  if (uniqueCandidates.length === 1) {
    // Unique match - sync to SelectionStore and return
    const match = uniqueCandidates[0];
    const sel = ctx.selection.get();
    // Only sync if different from current selection
    if (!sel.model || sel.model.providerID !== match.providerID || sel.model.modelID !== match.modelID) {
      await ctx.selection.setModel(match.providerID, match.modelID);
    }
    return match;
  }

  if (uniqueCandidates.length > 1) {
    // Ambiguous match - cannot safely pick one.
    // Fall back to SelectionStore to avoid silently switching providers.
    // Log for diagnostics.
    state.outputChannel.appendLine(
      `[handler] Native model "${nativeModel.id}" matched ${uniqueCandidates.length} backend models - ` +
      `falling back to SelectionStore to avoid ambiguity`,
    );
    return ctx.selection.get().model;
  }

  // No match at all - native model not in backend catalogue.
  // Fall back to SelectionStore. This can happen when the native picker shows
  // models that the backend doesn't serve (e.g. Copilot-only models).
  return ctx.selection.get().model;
}

/**
 * Normalize the persisted agent selection before it is sent to OpenCode.
 *
 * Older extension state and some picker payloads can contain a display name
 * instead of the backend agent id. OpenCode prompt expects the id, so resolve
 * against the backend catalogue and repair SelectionStore when possible.
 */
export async function resolvePromptAgent(
  state: ExtensionState,
  ctx: BackendContext,
  directory?: string,
): Promise<string | undefined> {
  const selected = ctx.selection.get().agent?.trim();
  if (!selected) {
    return undefined;
  }

  try {
    const result = await ctx.backend.config.agents(directory);
    const agents = result.data ?? [];
    if (agents.length === 0) {
      return selected;
    }

    const exactId = agents.find((agent) => agent.id === selected);
    if (exactId) {
      return exactId.id;
    }

    const byName = agents.filter((agent: AcpAgent) => agent.name?.trim() === selected);
    if (byName.length === 1) {
      const resolved = byName[0].id;
      await ctx.selection.setAgent(resolved);
      state.outputChannel.appendLine(
        `[handler] Agent selection normalized from ${JSON.stringify(selected)} to ${JSON.stringify(resolved)}`,
      );
      return resolved;
    }

    const selectedLower = selected.toLowerCase();
    const byCaseInsensitiveName = agents.filter(
      (agent: AcpAgent) => agent.name?.trim().toLowerCase() === selectedLower,
    );
    if (byCaseInsensitiveName.length === 1) {
      const resolved = byCaseInsensitiveName[0].id;
      await ctx.selection.setAgent(resolved);
      state.outputChannel.appendLine(
        `[handler] Agent selection normalized from ${JSON.stringify(selected)} to ${JSON.stringify(resolved)}`,
      );
      return resolved;
    }

    if (byName.length > 1 || byCaseInsensitiveName.length > 1) {
      state.outputChannel.appendLine(
        `[handler] Agent selection ${JSON.stringify(selected)} matched multiple backend agents; using stored value`,
      );
    } else {
      state.outputChannel.appendLine(
        `[handler] Agent selection ${JSON.stringify(selected)} was not found in backend agents; using stored value`,
      );
    }
    return selected;
  } catch (err) {
    state.outputChannel.appendLine(
      `[handler] Agent selection normalization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return selected;
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
): Promise<boolean> {
  const status = ctx.backend.getStatus();
  if (status === 'running') {
    return true;
  }

  try {
    stream.progress(status === 'starting' ? `${ctx.backend.name} is starting...` : `Starting ${ctx.backend.name} server...`);
    const workspacePath = getWorkspaceDirectory();
    const result = await ctx.backend.start(workspacePath);
    if (result.error || !result.data) {
      const msg = typeof result.error === 'string' ? result.error : 'Unknown error';
      stream.markdown(`Failed to start backend: ${msg}`);
      return false;
    }
    state.outputChannel.appendLine(`[handler] Server started at ${result.data.url}`);
    stream.progress('Server ready');
    return true;
  } catch (err) {
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
function recoverFromHistory(context: vscode.ChatContext): RecoveredHistory {
  const history = context.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    // ChatResponseTurn is a proposed API - access metadata via type assertion
    const metadata = (turn as unknown as { metadata?: Record<string, unknown> })?.metadata;
    if (!metadata) {continue;}

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

function getInitialSessionTitle(vscodeSessionId: string): string {
  if (vscodeSessionId.includes('/untitled-')) {
    return 'New OpenCode Session';
  }

  return `OpenCode Session ${vscodeSessionId.slice(0, 8)}`;
}

function isProvisionalTitleEcho(
  title: string | undefined,
  chatState: { title?: string; provisionalTitle?: boolean } | undefined,
): boolean {
  return !!title
    && !!chatState?.provisionalTitle
    && title.trim() === chatState.title?.trim();
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
): Promise<string | null> {
  // Get or create per-VSCode-chat state
  let chatState = ctx.sessions.get(vscodeSessionId);
  if (!chatState) {
    chatState = { backendSessionId: '', turnMap: [] };
    ctx.sessions.set(vscodeSessionId, chatState);
  }

  // Check for metadata recovery (VSCode restart / tab restore)
  if (!chatState.backendSessionId) {
    const recovered = recoverFromHistory(context);
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
    stream.progress('Creating new session...');
    const result = await ctx.backend.sessions.create({
      title: getInitialSessionTitle(vscodeSessionId),
      directory,
    });
    if (result.error || !result.data) {
      stream.markdown('Failed to create session.');
      return null;
    }
    chatState.backendSessionId = result.data.id;
    chatState.title = result.data.title;
    chatState.titleSource = isPlaceholderSessionTitle(result.data.title) ? 'placeholder' : 'backend';
    chatState.createdAt = result.data.createdAt;
    stream.progress('Session ready');
    // Write session metadata before title lifecycle patches can run. If this is
    // left fire-and-forget, the initial placeholder write can race with the
    // first-prompt provisional title update and overwrite it.
    try {
      await ctx.sessionStore.writeMeta(result.data.id, {
        id: result.data.id,
        title: result.data.title ?? getInitialSessionTitle(vscodeSessionId),
        titleSource: chatState.titleSource,
        titleUpdatedAt: new Date().toISOString(),
        createdAt: result.data.createdAt?.toISOString() ?? new Date().toISOString(),
        backendName: ctx.backend.name,
      });
    } catch (err) {
      state.outputChannel.appendLine(`[handler] writeMeta failed: ${err}`);
    }
    state.bus.emit('session-list-changed', { backendId: ctx.id });
    state.outputChannel.appendLine(
      `[handler] Created new session ${chatState.backendSessionId} for VSCode chat ${vscodeSessionId}`,
    );
    return chatState.backendSessionId;
  }

  // --- Case 2: Continue (same turn count) ---
  if (currentTurnIndex === chatState.turnMap.length) {
    stream.progress('Reusing existing session...');
    state.outputChannel.appendLine(
      `[handler] Reusing session ${chatState.backendSessionId} for VSCode chat ${vscodeSessionId} (turn ${currentTurnIndex}) ` +
      `turnMap=${chatState.turnMap.length}`,
    );
    return chatState.backendSessionId;
  }

  // --- Case 3: Rewind (fewer turns than recorded) - revert ---
  if (currentTurnIndex < chatState.turnMap.length) {
    const priorTurnMap = chatState.turnMap.slice(0, currentTurnIndex);
    if (currentTurnIndex > 0) {
      stream.progress('Rewinding conversation...');
      state.outputChannel.appendLine(
        `[handler] Rewind detected: reverting session ${chatState.backendSessionId} from turn ${currentTurnIndex} ` +
        `(turnMap had ${chatState.turnMap.length} entries, keeping ${priorTurnMap.length})`,
      );
      // Revert each extraneous message from back to front (oldest first)
      let allSucceeded = true;
      let revertCount = 0;
      for (let i = chatState.turnMap.length - 1; i >= currentTurnIndex; i--) {
        const entry = chatState.turnMap[i];
        if (entry?.messageId) {
          const revertResult = await ctx.backend.sessions.revert(
            chatState.backendSessionId,
            entry.messageId,
            undefined,
            directory,
          );
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
        state.outputChannel.appendLine(
          `[handler] Revert failure - creating new session as fallback`,
        );
        const createResult = await ctx.backend.sessions.create({
          directory,
        });
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
      // Rewound to the beginning - no prior message to revert to
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
 * Creates the ChatRequestHandler for the @opencode chat participant.
 *
 * Flow:
 *  1. Check cancellation
 *  2. Route slash command (if present)
 *  3. Check for empty prompt
 *  4. Start OpenCode server if not running
 *  5. Resolve or fork session (handles VSCode rewind)
 *  6. Subscribe to SSE events
 *  7. Send the user prompt
 *  7b. Hook cancellation - abort OpenCode backend
 *  8. Bridge events to VSCode chat stream (with per-edit externalEdit tracking)
 *  9. Record user message ID in turn map
 */
export function createParticipantHandler(
  state: ExtensionState,
  ctx: BackendContext,
): vscode.ChatRequestHandler {
  return async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    let sss: SerializableSessionStream | undefined;
    try {
      // 1. Early cancellation check
      if (token.isCancellationRequested) {
        return { metadata: {} };
      }

      // 2. Slash command routing
      if (request.command) {
        return await routeCommand(request.command, state, ctx, stream, token);
      }

      // 3. Empty prompt check
      if (isEmptyPrompt(request.prompt)) {
        stream.markdown(ErrorMessages.EMPTY_PROMPT);
        return { metadata: {} };
      }

      // 4. Start server if needed
      const ready = await ensureServer(state, ctx, stream);
      if (!ready) {return { metadata: {} };}

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

      const backendSessionId = await resolveSession(state, ctx, context, stream, vscodeSessionId, directory);
      if (!backendSessionId) {return { metadata: {} };}

      aliasSessionState(state, ctx, vscodeSessionId, sessionResourceKey);

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
        const provisionalTitle = request.prompt.length > 60
          ? `${request.prompt.slice(0, 57).trimEnd()}...`
          : request.prompt;
        await applyProvisionalSessionTitle(state, ctx, {
          backendSessionId,
          vscodeSessionId,
          title: provisionalTitle,
          directory,
          updateBackend: true,
          createdAt: activeChatState.createdAt,
        });
        state.outputChannel.appendLine(
          `[handler] Applied provisional first-prompt title: "${provisionalTitle}"`,
        );
      }

      const executeTurnWithBridge = async (): Promise<void> => {
        stream.progress('Connecting to event stream...');
        await ctx.backend.events.ensureStarted();

        // 7. Fire the user prompt WITHOUT awaiting (only once per turn)
        stream.progress('Sending message...');
        state.outputChannel.appendLine(
          `[handler] Prompting session ${backendSessionId} with: ${request.prompt.substring(0, 50)}`,
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
          attachments?: typeof attachments;
        } = {};
        const resolvedAgent = await resolvePromptAgent(state, ctx, directory);
        if (resolvedAgent) {
          promptOptions.agent = resolvedAgent;
        }
        // Resolve model: native VS Code picker -> backend match -> SelectionStore fallback
        const resolvedModel = await resolvePromptModel(request, state, ctx);
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

        const promptPromise = ctx.backend.sessions.prompt(
          backendSessionId,
          promptText,
          directory,
          promptOptions,
        ).then((result: { error?: unknown; data?: unknown }) => {
          if (result.error) {
            state.outputChannel.appendLine(`[handler] Prompt error: ${String(result.error)}`);
          } else {
            state.outputChannel.appendLine('[handler] Prompt accepted by backend');
          }
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Prompt failed';
          state.outputChannel.appendLine(`[handler] Prompt error: ${msg}`);
        });

        // 7b. Cancel - abort OpenCode session + all descendant sessions
        let aborted = false;
        const cancelDisposable = token.onCancellationRequested(() => {
          if (aborted) {return;}
          aborted = true;
          state.outputChannel.appendLine(
            `[handler] Cancellation requested, aborting session ${backendSessionId} and descendants`,
          );
          // Abort the parent session
          ctx.backend.sessions.abort(backendSessionId, directory).then((result: { data?: unknown }) => {
            state.outputChannel.appendLine(
              `[handler] Abort parent result: ${JSON.stringify(result?.data)}`,
            );
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            state.outputChannel.appendLine(`[handler] Abort parent error: ${msg}`);
          });
          // Abort all descendant sessions (children, grandchildren, etc.)
          const descendants = ctx.backend.sessions.descendants(backendSessionId);
          for (const childId of descendants) {
            ctx.backend.sessions.abort(childId, directory).then((result: { data?: unknown }) => {
              state.outputChannel.appendLine(
                `[handler] Abort descendant ${childId} result: ${JSON.stringify(result?.data)}`,
              );
            }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              state.outputChannel.appendLine(`[handler] Abort descendant ${childId} error: ${msg}`);
            });
          }
          if (descendants.length > 0) {
            state.outputChannel.appendLine(
              `[handler] Cascade-abort: ${descendants.length} descendant session(s) [${descendants.join(', ')}]`,
            );
          }
        });

        // Collect known file URIs for new-file detection (once per turn)
        let knownFileUris: string[] = [];
        try {
          knownFileUris = collectOpenFileUris().map(u => u.toString());
        } catch {
          // vscode.workspace.textDocuments may not be available (e.g., test mock)
        }

        // Continuation loop: after subagent tasks complete, the orchestrator needs
        // additional prompts to continue. We reopen the event stream and run the
        // bridge again until no more subagent tasks are detected.
        let userMessageId: string | null = null;
        let needsContinue = true;
        let sessionTitleFromBridge: string | undefined;
        let sessionTitleSourceFromBridge: SessionTitleSource | undefined;
        const liveTurnIndex = activeChatState?.turnMap.length ?? 0;
        let titleUpdateChain: Promise<void> = Promise.resolve();

        // SSS persistence (v2 architecture)
        const workspaceRoot = getWorkspaceDirectory() ?? '';
        state.outputChannel.appendLine(
          `[handler] workspaceRoot="${workspaceRoot}" backend="${ctx.backend.name}" ` +
          `backendSessionId="${backendSessionId}" requestId="${request.id}" turn=${liveTurnIndex}`,
        );
        sss = new SerializableSessionStream(stream, {
          workspaceRoot,
          backendName: ctx.backend.name,
          sessionId: backendSessionId,
          turnIndex: liveTurnIndex,
          requestId: request.id,
          onTitleChanged: (update) => {
            sessionTitleFromBridge = update.title;
            sessionTitleSourceFromBridge = update.source;
            titleUpdateChain = titleUpdateChain
              .catch(() => undefined)
              .then(async () => {
                const applied = await applySessionTitle(state, ctx, {
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
        await sss.initialize();
        state.outputChannel.appendLine(`[handler] SSS initialized`);
        sss.recordFirstPrompt(request.prompt);

        // Push user message before bridge.run (first record of the turn)
        sss.push(new UserPromptSSP({
          text: request.prompt,
          command: request.command,
          partId: `user-${backendSessionId}`,
        }));
        sss.writeMeta({
          id: backendSessionId,
          title: getInitialSessionTitle(vscodeSessionId),
          titleSource: 'placeholder',
          createdAt: new Date().toISOString(),
        });
        state.outputChannel.appendLine(`[handler] UserPromptSSP pushed`);

        try {
          while (needsContinue && !token.isCancellationRequested) {
            state.outputChannel.appendLine(`[handler] bridge run start for session ${backendSessionId}`);
            stream.progress('Waiting for response...');

            const events = ctx.backend.events.openSessionStream(backendSessionId);

            const bridge = ctx.backend.createBridge(backendSessionId, directory);
            (bridge as any).setLogger?.(state.outputChannel);
            bridge.setSSS(sss);
            state.outputChannel.appendLine(`[handler] Bridge created, SSS set`);

            state.outputChannel.appendLine('[handler] bridge.run() starting...');
            await bridge.run(events.stream, token);
            await sss.flush();
            state.outputChannel.appendLine(`[handler] bridge.run() completed.`);

            ctx.backend.events.closeSessionStream(backendSessionId);

            // Capture userMessageId from the first bridge run
            if (!userMessageId) {
              userMessageId = bridge.getUserMessageId();
            }

            // Capture backend-generated session title from the first bridge run.
            if (!sessionTitleFromBridge) {
              const title = bridge.getSessionTitle();
              state.outputChannel.appendLine(
                `[handler] bridge.getSessionTitle() = ${JSON.stringify(title)}`,
              );
              if (title) {
                sessionTitleFromBridge = title;
                sessionTitleSourceFromBridge = bridge.getSessionTitleSource?.() ?? 'backend';
              }
            }

            // After subagent tasks completed, send continuation prompt and loop
            if (bridge.getHadSubagentTasks() && !token.isCancellationRequested) {
              state.outputChannel.appendLine('[handler] Subagent tasks completed - sending continuation prompt');
              await ctx.backend.sessions.prompt(backendSessionId, '', directory);
            } else {
              needsContinue = false;
            }
          }
        } finally {
          cancelDisposable.dispose();
          ctx.backend.events.closeSessionStream(backendSessionId);
          await sss.drain();
          await titleUpdateChain;
          sss.close();
          await sss.flush();
        }

        // 9. Ensure prompt promise settles
        await promptPromise;

        // 10. Record user message ID
        const chatState = ctx.sessions.get(vscodeSessionId);
        state.outputChannel.appendLine(
          `[handler] User message ID for turn: ${!!chatState && !!userMessageId} (${userMessageId})`,
        );
        let wasFirstTurn = false;
        if (chatState && userMessageId) {
          wasFirstTurn = chatState.turnMap.length === 0;
          chatState.turnMap.push({
            vscodeTurn: chatState.turnMap.length,
            messageId: userMessageId,
          });
          state.outputChannel.appendLine(
            `[handler] Recorded turn ${chatState.turnMap.length - 1}: messageID=${userMessageId} (total turns=${chatState.turnMap.length})`,
          );

          // Derive session title from first prompt (matches experimental-session logic)
          if (wasFirstTurn) {
            state.outputChannel.appendLine(
              `[handler] First turn completed for session ${backendSessionId}`,
            );
          }
        }

        // Resolve session title. Priority:
        // 1. Backend auto-generates title (via session.updated event)
        // 2. sessions.get() returns a meaningful title
        // 3. Derive from first prompt + push to backend via sessions.update()
        let resolvedTitle = sessionTitleFromBridge;
        let resolvedTitleSource: SessionTitleSource | undefined = sessionTitleSourceFromBridge;
        if (isProvisionalTitleEcho(resolvedTitle, chatState)) {
          state.outputChannel.appendLine(
            `[handler] Ignoring provisional session title echo: "${resolvedTitle}"`,
          );
          resolvedTitle = undefined;
          resolvedTitleSource = undefined;
        }

        if (!resolvedTitle || isPlaceholderSessionTitle(resolvedTitle)) {
          try {
            const sessionInfo = await ctx.backend.sessions.get(backendSessionId, directory);
            const backendTitle = sessionInfo.data?.title?.trim() ?? '';
            if (isProvisionalTitleEcho(backendTitle, chatState)) {
              state.outputChannel.appendLine(
                `[handler] Ignoring provisional backend title echo: "${backendTitle}"`,
              );
            } else if (backendTitle && !isPlaceholderSessionTitle(backendTitle)) {
              resolvedTitle = backendTitle;
              resolvedTitleSource = 'backend';
              state.outputChannel.appendLine(
                `[handler] Title from sessions.get(): "${backendTitle}"`,
              );
            }
          } catch (err: unknown) {
            state.outputChannel.appendLine(
              `[handler] sessions.get() for title failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Turn-end naming is only reconciliation. Bridge owns raw event title
        // adaptation and SSS writes the live stream metadata.
        const shouldApplyReconciledTitle = !!resolvedTitle
          && !isPlaceholderSessionTitle(resolvedTitle);

        // Persist resolved title across backend/sessionMap/SessionStore.
        if (shouldApplyReconciledTitle) {
          await applySessionTitle(state, ctx, {
            backendSessionId,
            vscodeSessionId,
            title: resolvedTitle,
            directory,
            updateBackend: false,
            overwrite: false,
            source: resolvedTitleSource ?? 'backend',
          });
          state.outputChannel.appendLine(
            `[handler] Applied reconciled session title (${resolvedTitleSource ?? 'backend'}): "${resolvedTitle}"`,
          );
        }

        state.outputChannel.appendLine(`[handler] Refreshing Session list for session ${backendSessionId}`);
        state.bus.emit('session-list-changed', { backendId: ctx.id });
      };

      // 11. Execute turn
      await executeTurnWithBridge();

      // 12. Return metadata for future turn recovery
      return {
        metadata: {
          sessionId: backendSessionId,
          backendSessionId,
          turnMap: ctx.sessions.get(vscodeSessionId)?.turnMap ?? [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      stream.markdown(msg);
      state.outputChannel.appendLine(`[handler] Error: ${msg}`);
      return { metadata: {} };
    } finally {
      // SSS cleanup handled in executeTurnWithBridge's own finally block
    }
  };
}

/**
 * Recursively check if any descendant session (child, grandchild, etc.)
 * of `parentId` is still busy. Used by the bridge's polling callback
 * to prevent premature stop when nested background tasks exist.
 */
async function hasBusyDescendant(
  parentId: string,
  directory: string | undefined,
  visited: Set<string>,
  statuses: Record<string, AcpSessionStatus>,
  childrenFn: (id: string, dir?: string) => Promise<AcpResult<AcpChildSessionInfo[]>>,
): Promise<boolean> {
  if (visited.has(parentId)) {return false;}
  visited.add(parentId);

  const childrenResult = await childrenFn(parentId, directory);
  if (childrenResult.error || !childrenResult.data) {return false;}

  for (const child of childrenResult.data) {
    if (visited.has(child.id)) {continue;}

    const status = statuses[child.id];
    if (status?.type === 'busy') {return true;}

    if (await hasBusyDescendant(child.id, directory, visited, statuses, childrenFn)) {
      return true;
    }
  }
  return false;
}

