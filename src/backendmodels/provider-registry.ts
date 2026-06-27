/**
 * Provider registry — loads the static provider-config.json and provides
 * lookup queries used by the sync engine and resolver.
 *
 * @module
 */

import type { BackendProviderMeta } from './types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('./provider-config.json') as { providers: Record<string, BackendProviderMeta> };

// ===========================================================================
// Registry
// ===========================================================================

class ProviderRegistry {
  private providers: Map<string, BackendProviderMeta> = new Map();
  /** vendor → provider meta id index */
  private copilotVendorIndex: Map<string, string> = new Map();

  constructor() {
    for (const [id, meta] of Object.entries(config.providers)) {
      this.providers.set(id, meta);
      // Index by the provider's own id
      this.copilotVendorIndex.set(id, id);
      // Index aliases
      if (meta.copilotVendorAliases) {
        for (const alias of meta.copilotVendorAliases) {
          this.copilotVendorIndex.set(alias, id);
        }
      }
    }
  }

  /** Look up a provider meta entry by its registry id */
  get(id: string): BackendProviderMeta | undefined {
    return this.providers.get(id);
  }

  /** Find a provider by a Copilot-side vendor name (or alias) */
  findByCopilotVendor(vendor: string): BackendProviderMeta | undefined {
    const metaId = this.copilotVendorIndex.get(vendor);
    return metaId ? this.providers.get(metaId) : undefined;
  }

  /** Return all registered provider meta IDs */
  listIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Iterate over all provider meta entries */
  all(): IterableIterator<BackendProviderMeta> {
    return this.providers.values();
  }

  /**
   * Normalise a Copilot modelId through the provider's explicit mapping.
   * Falls back to the raw modelId if no mapping is defined.
   */
  normalizeCopilotModelId(providerMetaId: string, copilotModelId: string): string {
    const meta = this.providers.get(providerMetaId);
    return meta?.copilotModelIdMap?.[copilotModelId] ?? copilotModelId;
  }

  /**
   * Normalise an OpenCode modelId through the provider's explicit mapping.
   * Falls back to the raw modelId if no mapping is defined.
   */
  normalizeOpenCodeModelId(providerMetaId: string, opencodeModelId: string): string {
    const meta = this.providers.get(providerMetaId);
    return meta?.opencodeModelIdMap?.[opencodeModelId] ?? opencodeModelId;
  }

  /** Look up the static model metadata (token limits, capabilities) for a model within a provider */
  getModelMeta(providerMetaId: string, modelId: string) {
    const meta = this.providers.get(providerMetaId);
    return meta?.models?.[modelId];
  }
}

/** Singleton registry instance */
export const providerRegistry = new ProviderRegistry();
