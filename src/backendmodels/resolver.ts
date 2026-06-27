/**
 * ACPModels resolver — maps a Copilot model (vendor + id) to a
 * concrete ACP backend route (backendId + providerID + modelID).
 *
 * @module
 */

import { providerRegistry } from './provider-registry';
import type { NormalizedModel, ResolutionResult } from './types';

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Resolve a Copilot model reference to the best available backend route.
 *
 * @param allModels  Current sync snapshot (from `runSync()`)
 * @param copilotVendor  Vendor name from `request.model.vendor`
 * @param copilotModelId  Model ID from `request.model.id`
 */
export function resolve(
  allModels: NormalizedModel[],
  copilotVendor: string,
  copilotModelId: string,
): ResolutionResult {
  // Find the provider meta entry for this Copilot vendor
  const meta = providerRegistry.findByCopilotVendor(copilotVendor);
  const providerMetaId = meta?.id ?? copilotVendor;
  const normalizedId = meta
    ? providerRegistry.normalizeCopilotModelId(providerMetaId, copilotModelId)
    : copilotModelId;

  // Search the normalised model set for a matching backend
  for (const model of allModels) {
    if (model.providerMetaId !== providerMetaId) continue;
    if (model.modelId !== normalizedId && model.copilotModelId !== copilotModelId) continue;

    // Prefer backends that already have a key
    const withKey = model.backendPresence.find((bp) => bp.hasKey);
    if (withKey) {
      return {
        kind: 'backend',
        backendId: withKey.backendId,
        providerID: withKey.providerID,
        modelID: withKey.modelID,
      };
    }

    // Fallback: first backend that has the model (even without key)
    const any = model.backendPresence[0];
    if (any) {
      return {
        kind: 'backend',
        backendId: any.backendId,
        providerID: any.providerID,
        modelID: any.modelID,
      };
    }
  }

  // Model exists in Copilot but not in any backend — signal passthrough
  if (meta) {
    return { kind: 'passthrough' as const };
  }

  return { kind: 'not-found' as const };
}
