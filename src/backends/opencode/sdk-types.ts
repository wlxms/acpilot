/**
 * OpenCode SDK v2 type definitions.
 *
 * Moved from src/types/index.ts to keep global types backend-agnostic.
 * Only imported by src/backends/opencode/ and src/opencode/ modules.
 */

import type { OpenCodeEventStream } from './sdk-events';
import type { BackendSessionStatus } from '../../backend/types';

// ===========================================================================
// SDK response wrapper — mirrors the hey-api RequestResult flat shape
// ===========================================================================

export interface SdkResponse<T> {
  data?: T;
  error?: unknown;
}

// ===========================================================================
// Shared response data shapes (extracted from SDK v2 response union types)
// ===========================================================================

export interface SdkSessionData {
  id?: string;
  title?: string;
  time?: { created?: number };
}

export interface SdkProviderModel {
  id: string;
  name?: string;
  providerID?: string;
  capabilities?: Record<string, unknown>;
}

export interface SdkProvider {
  id: string;
  name: string;
  models?: Record<string, SdkProviderModel>;
}

export interface SdkAgentData {
  id?: string;
  name?: string;
  description?: string;
  model?: string | { modelID: string; providerID: string };
  mode?: string;
  hidden?: boolean;
}

export interface SdkConfigData {
  model?: string;
  small_model?: string;
  default_agent?: string;
  disabled_providers?: string[];
  enabled_providers?: string[];
  agent?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}

// ===========================================================================
// SDK message / part shapes (from session.messages() response)
// ===========================================================================

export interface SdkUserMessage {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  agent: string;
  model: { providerID: string; modelID: string };
}

export interface SdkAssistantMessage {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  error?: { name: string; data?: { message?: string } };
}

export type SdkMessage = SdkUserMessage | SdkAssistantMessage;

export interface SdkTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface SdkReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
}

export interface SdkToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  tool: string;
  callID?: string;
  state?: { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string };
}

export interface SdkSubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
}

export type SdkPart = SdkTextPart | SdkReasoningPart | SdkToolPart | SdkSubtaskPart | {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  [key: string]: unknown;
};

// ===========================================================================
// OpenCodeClient — typed contract for the OpenCode SDK v2 client
//
// This interface describes the subset of the SDK v2 OpencodeClient API
// that our codebase actually consumes. The adapter layer bridges between
// this contract and the raw SDK at the architectural boundary (server.ts).
// ===========================================================================

export interface OpenCodeClient {
  session: {
    create(parameters?: {
      directory?: string;
      parentID?: string;
      title?: string;
      agent?: string;
      model?: unknown;
    }): Promise<SdkResponse<SdkSessionData>>;
    get(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<SdkResponse<SdkSessionData>>;
    update(parameters: {
      sessionID: string;
      directory?: string;
      title?: string;
    }): Promise<SdkResponse<SdkSessionData>>;
    prompt(parameters: {
      sessionID: string;
      directory?: string;
      parts?: unknown;
      model?: unknown;
      agent?: string;
    }): Promise<SdkResponse<unknown>>;
    promptAsync(parameters: {
      sessionID: string;
      directory?: string;
      parts?: unknown;
      model?: unknown;
      agent?: string;
    }): Promise<SdkResponse<unknown>>;
    revert(parameters: {
      sessionID: string;
      directory?: string;
      messageID: string;
      partID?: string;
    }): Promise<SdkResponse<unknown>>;
    abort(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<SdkResponse<boolean>>;
    list(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<SdkSessionData[]>>;
    children(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<SdkResponse<Array<{ id?: string; parentID?: string }>>>;
    status(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<Record<string, BackendSessionStatus>>>;
    messages(parameters: {
      sessionID: string;
      directory?: string;
      limit?: number;
    }): Promise<SdkResponse<Array<{ info: SdkMessage; parts: SdkPart[] }>>>;
  };
  global: {
    event(): Promise<OpenCodeEventStream>;
    config: {
      get(options?: Record<string, unknown>): Promise<SdkResponse<SdkConfigData>>;
      update(parameters: { config?: unknown }): Promise<SdkResponse<unknown>>;
    };
  };
  event: {
    subscribe(): Promise<OpenCodeEventStream>;
  };
  app: {
    agents(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<SdkAgentData[]>>;
  };
  config: {
    providers(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<{ providers?: SdkProvider[] }>>;
    get(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<SdkConfigData>>;
    update(parameters?: {
      directory?: string;
      config?: unknown;
    }): Promise<SdkResponse<unknown>>;
  };
  auth: {
    set(parameters: {
      providerID: string;
      auth: { type: string; key?: string; access?: string; refresh?: string; expires?: number };
    }): Promise<SdkResponse<unknown>>;
    remove(parameters: {
      providerID: string;
    }): Promise<SdkResponse<unknown>>;
  };
  permission: {
    reply(parameters: {
      requestID: string;
      directory?: string;
      reply?: 'once' | 'always' | 'reject';
      message?: string;
    }): Promise<SdkResponse<unknown>>;
  };
  question: {
    reply(parameters: {
      requestID: string;
      directory?: string;
      answers?: Array<Array<string>>;
    }): Promise<SdkResponse<boolean>>;
    reject(parameters: {
      requestID: string;
      directory?: string;
    }): Promise<SdkResponse<boolean>>;
  };
}

export interface OpenCodeServerController {
  start(cwd?: string): Promise<string>;
  stop(): Promise<void>;
  getClient(): OpenCodeClient | null;
  getStatus(): 'stopped' | 'starting' | 'running' | 'error';
  isRunning(): boolean;
  getUrl(): string | null;
}
