/**
 * ACPModels sync engine — bidirectional model reconciliation.
 *
 * Phase 1: Copilot models → ACP backends
 * Phase 2: ACP backend models → Copilot registration list
 *
 * @module
 */

import * as vscode from 'vscode';
import type { Backend } from '../backend/backend';
import { enumerateCopilotModels } from './copilot-reader';
import { enumerateBackendModels } from './backend-reader';
import { providerRegistry } from './provider-registry';
import { AuthReader } from './auth-reader';
import type {
  NormalizedModel,
  SyncResult,
  ProviderInjection,
  CopilotModelRegistration,
  BackendModelPresence,
} from './types';

// ===========================================================================
// Public API
// ===========================================================================

export interface SyncEngineOptions {
  /** Active ACP backends (keyed by backend ID) */
  backends: Map<string, Backend>;
  /** Auth.json reader (shared) */
  authReader: AuthReader;
  /** Output logger */
  logger: vscode.OutputChannel;
  /**
   * When true, ACP backend-specific models are registered under their own vendor
   * (e.g. "opencode"), while non-specific models are registered under "{backend}-only".
   * When false, all models are registered under "{backend}-only" vendor.
   * Default: true
   */
  backendModelSupport?: boolean;
}

/**
 * Run a full bidirectional sync: enumerate everything, normalise,
 * compute diffs, and return inject + registration instructions.
 */
export async function runSync(opts: SyncEngineOptions): Promise<SyncResult> {
  const { backends, authReader, logger } = opts;

  // ── Phase 1: Enumerate ──────────────────────────────────────
  logger.appendLine('[acpmodels] Enumerating Copilot models...');
  const copilotModels = await enumerateCopilotModels();
  logger.appendLine(`[acpmodels] Copilot: ${copilotModels.length} models across ${uniqueVendors(copilotModels)} vendors`);

  const backendModels: NormalizedModel[] = [];
  for (const [id, backend] of backends) {
    const models = await enumerateBackendModels(backend, (pid) => authReader.hasKey(pid));
    // Tag with backend ID
    for (const m of models) {
      for (const p of m.backendPresence) {
        p.backendId = id;
      }
    }
    backendModels.push(...models);
    logger.appendLine(`[acpmodels] Backend "${id}": ${models.length} models`);
  }

  // ── Phase 2: Normalise and merge ─────────────────────────────
  const allModels = mergeModels(copilotModels, backendModels);

  // ── Phase 3: Compute injections ──────────────────────────────
  const providersToInject = computeInjections(allModels, opts);

  // ── Phase 4: Compute Copilot registrations ───────────────────
  const modelsToRegister = computeRegistrations(allModels, copilotModels);

  logger.appendLine(`[acpmodels] Sync complete: ${allModels.length} total, ${providersToInject.length} injections, ${modelsToRegister.length} registrations`);

  return { allModels, providersToInject, modelsToRegister };
}

/**
 * Execute the provider injections returned by `runSync`.
 * Calls backend.auth.setKey() + backend.config.updateGlobal().
 */
export async function applyInjections(
  injections: ProviderInjection[],
  backends: Map<string, Backend>,
  logger: vscode.OutputChannel,
): Promise<void> {
  for (const inj of injections) {
    const backend = backends.get(inj.backendId);
    if (!backend) continue;

    const meta = providerRegistry.get(inj.providerMetaId);
    if (!meta) continue;

    logger.appendLine(`[acpmodels] Injecting "${inj.providerMetaId}" for backend "${inj.backendId}"`);

    // Step 1: write API key via auth.set
    const keyResult = await backend.auth.setKey(inj.providerMetaId, inj.apiKey);
    if (keyResult.error) {
      logger.appendLine(`[acpmodels]   auth.setKey failed: ${String(keyResult.error)}`);
      continue;
    }

    // Step 2: write provider config via config.updateGlobal
    const modelEntries: Record<string, { name?: string }> = {};
    for (const [mid, mmeta] of Object.entries(inj.models)) {
      modelEntries[mid] = { name: mmeta.name };
    }

    const configResult = await backend.config.updateGlobal({
      provider: {
        [inj.providerMetaId]: {
          api: resolveApiType(meta.npm),
          name: meta.displayName,
          options: meta.baseURL ? { baseURL: meta.baseURL } : undefined,
          models: modelEntries,
        },
      },
    });
    if (configResult.error) {
      logger.appendLine(`[acpmodels]   config.updateGlobal failed: ${String(configResult.error)}`);
    } else {
      logger.appendLine(`[acpmodels]   Provider "${inj.providerMetaId}" injected successfully`);
    }
  }
}

// ===========================================================================
// Internal
// ===========================================================================

function uniqueVendors(models: { vendor: string }[]): number {
  return new Set(models.map((m) => m.vendor)).size;
}

