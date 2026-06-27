/**
 * OpenCode backend adapter - concrete Backend implementation.
 *
 * Maps every ACP operation to the OpenCode SDK, reusing
 * OpenCodeServerManager for lifecycle and GlobalEventBroker
 * for event multiplexing. No VSCode imports.
 */

import { OpenCodeServerManager } from '../../opencode/server';
import { GlobalEventBroker } from './event-broker';
import type {
  Backend,
  BackendBridge,
  BackendSessionOperations,
  BackendConfigOperations,
  AcpEventOperations,
  BackendPermissionOperations,
  BackendQuestionOperations,
  AcpEventStream,
  BackendAuthOperations,
} from '../../backend/backend';
import type {
  BackendServerInfo,
  BackendServerStatus,
  BackendSessionInfo,
  BackendSessionStatus,
  BackendModel,
  BackendAgent,
  BackendConfig,
  BackendFileAttachment,
  BackendResult,
  BackendPermissionResponse,
  BackendMessageHistory,
  BackendHistoryMessage,
} from '../../backend/types';
import type { OpenCodeStreamEvent } from './sdk-events';
import type { OpenCodeClient, SdkAgentData } from './sdk-types';
import { OpenCodeBridge } from './opencode-bridge';
import { OpenCodeSettingsProvider } from './settings';

// ===========================================================================
// Helpers
// ===========================================================================

function toAcpSessionInfo(data: { id?: string; title?: string; time?: { created?: number } }): BackendSessionInfo {
  return {
    id: data.id ?? '',
    title: data.title ?? '',
    createdAt: new Date(data.time?.created ?? Date.now()),
  };
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') {
      return record.message;
    }
    if (typeof record.code === 'string') {
      return record.code;
    }
  }

  return fallback;
}

