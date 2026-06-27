/**
 * OpenCodeBridge - translates raw OpenCode events to SSP push/update calls.
 *
 * Architecture (v2):
 * - Bridge does NOT touch the VS Code stream directly; SSS owns it
 * - Bridge only calls sss.push(ssp) / sss.update(id, data)
 * - SubagentManager stays in bridge for scope tracking
 * - Child session events route to sss.subsession(id)
 * - Permission/Question handled via SSP callback injection
 *
 * Replaces the old 1763-line bridge that directly called stream APIs.
 */

import type {
  AcpEvent,
  AcpPartUpdatedEvent,
  AcpPartDeltaEvent,
  AcpPermissionRequestEvent,
  AcpQuestionRequestEvent,
  AcpQuestionInfo,
  AcpTextPart,
  AcpToolPart,
  AcpToolState,
} from '../../backend/types';
import type { BackendBridge } from '../../backend/backend';
import type {
  OpenCodeEvent,
  OpenCodeStreamEvent,
  StreamPart,
  StreamToolState,
} from './sdk-events';

/**
 * Internal event shape the bridge consumes after projecting raw OpenCode
 * events. This is a bridge-private concern: raw OpenCode events are the only
 * input (rawEvent → projection here → SSS). The shared AcpEvent type is kept
 * only because downstream serialization still references some sub-shapes; it
 * is no longer the persistence format (SSP is).
 */
type OpenCodeBridgeEvent = AcpEvent;
import type { SerializableSessionStream } from '../../backend/streaming/session-stream';
import type { SubsessionStream } from '../../backend/streaming/subsession-stream';
import type { SessionStreamNode } from '../../backend/streaming/session-stream-node';
import type { SspStream } from '../../ssp/types';
import type { SessionTitleSource } from '../../backend/serializable/types';
import { SubagentManager, formatSubagentProgress, type SubagentScope } from '../../ssp/impl/subagent';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { QuestionSSP } from '../../ssp/impl/question';
import { SessionLifecycleSSP } from '../../ssp/impl/session-lifecycle';
import { generateSessionTitleWithVsCodeLm } from '../../participant/title-generator';
import { isPlaceholderSessionTitle } from '../../participant/session-title';
import {
  ChatQuestion,
  ChatQuestionType,
  type ChatSimpleToolResultData,
  type ChatToolInvocationPart,
} from '../../types/vscode-proposed-additions';
import type { Backend } from '../../backend/backend';
import path from 'node:path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEventSessionId(event: AcpEvent): string | undefined {
  const e = event as unknown as Record<string, unknown>;
  return (e.sessionId as string | undefined) ??
    (e.part as { sessionId?: string } | undefined)?.sessionId;
}

function createExternalEditUri(filePath: string, directory?: string): unknown {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(directory ?? '', filePath);
  const rawUri = vscode.Uri.file(resolvedPath);
  const normalizedPath = /^\/[a-zA-Z]:(?=\/)/.test(rawUri.path)
    ? rawUri.path.toLowerCase()
    : rawUri.path;
  return rawUri.path !== normalizedPath
    ? rawUri.with({ path: normalizedPath })
    : rawUri;
}

function isSubagentProgressTitleUpdate(state: Partial<AcpToolState>): boolean {
  const keys = Object.keys(state);
  return keys.length === 1 && keys[0] === 'title' && typeof state.title === 'string';
}

interface SystemNotice {
  title: string;
  output: string;
}

type ProposedOpenCodeVscode = typeof vscode & {
  ChatToolInvocationPart?: new (
    toolName: string,
    toolCallId: string,
    errorMessage?: string,
  ) => ChatToolInvocationPart;
};

const OpenCodeVS = vscode as ProposedOpenCodeVscode;

class OpenCodeSystemNoticeToolSSP extends ToolInvocationSSP {
  override render(stream: SspStream): void {
    const callId = this.payload.callId ?? this.payload.partId;
    const title = this.payload.state.title ?? this.payload.toolName;
    const output = this.payload.state.output ?? '';
    const ToolInvocationPartCtor = OpenCodeVS.ChatToolInvocationPart;

    if (ToolInvocationPartCtor && stream.push) {
      const part = new ToolInvocationPartCtor(title, callId);
      part.enablePartialUpdate = true;
      part.isAttachedToThinking = true;
      part.isComplete = true;
      part.pastTenseMessage = title;
      part.toolSpecificData = {
        input: title,
        output,
      } satisfies ChatSimpleToolResultData;
      stream.push(part);
      return;
    }

    stream.beginToolInvocation?.(callId, title, { isAttachedToThinking: true });
    stream.updateToolInvocation?.(callId, {
      pastTenseMessage: title,
      invocationMessage: title,
      isAttachedToThinking: true,
    });
  }
}

function getSystemNotice(part: AcpTextPart): SystemNotice | undefined {
  return getSystemNoticeFromText(part.text);
}

function getSystemNoticeFromText(text: string | undefined): SystemNotice | undefined {
  const value = text ?? '';
  if (!value || !hasClosedSystemReminder(value)) return undefined;
  return {
    title: extractBracketTitle(value) ?? 'SYSTEM REMINDER',
    output: value,
  };
}

function hasClosedSystemReminder(text: string): boolean {
  return /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/i.test(text);
}

function hasOpenSystemReminder(text: string | undefined): boolean {
  return /<system-reminder\b[^>]*>/i.test(text ?? '');
}

function extractBracketTitle(text: string): string | undefined {
  const match = text.match(/\[([^\]\r\n]+)\]/);
  const title = match?.[1]?.trim();
  return title || undefined;
}

// ---------------------------------------------------------------------------
// OpenCodeBridge
// ---------------------------------------------------------------------------

interface BridgeLogger { appendLine(message: string): void; }

type PartRouteKind = 'text' | 'reasoning' | 'ignored' | 'pendingSystemNotice' | 'systemNotice';
type StreamablePartKind = 'text' | 'reasoning';

interface StreamNodeState {
  userMessageId: string | null;
  assistantStarted: boolean;
  partRoutes: Map<string, PartRouteKind>;
  pendingDeltas: Map<string, AcpPartDeltaEvent[]>;
  deltaText: Map<string, string>;
}

export class OpenCodeBridge implements BackendBridge<OpenCodeStreamEvent> {
  private sss!: SerializableSessionStream;
  protected logger: BridgeLogger = { appendLine: () => {} };
  protected readonly sessionId: string;

  // Event state
  protected userMessageId: string | null = null;
  protected partTargets = new Map<string, SessionStreamNode>();
  protected nodeStates = new WeakMap<SessionStreamNode, StreamNodeState>();
  protected sessionTitle: string | undefined;
  protected sessionTitleSource: SessionTitleSource | undefined;
  protected hadSubagentTasks = false;
  protected pendingChildEvents = new Map<string, AcpEvent[]>();
  protected childSessionHints = new Map<string, string>();
  protected targetLabels = new WeakMap<SessionStreamNode, string>();
  protected externalEditIds = new Set<string>();

  // Subagent management
  protected subagents = new SubagentManager();