function mergeModels(
  copilotModels: Array<{ vendor: string; id: string; maxInputTokens: number; maxOutputTokens: number; capabilities: vscode.LanguageModelChatCapabilities; family?: string }>,
  backendModels: NormalizedModel[],
): NormalizedModel[] {
  const merged = new Map<string, NormalizedModel>();

  // Index backend models by a composite key
  for (const bm of backendModels) {
    for (const bp of bm.backendPresence) {
      const key = `${bp.backendId}/${bp.providerID}/${bm.modelId}`;
      merged.set(key, { ...bm });
    }
  }

  // Overlay Copilot info onto models where they match
  for (const cm of copilotModels) {
    const meta = providerRegistry.findByCopilotVendor(cm.vendor);
    const providerMetaId = meta?.id ?? cm.vendor;
    const normalizedId = meta
      ? providerRegistry.normalizeCopilotModelId(providerMetaId, cm.id)
      : cm.id;

    // Find matching backend model(s)
    let found = false;
    for (const [key, nm] of merged) {
      if (nm.providerMetaId === providerMetaId && nm.modelId === normalizedId) {
        nm.copilotVendor = cm.vendor;
        nm.copilotModelId = cm.id;
        // Prefer Copilot's token limits if more precise
        if (cm.maxInputTokens > 0) nm.maxInputTokens = Math.max(nm.maxInputTokens, cm.maxInputTokens);
        if (cm.maxOutputTokens > 0) nm.maxOutputTokens = Math.max(nm.maxOutputTokens, cm.maxOutputTokens);
        found = true;
      }
    }

    // If no backend model matched, create a Copilot-only entry
    if (!found) {
      const modelMeta = meta?.models?.[normalizedId];
      merged.set(`copilot/${cm.vendor}/${cm.id}`, {
        modelId: normalizedId,
        providerMetaId,
        displayName: modelMeta?.name ?? cm.id,
        maxInputTokens: modelMeta?.maxInputTokens ?? cm.maxInputTokens,
        maxOutputTokens: modelMeta?.maxOutputTokens ?? cm.maxOutputTokens,
        capabilities: {
          toolCalling: modelMeta?.toolCalling ?? cm.capabilities?.toolCalling,
          imageInput: modelMeta?.imageInput ?? cm.capabilities?.imageInput,
        },
        copilotVendor: cm.vendor,
        copilotModelId: cm.id,
        backendPresence: [],
      });
    }
  }

  return Array.from(merged.values());
}

function computeInjections(
  allModels: NormalizedModel[],
  opts: SyncEngineOptions,
): ProviderInjection[] {
  const injections: ProviderInjection[] = [];
  const seen = new Set<string>();

  for (const model of allModels) {
    if (!model.copilotVendor) continue; // not in Copilot, skip injection

    for (const bp of model.backendPresence) {
      if (bp.hasKey) continue; // already has key

      const key = `${bp.backendId}/${model.providerMetaId}`;
      if (seen.has(key)) continue;

      const apiKey = opts.authReader.getApiKey(model.providerMetaId);
      if (!apiKey) continue;

      const meta = providerRegistry.get(model.providerMetaId);
      if (!meta?.models) continue;

      seen.add(key);
      injections.push({
        backendId: bp.backendId,
        providerMetaId: model.providerMetaId,
        apiKey,
        models: meta.models,
      });
    }
  }

  return injections;
}

function computeRegistrations(
  allModels: NormalizedModel[],
  copilotModels: Array<{ vendor: string; id: string }>,
): CopilotModelRegistration[] {
  const copilotSet = new Set(copilotModels.map((m) => `${m.vendor}/${m.id}`));
  const registrations: CopilotModelRegistration[] = [];

  for (const model of allModels) {
    // Skip models already in Copilot
    if (model.copilotVendor && copilotSet.has(`${model.copilotVendor}/${model.copilotModelId}`)) {
      continue;
    }

    // Only register models that have at least one backend with a key
    const hasBacked = model.backendPresence.some((bp) => bp.hasKey);
    if (!hasBacked && model.backendPresence.length > 0) continue;

    // Determine vendor for Copilot registration
    const meta = providerRegistry.get(model.providerMetaId);
    const vendor = meta?.copilotVendorAliases?.[0] ?? model.providerMetaId;

    registrations.push({
      vendor,
      modelId: model.modelId,
      displayName: model.displayName,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
      sessionOnly: false,
    });
  }

  return registrations;
}

function resolveApiType(npm: string): string {
  if (npm.includes('@ai-sdk/anthropic')) return 'anthropic';
  if (npm.includes('@ai-sdk/openai') && !npm.includes('compatible')) return 'openai';
  if (npm.includes('@ai-sdk/google')) return 'google';
  return 'openai-compatible';
}
