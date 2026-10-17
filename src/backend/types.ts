/**
 * Backend domain types — shared contracts across all backend adapters.
 *
 * These are backend-agnostic abstractions (models, sessions, agents, config,
 * settings) that every backend adapter implements. Per-backend protocol event
 * shapes live with their adapters rather than here, so backends don't leak
 * their private event shapes into the shared layer. No VSCode or SDK imports
 * allowed.
 */

// ===========================================================================
// Server lifecycle
// ===========================================================================

export type BackendServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface BackendServerInfo {
  url: string | null;
  status: BackendServerStatus;
}

// ===========================================================================
// Models / providers
// ===========================================================================

export interface BackendModel {
  id: string;
  name?: string;
  /** Provider ID (used for API calls) */
  provider?: string;
  /** Human-readable provider name (used for UI only) */
  providerName?: string;
  /** Nested capability info: `input.image` indicates vision support */
  capabilitiesRaw?: Record<string, unknown>;
  /** Max input / context tokens (from SDK `limit.context`) */
  maxInputTokens?: number;
  /** Max output tokens (from SDK `limit.output`) */
  maxOutputTokens?: number;
  /** Effective API endpoint used by an ordinary Copilot LLM request. */
  apiBaseURL?: string;
  /** Provider wire protocol hint (openai-compatible, anthropic, google). */
  apiKind?: 'openai-compatible' | 'anthropic' | 'google';
  /** In-memory credential supplied by the backend runtime, never persisted in the catalog. */
  apiKey?: string;
}

export interface BackendProvider {
  id: string;
  name: string;
  models: BackendModel[];
}

// ===========================================================================
// Sessions
// ===========================================================================

export interface BackendSessionInfo {
  id: string;
  title: string;
  createdAt: Date;
}

export type BackendSessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number };

export interface BackendChildSessionInfo {
  id: string;
  parentID?: string;
}

export interface BackendTurnMapping {
  turnIndex: number;
  messageId: string;
}

// ===========================================================================
// Prompt attachments
// ===========================================================================

/**
 * A file attachment included with a prompt (image, document, etc.).
 * Protocol-agnostic - each backend adapter maps this to its SDK type.
 */
export interface BackendFileAttachment {
  /** MIME type (e.g. "image/png", "text/plain", "application/pdf") */
  mime: string;
  /** Optional display filename */
  filename?: string;
  /**
   * URL pointing to the file content.
   * May be a `file://` URI for local files or a `data:` URI for inline content.
   */
  url: string;
}

// ===========================================================================
// Result wrapper
// ===========================================================================

export interface BackendResult<T, E = string> {
  data?: T;
  error?: E;
}

// ===========================================================================
// Message history (for session history restoration)
// ===========================================================================

export interface BackendHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Extracted text content (from parts for user, or joined text parts for assistant) */
  text: string;
  /** Tool call summaries for assistant messages */
  toolCalls?: Array<{ toolName: string; callId?: string }>;
  metadata?: Record<string, unknown>;
}

export interface BackendMessageHistory {
  items: BackendHistoryMessage[];
}

// ===========================================================================
// Permission responses
// ===========================================================================

export type BackendPermissionResponse = 'once' | 'always' | 'reject';

/** Permission scope selected for the next Agent request. */
export type PermissionMode = 'full-edit' | 'approval' | 'read-only';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'approval';

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'full-edit' || value === 'approval' || value === 'read-only'
    ? value
    : DEFAULT_PERMISSION_MODE;
}

// ===========================================================================
// Agents
// ===========================================================================

export interface BackendAgent {
  id: string;
  name?: string;
  description?: string;
  model?: string | { modelID: string; providerID: string };
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
}

/**
 * Returns true if an agent should appear in user-selectable pickers.
 * Excludes hidden agents and subagent-mode agents so users only see
 * agents they can intentionally invoke.
 */
export function isUserSelectableAgent(agent: BackendAgent): boolean {
  return !agent.hidden && agent.mode !== 'subagent';
}

// ===========================================================================
// Configuration
// ===========================================================================

export interface BackendAgentConfig {
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  tools?: Record<string, boolean>;
  disable?: boolean;
  description?: string;
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
  steps?: number;
  maxSteps?: number;
}

export interface BackendProviderConfig {
  api?: string;
  name?: string;
  id?: string;
  options?: {
    apiKey?: string;
    baseURL?: string;
  };
  models?: Record<string, { name?: string }>;
}

export interface BackendConfig {
  model?: string;
  small_model?: string;
  default_agent?: string;
  disabled_providers?: string[];
  enabled_providers?: string[];
  agent?: Record<string, BackendAgentConfig>;
  provider?: Record<string, BackendProviderConfig>;
}

export interface BackendModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

// ===========================================================================
// Backend Settings Descriptor (pluggable settings UI)
// ===========================================================================

export interface TextField {
  type: 'text';
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
}

export interface SelectField {
  type: 'select';
  key: string;
  label: string;
  description?: string;
  options: Array<{ value: string; label: string }>;
}

export interface ToggleField {
  type: 'toggle';
  key: string;
  label: string;
  description?: string;
}

export interface InfoCardsField {
  type: 'info-cards';
  key: string;
  items: Array<{
    title: string;
    details: Array<{ label: string; value: string }>;
  }>;
}

/**
 * A map field: each item gets the same set of sub-fields.
 * Values are stored as: { [mapKey]: { [itemId]: { [subFieldKey]: value } } }
 */
export interface MapField {
  type: 'map';
  key: string;
  label: string;
  description?: string;
  items: Array<{ id: string; label: string; description?: string }>;
  fields: Array<TextField | SelectField | ToggleField>;
}

export type SettingsField = TextField | SelectField | ToggleField | InfoCardsField | MapField;

export interface SettingsFieldGroup {
  key: string;
  title?: string;
  description?: string;
  collapsible?: boolean;
  fields: SettingsField[];
}

export interface BackendSettingsTab {
  id: string;
  title: string;
  groups: SettingsFieldGroup[];
}

export interface BackendSettingsDescriptor {
  tabs: BackendSettingsTab[];
  values: Record<string, unknown>;
}
