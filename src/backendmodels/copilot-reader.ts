/**
 * Copilot model reader — enumerates all models registered in VS Code's
 * language-model registry and normalises them for ACPModels.
 *
 * @module
 */

import * as vscode from 'vscode';
import type { CopilotModelRef } from './types';

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Enumerate ALL models currently registered in VS Code's language-model API
 * across every vendor. Returns an empty array if the LM API is unavailable.
 */
export async function enumerateCopilotModels(): Promise<CopilotModelRef[]> {
  if (!isLmApiAvailable()) return [];

  try {
    const models = await vscode.lm.selectChatModels();
    return (models ?? []).map(toCopilotModelRef);
  } catch {
    return [];
  }
}

/**
 * Return Copilot models filtered to a specific vendor.
 */
export async function enumerateCopilotModelsForVendor(vendor: string): Promise<CopilotModelRef[]> {
  const all = await enumerateCopilotModels();
  return all.filter((m) => m.vendor === vendor);
}

// ===========================================================================
// Helpers
// ===========================================================================

function isLmApiAvailable(): boolean {
  return typeof (vscode.lm as Record<string, unknown>).selectChatModels === 'function';
}

function toCopilotModelRef(m: vscode.LanguageModelChat): CopilotModelRef {
  return {
    vendor: (m as unknown as { vendor?: string }).vendor ?? 'unknown',
    id: m.id,
    family: m.family,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {},
  };
}
