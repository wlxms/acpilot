/**
 * ACPModels domain types.
 *
 * Models are normalized to a single identity space so that
 * Copilot-side model references and ACP-backend-side model
 * references can be bidirectionally mapped through a shared
 * provider-configuration table.
 *
 * @module
 */

import type { LanguageModelChatInformation, LanguageModelChatCapabilities } from 'vscode';
import type { BackendModel } from '../backend/types';

// ===========================================================================
// Provider configuration (source of truth: provider-config.json)
// ===========================================================================

/** Static metadata for a single model within a provider */
export interface AcpProviderModelMeta {
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling?: boolean;
  imageInput?: boolean;
}

/** Per-provider configuration entry (agnostic of any specific backend) */
export interface BackendProviderMeta {
  /** Unique identifier for this provider in the registry, e.g. "anthropic" */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** AI SDK npm package used by OpenCode, e.g. "@ai-sdk/openai-compatible" */
  npm: string;
  /** Default API base URL, e.g. "https://api.openai.com/v1" */
  baseURL: string;
  /** Optional dynamic model-discovery endpoint (GET /models style) */
  modelDiscoveryEndpoint?: string;
  /** Static model catalog (offline fallback) */
  models?: Record<string, AcpProviderModelMeta>;
  /** Copilot vendor aliases (multiple Copilot vendor values may map to this provider) */
  copilotVendorAliases?: string[];
  /** Explicit mapping: Copilot modelId → normalized modelId */
  copilotModelIdMap?: Record<string, string>;
  /** Explicit mapping: OpenCode modelId → normalized modelId */
  opencodeModelIdMap?: Record<string, string>;
}

// ===========================================================================
// Normalized model — ACPModels internal "lingua franca"
// ===========================================================================

/** Presence of a model within a specific ACP backend */
export interface BackendModelPresence {
  backendId: string;
  providerID: string;
  modelID: string;
  /** Whether the backend already has an API key for this provider */
  hasKey: boolean;
}

/** A model normalized across Copilot and all ACP backends */
export interface NormalizedModel {
  /** Normalized unique model identifier */
  modelId: string;
  /** The provider meta entry this model belongs to */
  providerMetaId: string;
  displayName: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: LanguageModelChatCapabilities;
  /** Copilot-side info (if present in Copilot's registry) */
  copilotVendor?: string;
  copilotModelId?: string;
  /** Backend presence: which backends have this model, and with what IDs */
  backendPresence: BackendModelPresence[];
}

// ===========================================================================
// Auth entries (mirrors OpenCode's auth.json shape)
// ===========================================================================

export type AcpAuthType = 'api' | 'oauth' | 'wellknown';

export interface BackendAuthEntry {
  type: AcpAuthType;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

// ===========================================================================
// Sync operations
// ===========================================================================

/** Result of injecting a provider for a specific backend */
export interface ProviderInjection {
  backendId: string;
  providerMetaId: string;
  apiKey: string;
  models: Record<string, AcpProviderModelMeta>;
}

/** A model that needs to be registered with Copilot */
export interface CopilotModelRegistration {
  vendor: string;
  modelId: string;
  displayName: string;
  /** Display group in the model picker (e.g. "OpenCode CLI", "OpenCode Zen") */
  family?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: LanguageModelChatCapabilities;
  /** Optional API key for paid models */
  apiKey?: string;
  /** Limit visibility to @opencode session target only */
  sessionOnly?: boolean;
}

/** Aggregate sync result */
export interface SyncResult {
  /** All normalised models (Copilot ∪ all backends) */
  allModels: NormalizedModel[];
  /** Provider injections needed per backend */
  providersToInject: ProviderInjection[];
  /** Models to register with Copilot */
  modelsToRegister: CopilotModelRegistration[];
}

// ===========================================================================
// Resolution (Copilot model → backend route)
// ===========================================================================

export type ResolutionKind = 'backend' | 'passthrough' | 'not-found';

export interface ResolutionResult {
  kind: ResolutionKind;
  backendId?: string;
  providerID?: string;
  modelID?: string;
}

// ===========================================================================
// Copilot-side model reference (lightweight snapshot)
// ===========================================================================

export interface CopilotModelRef {
  vendor: string;
  id: string;
  family?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: LanguageModelChatCapabilities;
}

// ===========================================================================
// Backend extension: auth operations (new contract)
// ===========================================================================

export interface BackendAuthOperations {
  /** Persist an API key for a provider (writes to auth.json via SDK) */
  setKey(providerID: string, key: string): Promise<{ error?: unknown }>;
  /** Remove an API key for a provider */
  removeKey(providerID: string): Promise<{ error?: unknown }>;
  /** Read all stored auth entries */
  getAll(): Promise<Record<string, BackendAuthEntry>>;
}

// ===========================================================================
// Re-export for convenience
// ===========================================================================

export type { BackendModel, LanguageModelChatInformation, LanguageModelChatCapabilities };