  // Deferred idle
  protected deferredIdle = false;
  protected static readonly DEFERRED_IDLE_TIMEOUT_MS = 120_000;
  protected deferredIdleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly backend: Backend<unknown>,
    sessionId: string,
    private readonly directory?: string,
    options?: { sessionId?: string },
  ) {
    this.sessionId = options?.sessionId ?? sessionId;
  }

  setSSS(sss: unknown): void {
    this.sss = sss as SerializableSessionStream;
    this.targetLabels.set(this.sss, `root sessionID=${this.sessionId}`);
  }

  setLogger(logger: BridgeLogger): void {
    this.logger = logger;
    this.log = (msg: string) => logger.appendLine(`[bridge] ${msg}`);
  }

  private log: (msg: string) => void = () => {};
  private logTag(tag: string, msg: string): void { this.log(`[${tag}] ${msg}`); }

  // ---------------------------------------------------------------------------
  // Event loop — consumes raw OpenCode events directly.
  //
  // The bridge projects each raw OpenCodeStreamEvent into the internal
  // OpenCodeBridgeEvent (AcpEvent) shape inline, then dispatches to handlers.
  // Projection is a bridge-private concern; there is no shared intermediate
  // event layer across backends.
  // ---------------------------------------------------------------------------

  async run(events: AsyncIterable<OpenCodeStreamEvent>, token: { isCancellationRequested: boolean }): Promise<boolean> {
    try {
      for await (const rawEvent of events) {
        if (token.isCancellationRequested) break;
        const projected = projectOpenCodeStreamEvent(rawEvent);
        for (const event of projected) {
          if (await this.handleEvent(event)) break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      this.log(`bridge error: ${msg}`);
    }
    return !token.isCancellationRequested;
  }

  /**
   * Consume an already-projected AcpEvent stream (no raw-event projection).
   * Used only by the deprecated {@link OpenCodeProtocolBridge} restore path
   * (Phase 4b will remove it). Live turns use {@link run} with raw events.
   */
  async runWithProjected(events: AsyncIterable<AcpEvent>, token: { isCancellationRequested: boolean }): Promise<boolean> {
    try {
      for await (const event of events) {
        if (token.isCancellationRequested) break;
        if (await this.handleEvent(event)) break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      this.log(`bridge error: ${msg}`);
    }
    return !token.isCancellationRequested;
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  private async handleEvent(event: AcpEvent): Promise<boolean | undefined> {
    // 1. Check if this is a child/descendant session event
    const eventSessionId = getEventSessionId(event);
    if (eventSessionId && eventSessionId !== this.sessionId) {
      this.logTag('route', `child -> ${this.describeEvent(event)}`);
      this.handleChildSessionEvent(event, eventSessionId);
      return;
    }

    // 2. Parent session events
    this.logTag('route', `root -> ${this.describeEvent(event)}`);
    switch (event.type) {
      case 'part.updated':       this.handlePartUpdated(event); break;
      case 'part.delta':         this.handlePartDelta(event); break;
      case 'permission.asked':   this.handlePermissionAsked(event); break;
      case 'question.asked':     this.handleQuestionAsked(event); break;
      case 'session.updated':    await this.handleSessionUpdated(event); break;
      case 'session.created':    this.handleSessionCreated(event); break;
      case 'session.idle':       return this.handleSessionIdle();
      case 'session.diff':       this.handleSessionDiff(event); break;
      case 'session.status':     break; // log only
      default:                   break;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Append-only: text / reasoning deltas always push
  // ---------------------------------------------------------------------------

  private handlePartDelta(event: AcpPartDeltaEvent): void {
    if (!event.delta) return;
    this.renderDeltaToTarget(event, this.sss);
  }

  private handlePartUpdated(event: AcpPartUpdatedEvent): void {
    this.handlePartUpdatedForTarget(event, this.sss, true);
  }

  private handlePartUpdatedForTarget(
    event: AcpPartUpdatedEvent,
    target: SessionStreamNode,
    captureRootUserMessage: boolean,
  ): void {
    const part = event.part;
    const nodeState = this.getNodeState(target);
    this.logTag('route', `part.updated target=${this.describeTarget(target)} captureRootUser=${captureRootUserMessage} part=${this.describePart(part)} eventSession=${event.sessionId ?? '<none>'}`);
    switch (part.type) {
      case 'text': {
        // Skip if already routed; part.updated fires again at completion
        // with the full accumulated text; deltas already rendered the content.
        const existingRoute = nodeState.partRoutes.get(part.id);
        if (existingRoute) {
          this.partTargets.set(part.id, target);
          this.logTag('route', `part.updated duplicate text partID=${part.id} target=${this.describeTarget(target)} action=keep-existing-route`);
          if (existingRoute === 'pendingSystemNotice') {
            const systemNotice = getSystemNotice(part);
            if (systemNotice) {
              nodeState.partRoutes.set(part.id, 'systemNotice');
              nodeState.pendingDeltas.delete(part.id);
              this.pushSystemNoticeTool(target, part, systemNotice, event.sessionId);
              this.logTag('route', `text system notice completed partID=${part.id} title="${systemNotice.title}" target=${this.describeTarget(target)}`);
            }
            return;
          }
          if (existingRoute === 'ignored' || existingRoute === 'systemNotice') {
            return;
          }
          this.renderAssistantText(target, {
            partId: part.id,
            text: '',
            messageId: part.messageId,
            sessionId: event.sessionId ?? part.sessionId,
            isComplete: true,
          }, `text complete partID=${part.id}`);
          return;
        }
        const systemNotice = getSystemNotice(part);
        if (systemNotice) {
          nodeState.partRoutes.set(part.id, 'systemNotice');
          this.partTargets.set(part.id, target);
          nodeState.pendingDeltas.delete(part.id);
          this.pushSystemNoticeTool(target, part, systemNotice, event.sessionId);
          this.logTag('route', `text system notice partID=${part.id} title="${systemNotice.title}" target=${this.describeTarget(target)}`);
          return;
        }
        if (hasOpenSystemReminder(part.text)) {
          nodeState.partRoutes.set(part.id, 'pendingSystemNotice');
          this.partTargets.set(part.id, target);
          nodeState.pendingDeltas.delete(part.id);
          this.logTag('route', `text pending system notice partID=${part.id} target=${this.describeTarget(target)}`);
          return;
        }
        if (part.ignored === true) {
          nodeState.partRoutes.set(part.id, 'ignored');
          this.partTargets.set(part.id, target);
          nodeState.pendingDeltas.delete(part.id);
          this.logTag('route', `text ignored partID=${part.id} messageID=${part.messageId ?? '<none>'} target=${this.describeTarget(target)}`);
          return;
        }
        // User echo detection: before assistant output starts, the first text
        // message belongs to the user. Restored or user-echo-less streams may
        // begin directly with assistant text, so do not claim that id then.
        const hasInitialText = (part.text ?? '').length > 0;
        const hasBufferedDeltas = (nodeState.pendingDeltas.get(part.id)?.length ?? 0) > 0;
        if (!nodeState.assistantStarted && nodeState.userMessageId === null && part.messageId && hasInitialText && !hasBufferedDeltas) {
          nodeState.userMessageId = part.messageId;
          if (captureRootUserMessage) {
            this.userMessageId = part.messageId;
          }
          this.logTag('route', `text user candidate partID=${part.id} messageID=${part.messageId} target=${this.describeTarget(target)} captureRootUser=${captureRootUserMessage}`);
        }
        if (!nodeState.assistantStarted && hasInitialText && !hasBufferedDeltas && part.messageId && part.messageId === nodeState.userMessageId) {
          nodeState.partRoutes.set(part.id, 'ignored');
          this.partTargets.set(part.id, target);
          this.logTag('route', `text ignored user echo partID=${part.id} messageID=${part.messageId} target=${this.describeTarget(target)}`);
          return; // Skip user echo
        }
        nodeState.assistantStarted = true;
        nodeState.partRoutes.set(part.id, 'text');
        this.partTargets.set(part.id, target);
        const hadBufferedDelta = this.flushPendingDeltas(part.id, target);
        this.logTag('route', `text routed partID=${part.id} target=${this.describeTarget(target)} hadBufferedDelta=${hadBufferedDelta}`);
        if (!hadBufferedDelta) {
          this.renderAssistantText(target, {
            partId: part.id,
            text: part.text ?? '',
            messageId: part.messageId,
            sessionId: event.sessionId ?? part.sessionId,
          }, `text partID=${part.id}`);
        }
        break;
      }
      case 'reasoning':
        // Skip if already routed; same dedup as text (see above)
        if (nodeState.partRoutes.has(part.id)) {
          this.partTargets.set(part.id, target);
          this.logTag('route', `part.updated duplicate reasoning partID=${part.id} target=${this.describeTarget(target)} action=keep-existing-route`);
          this.pushReasoning(target, {
            partId: part.id,
            text: '',
            messageId: part.messageId,
            sessionId: event.sessionId ?? part.sessionId,
            isComplete: true,
          });
          return;
        }
        nodeState.assistantStarted = true;
        nodeState.partRoutes.set(part.id, 'reasoning');
        this.partTargets.set(part.id, target);
        const hadBufferedDelta = this.flushPendingDeltas(part.id, target);
        this.logTag('route', `reasoning routed partID=${part.id} target=${this.describeTarget(target)} hadBufferedDelta=${hadBufferedDelta}`);
        const initialDelta = part.text ?? '';
        if (!hadBufferedDelta && initialDelta) {
          const sessionId = event.sessionId ?? part.sessionId;
          this.pushReasoning(target, {
            partId: part.id,
            text: initialDelta,
            messageId: part.messageId,
            sessionId,
          });
          this.appendDeltaText(target, part.id, initialDelta);
        } else if (!hadBufferedDelta) {
          this.logTag('route', `reasoning initial empty skipped partID=${part.id} target=${this.describeTarget(target)}`);
        }
        break;
      case 'tool':
        this.logTag('route', `tool routed partID=${part.id} callID=${part.callId ?? part.id} tool=${part.toolName} status=${part.state?.status ?? '<none>'} target=${this.describeTarget(target)}`);
        if (part.toolName === 'task' || part.toolName === 'subagent') {
          this.ensureRootSubagentScope(part, event.sessionId);
        }
        this.handleToolState(part, target, event.sessionId);
        break;
      case 'step-start':
        nodeState.assistantStarted = true;
        this.logTag('route', `step-start target=${this.describeTarget(target)} partID=${part.id}`);
        break;
      case 'step-finish':
        this.logTag('route', `step-finish target=${this.describeTarget(target)} partID=${part.id}`);
        break; // No rendering needed
    }
  }

  private renderDeltaToTarget(event: AcpPartDeltaEvent, fallbackTarget: SessionStreamNode): void {
    if (!event.delta) return;

    const target = this.partTargets.get(event.partId) ?? fallbackTarget;
    const targetState = this.getNodeState(target);
    const kind = targetState.partRoutes.get(event.partId);
    this.logTag('route', `delta partID=${event.partId} sessionID=${event.sessionId ?? '<none>'} kind=${kind ?? '<unrouted>'} target=${this.describeTarget(target)} fallback=${this.describeTarget(fallbackTarget)} text="${previewText(event.delta)}"`);
    if (kind === 'reasoning') {
      this.pushReasoning(target, {
        partId: event.partId,
        text: event.delta,
        sessionId: event.sessionId,
      });
      this.logTag('route', `delta rendered reasoning partID=${event.partId} target=${this.describeTarget(target)}`);
      this.appendDeltaText(target, event.partId, event.delta);
    } else if (kind === 'text') {
      this.renderAssistantText(target, {
        partId: event.partId,
        text: event.delta,
        sessionId: event.sessionId,
      }, `text delta partID=${event.partId}`);
      this.logTag('route', `delta rendered text partID=${event.partId} target=${this.describeTarget(target)}`);
    } else if (kind === 'ignored' || kind === 'pendingSystemNotice' || kind === 'systemNotice') {
      this.logTag('route', `delta ignored kind=${kind} partID=${event.partId} target=${this.describeTarget(target)}`);
    } else if (event.sessionId) {
      const pending = targetState.pendingDeltas.get(event.partId) ?? [];
      pending.push(event);
      targetState.pendingDeltas.set(event.partId, pending);
      this.logTag('route', `delta buffered partID=${event.partId} sessionID=${event.sessionId} target=${this.describeTarget(target)} pending=${pending.length}`);
    } else {
      this.logTag('route', `delta dropped unrouted partID=${event.partId} no event sessionID target=${this.describeTarget(target)}`);
    }
  }

  private flushPendingDeltas(partId: string, target: SessionStreamNode): boolean {
    const targetState = this.getNodeState(target);
    const pending = targetState.pendingDeltas.get(partId);
    if (!pending || pending.length === 0) return false;
    targetState.pendingDeltas.delete(partId);
    this.logTag('route', `flush pending deltas partID=${partId} count=${pending.length} target=${this.describeTarget(target)}`);
    for (const event of pending) {
      this.renderDeltaToTarget(event, target);
    }
    return true;
  }

  private appendDeltaText(target: SessionStreamNode, partId: string, delta: string): void {
    if (!delta) return;
    const targetState = this.getNodeState(target);
    targetState.deltaText.set(partId, (targetState.deltaText.get(partId) ?? '') + delta);
  }

  private renderAssistantText(
    target: SessionStreamNode,
    data: { partId: string; text: string; messageId?: string; sessionId?: string; isComplete?: boolean },
    label: string,
  ): void {
    if (!data.text && !data.isComplete) return;
    if (this.isRootTarget(target)) {
      target.push(new AssistantTextSSP({
        partId: data.partId,
        delta: data.text,
        messageId: data.messageId,
        sessionId: data.sessionId,
        isComplete: data.isComplete,
      }));
    } else {
      target.push(new AssistantTextSSP({
        partId: data.partId,
        delta: data.text,
        messageId: data.messageId,
        sessionId: data.sessionId,
        isComplete: data.isComplete,
      }));
    }
    this.appendDeltaText(target, data.partId, data.text);
  }

  private pushSystemNoticeTool(
    target: SessionStreamNode,
    part: AcpTextPart,
    notice: SystemNotice,
    eventSessionId: string | undefined,
  ): void {
    const callId = `system-${part.id}`;
    target.push(new OpenCodeSystemNoticeToolSSP({
      partId: part.id,
      toolName: notice.title,
      callId,
      messageId: part.messageId,
      sessionId: eventSessionId ?? part.sessionId,
      state: {
        status: 'completed',
        input: {},
        output: notice.output,
        title: notice.title,
        metadata: {
          presentation: 'system',
          source: 'opencode-system-reminder',
        },
      },
    }));
  }

  private pushReasoning(
    target: SessionStreamNode,
    data: { partId: string; text: string; messageId?: string; sessionId?: string; thinkingId?: string; isComplete?: boolean },
  ): void {
    if (!data.text && !data.isComplete) return;
    target.push(new ReasoningSSP({
      partId: data.partId,
      delta: data.text,
      messageId: data.messageId,
      sessionId: data.sessionId,
      thinkingId: data.thinkingId,
      metadata: this.getReasoningMetadata(data.sessionId),
      isComplete: data.isComplete,
    }, this.getReasoningMeta(data.sessionId)));
  }

  private isRootTarget(target: SessionStreamNode): boolean {
    return target === this.sss;
  }

  private getReasoningMetadata(sessionId: string | undefined): Record<string, unknown> | undefined {
    if (!sessionId) return undefined;
    const metadata: Record<string, unknown> = { sessionId };
    const parentSessionId = this.getParentSessionId(sessionId);
    if (parentSessionId) {
      metadata.parentSessionId = parentSessionId;
    }
    return metadata;
  }

  private getReasoningMeta(sessionId: string | undefined): { parentSessionId?: string } | undefined {
    const parentSessionId = this.getParentSessionId(sessionId);
    return parentSessionId ? { parentSessionId } : undefined;
  }

  private getParentSessionId(sessionId: string | undefined): string | undefined {
    if (!sessionId || sessionId === this.sessionId) return undefined;
    return this.childSessionHints.get(sessionId) ?? this.sessionId;
  }

  private getDeltaText(target: SessionStreamNode, partId: string): string | undefined {
    return this.getNodeState(target).deltaText.get(partId);
  }

  private isAssistantTextPart(target: SessionStreamNode, partId: string | undefined): boolean {
    if (!partId) return false;
    return this.getNodeState(target).partRoutes.get(partId) === 'text';
  }

  private isReasoningPart(target: SessionStreamNode, partId: string | undefined): boolean {
    if (!partId) return false;
    return this.getNodeState(target).partRoutes.get(partId) === 'reasoning';
  }

  private updateScopeSummary(scope: SubagentScope, kind: StreamablePartKind, text: string | undefined): void {
    if (!text || !text.trim()) return;
    scope.lastText = text;
    if (kind === 'text') {
      scope.lastAssistantText = text;
    } else {
      scope.lastReasoningText = text;
    }
    this.logTag('subagent', `summary captured kind=${kind} scope=${this.describeScope(scope)} text="${previewText(text)}"`);
  }

  private ensureRootSubagentScope(part: AcpToolPart, sessionId: string | undefined): SubagentScope | undefined {
    if (part.toolName !== 'task' && part.toolName !== 'subagent') return undefined;
    const key = part.callId ?? part.id;
    let scope = this.subagents.getScope(key);
    if (!scope) {
      scope = this.subagents.startSubagent(key, {
        toolName: part.toolName,
        title: part.state?.title ?? '',
        input: part.state?.input ?? {},
      });
      this.logTag('subagent', `scope started ${this.describeScope(scope)} from ${part.state?.status ?? '<none>'} tool=${part.toolName} sessionID=${sessionId ?? '<none>'}`);
    }
    const childSessionId = this.getToolSessionId(part.state);
    if (childSessionId) {
      this.logTag('subagent', `task state has childSessionId=${childSessionId} scope=${this.describeScope(scope)}`);
      this.bindScopeToChildSession(scope, childSessionId);
    }
    return scope;
  }

  private getNodeState(target: SessionStreamNode): StreamNodeState {
    let state = this.nodeStates.get(target);
    if (!state) {
      state = {
        userMessageId: null,
        assistantStarted: false,
        partRoutes: new Map(),
        pendingDeltas: new Map(),
        deltaText: new Map(),
      };
      this.nodeStates.set(target, state);
    }
    return state;
  }

  // ---------------------------------------------------------------------------
  // Mutable: tool lifecycle push/update
  // ---------------------------------------------------------------------------

  private handleToolState(
    part: AcpToolPart,
    target: SessionStreamNode,
    eventSessionId = part.sessionId,
  ): void {
    const key = part.callId ?? part.id;
    const state = part.state;
    if (!state) return;

    const status = state.status;
    const sessionId = eventSessionId ?? part.sessionId;
    const eventScope = sessionId && sessionId !== this.sessionId
      ? this.findScopeForSession(sessionId)
      : undefined;
    const isKnownRootTool = target.has(key);
    const fallbackScope = eventScope ?? (!sessionId && !isKnownRootTool ? this.getActiveSubagentScope() : undefined);
    if (fallbackScope && !this.subagents.getScope(key) && part.toolName !== 'task' && part.toolName !== 'subagent') {
      this.handleSubagentToolPart(fallbackScope, part, sessionId);
      return;
    }

    // Write/edit tools: defer SSP creation until permission.asked creates ExternalEditSSP.
    // If permission never comes (auto-approve), create ToolInvocationSSP at completion.
    if (this.isWriteEditTool(part.toolName)) {
      if (this.hasExternalEdit(key, target)) {
        // ExternalEditSSP exists: external edit path
        if (status === 'completed' || status === 'error') {
          this.completeExternalEdit(key, target);
        }
        return;
      }
      // No ExternalEditSSP yet; keep deferring at pending/running
      if (status === 'pending' || status === 'running') return;
      // completed/error without permission: fall through to normal tool handling
    }

    if (!target.has(key)) {
      // Task/subagent: start scope
      if (part.toolName === 'task' || part.toolName === 'subagent') {
        this.ensureRootSubagentScope(part, sessionId);
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
          messageId: part.messageId,
          sessionId,
          subAgentId: key,
        }));
      } else {
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
          messageId: part.messageId,
          sessionId,
        }));
      }
    } else {
      if (part.toolName === 'task' || part.toolName === 'subagent') {
        const renderState = status === 'completed' || status === 'error'
          ? { ...state, status: 'running' as const }
          : state;
        target.update(key, { state: renderState });
      } else {
        target.update(key, { state });
      }

    }
    this.completeScopeFromToolPart(part, sessionId);
  }

  private completeScopeFromToolPart(part: AcpToolPart, sessionId: string | undefined): void {
    if (part.toolName !== 'task' && part.toolName !== 'subagent') return;
    const state = part.state;
    if (!state || (state.status !== 'completed' && state.status !== 'error')) return;

    const key = part.callId ?? part.id;
    const scope = this.subagents.getScope(key);
    if (!scope) return;

    this.ensureRootSubagentScope(part, sessionId);
    this.hadSubagentTasks = true;
    this.subagents.completeSubagent(key, state.output);
    this.logTag('subagent', `scope completed status=${state.status} ${this.describeScope(scope)} output="${previewText(state.output)}" childIdle=${!!scope.childIdle}`);
    if (scope.childIdle || state.status === 'error') {
      this.finalizeScopeTool(scope);
      this.checkDeferredIdleResolution();
    }
  }

  // ---------------------------------------------------------------------------
  // Permission to ExternalEditSSP with callbacks
  // ---------------------------------------------------------------------------

  private completeExternalEdit(callId: string, target: SessionStreamNode): void {
    target.update(callId, { status: 'completed' });
  }

  private hasExternalEdit(callId: string, target: SessionStreamNode): boolean {
    return this.externalEditIds.has(this.getExternalEditKey(callId, target));
  }

  private markExternalEdit(callId: string, target: SessionStreamNode): void {
    this.externalEditIds.add(this.getExternalEditKey(callId, target));
  }

  private getExternalEditKey(callId: string, target: SessionStreamNode): string {
    return `${this.describeTarget(target)}::${callId}`;
  }

  private handlePermissionAsked(event: AcpPermissionRequestEvent): void {
    this.startExternalEdit(event, this.sss);
  }

  private startExternalEdit(event: AcpPermissionRequestEvent, target: SessionStreamNode): void {
    const callId = event.tool?.callId;
    const filepath = event.metadata?.filepath as string | undefined;

    if (!callId || !filepath) {
      // Non-file permission: auto-reply directly
      this.backend.permissions.reply(event.sessionId, event.permissionId, 'once', this.directory);
      return;
    }

    const uri = createExternalEditUri(filepath, this.directory);
    this.markExternalEdit(callId, target);

    target.push(new ExternalEditSSP(
      {
        toolCallId: callId,
        editId: '',
        status: 'pending',
        uri: filepath,
        uris: [uri],
      },
      {
        onBaselineCaptured: () => {
          // Baseline captured: auto-reply permission
          this.backend.permissions.reply(
            event.sessionId,
            event.permissionId,
            'once',
            this.directory,
          );
        },
        onSnapshot: (snapshot) => {
          this.sss.serializeSnapshot(snapshot);
        },
      },
    ));
  }

  // ---------------------------------------------------------------------------
  // Question to QuestionSSP with callbacks
  // ---------------------------------------------------------------------------

  private handleQuestionAsked(event: AcpQuestionRequestEvent): void {
    this.startQuestion(event, this.sss);
  }

  private startQuestion(event: AcpQuestionRequestEvent, target: SessionStreamNode): void {
    const questions = event.questions;

    target.push(new QuestionSSP(
      {
        questionId: event.questionId,
        questions: questions as unknown[],
        status: 'asked',
      },
      {
        onResult: (vscodeRawResult) => {
          const answers = this.mapQuestionAnswers(vscodeRawResult, questions);
          this.backend.questions.reply(
            event.sessionId,
            event.questionId,
            answers,
            this.directory,
          );
          target.update(event.questionId, { status: 'replied' });
        },
        onSkip: () => {
          this.backend.questions.reject(
            event.sessionId,
            event.questionId,
            this.directory,
          );
          target.update(event.questionId, { status: 'skipped' });
        },
      },
    ));
  }

  /** Map VS Code questionCarousel result to OpenCode string[][] format */
  private mapQuestionAnswers(
    vscodeRaw: unknown,
    questions: AcpQuestionInfo[],
  ): string[][] {
    const result = vscodeRaw as Record<string, unknown> | undefined;
    if (!result) return questions.map(() => []);

    return questions.map((_, i) => {
      const key = `q_${i}`;
      const answer = result[key];
      if (answer === undefined || answer === null) return [];

      if (typeof answer === 'string') return [answer];

      if (typeof answer === 'object' && answer !== null) {
        const obj = answer as Record<string, unknown>;
        if ('selectedValue' in obj) {
          if (obj.freeformValue && typeof obj.freeformValue === 'string') return [obj.freeformValue];
          const val = obj.selectedValue;
          return val !== undefined && val !== null ? [String(val)] : [];
        }
        if ('selectedValues' in obj && Array.isArray(obj.selectedValues)) {
          const selected = (obj.selectedValues as unknown[])
            .map(v => v != null ? String(v) : '')
            .filter(v => v !== '');
          if (obj.freeformValue && typeof obj.freeformValue === 'string') selected.push(obj.freeformValue);
          return selected;
        }
      }
      return [];
    });
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle events write metadata
  // ---------------------------------------------------------------------------

  private async handleSessionUpdated(event: AcpEvent): Promise<void> {
    const e = event as { title?: string };
    if (e.title) {
      await this.updateSessionTitle(e.title);
    }
  }

  private async updateSessionTitle(rawTitle: string): Promise<void> {
    const title = normalizeTitleText(rawTitle);
    if (!title || isPlaceholderSessionTitle(title)) return;

    const firstPrompt = this.sss.getFirstPrompt();
    if (firstPrompt && isPromptEchoTitle(firstPrompt, title)) {
      const generatedTitle = await generateSessionTitleWithVsCodeLm(firstPrompt, this.logger);
      if (!generatedTitle || isPlaceholderSessionTitle(generatedTitle)) {
        this.logTag('title', `ignored prompt-echo title="${previewText(title)}"; VS Code LM title unavailable`);
        return;
      }
      this.setSessionTitle(generatedTitle, 'copilot-style');
      this.logTag('title', `updated prompt-echo title via VS Code LM title="${previewText(generatedTitle)}"`);
      return;
    }

    this.setSessionTitle(title, 'backend');
  }

  private setSessionTitle(title: string, source: SessionTitleSource): void {
    const persisted = this.sss.updateTitle(title, source, { provisional: false });
    if (!persisted) return;
    this.sessionTitle = persisted;
    this.sessionTitleSource = source;
  }

  private handleSessionCreated(event: AcpEvent): void {
    const e = event as { sessionId?: string; parentId?: string; title?: string };
    if (e.sessionId && e.parentId) {
      this.childSessionHints.set(e.sessionId, e.parentId);
    }
  }

  private handleSessionDiff(event: AcpEvent): void {
    const e = event as { diffs?: unknown[] };
    if (e.diffs) {
      this.sss.writeMeta({
        changeSummary: { files: e.diffs.length },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Session idle + deferred idle (wait for subagents)
  // ---------------------------------------------------------------------------

  private handleSessionIdle(): boolean {
    this.sss.writeMeta({ status: 'completed' });

    if (this.subagents.hasBusyDescendant()) {
      this.deferredIdle = true;
      this.startDeferredIdleTimer();
      this.logTag('idle', 'deferred; waiting for subagent sessions to complete');
      return false;
    }
    // No busy subagents; clean up and let loop end
    this.subagents.clear();
    return true;
  }

  private startDeferredIdleTimer(): void {
    this.clearDeferredIdleTimer();
    this.deferredIdleTimer = setTimeout(() => {
      this.logTag('idle', `deferred idle timeout (${OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS / 1000}s); stopping`);
      this.deferredIdle = false;
      this.subagents.clear();
    }, OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS);
  }

  private clearDeferredIdleTimer(): void {
    if (this.deferredIdleTimer) {
      clearTimeout(this.deferredIdleTimer);
      this.deferredIdleTimer = null;
    }
  }

  /** Check if deferred idle can be resolved (all subagents done) */
  private checkDeferredIdleResolution(): boolean {
    if (!this.deferredIdle) return false;
    if (!this.subagents.hasBusyDescendant()) {
      this.deferredIdle = false;
      this.clearDeferredIdleTimer();
      // Clean up completed scopes
      for (const scope of this.subagents.listScopes()) {
        if (scope.completed) this.subagents.removeSubagent(scope.callId);
      }
      return true;
    }
    // Reset safety timer on any activity
    this.startDeferredIdleTimer();
    return false;
  }

  // ---------------------------------------------------------------------------
  // Child session event routing to subsession
  // ---------------------------------------------------------------------------

  private handleChildSessionEvent(event: AcpEvent, eventSessionId: string): void {
    this.logTag('subagent', `child event start sessionID=${eventSessionId} ${this.describeEvent(event)}`);
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const created = event as { parentId?: string };
      if (created.parentId) {
        this.childSessionHints.set(eventSessionId, created.parentId);
        this.logTag('subagent', `child hint sessionID=${eventSessionId} parentID=${created.parentId}`);
      }
    }

    // Find owning scope
    let scope = this.findScopeForSession(eventSessionId);
    if (scope) {
      this.logTag('subagent', `scope matched directly sessionID=${eventSessionId} ${this.describeScope(scope)}`);
    }

    if (!scope) {
      scope = this.findBindableScopeForChildSession(eventSessionId);
      if (scope) {
        this.logTag('subagent', `scope bindable sessionID=${eventSessionId} ${this.describeScope(scope)}`);
        this.bindScopeToChildSession(scope, eventSessionId);
        scope = this.findScopeForSession(eventSessionId) ?? scope;
      }
    }

    if (!scope) {
      this.bufferChildEvent(eventSessionId, event);
      this.logTag('subagent', `buffered child event type=${event.type} for sessionID=${eventSessionId}`);
      return;
    }

    if (event.type === 'session.created') {
      const e = event as { title?: string };
      if (e.title) {
        const target = this.getSubsessionStream(scope.subAgentInvocationId!);
        this.logTag('subagent', `child session.created write meta title="${e.title}" target=${this.describeTarget(target)} scope=${this.describeScope(scope)}`);
        target.writeMeta({ title: e.title, titleSource: 'backend' });
      }
      return;
    }

    const target = this.getSubsessionStream(scope.subAgentInvocationId!);
    this.logTag('subagent', `child event routed target=${this.describeTarget(target)} scope=${this.describeScope(scope)} ${this.describeEvent(event)}`);

    if (event.type === 'permission.asked') {
      this.logTag('subagent', `child permission routed to external edit target=${this.describeTarget(target)} permissionID=${event.permissionId}`);
      this.startExternalEdit(event, target);
      return;
    }

    if (event.type === 'question.asked') {
      this.logTag('subagent', `child question routed target=${this.describeTarget(target)} questionID=${event.questionId}`);
      this.startQuestion(event, target);
      return;
    }

    if (event.type === 'session.updated') {
      const e = event as { title?: string };
      if (e.title) {
        this.logTag('subagent', `child session.updated write meta title="${e.title}" target=${this.describeTarget(target)}`);
        target.writeMeta({ title: e.title, titleSource: 'backend' });
      }
      return;
    }

    if (event.type === 'session.diff') {
      const e = event as { diffs?: unknown[] };
      if (e.diffs) {
        this.logTag('subagent', `child session.diff write meta files=${e.diffs.length} target=${this.describeTarget(target)}`);
        target.writeMeta({ changeSummary: { files: e.diffs.length } });
      }
      return;
    }

    if (event.type === 'session.status') {
      const e = event as { status?: unknown };
      this.logTag('subagent', `child session.status write meta status=${JSON.stringify(e.status)} target=${this.describeTarget(target)}`);
      target.writeMeta({ status: e.status });
      return;
    }

    // Handle idle from child
    if (event.type === 'session.idle') {
      scope.descendantSessionIds.add(eventSessionId);
      this.recordAncestorDescendantSessions(scope, eventSessionId);
      this.logTag('subagent', `child idle sessionID=${eventSessionId} scope=${this.describeScope(scope)} completed=${!!scope.completed} lastAssistantText="${previewText(scope.lastAssistantText)}" lastReasoningText="${previewText(scope.lastReasoningText)}"`);
      if (scope.childSessionId === eventSessionId && !scope.childIdle) {
        scope.childIdle = true;
        scope.timeEnd = Date.now();
        if (scope.completed) {
          this.finalizeScopeTool(scope);
        }
      }
      this.checkDeferredIdleResolution();
      target.push(new SessionLifecycleSSP({
        eventType: 'session.idle',
        sessionId: eventSessionId,
      }));
      return;
    }

    // Handle tool events from child and route to subsession
    if (event.type === 'part.updated') {
      const part = (event as { part?: { type?: string } }).part;
      if (part?.type === 'tool') {
        const toolPart = (event as { part: AcpToolPart }).part;
        this.logTag('subagent', `child tool captured tool=${toolPart.toolName} callID=${toolPart.callId ?? toolPart.id} status=${toolPart.state?.status ?? '<none>'} scope=${this.describeScope(scope)}`);
        this.handleSubagentToolPart(scope, toolPart, eventSessionId);
        return;
      }

      this.handlePartUpdatedForTarget(event as AcpPartUpdatedEvent, target, false);
      // Capture child text/reasoning for the parent subagent card result.
      if (part?.type === 'text' || part?.type === 'reasoning') {
        const streamPart = (event as { part?: { id?: string; text?: string } }).part;
        const isCapturedPart = part.type === 'text'
          ? this.isAssistantTextPart(target, streamPart?.id)
          : this.isReasoningPart(target, streamPart?.id);
        if (isCapturedPart) {
          const streamedText = streamPart?.id ? this.getDeltaText(target, streamPart.id) : undefined;
          this.updateScopeSummary(scope, part.type, streamedText ?? streamPart?.text);
        } else {
          this.logTag('subagent', `child ${part.type} not captured partID=${streamPart?.id ?? '<none>'} route=${streamPart?.id ? this.getNodeState(target).partRoutes.get(streamPart.id) ?? '<none>' : '<none>'} target=${this.describeTarget(target)}`);
        }
      }
      return;
    }

    if (event.type === 'part.delta') {
      const deltaEvent = event as AcpPartDeltaEvent;
      this.renderDeltaToTarget(deltaEvent, target);
      const kind = this.isAssistantTextPart(target, deltaEvent.partId)
        ? 'text'
        : this.isReasoningPart(target, deltaEvent.partId)
          ? 'reasoning'
          : undefined;
      const text = kind
        ? this.getDeltaText(target, deltaEvent.partId)
        : undefined;
      if (kind) {
        this.updateScopeSummary(scope, kind, text);
      }
      if (!text) {
        this.logTag('subagent', `child delta no summary partID=${deltaEvent.partId} route=${this.getNodeState(target).partRoutes.get(deltaEvent.partId) ?? '<none>'} target=${this.describeTarget(target)}`);
      }
      return;
    }
  }

  private findScopeForSession(sessionId: string): SubagentScope | undefined {
    return this.subagents.findScopeForSession(sessionId);
  }

  private findBindableScopeForChildSession(sessionId: string): SubagentScope | undefined {
    const parentId = this.childSessionHints.get(sessionId);
    const unbound = this.subagents.listScopes().filter(scope => !scope.childSessionId);
    if (unbound.length === 0) return undefined;

    let candidates = unbound;
    if (parentId) {
      const parentScope = this.findScopeForSession(parentId);
      candidates = parentScope?.subAgentInvocationId
        ? unbound.filter(scope => scope.parentSubAgentInvocationId === parentScope.subAgentInvocationId)
        : parentId === this.sessionId
          ? unbound.filter(scope => !scope.parentSubAgentInvocationId)
          : [];
    }

    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private bindScopeToChildSession(
    scope: SubagentScope,
    childSessionId: string,
    drainPending = true,
  ): void {
    if (scope.childSessionId === childSessionId) return;
    if (scope.childSessionId && scope.childSessionId !== childSessionId) {
      this.logTag('subagent', `scope callID=${scope.callId} already bound to childSessionId=${scope.childSessionId}, ignoring ${childSessionId}`);
      return;
    }

    this.subagents.setChildSession(scope.callId, childSessionId);
    this.recordAncestorDescendantSessions(scope, childSessionId);
    this.logTag('subagent', `bound childSessionId=${childSessionId} to callID=${scope.callId}`);
    this.logTag('subagent', `bound scope now ${this.describeScope(scope)}`);

    if (drainPending) {
      this.drainPendingChildEvents(childSessionId);
    }
  }

  private bufferChildEvent(sessionId: string, event: AcpEvent): void {
    const existing = this.pendingChildEvents.get(sessionId) ?? [];
    existing.push(event);
    this.pendingChildEvents.set(sessionId, existing);
    this.logTag('subagent', `pending child buffer sessionID=${sessionId} count=${existing.length} ${this.describeEvent(event)}`);
  }

  private drainPendingChildEvents(sessionId: string): void {
    const pending = this.pendingChildEvents.get(sessionId);
    if (!pending || pending.length === 0) return;
    this.pendingChildEvents.delete(sessionId);
    this.logTag('subagent', `draining pending child events sessionID=${sessionId} count=${pending.length}`);
    for (const event of pending) {
      this.handleChildSessionEvent(event, sessionId);
    }
  }

  private getActiveSubagentScope(): SubagentScope | undefined {
    return this.subagents.listScopes()
      .filter(scope => !scope.childIdle && !scope.completed)
      .sort((a, b) => this.getScopeDepth(b) - this.getScopeDepth(a))[0];
  }

  private getScopeDepth(scope: SubagentScope): number {
    let depth = 0;
    let current = scope;
    while (current.parentSubAgentInvocationId) {
      const parent = this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  private handleSubagentToolPart(
    scope: SubagentScope,
    toolPart: AcpToolPart,
    eventSessionId = toolPart.sessionId,
  ): void {
    const childCallId = toolPart.callId ?? toolPart.id;
    const childStatus = toolPart.state?.status ?? 'running';
    const sub = this.getSubsessionStream(scope.subAgentInvocationId!);
    this.logTag('subagent', `child tool route scope=${this.describeScope(scope)} target=${this.describeTarget(sub)} tool=${toolPart.toolName} callID=${childCallId} status=${childStatus} eventSession=${eventSessionId ?? '<none>'}`);

    // Write/edit tools: defer until permission.asked creates ExternalEditSSP.
    if (this.isWriteEditTool(toolPart.toolName)) {
      if (this.hasExternalEdit(childCallId, sub)) {
        if (childStatus === 'completed' || childStatus === 'error') {
          this.completeExternalEdit(childCallId, sub);
          this.subagents.recordChildToolCall(scope.callId, {
            name: toolPart.toolName,
            title: toolPart.state?.title,
            status: childStatus,
          });
          this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
        }
        return;
      }
      // No ExternalEditSSP yet; keep deferring at pending/running
      if (childStatus === 'pending' || childStatus === 'running') return;
      // completed/error without permission: fall through to normal handling
    }
    let nestedScope: SubagentScope | undefined;
    if (toolPart.toolName === 'task' || toolPart.toolName === 'subagent') {
      nestedScope = this.subagents.getScope(childCallId);
      if (!nestedScope) {
        nestedScope = this.subagents.startSubagent(
          childCallId,
          {
            toolName: toolPart.toolName,
            title: toolPart.state?.title ?? '',
            input: toolPart.state?.input ?? {},
          },
          scope.subAgentInvocationId,
        );
        this.logTag('subagent', `nested scope started ${this.describeScope(nestedScope)} parent=${this.describeScope(scope)}`);
      }
      const childSessionId = this.getToolSessionId(toolPart.state);
      if (childSessionId) {
        this.bindScopeToChildSession(nestedScope, childSessionId);
      }
    }
    const payload = {
      partId: `subagent-child-${childCallId}`,
      toolName: toolPart.toolName,
      callId: childCallId,
      state: toolPart.state!,
      messageId: toolPart.messageId,
      sessionId: eventSessionId,
      subAgentId: scope.subAgentInvocationId,
      subAgentInvocationId: scope.subAgentInvocationId,
    };

    const isFirstChildToolEvent = !sub.has(childCallId);
    if (isFirstChildToolEvent) {
      sub.push(new ToolInvocationSSP(payload));
      this.logTag('subagent', `child tool push callID=${childCallId} subAgentInvocationId=${scope.subAgentInvocationId ?? '<none>'}`);
    } else {
      sub.update(childCallId, { state: toolPart.state });
      this.logTag('subagent', `child tool update callID=${childCallId} subAgentInvocationId=${scope.subAgentInvocationId ?? '<none>'}`);
    }

    if (childStatus === 'completed' || childStatus === 'error') {
      if (nestedScope) {
        this.subagents.completeSubagent(childCallId, toolPart.state?.output);
      }
      this.subagents.recordChildToolCall(scope.callId, {
        name: toolPart.toolName,
        title: toolPart.state?.title,
        status: childStatus,
      });
      this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
    }
  }

  private updateScopeTool(scope: SubagentScope, state: Partial<AcpToolState>): void {
    const renderMode = isSubagentProgressTitleUpdate(state) ? 'updateOnly' : undefined;
    const target = scope.parentSubAgentInvocationId
      ? this.getSubsessionStream(scope.parentSubAgentInvocationId)
      : this.sss;
    this.logTag('subagent', `update scope tool callID=${scope.callId} target=${this.describeTarget(target)} state=${this.describeToolStatePatch(state)} scope=${this.describeScope(scope)}`);
    target.update(scope.callId, { state, renderMode });
  }

  private finalizeScopeTool(scope: SubagentScope): void {
    const output = scope.lastAssistantText?.trim() || scope.output || '';
    this.logTag('subagent', `finalize scope ${this.describeScope(scope)} output="${previewText(output)}" progress="${formatSubagentProgress(scope)}"`);
    this.updateScopeTool(scope, {
      status: 'completed',
      output,
      title: formatSubagentProgress(scope) || scope.toolMeta?.title,
    });
  }

  private recordAncestorDescendantSessions(scope: SubagentScope | undefined, sessionId: string): void {
    let current = scope;
    while (current?.parentSubAgentInvocationId) {
      const parent = this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId);
      if (!parent) return;
      this.subagents.addDescendantSession(parent.callId, sessionId);
      current = parent;
    }
  }

  private getSubsessionStream(subAgentInvocationId: string): SubsessionStream {
    const scope = this.subagents.findScopeBySubAgentInvocationId(subAgentInvocationId);
    const chain: string[] = [];
    let current: SubagentScope | undefined = scope;

    while (current) {
      if (current.subAgentInvocationId) {
        chain.unshift(current.subAgentInvocationId);
      }
      current = current.parentSubAgentInvocationId
        ? this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId)
        : undefined;
    }

    const ids = chain.length > 0 ? chain : [subAgentInvocationId];
    let sub = this.sss.subsession(ids[0]);
    this.targetLabels.set(sub, `subsession path=${ids[0]}`);
    for (const id of ids.slice(1)) {
      sub = sub.subsession(id);
      this.targetLabels.set(sub, `subsession path=${ids.join('/')}`);
    }
    return sub;
  }

  private getToolSessionId(state: AcpToolState | undefined): string | undefined {
    const raw = state?.metadata?.sessionId ?? state?.metadata?.sessionID;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private isWriteEditTool(toolName: string): boolean {
    return toolName === 'write' || toolName === 'edit';
  }

  getUserMessageId(): string | null { return this.userMessageId; }
  getSessionTitle(): string | null { return this.sessionTitle ?? null; }
  getSessionTitleSource(): SessionTitleSource | null { return this.sessionTitleSource ?? null; }
  getHadSubagentTasks(): boolean { return this.hadSubagentTasks; }

  private describeTarget(target: SessionStreamNode): string {
    return this.targetLabels.get(target) ?? 'unknown-target';
  }

  private describeScope(scope: SubagentScope): string {
    return [
      `callID=${scope.callId}`,
      `subAgentInvocationId=${scope.subAgentInvocationId ?? '<none>'}`,
      `parentSubAgentInvocationId=${scope.parentSubAgentInvocationId ?? '<none>'}`,
      `childSessionId=${scope.childSessionId ?? '<none>'}`,
      `childIdle=${!!scope.childIdle}`,
      `completed=${!!scope.completed}`,
      `descendants=${scope.descendantSessionIds.size}`,
    ].join(' ');
  }

  private describeEvent(event: AcpEvent): string {
    switch (event.type) {
      case 'part.updated':
        return `type=part.updated eventSession=${event.sessionId ?? '<none>'} ${this.describePart(event.part)}`;
      case 'part.delta':
        return `type=part.delta sessionID=${event.sessionId ?? '<none>'} partID=${event.partId} field=${event.field ?? '<none>'} text="${previewText(event.delta)}"`;
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'session.error':
        return `type=${event.type} sessionID=${event.sessionId} parentID=${event.parentId ?? '<none>'} title="${previewText(event.title)}"`;
      case 'session.idle':
        return `type=session.idle sessionID=${event.sessionId ?? '<none>'}`;
      case 'session.status':
        return `type=session.status sessionID=${event.sessionId} status=${JSON.stringify(event.status)}`;
      case 'session.diff':
        return `type=session.diff sessionID=${event.sessionId} files=${event.diffs.length}`;
      case 'permission.asked':
        return `type=permission.asked sessionID=${event.sessionId} permissionID=${event.permissionId} toolCallID=${event.tool?.callId ?? '<none>'}`;
      case 'question.asked':
        return `type=question.asked sessionID=${event.sessionId} questionID=${event.questionId}`;
      default:
        return `type=${event.type}`;
    }
  }

  private describePart(part: AcpPartUpdatedEvent['part']): string {
    if (part.type === 'tool') {
      return `partType=tool partID=${part.id} callID=${part.callId ?? part.id} tool=${part.toolName} status=${part.state?.status ?? '<none>'} partSession=${part.sessionId ?? '<none>'} title="${previewText(part.state?.title)}"`;
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      return `partType=${part.type} partID=${part.id} messageID=${part.messageId ?? '<none>'} partSession=${part.sessionId ?? '<none>'} text="${previewText(part.text)}"`;
    }
    return `partType=${part.type} partID=${part.id} messageID=${part.messageId ?? '<none>'} partSession=${part.sessionId ?? '<none>'}`;
  }

  private describeToolStatePatch(state: Partial<AcpToolState>): string {
    return [
      state.status ? `status=${state.status}` : '',
      state.title ? `title="${previewText(state.title)}"` : '',
      state.output ? `output="${previewText(state.output)}"` : '',
    ].filter(Boolean).join(' ') || JSON.stringify(state);
  }
}

/**
 * @deprecated Legacy restore-only bridge that consumes already-projected
 * AcpEvent streams (used by the session-history replay path in
 * experimental-session.ts). Retained until Phase 4b removes that path and
 * unifies replay on SSP records. New code must use {@link OpenCodeBridge}
 * which consumes raw OpenCodeStreamEvents directly.
 */
export class OpenCodeProtocolBridge implements BackendBridge<AcpEvent> {
  private readonly inner: OpenCodeBridge;

  constructor(backend: Backend<unknown>, sessionId: string, directory?: string, options?: { sessionId?: string }) {
    this.inner = new OpenCodeBridge(backend, sessionId, directory, options);
  }

  setSSS(sss: unknown): void { this.inner.setSSS(sss); }
  setLogger(logger: BridgeLogger): void { this.inner.setLogger(logger); }
  getUserMessageId(): string | null { return this.inner.getUserMessageId(); }
  getSessionTitle(): string | null { return this.inner.getSessionTitle(); }
  getSessionTitleSource(): import('../../backend/serializable/types').SessionTitleSource | null { return this.inner.getSessionTitleSource(); }
  getHadSubagentTasks(): boolean { return this.inner.getHadSubagentTasks(); }

  async run(events: AsyncIterable<AcpEvent>, token: { isCancellationRequested: boolean }): Promise<boolean> {
    return this.inner.runWithProjected(events, token);
  }
}

function previewText(text: unknown, maxLen = 80): string {
  if (text === undefined || text === null) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length > maxLen ? normalized.slice(0, maxLen - 3) + '...' : normalized;
}

function normalizeTitleText(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function normalizeEchoPrefixText(title: string | undefined): string | undefined {
  const normalized = normalizeTitleText(title)
    ?.replace(/(?:\s*(?:\.{3}|\u2026))+$/u, '')
    .trim();
  return normalized || undefined;
}

function isPromptEchoTitle(firstPrompt: string, title: string): boolean {
  const prompt = normalizeTitleText(firstPrompt);
  const candidate = normalizeEchoPrefixText(title);
  return !!prompt && !!candidate && prompt.startsWith(candidate);
}

function projectOpenCodeStreamEvent(rawEvent: OpenCodeStreamEvent): AcpEvent[] {
  const event = unwrapOpenCodeStreamEvent(rawEvent);
  switch (event.type) {
    case 'server.connected':
      return [{ type: 'server.connected' }];
    case 'session.created':
    case 'session.updated': {
      const info = (event.properties as { info?: { id?: string; title?: string; parentID?: string } } | undefined)?.info;
      return [{
        type: event.type,
        sessionId: info?.id ?? '',
        parentId: info?.parentID,
        title: info?.title,
      }];
    }
    case 'session.deleted': {
      const info = (event.properties as { info?: { id?: string } } | undefined)?.info;
      return [{ type: 'session.deleted', sessionId: info?.id ?? '' }];
    }
    case 'session.error':
      return [{
        type: 'session.error',
        sessionId: getRawEventSessionId(event) ?? '',
        error: formatOpenCodeError((event.properties as Record<string, unknown> | undefined)?.error),
      }];
    case 'session.idle':
      return [{ type: 'session.idle', sessionId: event.properties?.sessionID }];
    case 'session.diff':
      return [{
        type: 'session.diff',
        sessionId: event.properties.sessionID,
        diffs: event.properties.diff.map(toAcpFileDiff),
      }];
    case 'session.status':
      return [{
        type: 'session.status',
        sessionId: event.properties.sessionID,
        status: event.properties.status as never,
      }];
    case 'message.part.updated':
      return [{
        type: 'part.updated',
        sessionId: getRawEventSessionId(event),
        part: projectStreamPart(event.properties.part),
        delta: event.properties.delta,
      }];
    case 'message.part.delta':
      return [{
        type: 'part.delta',
        partId: event.properties.partID,
        delta: event.properties.delta,
        field: event.properties.field,
        sessionId: getRawEventSessionId(event),
      }];
    case 'message.removed':
      return [{ type: 'session.updated', sessionId: getRawEventSessionId(event) ?? '' }];
    case 'permission.asked':
      return [{
        type: 'permission.asked',
        permissionId: event.properties.id,
        sessionId: event.properties.sessionID,
        permission: event.properties.permission,
        patterns: event.properties.patterns,
        metadata: event.properties.metadata,
        always: event.properties.always,
        tool: event.properties.tool
          ? { messageId: event.properties.tool.messageID, callId: event.properties.tool.callID }
          : undefined,
      }];
    case 'permission.replied':
      return [{
        type: 'permission.replied',
        sessionId: event.properties.sessionID,
        permissionId: event.properties.requestID,
        response: event.properties.reply,
      }];
    case 'question.asked':
      return [{
        type: 'question.asked',
        questionId: event.properties.id,
        sessionId: event.properties.sessionID,
        questions: event.properties.questions.map(q => ({
          question: q.question,
          header: q.header,
          options: q.options.map(o => ({ label: o.label, description: o.description })),
          multiple: q.multiple,
          custom: q.custom,
        })),
        tool: event.properties.tool
          ? { messageId: event.properties.tool.messageID, callId: event.properties.tool.callID }
          : undefined,
      }];
    case 'question.replied':
      return [{
        type: 'question.replied',
        sessionId: event.properties.sessionID,
        requestId: event.properties.requestID,
      }];
    case 'question.rejected':
      return [{
        type: 'question.rejected',
        sessionId: event.properties.sessionID,
        requestId: event.properties.requestID,
      }];
    default:
      return [];
  }
}

function unwrapOpenCodeStreamEvent(event: OpenCodeStreamEvent): OpenCodeEvent {
  return 'payload' in event ? event.payload : event;
}

function getRawEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case 'message.part.updated':
      return event.properties?.part?.sessionID;
    case 'message.part.delta':
      return (event.properties as { sessionID?: string }).sessionID;
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return (event.properties as { info?: { id?: string } }).info?.id;
    default:
      return (event.properties as { sessionID?: string } | undefined)?.sessionID;
  }
}

function projectStreamPart(part: StreamPart): AcpPartUpdatedEvent['part'] {
  const base = {
    id: part.id,
    messageId: part.messageID,
    sessionId: part.sessionID,
  };

  switch (part.type) {
    case 'text':
      return {
        ...base,
        type: 'text',
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
        metadata: part.metadata,
      };
    case 'reasoning':
      return {
        ...base,
        type: 'reasoning',
        text: part.text,
      };
    case 'tool':
      return {
        ...base,
        type: 'tool',
        toolName: part.tool,
        callId: part.callID,
        state: projectToolState(part.state),
      };
    case 'step-start':
    case 'step-finish':
      return {
        ...base,
        type: part.type,
        reason: part.type === 'step-finish' ? part.reason : undefined,
        snapshot: part.snapshot,
      };
    default:
      return {
        ...base,
        type: 'text',
        text: '',
      };
  }
}

function projectToolState(state: StreamToolState): AcpToolState {
  const base: Pick<AcpToolState, 'status' | 'input'> = {
    status: state.status,
    input: state.input,
  };

  switch (state.status) {
    case 'pending':
      return { ...base, status: 'pending' };
    case 'running':
      return {
        ...base,
        status: 'running',
        title: state.title,
        metadata: state.metadata,
        startTime: state.time?.start,
      };
    case 'completed':
      return {
        ...base,
        status: 'completed',
        output: state.output,
        title: state.title,
        metadata: state.metadata,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        error: state.error,
        metadata: state.metadata,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
  }
}

interface RawFileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

function toAcpFileDiff(diff: RawFileDiff) {
  const file = diff.file ?? '';
  return {
    file,
    patch: diff.patch ?? `--- a/${file}\n+++ b/${file}\n`,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
  };
}

function formatOpenCodeError(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object') {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  if (typeof record.name === 'string' && record.name.trim()) return record.name;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
