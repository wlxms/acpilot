/**
 * ACP backend model reader — enumerates models from a given Backend
 * and normalises them into the ACPModels internal representation.
 *
 * @module
 */

import type { Backend } from '../backend/backend';
import type { BackendModel } from '../backend/types';
import type { NormalizedModel, BackendModelPresence } from './types';
import type { LanguageModelChatCapabilities } from 'vscode';

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Enumerate all models from a single ACP backend and normalise them.
 *
 * @param backend      The ACP backend instance (e.g. OpenCode)
 * @param hasKeyFn     Callback that returns `true` if the given provider has an API key
 */
export async function enumerateBackendModels(
  backend: Backend,
  hasKeyFn: (providerID: string) => boolean,
): Promise<NormalizedModel[]> {
  const result = await backend.config.models();
  if (result.error || !result.data) return [];

  return (result.data as BackendModel[]).map((m) =>
    toNormalizedModel(backend, m, hasKeyFn),
  );
}

// ===========================================================================
// Internal
// ===========================================================================

function toNormalizedModel(
  backend: Backend,
  acp: BackendModel,
  hasKeyFn: (providerID: string) => boolean,
): NormalizedModel {
  const providerID = acp.provider ?? 'default';
  const modelID = acp.id;
  const rawCaps = acp.capabilitiesRaw as Record<string, unknown> | undefined;

  const capabilities: LanguageModelChatCapabilities = {
    toolCalling: rawCaps?.toolcall === true ? true : undefined,
    imageInput: hasImageCap(rawCaps) || undefined,
  };

  const presence: BackendModelPresence = {
    backendId: backend.name,
    providerID,
    modelID,
    hasKey: hasKeyFn(providerID),
  };

  return {
    modelId: modelID,
    providerMetaId: providerID,
    displayName: acp.name ?? modelID,
    maxInputTokens: acp.maxInputTokens ?? 128_000,
    maxOutputTokens: acp.maxOutputTokens ?? 16_384,
    capabilities,
    backendPresence: [presence],
  };
}

function hasImageCap(caps?: Record<string, unknown>): boolean {
  if (!caps) return false;
  const input = caps.input as Record<string, unknown> | undefined;
  if (input && typeof input.image === 'boolean') return input.image;
  if (typeof caps.attachment === 'boolean') return caps.attachment;
  return false;
}
