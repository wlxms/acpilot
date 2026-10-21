/**
 * Native VS Code Language Model Chat Provider for backend models.
 *
 * Registers backend models via `vscode.lm.registerLanguageModelChatProvider` so
 * that VS Code's model picker (and any extension using `vscode.lm.selectChatModels`)
 * can discover and target models owned by the active backend.
 *
 * == Architecture ==
 * ```
 * VS Code model picker / lm.selectChatModels({ vendor: 'opencode' })
 *     │
 *     ▼
 * ┌─────────────────────────────────────────────────┐
 * │  LanguageModelChatProvider (this module)         │
 * │  ┌────────────────────────────────────────────┐ │
 * │  │ provideLanguageModelChatInformation()      │ │
 * │  │ → maps BackendModel[] → LanguageModelChatInfo[]│ │
 * │  └────────────────────────────────────────────┘ │
 * │  ┌────────────────────────────────────────────┐ │
 * │  │ provideLanguageModelChatResponse()         │ │
 * │  │ → streams text from backend prompt API     │ │
 * │  └────────────────────────────────────────────┘ │
 * └─────────────────────────────────────────────────┘
 *     │
 *     ▼
 * Backend vendor → BackendModelProvider → BackendPipeline → SSP
 * ```
 *
 * @module
 */

import * as vscode from 'vscode';
import type { ExtensionState, BackendContext } from '../../types';
import { BackendRuntimeChangedError, type BackendRuntimeGuard } from '../../backend/backend';
import { streamBackendChatResponse } from './backend-chat-client';
import { normalizePermissionMode } from '../../backend/types';
import {
  AUTO_MODEL_ID,
  AUTO_MODEL_PROVIDER_ID,
  autoCopilotModelId,
  isAutoCopilotModelId,
} from './model-catalog';

// The lightweight VS Code test shim predates this enum. Keep the runtime
// comparison named while tolerating that older test surface.
const REQUIRED_TOOL_MODE = (
  vscode as typeof vscode & {
    LanguageModelChatToolMode?: typeof vscode.LanguageModelChatToolMode;
  }
).LanguageModelChatToolMode?.Required ?? 2;

// ---------------------------------------------------------------------------
// Extended model info carrying backend metadata
// ---------------------------------------------------------------------------

/**
 * Backend routing metadata is intentionally kept out of the VS Code-facing
 * type. The canonical model id and live catalog are the routing authority.
 */
export type BackendLanguageModelChatInformation = vscode.LanguageModelChatInformation;

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/**
 * `true` if `vscode.lm.registerLanguageModelChatProvider` is available.
 * Guards registration at activation time.
 */
