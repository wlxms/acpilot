/**
 * AcpPipeline — consumes standard ACP `session/update` notifications and
 * translates them into SSS push/update calls.
 *
 * Unlike OpenCodePipeline (which parses a private SSE protocol), this pipeline
 * consumes the official Agent Client Protocol event model directly: it iterates
 * an `ActiveSessionMessage` stream (`session_update` / `stop`) produced by the
 * `@agentclientprotocol/sdk` ActiveSession helper, and maps each `SessionUpdate`
 * to the appropriate SSP.
 *
 * Mapping (ACP SessionUpdate.sessionUpdate → SSP):
 *   agent_message_chunk  → AssistantTextSSP
 *   agent_thought_chunk  → ReasoningSSP
 *   tool_call            → ToolInvocationSSP (created)
 *   tool_call_update     → ToolInvocationSSP (updated)
 *   session_info_update  → SessionLifecycleSSP / title update
 *   plan / plan_update   → ignored until a dedicated SSP semantic is defined
 *   stop (PromptResponse)→ flush / idle
 *
 * @module
 */

import type { BackendPipeline, BackendPipelineOptions, BackendPipelineResult, BackendPipelineStream, BackendPipelineToken } from '../../backend/backend';
import type { PermissionMode } from '../../backend/types';
import type { SessionStreamNode } from '../../backend/streaming/session-stream-node';
import type {
  ActiveSessionMessage,
  SessionUpdate,
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import path from 'node:path';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { QuestionSSP } from '../../ssp/impl/question';
import { resolveToolCallPath } from './filepath-resolver';

interface PipelineLogger { appendLine(message: string): void; }

/** Minimal text-content extraction from an ACP ContentBlock. */
function textFromContent(content: ContentBlock | undefined): string {
  if (!content) {return '';}
  if (content.type === 'text') {return content.text ?? '';}
  return '';
}

export class AcpPipeline implements BackendPipeline<ActiveSessionMessage> {
  protected readonly sss: BackendPipelineStream;
  protected readonly directory?: string;
  protected logger: PipelineLogger = { appendLine: () => {} };
  protected readonly sessionId: string;
  protected readonly permissionMode: PermissionMode;
  private readonly allowUserInteraction: boolean;

  /** ACP may echo the user message identity in user_message_chunk updates. */
  private userMessageId: string | null = null;
  private sessionTitle: string | null = null;
  private sessionTitleSource: 'backend' | null = null;
  /** Timestamp-based IDs can collide when an agent emits several chunks in one turn. */
  private nextPartSequence = 0;

  /** toolCallId → persisted stream-part id (ToolInvocationSSP uses callId as its id). */
  private readonly toolTargets = new Map<string, string>();
  /**
   * ACP tool updates may omit `status` when they only replace content/title.
   * Keep the last translated lifecycle state so a partial update cannot move
   * a completed tool back to `running`.
   */
  private readonly toolStatuses = new Map<string, ToolLifecycleStatus>();
  /** toolCallId → ExternalEditSSP id for permission-gated file edits. */
  private readonly externalEditTargets = new Map<string, string>();
  /** Baseline callbacks may be registered before or after a bridge edit is rendered. */
  private readonly externalEditBaselineStates = new Map<string, { captured: boolean; callbacks: Set<() => void> }>();

  constructor(options: BackendPipelineOptions) {
    this.sessionId = options.sessionId;
    this.directory = options.directory;
    this.permissionMode = options.permissionMode ?? 'approval';
    this.allowUserInteraction = options.allowUserInteraction !== false;
    this.sss = options.stream;
    if (options.logger) {
      this.logger = options.logger;
    }
  }

  /** Specialized ACP backends may defer the generic tool card until a side channel supplies its presentation. */
  protected shouldDeferToolCall(_update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): boolean {
    return false;
  }

  /** Specialized pipelines can flush side-channel state before a turn closes. */
  protected beforeStop(): void {
    // Base ACP has no delayed side-channel state.
  }

  async resolvePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }

    // ACP agents ask the client immediately before sensitive operations. In
    // read-only mode reject mutating/exec requests before creating an SSP so
    // the policy cannot be bypassed by a backend-specific permission UI.
    if (this.permissionMode === 'read-only'
      && !isReadOnlyAcpTool(params.toolCall.kind)) {
      this.logger.appendLine(`[acp-pipeline] Rejected ${params.toolCall.kind ?? 'unknown'} tool in read-only mode`);
      return { outcome: { outcome: 'cancelled' } };
    }

    if (this.permissionMode === 'read-only') {
      const option = selectAutomaticPermissionOption(params.options);
      if (option) {
        this.logger.appendLine(`[acp-pipeline] Automatically allowed ${params.toolCall.kind ?? 'unknown'} in read-only mode`);
        return selectedPermissionResponse(option.optionId);
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    const automaticResponse = (this.permissionMode === 'full-edit' || !this.allowUserInteraction)
      ? automaticPermissionResponse(params.options)
      : undefined;
    const filePaths = resolveToolCallPaths(params.toolCall, this.directory);

    if (!this.sss) {
      return { outcome: { outcome: 'cancelled' } };
    }
    if (filePaths.length === 0) {
      if (automaticResponse) {
        const mode = this.permissionMode === 'full-edit' ? 'full-edit' : 'non-interactive LM';
        this.logger.appendLine(`[acp-pipeline] Automatically allowed ${params.toolCall.kind ?? 'unknown'} in ${mode}`);
        return automaticResponse;
      }
      if (!this.allowUserInteraction) {
        this.logger.appendLine(`[acp-pipeline] Rejected ${params.toolCall.kind ?? 'unknown'}: no allow option for non-interactive LM`);
        return { outcome: { outcome: 'cancelled' } };
      }
      return this.requestPermissionChoice(params);
    }

    return await new Promise<RequestPermissionResponse>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (response: RequestPermissionResponse) => {
        if (settled) {return;}
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        resolve(response);
      };

      this.ensureExternalEdit(params.toolCall, filePaths, () => {
        if (automaticResponse) {
          const mode = this.permissionMode === 'full-edit' ? 'full-edit' : 'non-interactive LM';
          this.logger.appendLine(`[acp-pipeline] Automatically allowed ${params.toolCall.kind ?? 'unknown'} in ${mode} after baseline`);
          settle(automaticResponse);
        } else if (!this.allowUserInteraction) {
          this.logger.appendLine(`[acp-pipeline] Rejected ${params.toolCall.kind ?? 'unknown'}: no allow option for non-interactive LM`);
          settle({ outcome: { outcome: 'cancelled' } });
        } else {
          void this.requestPermissionChoice(params).then(settle);
        }
      });

      timeout = setTimeout(() => settle({ outcome: { outcome: 'cancelled' } }), 30_000);
      // A synchronous renderer may capture the baseline during push(), before
      // the timeout is assigned. Avoid leaving that timer alive after settle.
      if (settled) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    });
  }

  /**
   * Start one ExternalEditSSP for a permission-gated file operation. The
   * baseline callback is the barrier before an allow response is returned.
   */
  protected ensureExternalEdit(
    toolCall: RequestPermissionRequest['toolCall'],
    filePaths: string[],
    onBaselineCaptured: () => void,
  ): boolean {
    const toolCallId = toolCall.toolCallId;
    const existingId = this.externalEditTargets.get(toolCallId);
    if (existingId) {
      const state = this.externalEditBaselineStates.get(toolCallId);
      if (state?.captured) {
        queueMicrotask(onBaselineCaptured);
      } else {
        state?.callbacks.add(onBaselineCaptured);
      }
      return false;
    }
    if (filePaths.length === 0) {return false;}

    const externalEditId = `external-edit-${toolCallId}`;
    const state = { captured: false, callbacks: new Set<() => void>() };
    state.callbacks.add(onBaselineCaptured);
    this.externalEditTargets.set(toolCallId, externalEditId);
    this.externalEditBaselineStates.set(toolCallId, state);

    this.sss.push(new ExternalEditSSP(
      {
        toolCallId,
        editId: '',
        status: 'pending',
        ...(filePaths.length > 1 ? { uris: filePaths } : { uri: filePaths[0] }),
      },
      {
        onBaselineCaptured: () => {
          state.captured = true;
          const callbacks = [...state.callbacks];
          state.callbacks.clear();
          for (const callback of callbacks) {callback();}
        },
      },
      {
        sessionId: this.sessionId,
        toolCallId,
        uri: filePaths[0],
      },
      externalEditId,
      this.directory,
    ));
    return true;
  }

  protected clearExternalEditTracking(toolCallId: string): void {
    this.externalEditTargets.delete(toolCallId);
    this.externalEditBaselineStates.delete(toolCallId);
  }

  private requestPermissionChoice(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise(resolve => {
      const questionId = `permission-${params.toolCall.toolCallId}`;
      this.sss.push(new QuestionSSP(
        {
          questionId,
          questions: [{
            id: 'q_0',
            header: 'Permission',
            question: params.toolCall.title ?? 'Allow this tool call?',
            options: params.options.map(option => ({
              label: permissionOptionLabel(option.kind),
              value: option.optionId,
            })),
            custom: false,
          }],
          status: 'asked',
        },
        {
          onResult: result => {
            const selected = getSelectedPermissionOption(result);
            const option = params.options.find(candidate => candidate.optionId === selected);
            resolve(option && option.kind.startsWith('allow')
              ? selectedPermissionResponse(option.optionId)
              : { outcome: { outcome: 'cancelled' } });
          },
          onSkip: () => resolve({ outcome: { outcome: 'cancelled' } }),
        },
        { sessionId: params.sessionId, toolCallId: params.toolCall.toolCallId },
        questionId,
      ));
    });
  }

  /**
   * Consume an `ActiveSessionMessage` stream until a `stop` message arrives.
   * Each `session_update` is mapped to an SSP push/update on the SSS.
   */
  async run(
    events: AsyncIterable<ActiveSessionMessage>,
    token: BackendPipelineToken,
  ): Promise<BackendPipelineResult> {
    let completed = false;
    const log = (m: string) => this.logger.appendLine(`[acp-pipeline] ${m}`);
    try {
      for await (const message of events) {
        if (token.isCancellationRequested) {break;}
        if (message.kind === 'stop') {
          this.beforeStop();
          log(`turn stopped: stopReason=${message.stopReason}`);
          completed = isSuccessfulStopReason(message.stopReason);
          this.handleStop(message.stopReason);
          break;
        }
        this.handleSessionUpdate(message.update, message.notification.sessionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      log(`error: ${msg}`);
    }
    return {
      completed: completed && !token.isCancellationRequested,
      userMessageId: this.userMessageId,
      sessionTitle: this.sessionTitle,
      sessionTitleSource: this.sessionTitleSource,
      hadSubagentTasks: false,
    };
  }

  protected handleSessionUpdate(update: SessionUpdate, eventSessionId: string | null | undefined): void {
    const target: SessionStreamNode = this.sss;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textFromContent(update.content);
        if (!text) {break;}
        const messageId = update.messageId ?? undefined;
        target.push(new AssistantTextSSP({
          partId: this.createPartId('msg', messageId),
          delta: text,
          messageId: messageId ?? undefined,
          sessionId: eventSessionId ?? this.sessionId,
        }));
        break;
      }
      case 'agent_thought_chunk': {
        const text = textFromContent(update.content);
        if (!text) {break;}
        const messageId = update.messageId ?? undefined;
        target.push(new ReasoningSSP({
          partId: this.createPartId('thought', messageId),
          delta: text,
          messageId: messageId ?? undefined,
          sessionId: eventSessionId ?? this.sessionId,
        }));
        break;
      }
      case 'tool_call': {
        // Create a new tool invocation part.
        const toolCallId = update.toolCallId;
        const toolName = update.title ?? 'tool';
        const status = toToolLifecycleStatus(update.status) ?? 'running';
        this.toolStatuses.set(toolCallId, status);
        // Keep the map value identical to the SSP id. ACP emits later
        // tool_call_update messages keyed by toolCallId, while the persisted
        // part uses a namespaced id to avoid collisions with other SSP kinds.
        const partId = `tool-${toolCallId}`;
        this.toolTargets.set(toolCallId, toolCallId);
        if (this.shouldDeferToolCall(update)) {
          break;
        }
        target.push(new ToolInvocationSSP({
          partId,
          toolName,
          callId: toolCallId,
          state: {
            status,
            input: (update.rawInput as Record<string, unknown>) ?? {},
            title: update.title,
          },
          sessionId: eventSessionId ?? this.sessionId,
        }));
        break;
      }
      case 'tool_call_update': {
        const externalEditId = this.externalEditTargets.get(update.toolCallId);
        if (externalEditId && (update.status === 'completed' || update.status === 'failed')) {
          target.update(externalEditId, {
            status: update.status === 'failed' ? 'error' : 'completed',
            error: update.status === 'failed' ? toolOutputToText(update) : undefined,
          });
          this.clearExternalEditTracking(update.toolCallId);
        }

        const partId = this.toolTargets.get(update.toolCallId);
        if (!partId) {
          // Update for an unknown tool call — create implicitly.
          const implicitPartId = `tool-${update.toolCallId}`;
          this.toolTargets.set(update.toolCallId, update.toolCallId);
          const implicitStatus = toToolLifecycleStatus(update.status) ?? 'running';
          this.toolStatuses.set(update.toolCallId, implicitStatus);
          const output = toolOutputToText(update);
          target.push(new ToolInvocationSSP({
            partId: implicitPartId,
            toolName: update.title ?? 'tool',
            callId: update.toolCallId,
            state: {
              status: implicitStatus,
              input: (update.rawInput as Record<string, unknown>) ?? {},
              title: update.title ?? undefined,
              output,
              error: update.status === 'failed' ? output : undefined,
            },
            sessionId: eventSessionId ?? this.sessionId,
          }));
          break;
        }
        const status = toToolLifecycleStatus(update.status)
          ?? this.toolStatuses.get(update.toolCallId)
          ?? 'running';
        this.toolStatuses.set(update.toolCallId, status);
        const nextState: Record<string, unknown> = { status };
        if (update.rawInput !== undefined) {
          nextState.input = (update.rawInput as Record<string, unknown>) ?? {};
        }
        if (update.rawOutput !== undefined || update.content !== undefined) {
          nextState.output = toolOutputToText(update);
        }
        if (update.title !== undefined && update.title !== null) {
          nextState.title = update.title;
        }
        if (status === 'error') {
          nextState.error = toolOutputToText(update);
        }
        target.update(partId, {
          state: nextState,
        });
        break;
      }
      case 'session_info_update': {
        if (update.title) {
          const title = this.sss.updateTitle(update.title, 'backend', { provisional: false });
          if (title) {
            this.sessionTitle = title;
            this.sessionTitleSource = 'backend';
          }
        }
        break;
      }
      case 'plan':
      case 'plan_update':
      case 'plan_removed':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'usage_update':
        // These updates have no dedicated SSP semantic yet. Do not persist raw
        // protocol payloads as an implicit compatibility format.
        break;
      case 'user_message_chunk':
        if (!this.userMessageId && update.messageId) {
          this.userMessageId = update.messageId;
        }
        // User prompts are recorded by the Copilot integration; this protocol
        // echo has no additional SSP record.
        break;
      default:
        break;
    }
  }

  private createPartId(prefix: string, messageId?: string): string {
    this.nextPartSequence += 1;
    return `${prefix}-${messageId ?? 'turn'}-${this.nextPartSequence}`;
  }

  private handleStop(stopReason: string): void {
    // Turn boundary: record lifecycle idle (SSP has no idle kind; meta status
    // carries the turn-complete signal for restore).
    this.sss.writeMeta({
      status: isSuccessfulStopReason(stopReason) ? 'completed' : 'failed',
    });
  }
}