function getResultError(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return (value as Record<string, unknown>).error;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatResultError(value: unknown, fallback: string): string {
  return `${extractErrorMessage(value, fallback)} | raw=${safeStringify(value)}`;
}

// ===========================================================================
// Adapter
// ===========================================================================

export class OpenCodeBackend implements Backend<OpenCodeStreamEvent> {
  readonly name = 'opencode';

  private readonly serverManager = new OpenCodeServerManager();
  private readonly eventBroker = new GlobalEventBroker();
  private rawClient: OpenCodeClient | null = null;

  // =======================================================================
  // Lifecycle
  // =======================================================================

  async start(directory?: string): Promise<BackendResult<BackendServerInfo>> {
    try {
      const url = await this.serverManager.start(directory);
      const rawClient = this.serverManager.getClient();
      if (!rawClient) {
        return { error: 'OpenCode client not available after start' };
      }
      this.rawClient = rawClient;
      return {
        data: {
          url,
          status: 'running',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  }

  async stop(): Promise<void> {
    this.rawClient = null;
    await this.serverManager.stop();
  }

  getStatus(): BackendServerStatus {
    return this.serverManager.getStatus();
  }

  getUrl(): string | null {
    return this.serverManager.getUrl();
  }

  isRunning(): boolean {
    return this.serverManager.isRunning();
  }

  /** @inheritdoc */
  createBridge(sessionId: string, directory?: string): BackendBridge<OpenCodeStreamEvent> {
    return new OpenCodeBridge(this, sessionId, directory);
  }

  // =======================================================================
  // Internal: typed reference to the SDK client
  // =======================================================================

  private get sdk(): OpenCodeClient {
    const c = this.serverManager.getClient();
    if (!c) {throw new Error('Server not running');}
    return c;
  }

  // =======================================================================
  // Sessions
  // =======================================================================

  readonly sessions: BackendSessionOperations = {
    create: async (options?): Promise<BackendResult<BackendSessionInfo>> => {
      try {
        const result = await this.sdk.session.create({
          directory: options?.directory,
          title: options?.title,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session not created') };
        }
        if (!result.data?.id) {
          return { error: 'Session not created' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    get: async (id: string, directory?: string): Promise<BackendResult<BackendSessionInfo>> => {
      try {
        const result = await this.sdk.session.get({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session not found') };
        }
        if (!result.data) {
          return { error: 'Session not found' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    update: async (id: string, options: { title?: string; directory?: string }): Promise<BackendResult<BackendSessionInfo>> => {
      try {
        const result = await this.sdk.session.update({
          sessionID: id,
          directory: options.directory,
          title: options.title,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session update failed') };
        }
        if (!result.data) {
          return { error: 'Session update failed' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    children: async (id: string, directory?: string) => {
      try {
        const result = await this.sdk.session.children({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get children') };
        }
        return {
          data: (result.data ?? []).map(s => ({ id: s.id ?? '', parentID: s.parentID ?? '' })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    status: async (directory?: string) => {
      try {
        const result = await this.sdk.session.status({ directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get session status') };
        }
        return { data: result.data ?? {} };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    prompt: async (
      id: string,
      text: string,
      directory?: string,
      options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        attachments?: BackendFileAttachment[];
      },
    ): Promise<BackendResult<unknown>> => {
      try {
        const parts: unknown[] = [{ type: 'text', text }];

        // Convert file attachments to SDK FilePartInput[] and prepend them
        // so the text part remains the last/user-like part.
        if (options?.attachments?.length) {
          const fileParts = options.attachments.map((att) => ({
            type: 'file' as const,
            mime: att.mime,
            filename: att.filename,
            url: att.url,
          }));
          parts.unshift(...fileParts);
        }

        const result = await this.sdk.session.promptAsync({
          sessionID: id,
          directory,
          parts,
          model: options?.model,
          agent: options?.agent,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: formatResultError(error, 'Prompt failed') };
        }
        return { data: result };
      } catch (err) {
        return {
          error: formatResultError(err, 'Prompt failed'),
        };
      }
    },

    revert: async (id: string, messageId: string, partId?: string, directory?: string): Promise<BackendResult<unknown>> => {
      try {
        const result = await this.sdk.session.revert({
          sessionID: id,
          directory,
          messageID: messageId,
          partID: partId,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Revert failed') };
        }
        return { data: result };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    abort: async (id: string, directory?: string): Promise<BackendResult<boolean>> => {
      try {
        const result = await this.sdk.session.abort({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Abort failed') };
        }
        return { data: result?.data ?? true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    list: async (directory?: string): Promise<BackendResult<BackendSessionInfo[]>> => {
      try {
        const result = await this.sdk.session.list({ directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List sessions failed') };
        }
        return { data: (result.data ?? []).map(toAcpSessionInfo) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    // -- Hierarchy navigation (delegates to GlobalEventBroker) --

    descendants: (parentId: string): string[] => {
      return this.eventBroker.getDescendantSessions(parentId);
    },

    findAncestor: (sessionId: string, candidateIds: Set<string>): string | undefined => {
      return this.eventBroker.findAncestorIn(sessionId, candidateIds);
    },

    parent: (sessionId: string): string | undefined => {
      return this.eventBroker.getParentSession(sessionId);
    },

    messages: async (id: string, directory?: string): Promise<BackendResult<BackendMessageHistory>> => {
      try {
        const result = await this.sdk.session.messages({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get messages') };
        }

        const items = result.data ?? [];
        const mapped: BackendHistoryMessage[] = [];

        for (const item of items) {
          if (item.info.role === 'user') {
            // UserMessage: text is in the parts (type='text')
            const text = item.parts
              .filter((p): p is typeof p & { type: 'text'; text: string } =>
                p.type === 'text' && typeof (p as { text?: unknown }).text === 'string'
              )
              .map(p => p.text)
              .join('\n');
            mapped.push({
              id: item.info.id,
              role: 'user',
              text: text || '(no text)',
            });
          } else if (item.info.role === 'assistant') {
            // AssistantMessage: join text parts, collect tool call summaries
            const textParts: string[] = [];
            const toolCalls: Array<{ toolName: string; callId?: string }> = [];

            for (const part of item.parts) {
              if (part.type === 'text') {
                textParts.push((part as { type: 'text'; text: string }).text);
              } else if (part.type === 'tool') {
                const tp = part as { type: 'tool'; tool: string; callID?: string };
                toolCalls.push({ toolName: tp.tool, callId: tp.callID });
              }
            }

            mapped.push({
              id: item.info.id,
              role: 'assistant',
              text: textParts.join('\n'),
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              metadata: {
                sessionId: item.info.sessionID,
                cost: item.info.cost,
              },
            });
          }
        }

        return { data: { items: mapped } };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // =======================================================================
  // Config
  // =======================================================================

  readonly config: BackendConfigOperations = {
    models: async (directory?: string): Promise<BackendResult<BackendModel[]>> => {
      try {
        const result = await this.sdk.config.providers({ directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List models failed') };
        }
        const providers = result.data?.providers ?? [];
        const models: BackendModel[] = [];
        for (const provider of providers) {
          for (const m of Object.values(provider.models ?? {})) {
            const rawM = m as unknown as Record<string, unknown>;
            const capRecord = rawM.capabilities as Record<string, unknown> | undefined;
            const limitRecord = rawM.limit as Record<string, number> | undefined;
            models.push({
              id: m.id,
              name: m.name ?? m.id,
              provider: provider.id,
              providerName: provider.name,
              capabilities: capRecord
                ? Object.keys(capRecord).filter((k) => Boolean(capRecord[k]))
                : undefined,
              capabilitiesRaw: capRecord,
              maxInputTokens: limitRecord?.context,
              maxOutputTokens: limitRecord?.output,
            });
          }
        }
        return { data: models };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    agents: async (directory?: string): Promise<BackendResult<BackendAgent[]>> => {
      try {
        const result = await this.sdk.app.agents({
          directory,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List agents failed') };
        }
        const agents: BackendAgent[] = (result.data ?? []).map((a: SdkAgentData) => ({
          id: a.id ?? a.name ?? '',
          name: a.name ?? a.id,
          description: a.description,
          model: typeof a.model === 'object' && a.model !== null
            ? (a.model.modelID ?? String(a.model))
            : a.model,
          mode: a.mode as BackendAgent['mode'],
          hidden: a.hidden,
        }));
        return { data: agents };
      } catch (err) {
        return { error: extractErrorMessage(err, 'List agents failed') };
      }
    },

    get: async (directory?: string): Promise<BackendResult<BackendConfig>> => {
      try {
        const configResult = await this.sdk.config.get({
          directory,
        });
        const error = getResultError(configResult);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Get config failed') };
        }
        const raw = configResult.data ?? {};
        const config: BackendConfig = {
          model: raw.model,
          small_model: raw.small_model,
          default_agent: raw.default_agent,
          disabled_providers: raw.disabled_providers,
          enabled_providers: raw.enabled_providers,
          agent: raw.agent as BackendConfig['agent'],
          provider: raw.provider as BackendConfig['provider'],
        };
        return { data: config };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Get config failed') };
      }
    },

    update: async (config: Partial<BackendConfig>, directory?: string): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.config.update({
          directory,
          config,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Update config failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Update config failed') };
      }
    },

    updateGlobal: async (config: Partial<BackendConfig>): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.global.config.update({ config });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Update global config failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Update global config failed') };
      }
    },
  };

  // =======================================================================
  // Settings provider - declarative backend-specific settings UI
  // =======================================================================

  readonly settingsProvider = new OpenCodeSettingsProvider(this.config);

  // =======================================================================
  // Events - delegates raw OpenCode stream multiplexing to GlobalEventBroker
  // =======================================================================

  readonly events: AcpEventOperations<OpenCodeStreamEvent> = {
    openSessionStream: (sessionId: string): AcpEventStream<OpenCodeStreamEvent> => {
      return this.eventBroker.openSessionStream(sessionId);
    },

    openGlobalStream: async (): Promise<AcpEventStream<OpenCodeStreamEvent>> => {
      return await this.sdk.global.event();
    },

    closeSessionStream: (sessionId: string): void => {
      this.eventBroker.closeSessionStream(sessionId);
    },

    ensureStarted: async (): Promise<void> => {
      const c = this.rawClient;
      if (c) {
        await this.eventBroker.ensureStarted(c);
      }
    },
  };

  // =======================================================================
  // Permissions
  // =======================================================================

  readonly permissions: BackendPermissionOperations = {
    reply: async (
      sessionId: string,
      permissionId: string,
      response: BackendPermissionResponse,
      directory?: string,
    ): Promise<void> => {
      const result = await this.sdk.permission.reply({
        requestID: permissionId,
        directory,
        reply: response,
      });
      if (result.error) {
        throw new Error(`Permission reply failed: ${extractErrorMessage(result.error, 'Unknown error')}`);
      }
    },
  };

  // =======================================================================
  // Questions
  // =======================================================================

  readonly questions: BackendQuestionOperations = {
    reply: async (
      sessionId: string,
      requestId: string,
      answers: Array<Array<string>>,
      directory?: string,
    ): Promise<BackendResult<boolean>> => {
      try {
        const result = await this.sdk.question.reply({
          requestID: requestId,
          directory,
          answers,
        });
        if (result.data !== undefined) {
          return { data: true };
        }
        return { error: `Question reply failed: ${JSON.stringify(result.error)}` };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Failed to reply to question') };
      }
    },

    reject: async (
      sessionId: string,
      requestId: string,
      directory?: string,
    ): Promise<BackendResult<boolean>> => {
      try {
        const result = await this.sdk.question.reject({
          requestID: requestId,
          directory,
        });
        if (result.data !== undefined) {
          return { data: true };
        }
        return { error: `Question reject failed: ${JSON.stringify(result.error)}` };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Failed to reject question') };
      }
    },
  };

  // =======================================================================
  // Auth - delegates to v2 SDK auth.set / auth.remove
  // =======================================================================

  readonly auth: BackendAuthOperations = {
    setKey: async (providerID: string, key: string): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.auth.set({
          providerID,
          auth: { type: 'api', key },
        });
        if (result.error) {
          return { error: extractErrorMessage(result.error, 'Auth set failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Auth set failed') };
      }
    },

    removeKey: async (providerID: string): Promise<BackendResult<void>> => {
      try {
        const result = await this.sdk.auth.remove({ providerID });
        if (result.error) {
          return { error: extractErrorMessage(result.error, 'Auth remove failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Auth remove failed') };
      }
    },
  };
}