export function hasRegisterLanguageModelChatProvider(): boolean {
  return typeof (vscode.lm as Record<string, unknown>).registerLanguageModelChatProvider === 'function';
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create the LanguageModelChatProvider for one backend vendor.
 */
export function createLanguageModelChatProvider(
  state: ExtensionState,
  ctx: BackendContext,
  providerOptions: { vendorId?: string } = {},
): { provider: vscode.LanguageModelChatProvider<BackendLanguageModelChatInformation>; dispose: () => void } {
  const vendorId = providerOptions.vendorId ?? ctx.vendor;
  const logger = state.outputChannel;
  const onChangeEmitter = new vscode.EventEmitter<void>();

  // Track cached models to avoid unnecessary refresh
  let cachedModels: BackendLanguageModelChatInformation[] = [];

  // Subscribe to bus events that signal model list may have changed.
  // Only react to events from THIS backend's channel.
  const unsubBackendReady = state.bus.on('backend-ready', (e) => {
    if (e.backendId !== ctx.id) {return;}
    cachedModels = [];
    onChangeEmitter.fire();
  });

  const unsubSelectionChanged = state.bus.on('selection-changed', (e) => {
    if (e.backendId !== ctx.id) {return;}
    cachedModels = [];
    onChangeEmitter.fire();
  });

  const unsubModelsChanged = state.bus.on('models-changed', (e) => {
    if (e.backendId !== ctx.id) {return;}
    cachedModels = [];
    onChangeEmitter.fire();
  });

  const provider: vscode.LanguageModelChatProvider<BackendLanguageModelChatInformation> = {
    onDidChangeLanguageModelChatInformation: onChangeEmitter.event,

    async provideLanguageModelChatInformation(
      _options: vscode.PrepareLanguageModelChatModelOptions,
      token: vscode.CancellationToken,
    ): Promise<BackendLanguageModelChatInformation[]> {
      const runtime = captureRuntimeGuard(state, ctx);
      const autoModelFor = (instanceKey: string): BackendLanguageModelChatInformation => ({
        id: autoCopilotModelId(vendorId, instanceKey),
        name: 'Auto',
        family: familyForVendor(vendorId, ctx),
        version: '1',
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        capabilities: { agentMode: true, toolCalling: true },
        isBYOK: true,
        isUserSelectable: true,
        isDefault: true,
        targetChatSessionType: ctx.scheme,
      });
      try {
        assertProviderRequestActive(runtime, token);

        // Auto is the stable entry point for this backend. It is available
        // before the backend starts, so the model picker is never empty merely
        // because startup or model discovery has not completed yet.
        const autoModel = autoModelFor(runtime.instanceKey);
        let entries: BackendLanguageModelChatInformation[] = [];

        // Native catalog entries are only trustworthy for a running backend.
        // A stopped backend can still have a cached snapshot from its previous
        // runtime; do not offer those stale handles alongside Auto.
        if (ctx.backend.isRunning()) {
          if (typeof state.modelCatalog.refresh === 'function') {
            await awaitProviderOperation(
              state.modelCatalog.refresh(workspaceDirectory()),
              runtime,
              token,
            );
          }
          assertProviderRequestActive(runtime, token);
          entries = state.modelCatalog.list()
            .filter((r) => r.vendor === vendorId
              && r.backendId === ctx.id
              && r.backendInstanceKey === runtime.instanceKey)
            .map((r) => ({
              id: r.copilotModelId,
              name: r.displayName,
              family: r.family ?? familyForVendor(vendorId, ctx),
              version: '1',
              maxInputTokens: r.maxInputTokens,
              maxOutputTokens: r.maxOutputTokens,
              capabilities: r.capabilities,
              isBYOK: true,
              isUserSelectable: true,
              targetChatSessionType: ctx.scheme,
            }));
        }

        cachedModels = [autoModel, ...entries];
        logger.appendLine(
          `[lm-provider:${vendorId}] Reported ${cachedModels.length} models `
          + `(auto=true, toolCalling=${cachedModels.filter(model => Boolean(model.capabilities?.toolCalling)).length}, `
          + `backendVendor=${vendorId})`,
        );
        return cachedModels;
      } catch (providerError) {
        // Auto is runtime-independent. Even if discovery is cancelled or the
        // backend runtime is replaced, keep the current vendor's entry point
        // visible so the user can explicitly retry by selecting it.
        logger.appendLine(`[lm-provider:${vendorId}] Error: ${providerError instanceof Error ? providerError.message : String(providerError)}`);
        return [autoModelFor(ctx.instanceKey)];
      }
    },

    async provideLanguageModelChatResponse(
      model: BackendLanguageModelChatInformation,
      messages: readonly vscode.LanguageModelChatRequestMessage[],
      options: vscode.ProvideLanguageModelChatResponseOptions,
      progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
      token: vscode.CancellationToken,
    ): Promise<void> {
      const runtime = captureRuntimeGuard(state, ctx);
      assertRuntimeGuard(runtime);
      const autoSelected = isAutoCopilotModelId(vendorId, model.id, runtime.instanceKey);
      let route = autoSelected
        ? resolveAutoModelRoute(ctx, runtime.instanceKey)
        : resolveModelRoute(state, ctx, vendorId, model, runtime.instanceKey);
      if (!route && autoSelected) {
        const start = ctx.backend.start;
        if (typeof start !== 'function') {
          const message = `Backend "${ctx.displayName}" cannot start from Auto.`;
          error(progress, message);
          throw new Error(message);
        }
        let started: Awaited<ReturnType<NonNullable<BackendContext['backend']['start']>>>;
        try {
          started = await awaitProviderOperation(
            start.call(ctx.backend, workspaceDirectory()),
            runtime,
            token,
          );
        } catch (startError) {
          const message = startError instanceof Error ? startError.message : String(startError);
          error(progress, `Backend start failed: ${message}`);
          throw startError;
        }
        assertProviderRequestActive(runtime, token);
        if (started.error) {
          const message = `Backend start failed: ${String(started.error)}`;
          error(progress, message);
          throw new Error(message);
        }
        if (typeof state.modelCatalog.refresh === 'function') {
          await awaitProviderOperation(
            state.modelCatalog.refresh(workspaceDirectory()),
            runtime,
            token,
          );
        }
        assertProviderRequestActive(runtime, token);
        await ctx.selection?.resolveDefaults?.();
        // No native model is still a valid Auto request: the backend can use
        // its own configured default. The session model provider strips the
        // synthetic identity before prompting.
        route = resolveAutoModelRoute(ctx, runtime.instanceKey) ?? {
          providerID: AUTO_MODEL_PROVIDER_ID,
          modelID: AUTO_MODEL_ID,
        };
      }
      if (!route) {
        const message = `Unable to resolve model "${model.id}" for active backend instance `
          + `"${runtime.instanceKey}" (${ctx.displayName}).`;
        error(progress, message);
        throw new Error(message);
      }
      // ACPilot backends own the Agent tool loop. Copilot may still attach its
      // caller-owned tool definitions when the selected model is used from
      // Agent mode; those tools are intentionally not forwarded because the
      // backend pipeline is the authority for tool execution. Accepting the
      // request keeps the model selectable and lets the backend execute its
      // native tools instead of failing a valid Agent request at the host
      // boundary. Required mode is likewise treated as a backend-owned loop.
      if ((options.tools?.length ?? 0) > 0 || options.toolMode === REQUIRED_TOOL_MODE) {
        logger.appendLine(
          `[lm-provider:${vendorId}] Ignoring ${options.tools?.length ?? 0} Copilot-owned tools; `
            + 'backend pipeline owns tool execution',
        );
      }
      try {
        assertRuntimeGuard(runtime);
        const selection = ctx.selection?.get?.() ?? {};
        await streamBackendChatResponse({
          ctx,
          runtime,
          model: { providerID: route.providerID, modelID: route.modelID },
          messages,
          modelOptions: options.modelOptions === undefined
            ? undefined
            : { ...options.modelOptions },
          purpose: options.modelOptions?.acpilotPurpose === 'title-generation'
            ? 'title-generation'
            : 'chat',
          progress,
          token,
          directory: workspaceDirectory(),
          agent: selection.agent,
          permissionMode: normalizePermissionMode(selection.permissionMode),
          // Native LM responses have no Chat Participant question/permission
          // carousel. Let the backend resolve permission events without
          // waiting for an interaction that Copilot cannot provide.
          allowUserInteraction: false,
          title: 'LM Provider Chat',
          logger,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[lm-provider:${vendorId}] Backend model error: ${msg}`);
        error(progress, `Backend error: ${msg}`);
        throw err;
      }
    },

    async provideTokenCount(
      _model: BackendLanguageModelChatInformation,
      _text: string | vscode.LanguageModelChatRequestMessage,
      _token: vscode.CancellationToken,
    ): Promise<number> {
      // Rough estimate: ~4 chars per token
      if (typeof _text === 'string') {
        return Math.ceil(_text.length / 4);
      }
      const parts = _text.content;
      let len = 0;
      for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
          len += (part as vscode.LanguageModelTextPart).value.length;
        }
      }
      return Math.ceil(len / 4);
    },
  };

  return {
    provider,
    dispose: () => {
      unsubBackendReady();
      unsubSelectionChanged();
      unsubModelsChanged();
      onChangeEmitter.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Register the Agent provider and, when available, the separate Copilot
 * provider for one backend.
 */
export function registerLanguageModelChatProvider(
  state: ExtensionState,
  ctx: BackendContext,
): vscode.Disposable | undefined {
  if (!hasRegisterLanguageModelChatProvider()) {
    state.outputChannel.appendLine('[lm-provider] vscode.lm.registerLanguageModelChatProvider unavailable — skipping');
    return undefined;
  }

  const registrations: vscode.Disposable[] = [];
  const disposables: (() => void)[] = [];

  const { provider, dispose } = createLanguageModelChatProvider(state, ctx, {
    vendorId: ctx.vendor,
  });
  try {
    registrations.push(vscode.lm.registerLanguageModelChatProvider(ctx.vendor, provider));
    disposables.push(dispose);
  } catch (registrationError) {
    // Provider creation subscribes to the application bus and allocates an
    // EventEmitter before VS Code registration runs.  Dispose those resources
    // when registration itself fails, otherwise activation leaks listeners.
    dispose();
    throw registrationError;
  }
  state.outputChannel.appendLine(`[lm-provider:${ctx.id}] Registered LM provider (vendor="${ctx.vendor}")`);


  return {
    dispose: () => {
      for (const r of registrations) {r.dispose();}
      for (const d of disposables) {d();}
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────

function familyForVendor(vendorId: string, ctx: BackendContext): string {
  if (vendorId === 'opencode') {return 'OpenCode';}
  return ctx.displayName;
}

interface ResolvedModelRoute {
  providerID: string;
  modelID: string;
}

/** Resolve Auto to the backend's currently selected default model. */
function resolveAutoModelRoute(
  ctx: BackendContext,
  backendInstanceKey: string,
): ResolvedModelRoute | undefined {
  if (ctx.instanceKey !== backendInstanceKey) {
    return undefined;
  }
  const selected = ctx.selection?.get?.().model;
  if (!selected?.providerID || !selected.modelID) {
    return undefined;
  }
  if (selected.providerID === AUTO_MODEL_PROVIDER_ID && selected.modelID === AUTO_MODEL_ID) {
    return undefined;
  }
  return {
    providerID: selected.providerID,
    modelID: selected.modelID,
  };
}

/**
 * Resolve the backend-native model selector from the canonical VS Code id.
 * The id must identify a current registration owned by this backend/vendor.
 * No provider/model metadata fallback is accepted.
 */
function resolveModelRoute(
  state: ExtensionState,
  ctx: BackendContext,
  vendorId: string,
  model: BackendLanguageModelChatInformation,
  backendInstanceKey: string,
): ResolvedModelRoute | undefined {
  const resolved = state.modelCatalog.resolve(
    ctx.id,
    vendorId,
    model.id,
    backendInstanceKey,
  );
  if (resolved.kind !== 'backend' || resolved.backendId !== ctx.id
    || resolved.backendInstanceKey !== backendInstanceKey
    || !resolved.providerID || !resolved.modelID) {
    return undefined;
  }
  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  };

}

/** Capture the backend instance identity for one native LM request. */
function captureRuntimeGuard(state: ExtensionState, ctx: BackendContext): BackendRuntimeGuard {
  const generation = ctx.runtimeGeneration;
  const instanceKey = ctx.instanceKey;
  return {
    generation,
    instanceKey,
    isCurrent: () => {
      const owner = state.backends?.get(ctx.id);
      return (owner === undefined || owner === ctx)
        && ctx.runtimeGeneration === generation
        && ctx.instanceKey === instanceKey
        && ctx.acceptingRequests !== false;
    },
    onInvalidated: (listener: () => void): (() => void) => state.bus.on(
      'backend-runtime-changing',
      event => {
        if (event.backendId === ctx.id
          && (event.runtimeGeneration > generation || event.instanceKey !== instanceKey)) {
          listener();
        }
      },
    ),
  };
}

function assertRuntimeGuard(runtime: BackendRuntimeGuard): void {
  if (!isRuntimeGuardCurrent(runtime)) {
    throw new Error(
      `Backend runtime changed before the model request started (instance "${runtime.instanceKey}").`,
    );
  }
}

/** Error used only to short-circuit a cancelled model-information request. */
class LanguageModelInformationCancelledError extends Error {
  constructor() {
    super('Language model information request cancelled');
    this.name = 'LanguageModelInformationCancelledError';
  }
}

/** Read a runtime lease defensively; a faulty host guard is treated as stale. */
function isRuntimeGuardCurrent(runtime: BackendRuntimeGuard): boolean {
  try {
    return runtime.isCurrent();
  } catch {
    return false;
  }
}

function assertProviderRequestActive(
  runtime: BackendRuntimeGuard,
  token: vscode.CancellationToken,
): void {
  if (token.isCancellationRequested) {
    throw new LanguageModelInformationCancelledError();
  }
  if (!isRuntimeGuardCurrent(runtime)) {
    throw new BackendRuntimeChangedError(runtime.instanceKey);
  }
}

/**
 * Await a backend operation without letting an obsolete runtime strand the
 * VS Code provider call. The backend promise itself is deliberately not
 * forcefully terminated; the adapter owns any transport-specific cleanup.
 */
async function awaitProviderOperation<T>(
  operation: Promise<T>,
  runtime: BackendRuntimeGuard,
  token: vscode.CancellationToken,
): Promise<T> {
  let tokenDisposable: { dispose(): void } | undefined;
  let runtimeDisposable: (() => void) | undefined;
  let rejectCancellation!: (reason: Error) => void;
  let settled = false;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const rejectOnce = (reason: Error): void => {
    if (settled) {return;}
    rejectCancellation(reason);
  };
  // Attach handlers before listener registration can fail or discover a
  // transition. This keeps a late backend rejection from becoming unhandled
  // when the provider has already returned an invalidation/cancellation.
  const raced = Promise.race([operation, cancellation]);

  try {
    assertProviderRequestActive(runtime, token);
    if (typeof token.onCancellationRequested === 'function') {
      tokenDisposable = token.onCancellationRequested(() => {
        rejectOnce(new LanguageModelInformationCancelledError());
      });
    }
    runtimeDisposable = runtime.onInvalidated?.(() => {
      rejectOnce(new BackendRuntimeChangedError(runtime.instanceKey));
    });
    // A transition may have completed between the initial check and listener
    // registration. Re-check so the operation cannot wait on a stale promise.
    assertProviderRequestActive(runtime, token);

    return await raced;
  } finally {
    settled = true;
    tokenDisposable?.dispose();
    runtimeDisposable?.();
  }
}

function workspaceDirectory(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
}

function error(progress: vscode.Progress<vscode.LanguageModelResponsePart>, msg: string): void {
  progress.report(new vscode.LanguageModelTextPart(`❌ ${msg}`));
}