function resolveToolCallPaths(
  toolCall: RequestPermissionRequest['toolCall'],
  directory?: string,
): string[] {
  const candidates = [
    resolveToolCallPath(toolCall.rawInput),
    ...(toolCall.locations ?? []).map(location => location.path),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(candidates)].map(value => path.isAbsolute(value)
    ? value
    : path.resolve(directory ?? '', value));
}

function isReadOnlyAcpTool(kind: string | null | undefined): boolean {
  return kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch';
}

/**
 * ACP's stop reason is part of the protocol result, not merely a transport
 * sentinel. Only normal/resource-limit stops represent a usable completed
 * turn; cancellation, refusal, and unknown future reasons must remain
 * unsuccessful so Copilot does not record a false success.
 */
function isSuccessfulStopReason(reason: string): boolean {
  return reason === 'end_turn'
    || reason === 'max_tokens'
    || reason === 'max_turn_requests';
}

type ToolLifecycleStatus = 'pending' | 'running' | 'completed' | 'error';

/** Translate the ACP status union into the SSP tool lifecycle vocabulary. */
function toToolLifecycleStatus(value: unknown): ToolLifecycleStatus | undefined {
  switch (value) {
    case 'pending': return 'pending';
    case 'in_progress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'error';
    default: return undefined;
  }
}

