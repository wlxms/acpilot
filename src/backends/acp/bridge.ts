/**
 * AcpBridge — consumes standard ACP `session/update` notifications and
 * translates them into SSS push/update calls.
 *
 * Unlike OpenCodeBridge (which projects a private SSE protocol), this bridge
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
 *   plan / plan_update   → (logged, not yet rendered)
 *   stop (PromptResponse)→ flush / idle
 *
 * @module
 */

import type { BackendBridge } from '../../backend/backend';
import type { SerializableSessionStream } from '../../backend/streaming/session-stream';
import type { SessionStreamNode } from '../../backend/streaming/session-stream-node';
import type {
  ActiveSessionMessage,
  SessionUpdate,
  ContentBlock,
} from '@agentclientprotocol/sdk';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { SessionLifecycleSSP } from '../../ssp/impl/session-lifecycle';

interface BridgeLogger { appendLine(message: string): void; }

/** Minimal text-content extraction from an ACP ContentBlock. */
function textFromContent(content: ContentBlock | undefined): string {
  if (!content) {return '';}
  if (content.type === 'text') {return content.text ?? '';}
  return '';
}

export class AcpBridge implements BackendBridge<ActiveSessionMessage> {
  private sss!: SerializableSessionStream;
  protected logger: BridgeLogger = { appendLine: () => {} };
  protected readonly sessionId: string;

  /** toolCallId → root stream key (for tool invocation update correlation). */
  private readonly toolTargets = new Map<string, string>();

  constructor(
    sessionId: string,
  ) {
    this.sessionId = sessionId;
  }

  setSSS(sss: unknown): void {
    this.sss = sss as SerializableSessionStream;
  }

  setLogger(logger: BridgeLogger): void {
    this.logger = logger;
  }

  getUserMessageId(): string | null { return null; }
  getSessionTitle(): string | null { return null; }
  getHadSubagentTasks(): boolean { return false; }

  /**
   * Consume an `ActiveSessionMessage` stream until a `stop` message arrives.
   * Each `session_update` is mapped to an SSP push/update on the SSS.
   */
  async run(
    events: AsyncIterable<ActiveSessionMessage>,
    token: { isCancellationRequested: boolean },
  ): Promise<boolean> {
    const log = (m: string) => this.logger.appendLine(`[acp-bridge] ${m}`);
    try {
      for await (const message of events) {
        if (token.isCancellationRequested) {break;}
        if (message.kind === 'stop') {
          log(`turn stopped: stopReason=${message.stopReason}`);
          this.handleStop();
          break;
        }
        this.handleSessionUpdate(message.update, message.notification.sessionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      log(`error: ${msg}`);
    }
    return !token.isCancellationRequested;
  }

  private handleSessionUpdate(update: SessionUpdate, eventSessionId: string | null | undefined): void {
    const target: SessionStreamNode = this.sss;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textFromContent(update.content);
        if (!text) {break;}
        const messageId = update.messageId ?? undefined;
        target.push(new AssistantTextSSP({
          partId: `msg-${messageId ?? Date.now()}`,
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
          partId: `thought-${messageId ?? Date.now()}`,
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
        const partId = `tool-${toolCallId}`;
        this.toolTargets.set(toolCallId, partId);
        target.push(new ToolInvocationSSP({
          partId,
          toolName,
          callId: toolCallId,
          state: {
            status: 'running',
            input: (update.rawInput as Record<string, unknown>) ?? {},
            title: update.title,
          },
          sessionId: eventSessionId ?? this.sessionId,
        }));
        break;
      }
      case 'tool_call_update': {
        const partId = this.toolTargets.get(update.toolCallId);
        if (!partId) {
          // Update for an unknown tool call — create implicitly.
          this.toolTargets.set(update.toolCallId, `tool-${update.toolCallId}`);
          target.push(new ToolInvocationSSP({
            partId: `tool-${update.toolCallId}`,
            toolName: update.title ?? 'tool',
            callId: update.toolCallId,
            state: {
              status: 'running',
              input: (update.rawInput as Record<string, unknown>) ?? {},
              title: update.title ?? undefined,
            },
            sessionId: eventSessionId ?? this.sessionId,
          }));
          break;
        }
        const status = update.status === 'completed' ? 'completed'
          : update.status === 'failed' ? 'error'
          : 'running';
        target.update(partId, {
          state: {
            status,
            input: (update.rawInput as Record<string, unknown>) ?? {},
            output: typeof update.content === 'string' ? update.content : undefined,
            title: update.title,
            error: update.status === 'failed' ? update.content : undefined,
          },
        });
        break;
      }
      case 'session_info_update': {
        if (update.title) {
          target.writeMeta?.({ title: update.title });
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
      case 'user_message_chunk':
        // Logged but not yet rendered as SSP.
        break;
      default:
        break;
    }
  }

  private handleStop(): void {
    // Turn boundary: record lifecycle idle (SSP has no idle kind; meta status
    // carries the turn-complete signal for restore).
    this.sss.writeMeta({ status: 'completed' });
  }
}
