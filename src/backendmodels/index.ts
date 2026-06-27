/**
 * ACPModels — model registry for ACP backends.
 *
 * Exposes models through LM provider vendors:
 *   - "opencode-cli"  (OpenCode CLI) — ALL models, always, @opencode only
 *   - "opencode-zen"  (OpenCode Zen) — ALL models, only when BMS ON, all targets
 *
 * @module
 */

import * as vscode from 'vscode';
import type { Backend } from '../backend/backend';
import { AuthReader } from './auth-reader';
import { runSync, applyInjections } from './sync-engine';
import { resolve as resolveModel } from './resolver';
import { providerRegistry } from './provider-registry';
import type {
  SyncResult,
  CopilotModelRegistration,
  ResolutionResult,
} from './types';

// ===========================================================================
// Public interface
// ===========================================================================

export interface AcpModels {
  sync(): Promise<void>;
  resolve(copilotVendor: string, copilotModelId: string): ResolutionResult;
  getModelsForExposure(): CopilotModelRegistration[];
  refresh(): Promise<void>;
  dispose(): void;
}

// ===========================================================================
// Factory
// ===========================================================================

export interface CreateAcpModelsOptions {
  backends: Map<string, Backend>;
  authReader: AuthReader;
  logger: vscode.OutputChannel;
  /** When true, also register "opencode-zen" vendor for Copilot use */
  backendModelSupport?: boolean;
}

export function createAcpModels(opts: CreateAcpModelsOptions): AcpModels {
  let lastSync: SyncResult | null = null;
  let copilotModelIds: Set<string> = new Set();

  const { backends, authReader, logger } = opts;
  const bms = opts.backendModelSupport !== false;

  const CLI_DISPLAY = 'OpenCode CLI';
  const ZEN_DISPLAY = 'OpenCode Zen';

  // Models that are OpenCode-specific (not generic proxies).
  // These are the only models that go into the "opencode-zen" vendor when BMS is ON.
  const ZEN_EXCLUSIVE_MODELS = new Set([
    'big-pickle',
    'minimax-m3-free',
    'mimo-v2.5-free',
    'nemotron-3-super-free',
    // Add more OpenCode-native models here as needed
  ]);

  const instance: AcpModels = {
    async sync(): Promise<void> {
      await authReader.load();

      // Cache Copilot-side model IDs for resolve()
      try {
        const cpModels = await enumerateCopilotModels();
        copilotModelIds = new Set(cpModels.map((m) => `${m.vendor}/${m.id}`));
      } catch {
        copilotModelIds = new Set();
      }

      const result = await runSync({ backends, authReader, logger });
      await applyInjections(result.providersToInject, backends, logger);
      lastSync = result;
    },

    resolve(copilotVendor: string, copilotModelId: string): ResolutionResult {
      if (!lastSync) return { kind: 'not-found' };
      return resolveModel(lastSync.allModels, copilotVendor, copilotModelId);
    },

    getModelsForExposure(): CopilotModelRegistration[] {
      if (!lastSync) return [];

      const registrations: CopilotModelRegistration[] = [];
      // Deduplicate by the final LM registration key (vendor/modelId) to avoid
      // registering the same model twice when it appears under multiple providers.
      const seen = new Set<string>();

      for (const model of lastSync.allModels) {
        // Skip models with no backend presence — they cannot be routed
        if (model.backendPresence.length === 0) continue;

        // opencode-cli: one registration per unique modelId
        const cliKey = `opencode-cli/${model.modelId}`;
        if (!seen.has(cliKey)) {
          seen.add(cliKey);
          registrations.push({
            vendor: 'opencode-cli',
            modelId: model.modelId,
            displayName: model.displayName,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            capabilities: model.capabilities,
            sessionOnly: true,
          });
        }

        // opencode-zen: only OpenCode-specific models when BMS is ON
        if (bms && ZEN_EXCLUSIVE_MODELS.has(model.modelId)) {
          const zenKey = `opencode-zen/${model.modelId}`;
          if (!seen.has(zenKey)) {
            seen.add(zenKey);
            registrations.push({
              vendor: 'opencode-zen',
              modelId: model.modelId,
              displayName: model.displayName,
              maxInputTokens: model.maxInputTokens,
              maxOutputTokens: model.maxOutputTokens,
              capabilities: model.capabilities,
              sessionOnly: false,
            });
          }
        }
      }

      // [debug] logger.appendLine(
      //   `[acpmodels] Exposure: ${registrations.length} registrations ` +
      //   `(bms=${bms}, sync=${lastSync.allModels.length})`,
      // );
      return registrations;
    },

    async refresh(): Promise<void> {
      await instance.sync();
    },

    dispose(): void {
      lastSync = null;
      copilotModelIds.clear();
    },
  };

  return instance;
}