function selectedPermissionResponse(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

function automaticPermissionResponse(
  options: readonly RequestPermissionRequest['options'][number][],
): RequestPermissionResponse | undefined {
  const option = selectAutomaticPermissionOption(options);
  return option ? selectedPermissionResponse(option.optionId) : undefined;
}

function selectAutomaticPermissionOption(
  options: readonly RequestPermissionRequest['options'][number][],
): RequestPermissionRequest['options'][number] | undefined {
  // Keep the permission mode request-scoped. Selecting allow_always would
  // persist a backend-side grant that could outlive a later switch to approval.
  return options.find(option => option.kind === 'allow_once')
    ?? options.find(option => option.kind === 'allow_always');
}

function permissionOptionLabel(kind: string): string {
  if (kind === 'allow_always') {return 'Always allow';}
  if (kind.startsWith('allow')) {return 'Allow once';}
  return 'Reject';
}

function getSelectedPermissionOption(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {return undefined;}
  const answer = (result as Record<string, unknown>).q_0;
  if (typeof answer === 'string') {return answer;}
  if (!answer || typeof answer !== 'object') {return undefined;}
  const value = (answer as Record<string, unknown>).selectedValue;
  return typeof value === 'string' ? value : undefined;
}

function toolOutputToText(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>): string | undefined {
  if (typeof update.rawOutput === 'string') {return update.rawOutput;}
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    try {return JSON.stringify(update.rawOutput);}
    catch {return String(update.rawOutput);}
  }
  if (Array.isArray(update.content)) {
    const text = update.content
      .map(item => {
        if (item.type === 'content' && item.content.type === 'text') {return item.content.text;}
        if (item.type === 'diff') {return `Diff ${item.path}`;}
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}
