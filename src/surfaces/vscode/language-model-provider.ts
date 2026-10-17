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
  let cachedRuntime: { generation: number; instanceKey: string } | undefined;

  // Subscribe to bus events that signal model list may have changed.
  // Only react to events from THIS backend's channel.
  const unsubBackendReady = state.bus.on('backend-ready', (e) => {
    if (e.backendId !== ctx.id) {return;}
    cachedModels = [];
    cachedRuntime = undefined;
    onChangeEmitter.fire();
  });

  const unsubSelectionChanged = state.bus.on('selection-changed', (e) => {
    if (e.backendId !== ctx.id) {return;}
    cachedModels = [];
    cachedRuntime = undefined;
    onChangeEmitter.fire();
  });

  const unsubModelsChanged = state.bus.on('models-changed', (e) => {
    if (e.backendId !== ctx.id) {return;}
    cachedModels = [];
    cachedRuntime = undefined;
    onChangeEmitter.fire();
  });

  const provider: vscode.LanguageModelChatProvider<BackendLanguageModelChatInformation> = {
    onDidChangeLanguageModelChatInformation: onChangeEmitter.event,

    async provideLanguageModelChatInformation(
      _options: vscode.PrepareLanguageModelChatModelOptions,
      token: vscode.CancellationToken,
    ): Promise<BackendLanguageModelChatInformation[]> {
      const runtime = captureRuntimeGuard(state, ctx);
      try {
        assertProviderRequestActive(runtime, token);
        if (!ctx.backend.isRunning()) {
          // Model information is the first entry point for a native picker.
          // Backends such as Reasonix are intentionally lazy, so waiting for a
          // chat participant before starting them would leave a valid vendor
          // permanently empty in Copilot's model picker.
          const start = ctx.backend.start;
          if (typeof start !== 'function') {
            logger.appendLine(`[lm-provider:${vendorId}] Backend is stopped and cannot be started`);
            clearBackendCatalog();
            return [];
          }
          let started: Awaited<ReturnType<NonNullable<BackendContext['backend']['start']>>>;
          try {
            started = await awaitProviderOperation(
              start.call(ctx.backend, workspaceDirectory()),
              runtime,
              token,
            );
          } catch (startError) {
            // A failed lazy start leaves the backend stopped. Clear the
            // central catalog as well as the provider cache so an old model
            // handle cannot resolve against the dead runtime.
            // Cancellation and runtime invalidation are control flow, not a
            // failed startup; preserve the existing catalog in that case.
            if (!(startError instanceof LanguageModelInformationCancelledError)
              && isRuntimeGuardCurrent(runtime)) {
              clearBackendCatalog();
            }
            throw startError;
          }
          assertProviderRequestActive(runtime, token);
          if (started.error) {
            logger.appendLine(`[lm-provider:${vendorId}] Backend start failed: ${String(started.error)}`);
            clearBackendCatalog();
            return [];
          }
        }

        // Refresh after a lazy start so the provider exposes the backend's
        // current catalog, including ACP session-discovered models.
        if (typeof state.modelCatalog.refresh === 'function') {
          await awaitProviderOperation(
            state.modelCatalog.refresh(workspaceDirectory()),
            runtime,
            token,
          );
        }
        assertProviderRequestActive(runtime, token);

        // Only return models matching THIS vendor AND belonging to THIS backend.
        // The catalog tags every registration with its owning backend id;
        // filtering by ctx.id keeps backend vendor namespaces isolated.
        const all = state.modelCatalog.list();
        const entries: BackendLanguageModelChatInformation[] = all
          .filter((r) => r.vendor === vendorId
            && r.backendId === ctx.id
            && r.backendInstanceKey === runtime.instanceKey)
          .map((r, i) => ({
            id: r.copilotModelId,
            name: r.displayName,
            // family controls the vendor group name in the model picker
            family: r.family ?? familyForVendor(vendorId, ctx),
            version: '1',
            maxInputTokens: r.maxInputTokens,
            maxOutputTokens: r.maxOutputTokens,
            capabilities: r.capabilities,
            // This is a backend-owned model exposed through VS Code's
            // language-model API. Marking it as BYOK lets Copilot include
            // non-Copilot vendors in its Agent model pool.
            isBYOK: true,
            isUserSelectable: true,
            isDefault: i === 0 ? true : undefined,
            targetChatSessionType: ctx.scheme,
          }));

        cachedModels = entries;
        cachedRuntime = { generation: runtime.generation, instanceKey: runtime.instanceKey };
        logger.appendLine(
          `[lm-provider:${vendorId}] Reported ${cachedModels.length} models `
          + `(toolCalling=${cachedModels.filter(model => Boolean(model.capabilities?.toolCalling)).length}, `
          + `backendVendor=${vendorId})`,
        );
        return cachedModels;
      } catch (providerError) {
        if (providerError instanceof LanguageModelInformationCancelledError) {
          return [];
        }
        logger.appendLine(`[lm-provider:${vendorId}] Error: ${providerError instanceof Error ? providerError.message : String(providerError)}`);
        // A transition invalidates the old catalog. Never hand a picker a
        // model list from the previous ACP target while the replacement is
        // starting; VS Code will re-query after the ready/change event.
        if (!isRuntimeGuardCurrent(runtime)
          || cachedRuntime?.generation !== runtime.generation
          || cachedRuntime?.instanceKey !== runtime.instanceKey) {
          return [];
        }
        return cachedModels;
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
      const route = resolveModelRoute(state, ctx, vendorId, model, runtime.instanceKey);
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

  function clearBackendCatalog(): void {
    // A failed lazy start is commonly retried by VS Code after the provider
    // reports a change.  Do not publish another change when this backend has
    // already been removed from the catalog: doing so creates a feedback
    // loop (onDidChange -> provider query -> failed start -> onDidChange) and
    // needlessly invalidates in-flight catalog refreshes.
    const hadCachedModels = cachedModels.length > 0;
    const hadCatalogModels = state.modelCatalog.list().some(
      model => model.backendId === ctx.id,
    );
    cachedModels = [];
    cachedRuntime = undefined;
    if (!hadCachedModels && !hadCatalogModels) {
      return;
    }
    state.modelCatalog.clearBackend?.(ctx.id);
    state.bus.emit('models-changed', { backendId: ctx.id });
  }

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
