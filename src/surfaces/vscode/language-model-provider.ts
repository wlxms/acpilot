/**
 * Native VS Code Language Model Chat Provider for OpenCode.
 *
 * Registers backend models via `vscode.lm.registerLanguageModelChatProvider` so
 * that VS Code's model picker (and any extension using `vscode.lm.selectChatModels`)
 * can discover and target OpenCode models for the
 * `acpilot.opencode` session type.
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
 * state.backend (Backend)
 * ```
 *
 * @module
 */

import * as vscode from 'vscode';
import type { ExtensionState, BackendContext } from '../../types';
import { streamViaProvider } from './streaming-client';
import { providerRegistry } from '../../backendmodels/provider-registry';
import { AuthReader } from '../../backendmodels/auth-reader';

// ---------------------------------------------------------------------------
// Extended model info carrying backend metadata
// ---------------------------------------------------------------------------

/**
 * Language model information enriched with backend routing data.
 * The extra `providerID` field lets us route a chat request
 * to the correct backend model when VS Code invokes `provideLanguageModelChatResponse`.
 */
export interface OpenCodeLanguageModelChatInformation
  extends vscode.LanguageModelChatInformation {
  /** Backend provider ID (e.g. "openai", "anthropic") used for routing */
  readonly providerID: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Vendor identifier used for `vscode.lm.registerLanguageModelChatProvider` */
const VENDOR_ID = 'opencode';

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
 * Create a LanguageModelChatProvider for a specific vendor.
 * Each vendor instance only returns models that belong to it.
 */
export function createLanguageModelChatProvider(
  state: ExtensionState,
  ctx: BackendContext,
  vendorId: string,
): { provider: vscode.LanguageModelChatProvider<OpenCodeLanguageModelChatInformation>; dispose: () => void } {
  const logger = state.outputChannel;
  const onChangeEmitter = new vscode.EventEmitter<void>();

  // Track cached models to avoid unnecessary refresh
  let cachedModels: OpenCodeLanguageModelChatInformation[] = [];

  // Subscribe to bus events that signal model list may have changed.
  // Only react to events from THIS backend's channel.
  const unsubBackendReady = state.bus.on('backend-ready', (e) => {
    if (e.backendId !== ctx.id) {return;}
    onChangeEmitter.fire();
  });

  const unsubSelectionChanged = state.bus.on('selection-changed', (e) => {
    if (e.backendId !== ctx.id) {return;}
    onChangeEmitter.fire();
  });

  // providerID for routing: map vendor name → backend ID
  //   opencode-cli → opencode
  //   opencode-zen → opencode
  const routeProviderID = vendorId.startsWith('opencode-') ? 'opencode' : vendorId;

  const provider: vscode.LanguageModelChatProvider<OpenCodeLanguageModelChatInformation> = {
    onDidChangeLanguageModelChatInformation: onChangeEmitter.event,

    async provideLanguageModelChatInformation(
      _options: vscode.PrepareLanguageModelChatModelOptions,
      _token: vscode.CancellationToken,
    ): Promise<OpenCodeLanguageModelChatInformation[]> {
      try {
        if (!ctx.backend.isRunning()) {
          logger.appendLine(`[lm-provider:${vendorId}] Backend not running — returning cached/empty model list`);
          return cachedModels;
        }

        // Only return models matching THIS vendor
        const all = state.acpModels?.getModelsForExposure() ?? [];
        const entries: OpenCodeLanguageModelChatInformation[] = all
          .filter((r) => r.vendor === vendorId)
          .map((r, i) => ({
            id: `${r.vendor}/${r.modelId}`,
            name: r.displayName,
            // family controls the vendor group name in the model picker
            family: vendorId === 'opencode-zen' ? 'OpenCode Zen' : 'OpenCode CLI',
            version: '1',
            maxInputTokens: r.maxInputTokens,
            maxOutputTokens: r.maxOutputTokens,
            capabilities: r.capabilities,
            isUserSelectable: true,
            isDefault: i === 0 ? true : undefined,
            targetChatSessionType: r.sessionOnly ? ctx.scheme : undefined,
            providerID: routeProviderID,
          }));

        cachedModels = entries;
        // [debug] logger.appendLine(`[lm-provider:${vendorId}] Reported ${cachedModels.length} models`);
        return cachedModels;
      } catch (err) {
        logger.appendLine(`[lm-provider:${vendorId}] Error: ${err instanceof Error ? err.message : String(err)}`);
        return cachedModels;
      }
    },

    async provideLanguageModelChatResponse(
      model: OpenCodeLanguageModelChatInformation,
      messages: readonly vscode.LanguageModelChatRequestMessage[],
      _options: vscode.ProvideLanguageModelChatResponseOptions,
      progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
      token: vscode.CancellationToken,
    ): Promise<void> {
      const bareId = model.id.includes('/') ? model.id.split('/').pop()! : model.id;
      const providerID = model.providerID;

      const providerMeta = providerRegistry.get(providerID);
      if (!providerMeta) {
        error(progress, `Unknown provider "${providerID}"`);
        return;
      }

      // Resolve API key: use "public" for free providers, auth.json for paid ones.
      let apiKey: string | undefined;
      if (isFreeProvider(providerID)) {
        apiKey = 'public';
      } else {
        const authReader = new AuthReader();
        await authReader.load();
        apiKey = authReader.getApiKey(providerID);
      }

      if (!apiKey) {
        error(progress, `No API key configured for provider "${providerID}". Add it via \`opencode /connect ${providerID}\` or set the ${providerID.toUpperCase()}_API_KEY environment variable.`);
        return;
      }

      logger.appendLine(`[lm-provider] Streaming via ${providerMeta.npm} ${providerMeta.baseURL} model="${bareId}"`);

      try {
        await streamViaProvider({
          providerMeta,
          apiKey,
          modelId: bareId,
          messages,
          tools: _options.tools,
          progress,
          token,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[lm-provider] Provider stream error: ${msg}`);
        error(progress, `Provider error: ${msg}`);
      }
    },

    async provideTokenCount(
      _model: OpenCodeLanguageModelChatInformation,
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
      onChangeEmitter.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Register the OpenCode language model chat providers.
 * Registers two vendors (both declared in package.json languageModelChatProviders):
 *   - "opencode"     → models for @opencode only
 *   - "opencode-zen" → models for all targets (Copilot use)
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

  // Create a separate provider instance per vendor owned by this backend,
  // each filtering its own models.
  for (const vendor of ctx.vendors) {
    const { provider, dispose } = createLanguageModelChatProvider(state, ctx, vendor);
    registrations.push(vscode.lm.registerLanguageModelChatProvider(vendor, provider));
    disposables.push(dispose);
    state.outputChannel.appendLine(`[lm-provider:${ctx.id}] Registered LM provider (vendor="${vendor}")`);
  }

  return {
    dispose: () => {
      for (const r of registrations) r.dispose();
      for (const d of disposables) d();
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────

/** Providers that use "public" auth (free tier, no key required) */
function isFreeProvider(providerID: string): boolean {
  return providerID === 'opencode' || providerID === 'ollama';
}

function error(progress: vscode.Progress<vscode.LanguageModelResponsePart>, msg: string): void {
  progress.report(new vscode.LanguageModelTextPart(`❌ ${msg}`));
}
