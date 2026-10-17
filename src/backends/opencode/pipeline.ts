/**
 * OpenCodePipeline - translates raw OpenCode events to SSP push/update calls.
 *
 * Architecture (v3 — projection removed):
 * - Pipeline consumes raw {@link OpenCodeEvent} values directly. There is NO
 *   intermediate projection/event-renaming layer: handlers read raw SDK field
 *   names (UPPER-case IDs, nested `time.{start,end}`, `properties.*` payloads).
 * - The only translation is flattening `StreamToolState.time.{start,end}` into
 *   the flat `SerializableToolState.{startTime,endTime}` shape SSP expects,
 *   via {@link flattenToolState} (see ./pipeline-types.ts).
 * - Pipeline does NOT touch the VS Code stream directly; SSS owns it.
 * - Pipeline only calls sss.push(ssp) / sss.update(id, data).
 * - SubagentManager stays in pipeline for scope tracking.
 * - Child session events route to sss.subsession(id).
 * - Permission/Question handled via SSP callback injection.
 */

import type { BackendPipeline, BackendPipelineOptions, BackendPipelineResult, BackendPipelineStream, BackendPipelineToken } from '../../backend/backend';
import type { PermissionMode } from '../../backend/types';
import type { SessionStreamNode } from '../../backend/streaming/session-stream-node';
import type { SessionTitleSource } from '../../backend/serializable/types';
import { SessionTitleService } from '../../participant/session-title';
import { SubagentManager, formatSubagentProgress, type SubagentScope } from '../../ssp/impl/subagent';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { QuestionSSP } from '../../ssp/impl/question';
import { SessionLifecycleSSP } from '../../ssp/impl/session-lifecycle';
import type { Backend } from '../../backend/backend';
import type {
  MessagePartDeltaEvent,
  MessagePartUpdatedEvent,
  OpenCodeEvent,
  OpenCodeStreamEvent,
  PermissionAskedEvent,
  QuestionAskedEvent,
  QuestionInfo,
  ReasoningStreamPart,
  StreamToolPart,
  StreamToolState,
  TextStreamPart,
} from './sdk-events';
import type { PipelineToolState } from './pipeline-types';
import { flattenToolState, getToolStateTitle } from './pipeline-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the session id a raw OpenCode event belongs to.
 *
 * The field location depends on `event.type`:
 * - `message.part.updated`: `properties.part.sessionID` (or the event
 *   properties fallback used by some OpenCode versions)
 * - `message.part.delta`: `properties.sessionID`
 * - `session.*`: `properties.info.id`
 * - everything else (`permission.asked`, `question.asked`, …): `properties.sessionID`
 */
function getRawEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case 'message.part.updated': {
      const part = event.properties?.part;
      return part?.sessionID
        ?? part?.sessionId
        ?? event.properties?.sessionID
        ?? event.properties?.sessionId;
    }
    case 'message.part.delta':
      return event.properties.sessionID
        ?? (event.properties as { sessionId?: string }).sessionId;
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return (event.properties as { info?: { id?: string } }).info?.id;
    default:
      return (event.properties as { sessionID?: string } | undefined)?.sessionID;
  }
}

/** Unwrap a stream envelope (`{ directory, payload }`) into a raw OpenCodeEvent. */
function unwrapOpenCodeStreamEvent(event: OpenCodeStreamEvent): OpenCodeEvent {
  return 'payload' in event ? event.payload : event;
}

function isSubagentProgressTitleUpdate(state: Partial<PipelineToolState>): boolean {
  const keys = Object.keys(state);
  return keys.length === 1 && keys[0] === 'title' && typeof state.title === 'string';
}

interface SystemNotice {
  title: string;
  output: string;
}

function normalizeBackendTitle(rawTitle: string): string | undefined {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!title || isPlaceholderBackendTitle(title)) {
    return undefined;
  }
  return title;
}

function isPlaceholderBackendTitle(title: string): boolean {
  return title === 'New OpenCode Session'
    || title.startsWith('OpenCode Session ')
    || title.startsWith('Session ');
}

function getSystemNotice(part: TextStreamPart): SystemNotice | undefined {
  return getSystemNoticeFromText(part.text);
}

function getSystemNoticeFromText(text: string | undefined): SystemNotice | undefined {
  const value = text ?? '';
  if (!value || !hasClosedSystemReminder(value)) {return undefined;}
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
// OpenCodePipeline
// ---------------------------------------------------------------------------

interface PipelineLogger { appendLine(message: string): void; }

type PartRouteKind = 'text' | 'reasoning' | 'ignored' | 'pendingSystemNotice' | 'systemNotice';
type StreamablePartKind = 'text' | 'reasoning';

type DeferredIdleOutcome = 'resolved' | 'timeout' | 'cancelled';

interface StreamNodeState {
  userMessageId: string | null;
  assistantStarted: boolean;
  partRoutes: Map<string, PartRouteKind>;
  pendingDeltas: Map<string, MessagePartDeltaEvent[]>;
  deltaText: Map<string, string>;
}

export class OpenCodePipeline implements BackendPipeline<OpenCodeStreamEvent> {
  private readonly sss: BackendPipelineStream;
  private readonly directory?: string;
  protected logger: PipelineLogger = { appendLine: () => {} };
  protected readonly sessionId: string;
  private readonly permissionMode: PermissionMode;
  private readonly allowUserInteraction: boolean;
  private readonly suppressTitleGeneration: boolean;

  // Event state
  protected userMessageId: string | null = null;
  protected partTargets = new Map<string, SessionStreamNode>();
  protected nodeStates = new WeakMap<SessionStreamNode, StreamNodeState>();
  protected sessionTitle: string | undefined;
  protected sessionTitleSource: SessionTitleSource | undefined;
  protected hadSubagentTasks = false;
  /** Set when the root backend reports a terminal session error. */
  protected terminalError = false;
  protected terminalErrorMessage: string | undefined;
  protected pendingChildEvents = new Map<string, OpenCodeEvent[]>();
  protected childSessionHints = new Map<string, string>();
  protected targetLabels = new WeakMap<SessionStreamNode, string>();
  protected externalEditIds = new Set<string>();

  // Subagent management
  protected subagents = new SubagentManager();

  // Deferred idle
  protected deferredIdle = false;
  protected static readonly DEFERRED_IDLE_TIMEOUT_MS = 120_000;
  protected deferredIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves the event loop while it is waiting for a child session update. */
  private deferredIdleWake: ((outcome: DeferredIdleOutcome) => void) | null = null;

  constructor(
    private readonly backend: Backend<unknown>,
    options: BackendPipelineOptions,
  ) {
    this.sessionId = options.sessionId;
    this.directory = options.directory;
    this.permissionMode = options.permissionMode ?? 'approval';
    this.allowUserInteraction = options.allowUserInteraction !== false;
    this.suppressTitleGeneration = options.suppressTitleGeneration === true;
    this.sss = options.stream;
    this.targetLabels.set(this.sss, `root sessionID=${this.sessionId}`);
    if (options.logger) {
      this.logger = options.logger;
      this.log = (msg: string) => options.logger!.appendLine(`[pipeline] ${msg}`);
    }
  }

  private log: (msg: string) => void = () => {};
  private logTag(tag: string, msg: string): void { this.log(`[${tag}] ${msg}`); }

  // ---------------------------------------------------------------------------
  // Event loop — consumes raw OpenCode events directly (no projection layer).
  // ---------------------------------------------------------------------------

  async run(events: AsyncIterable<OpenCodeStreamEvent>, token: BackendPipelineToken): Promise<BackendPipelineResult> {
    let completed = false;
    const iterator = events[Symbol.asyncIterator]();
    let nextPromise: Promise<IteratorResult<OpenCodeStreamEvent>> | undefined;
    let wakeResolver: ((outcome: DeferredIdleOutcome) => void) | null = null;
    const deferredIdleWake = new Promise<DeferredIdleOutcome>(resolve => {
      wakeResolver = resolve;
    });
    const wake = (outcome: DeferredIdleOutcome): void => {
      const resolve = wakeResolver;
      if (!resolve) {return;}
      wakeResolver = null;
      if (this.deferredIdleWake === wake) {
        this.deferredIdleWake = null;
      }
      resolve(outcome);
    };
    this.deferredIdleWake = wake;
    const cancellationTimer = setInterval(() => {
      if (token.isCancellationRequested) {
        wake('cancelled');
      }
    }, 25);
    if (token.isCancellationRequested) {
      wake('cancelled');
    }

    try {
      // Keep the iterator under our control. When the parent goes idle while a
      // child is still running, the source can remain blocked in `next()` with
      // no further event capable of waking this loop. The deferred-idle signal
      // races that pending read and lets child completion/timeout end the turn.
      while (!token.isCancellationRequested) {
        nextPromise = Promise.resolve().then(() => iterator.next());
        const outcome = await Promise.race([
          nextPromise.then(result => ({ type: 'event' as const, result })),
          deferredIdleWake.then(reason => ({ type: 'deferred-idle' as const, reason })),
        ]);

        if (outcome.type === 'deferred-idle') {
          // A safety timeout means the backend turn did not fully converge.
          // Report it as incomplete so the Copilot handler can surface/retry it
          // instead of recording a false successful completion.
          completed = outcome.reason === 'resolved' && !this.terminalError;
          break;
        }

        nextPromise = undefined;
        if (outcome.result.done) {break;}
        if (await this.handleEvent(unwrapOpenCodeStreamEvent(outcome.result.value))) {
          // `handleSessionIdle()` is a successful terminal boundary, while
          // `handleSessionError()` is terminal but incomplete. Keep those
          // outcomes distinct so a backend error cannot be reported as a
          // successful model invocation.
          completed = !this.terminalError;
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      this.log(`pipeline error: ${msg}`);
    } finally {
      clearInterval(cancellationTimer);
      this.clearDeferredIdleTimer();
      this.deferredIdle = false;
      if (this.deferredIdleWake === wake) {
        this.deferredIdleWake = null;
      }

      // If the loop was interrupted by a deferred signal, `nextPromise` may
      // still be waiting on the source. Request iterator cleanup, but do not
      // await it: async generators commonly queue `return()` behind that
      // pending read, and awaiting would deadlock the caller that closes the
      // session channel after pipeline completion.
      if (iterator.return) {
        try {
          const cleanup = Promise.resolve(iterator.return());
          if (nextPromise) {
            void cleanup.catch(() => undefined);
          } else {
            await cleanup.catch(() => undefined);
          }
        } catch {
          // Iterator cleanup is best effort; the backend channel is closed by
          // the owning Copilot turn after this method returns.
        }
      }
    }
    return {
      completed: completed && !this.terminalError && !token.isCancellationRequested,
      error: this.terminalErrorMessage,
      userMessageId: this.userMessageId,
      sessionTitle: this.sessionTitle ?? null,
      sessionTitleSource: this.sessionTitleSource ?? null,
      hadSubagentTasks: this.hadSubagentTasks,
    };
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  private async handleEvent(event: OpenCodeEvent): Promise<boolean | undefined> {
    // 1. Check if this is a child/descendant session event
    const eventSessionId = getRawEventSessionId(event);
    if (eventSessionId && eventSessionId !== this.sessionId) {
      this.logTag('route', `child -> ${this.describeEvent(event)}`);
      this.handleChildSessionEvent(event, eventSessionId);
      // A child session error belongs to the child scope.  It must not turn
      // the root pipeline into a terminal error or stop consuming parent
      // events: the parent agent may recover from, report, or replace the
      // failed task before its own session.idle boundary.
      return false;
    }

    // 2. Parent session events
    this.logTag('route', `root -> ${this.describeEvent(event)}`);
    switch (event.type) {
      case 'message.part.updated': this.handlePartUpdated(event); break;
      case 'message.part.delta':   this.handlePartDelta(event); break;
      case 'permission.asked':     this.handlePermissionAsked(event); break;
      case 'question.asked':       this.handleQuestionAsked(event); break;
      case 'session.updated':      await this.handleSessionUpdated(event); break;
      case 'session.created':      this.handleSessionCreated(event); break;
      case 'session.idle':         return this.handleSessionIdle();
      case 'session.error':        return this.handleSessionError(event);
      case 'session.diff':         this.handleSessionDiff(event); break;
      case 'session.status':       break; // log only
      default:                     break;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Append-only: text / reasoning deltas always push
  // ---------------------------------------------------------------------------

  private handlePartDelta(event: MessagePartDeltaEvent): void {
    const delta = event.properties.delta;
    if (!delta) {return;}
    this.renderDeltaToTarget(event, this.sss);
  }

  private handlePartUpdated(event: MessagePartUpdatedEvent): void {
    this.handlePartUpdatedForTarget(event, this.sss, true);
  }

  private handlePartUpdatedForTarget(
    event: MessagePartUpdatedEvent,
    target: SessionStreamNode,
    captureRootUserMessage: boolean,
  ): void {
    const part = event.properties.part;
    const eventSessionId = getRawEventSessionId(event);
    const nodeState = this.getNodeState(target);
    this.logTag('route', `part.updated target=${this.describeTarget(target)} captureRootUser=${captureRootUserMessage} part=${this.describePart(part)} eventSession=${eventSessionId ?? '<none>'}`);
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
              this.pushSystemNoticeTool(target, part, systemNotice, eventSessionId);
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
            messageId: part.messageID,
            sessionId: eventSessionId ?? part.sessionID,
            isComplete: true,
          }, `text complete partID=${part.id}`);
          return;
        }
        const systemNotice = getSystemNotice(part);
        if (systemNotice) {
          nodeState.partRoutes.set(part.id, 'systemNotice');
          this.partTargets.set(part.id, target);
          nodeState.pendingDeltas.delete(part.id);
          this.pushSystemNoticeTool(target, part, systemNotice, eventSessionId);
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
          this.logTag('route', `text ignored partID=${part.id} messageID=${part.messageID ?? '<none>'} target=${this.describeTarget(target)}`);
          return;
        }
        // User echo detection: before assistant output starts, the first text
        // message belongs to the user. Restored or user-echo-less streams may
        // begin directly with assistant text, so do not claim that id then.
        const hasInitialText = (part.text ?? '').length > 0;
        const hasBufferedDeltas = (nodeState.pendingDeltas.get(part.id)?.length ?? 0) > 0;
        if (!nodeState.assistantStarted && nodeState.userMessageId === null && part.messageID && hasInitialText && !hasBufferedDeltas) {
          nodeState.userMessageId = part.messageID;
          if (captureRootUserMessage) {
            this.userMessageId = part.messageID;
          }
          this.logTag('route', `text user candidate partID=${part.id} messageID=${part.messageID} target=${this.describeTarget(target)} captureRootUser=${captureRootUserMessage}`);
        }
        if (!nodeState.assistantStarted && hasInitialText && !hasBufferedDeltas && part.messageID && part.messageID === nodeState.userMessageId) {
          nodeState.partRoutes.set(part.id, 'ignored');
          this.partTargets.set(part.id, target);
          this.logTag('route', `text ignored user echo partID=${part.id} messageID=${part.messageID} target=${this.describeTarget(target)}`);
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
            messageId: part.messageID,
            sessionId: eventSessionId ?? part.sessionID,
          }, `text partID=${part.id}`);
        }
        break;
      }
      case 'reasoning': {
        // Skip if already routed; same dedup as text (see above)
        if (nodeState.partRoutes.has(part.id)) {
          this.partTargets.set(part.id, target);
          this.logTag('route', `part.updated duplicate reasoning partID=${part.id} target=${this.describeTarget(target)} action=keep-existing-route`);
          this.pushReasoning(target, {
            partId: part.id,
            text: '',
            messageId: part.messageID,
            sessionId: eventSessionId ?? part.sessionID,
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
          const sessionId = eventSessionId ?? part.sessionID;
          this.pushReasoning(target, {
            partId: part.id,
            text: initialDelta,
            messageId: part.messageID,
            sessionId,
          });
          this.appendDeltaText(target, part.id, initialDelta);
        } else if (!hadBufferedDelta) {
          this.logTag('route', `reasoning initial empty skipped partID=${part.id} target=${this.describeTarget(target)}`);
        }
        break;
      }
      case 'tool':
        this.logTag('route', `tool routed partID=${part.id} callID=${part.callID ?? part.id} tool=${part.tool} status=${part.state?.status ?? '<none>'} target=${this.describeTarget(target)}`);
        if (part.tool === 'task' || part.tool === 'subagent') {
          this.ensureRootSubagentScope(part, eventSessionId);
        }
        this.handleToolState(part, target, eventSessionId);
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

  private renderDeltaToTarget(event: MessagePartDeltaEvent, fallbackTarget: SessionStreamNode): void {
    const partId = event.properties.partID;
    const delta = event.properties.delta;
    const eventSessionId = event.properties.sessionID
      ?? (event.properties as { sessionId?: string }).sessionId;
    if (!delta) {return;}

    const target = this.partTargets.get(partId) ?? fallbackTarget;
    const targetState = this.getNodeState(target);
    const kind = targetState.partRoutes.get(partId);
    this.logTag('route', `delta partID=${partId} sessionID=${eventSessionId ?? '<none>'} kind=${kind ?? '<unrouted>'} target=${this.describeTarget(target)} fallback=${this.describeTarget(fallbackTarget)} text="${previewText(delta)}"`);
    if (kind === 'reasoning') {
      this.pushReasoning(target, {
        partId,
        text: delta,
        sessionId: eventSessionId,
      });
      this.logTag('route', `delta rendered reasoning partID=${partId} target=${this.describeTarget(target)}`);
      this.appendDeltaText(target, partId, delta);
    } else if (kind === 'text') {
      this.renderAssistantText(target, {
        partId,
        text: delta,
        sessionId: eventSessionId,
      }, `text delta partID=${partId}`);
      this.logTag('route', `delta rendered text partID=${partId} target=${this.describeTarget(target)}`);
    } else if (kind === 'ignored' || kind === 'pendingSystemNotice' || kind === 'systemNotice') {
      this.logTag('route', `delta ignored kind=${kind} partID=${partId} target=${this.describeTarget(target)}`);
    } else if (eventSessionId) {
      const pending = targetState.pendingDeltas.get(partId) ?? [];
      pending.push(event);
      targetState.pendingDeltas.set(partId, pending);
      this.logTag('route', `delta buffered partID=${partId} sessionID=${eventSessionId} target=${this.describeTarget(target)} pending=${pending.length}`);
    } else {
      this.logTag('route', `delta dropped unrouted partID=${partId} no event sessionID target=${this.describeTarget(target)}`);
    }
  }

  private flushPendingDeltas(partId: string, target: SessionStreamNode): boolean {
    const targetState = this.getNodeState(target);
    const pending = targetState.pendingDeltas.get(partId);
    if (!pending || pending.length === 0) {return false;}
    targetState.pendingDeltas.delete(partId);
    this.logTag('route', `flush pending deltas partID=${partId} count=${pending.length} target=${this.describeTarget(target)}`);
    for (const event of pending) {
      this.renderDeltaToTarget(event, target);
    }
    return true;
  }

  private appendDeltaText(target: SessionStreamNode, partId: string, delta: string): void {
    if (!delta) {return;}
    const targetState = this.getNodeState(target);
    targetState.deltaText.set(partId, (targetState.deltaText.get(partId) ?? '') + delta);
  }

  private renderAssistantText(
    target: SessionStreamNode,
    data: { partId: string; text: string; messageId?: string; sessionId?: string; isComplete?: boolean },
    _label: string,
  ): void {
    if (!data.text && !data.isComplete) {return;}
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
    part: TextStreamPart,
    notice: SystemNotice,
    eventSessionId: string | undefined,
  ): void {
    const callId = `system-${part.id}`;
    target.push(new ToolInvocationSSP({
      partId: part.id,
      toolName: notice.title,
      callId,
      messageId: part.messageID,
      sessionId: eventSessionId ?? part.sessionID,
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
    if (!data.text && !data.isComplete) {return;}
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
    if (!sessionId) {return undefined;}
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
    if (!sessionId || sessionId === this.sessionId) {return undefined;}
    return this.childSessionHints.get(sessionId) ?? this.sessionId;
  }

  private getDeltaText(target: SessionStreamNode, partId: string): string | undefined {
    return this.getNodeState(target).deltaText.get(partId);
  }

  private isAssistantTextPart(target: SessionStreamNode, partId: string | undefined): boolean {
    if (!partId) {return false;}
    return this.getNodeState(target).partRoutes.get(partId) === 'text';
  }

  private isReasoningPart(target: SessionStreamNode, partId: string | undefined): boolean {
    if (!partId) {return false;}
    return this.getNodeState(target).partRoutes.get(partId) === 'reasoning';
  }

  private updateScopeSummary(scope: SubagentScope, kind: StreamablePartKind, text: string | undefined): void {
    if (!text || !text.trim()) {return;}
    scope.lastText = text;
    if (kind === 'text') {
      scope.lastAssistantText = text;
    } else {
      scope.lastReasoningText = text;
    }
    this.logTag('subagent', `summary captured kind=${kind} scope=${this.describeScope(scope)} text="${previewText(text)}"`);
  }

  private ensureRootSubagentScope(part: StreamToolPart, sessionId: string | undefined): SubagentScope | undefined {
    if (part.tool !== 'task' && part.tool !== 'subagent') {return undefined;}
    const key = part.callID ?? part.id;
    let scope = this.subagents.getScope(key);
    if (!scope) {
      scope = this.subagents.startSubagent(key, {
        toolName: part.tool,
        title: getToolStateTitle(part.state) ?? '',
        input: part.state.input ?? {},
      });
      this.logTag('subagent', `scope started ${this.describeScope(scope)} from ${part.state.status} tool=${part.tool} sessionID=${sessionId ?? '<none>'}`);
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
    part: StreamToolPart,
    target: SessionStreamNode,
    eventSessionId = part.sessionID,
  ): void {
    const key = part.callID ?? part.id;
    const rawState = part.state;
    if (!rawState) {return;}

    const state = flattenToolState(rawState);
    const status = state.status;
    const sessionId = eventSessionId ?? part.sessionID;
    const eventScope = sessionId && sessionId !== this.sessionId
      ? this.findScopeForSession(sessionId)
      : undefined;
    const isKnownRootTool = target.has(key);
    const fallbackScope = eventScope ?? (!sessionId && !isKnownRootTool ? this.getActiveSubagentScope() : undefined);
    if (fallbackScope && !this.subagents.getScope(key) && part.tool !== 'task' && part.tool !== 'subagent') {
      this.handleSubagentToolPart(fallbackScope, part, sessionId);
      return;
    }

    // Write/edit tools: defer SSP creation until permission.asked creates ExternalEditSSP.
    // If permission never comes (auto-approve), create ToolInvocationSSP at completion.
    if (this.isWriteEditTool(part.tool)) {
      if (this.hasExternalEdit(key, target)) {
        // ExternalEditSSP exists: external edit path
        if (status === 'completed' || status === 'error') {
          this.completeExternalEdit(key, target);
        }
        return;
      }
      // No ExternalEditSSP yet; keep deferring at pending/running
      if (status === 'pending' || status === 'running') {return;}
      // completed/error without permission: fall through to normal tool handling
    }

    if (!target.has(key)) {
      // Task/subagent: start scope
      if (part.tool === 'task' || part.tool === 'subagent') {
        this.ensureRootSubagentScope(part, sessionId);
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.tool,
          callId: key,
          state,
          messageId: part.messageID,
          sessionId,
          subAgentId: key,
        }));
      } else {
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.tool,
          callId: key,
          state,
          messageId: part.messageID,
          sessionId,
        }));
      }
    } else {
      if (part.tool === 'task' || part.tool === 'subagent') {
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

  private completeScopeFromToolPart(part: StreamToolPart, sessionId: string | undefined): void {
    if (part.tool !== 'task' && part.tool !== 'subagent') {return;}
    const rawState = part.state;
    if (!rawState || (rawState.status !== 'completed' && rawState.status !== 'error')) {return;}

    const key = part.callID ?? part.id;
    const scope = this.subagents.getScope(key);
    if (!scope) {return;}

    this.ensureRootSubagentScope(part, sessionId);
    this.hadSubagentTasks = true;
    const output = rawState.status === 'completed' ? rawState.output : undefined;
    this.subagents.completeSubagent(key, output);
    this.logTag('subagent', `scope completed status=${rawState.status} ${this.describeScope(scope)} output="${previewText(output)}" childIdle=${!!scope.childIdle}`);
    if (scope.childIdle || rawState.status === 'error') {
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

  private handlePermissionAsked(event: PermissionAskedEvent, target: SessionStreamNode = this.sss): void {
    const permission = event.properties.permission;
    if (this.permissionMode === 'read-only' && isMutatingOpenCodePermission(permission)) {
      void this.backend.permissions.reply(
        event.properties.sessionID,
        event.properties.id,
        'reject',
        this.directory,
      );
      this.logTag('permission', `Rejected ${permission} in read-only mode`);
      return;
    }
    if (this.permissionMode === 'full-edit' || !this.allowUserInteraction) {
      // File edits still have to pass through ExternalEditSSP. Its callback is
      // the baseline barrier: replying before it completes can let the
      // backend mutate the file before VS Code has captured the undo baseline.
      this.startExternalEdit(event, target, () => {
        void this.replyPermission(event, 'once');
        const mode = this.permissionMode === 'full-edit' ? 'full-edit' : 'non-interactive LM';
        this.logTag('permission', `Automatically allowed ${permission} in ${mode} after baseline`);
      });
      return;
    }
    if (this.permissionMode === 'read-only') {
      void this.replyPermission(event, 'once');
      this.logTag('permission', `Automatically allowed ${permission} in read-only mode`);
      return;
    }
    this.startExternalEdit(event, target);
  }

  private replyPermission(event: PermissionAskedEvent, response: 'once' | 'always' | 'reject'): Promise<void> {
    return this.backend.permissions.reply(
      event.properties.sessionID,
      event.properties.id,
      response,
      this.directory,
    );
  }

  private startExternalEdit(
    event: PermissionAskedEvent,
    target: SessionStreamNode,
    onBaselineCaptured?: () => void,
  ): void {
    const props = event.properties;
    const callId = props.tool?.callID;
    const filepath = props.metadata?.filepath as string | undefined;

    if (!callId || !filepath) {
      if (onBaselineCaptured) {
        onBaselineCaptured();
      } else {
        this.requestPermissionChoice(event, target);
      }
      return;
    }

    this.markExternalEdit(callId, target);

    target.push(new ExternalEditSSP(
      {
        toolCallId: callId,
        editId: '',
        status: 'pending',
        uri: filepath,
      },
      {
        onBaselineCaptured: () => {
          if (onBaselineCaptured) {
            onBaselineCaptured();
          } else {
            this.requestPermissionChoice(event, target);
          }
        },
      },
      undefined,
      undefined,
      this.directory,
    ));
  }

  private requestPermissionChoice(event: PermissionAskedEvent, target: SessionStreamNode): void {
    const props = event.properties;
    const questionId = `permission:${props.id}`;
    target.push(new QuestionSSP(
      {
        questionId,
        questions: [{
          id: 'q_0',
          header: 'Permission',
          question: props.permission || 'Allow this operation?',
          options: [
            { label: 'Allow once', value: 'once' },
            { label: 'Always allow', value: 'always' },
            { label: 'Reject', value: 'reject' },
          ],
          custom: false,
        }],
        status: 'asked',
      },
      {
        onResult: result => {
          const response = getPermissionResponse(result);
          void this.backend.permissions.reply(
            props.sessionID,
            props.id,
            response,
            this.directory,
          );
        },
        onSkip: () => {
          void this.backend.permissions.reply(
            props.sessionID,
            props.id,
            'reject',
            this.directory,
          );
        },
      },
      { sessionId: props.sessionID, toolCallId: props.tool?.callID },
      questionId,
    ));
  }

  // ---------------------------------------------------------------------------
  // Question to QuestionSSP with callbacks
  // ---------------------------------------------------------------------------

  private handleQuestionAsked(event: QuestionAskedEvent): void {
    this.startQuestion(event, this.sss);
  }

  private startQuestion(event: QuestionAskedEvent, target: SessionStreamNode): void {
    const props = event.properties;
    const questions = props.questions;

    target.push(new QuestionSSP(
      {
        questionId: props.id,
        questions: questions as unknown[],
        status: 'asked',
      },
      {
        onResult: (vscodeRawResult) => {
          const answers = this.mapQuestionAnswers(vscodeRawResult, questions);
          void this.backend.questions.reply(
            props.sessionID,
            props.id,
            answers,
            this.directory,
          );
          target.update(props.id, { status: 'replied' });
        },
        onSkip: () => {
          void this.backend.questions.reject(
            props.sessionID,
            props.id,
            this.directory,
          );
          target.update(props.id, { status: 'skipped' });
        },
      },
    ));
  }

  /** Map VS Code questionCarousel result to OpenCode string[][] format */
  private mapQuestionAnswers(
    vscodeRaw: unknown,
    questions: QuestionInfo[],
  ): string[][] {
    const result = vscodeRaw as Record<string, unknown> | undefined;
    if (!result) {return questions.map(() => []);}

    return questions.map((_, i) => {
      const key = `q_${i}`;
      const answer = result[key];
      if (answer === undefined || answer === null) {return [];}

      if (typeof answer === 'string') {return [answer];}

      if (typeof answer === 'object' && answer !== null) {
        const obj = answer as Record<string, unknown>;
        if ('selectedValue' in obj) {
          if (obj.freeformValue && typeof obj.freeformValue === 'string') {return [obj.freeformValue];}
          const val = obj.selectedValue;
          return val !== undefined && val !== null ? [String(val)] : [];
        }
        if ('selectedValues' in obj && Array.isArray(obj.selectedValues)) {
          const selected = (obj.selectedValues as unknown[])
            .map(v => v !== undefined && v !== null ? String(v) : '')
            .filter(v => v !== '');
          if (obj.freeformValue && typeof obj.freeformValue === 'string') {selected.push(obj.freeformValue);}
          return selected;
        }
      }
      return [];
    });
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle events write metadata
  // ---------------------------------------------------------------------------

  private async handleSessionUpdated(event: OpenCodeEvent): Promise<void> {
    const info = (event.properties as { info?: { title?: string } } | undefined)?.info;
    if (info?.title && !this.suppressTitleGeneration) {
      await this.updateSessionTitle(info.title);
    } else if (info?.title) {
      this.logTag('title', 'skipped title generation for title-generation request');
    }
  }

  private async updateSessionTitle(rawTitle: string): Promise<void> {
    const title = normalizeBackendTitle(rawTitle);
    if (!title) {
      return;
    }

    const resolved = await SessionTitleService.resolveBackendTitleUpdate(
      {
        rawTitle: title,
        firstPrompt: this.sss.getFirstPrompt(),
      },
      this.logger,
      this.backend.modelProvider?.vendor,
    );
    if (!resolved.title) {
      this.logTag(
        'title',
        `ignored backend title="${previewText(title)}" reason=${resolved.reason ?? 'unusable'}`,
      );
      // Keep the backend value when generation is unavailable. This preserves
      // a stable title instead of leaving the session at its placeholder.
      if (resolved.reason === 'prompt-echo-generator-unavailable') {
        this.setSessionTitle(title, 'backend');
      }
      return;
    }

    this.setSessionTitle(resolved.title, resolved.source ?? 'backend');
  }

  private setSessionTitle(title: string, source: SessionTitleSource): void {
    const persisted = this.sss.updateTitle(title, source, { provisional: false });
    if (!persisted) {return;}
    this.sessionTitle = persisted;
    this.sessionTitleSource = source;
  }

  private handleSessionCreated(event: OpenCodeEvent): void {
    const info = (event.properties as { info?: { id?: string; parentID?: string; title?: string } } | undefined)?.info;
    if (info?.id && info?.parentID) {
      this.childSessionHints.set(info.id, info.parentID);
    }
  }

  private handleSessionDiff(event: OpenCodeEvent): void {
    const props = event.properties as { diff?: unknown[] } | undefined;
    if (props?.diff) {
      this.sss.writeMeta({
        changeSummary: { files: props.diff.length },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Session idle + deferred idle (wait for subagents)
  // ---------------------------------------------------------------------------

  private handleSessionIdle(): boolean {
    if (this.terminalError) {
      // Do not let a late idle overwrite the failed terminal state.
      this.sss.writeMeta({ status: 'failed' });
      this.subagents.clear();
      return true;
    }
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

  /**
   * A session error is a terminal backend boundary even when OpenCode does not
   * follow it with `session.idle`. Persist/render the error and stop consuming
   * the channel so native model requests cannot wait forever for a missing idle
   * event.
   */
  private handleSessionError(event: OpenCodeEvent): boolean {
    const properties = event.properties as {
      sessionID?: string;
      sessionId?: string;
      error?: unknown;
    } | undefined;
    const sessionId = properties?.sessionID
      ?? properties?.sessionId
      ?? this.sessionId;
    const error = formatOpenCodeError(properties?.error) ?? 'OpenCode session error';
    this.terminalError = true;
    this.terminalErrorMessage = error;
    this.sss.push(new SessionLifecycleSSP({
      eventType: 'session.error',
      sessionId,
      error,
    }));
    this.sss.writeMeta({ status: 'failed', error });
    this.deferredIdle = false;
    this.clearDeferredIdleTimer();
    this.subagents.clear();
    this.logTag('error', `session error sessionID=${sessionId} message="${previewText(error)}"`);
    return true;
  }

  private startDeferredIdleTimer(): void {
    this.clearDeferredIdleTimer();
    this.deferredIdleTimer = setTimeout(() => {
      this.deferredIdleTimer = null;
      if (!this.deferredIdle) {return;}
      this.logTag('idle', `deferred idle timeout (${OpenCodePipeline.DEFERRED_IDLE_TIMEOUT_MS / 1000}s); stopping`);
      this.deferredIdle = false;
      this.subagents.clear();
      this.signalDeferredIdle('timeout');
    }, OpenCodePipeline.DEFERRED_IDLE_TIMEOUT_MS);
  }

  private clearDeferredIdleTimer(): void {
    if (this.deferredIdleTimer) {
      clearTimeout(this.deferredIdleTimer);
      this.deferredIdleTimer = null;
    }
  }

  /** Check if deferred idle can be resolved (all subagents done) */
  private checkDeferredIdleResolution(): boolean {
    if (!this.deferredIdle) {return false;}
    if (!this.subagents.hasBusyDescendant()) {
      this.deferredIdle = false;
      this.clearDeferredIdleTimer();
      // Clean up completed scopes
      for (const scope of this.subagents.listScopes()) {
        if (scope.completed) {this.subagents.removeSubagent(scope.callId);}
      }
      this.signalDeferredIdle('resolved');
      return true;
    }
    // Reset safety timer on any activity
    this.startDeferredIdleTimer();
    return false;
  }

  private signalDeferredIdle(outcome: DeferredIdleOutcome): void {
    this.deferredIdleWake?.(outcome);
  }

  // ---------------------------------------------------------------------------
  // Child session event routing to subsession
  // ---------------------------------------------------------------------------

  private handleChildSessionEvent(event: OpenCodeEvent, eventSessionId: string): void {
    this.logTag('subagent', `child event start sessionID=${eventSessionId} ${this.describeEvent(event)}`);
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const info = (event.properties as { info?: { parentID?: string } } | undefined)?.info;
      if (info?.parentID) {
        this.childSessionHints.set(eventSessionId, info.parentID);
        this.logTag('subagent', `child hint sessionID=${eventSessionId} parentID=${info.parentID}`);
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
      const info = (event.properties as { info?: { title?: string } } | undefined)?.info;
      if (info?.title) {
        const target = this.getSubsessionStream(scope.subAgentInvocationId!);
        this.logTag('subagent', `child session.created write meta title="${info.title}" target=${this.describeTarget(target)} scope=${this.describeScope(scope)}`);
        target.writeMeta({ title: info.title, titleSource: 'backend' });
      }
      return;
    }

    const target = this.getSubsessionStream(scope.subAgentInvocationId!);
    this.logTag('subagent', `child event routed target=${this.describeTarget(target)} scope=${this.describeScope(scope)} ${this.describeEvent(event)}`);

    if (event.type === 'session.error') {
      this.handleChildSessionError(event, eventSessionId, scope, target);
      return;
    }

    if (event.type === 'permission.asked') {
      this.logTag('subagent', `child permission routed through permission policy target=${this.describeTarget(target)} permissionID=${event.properties.id}`);
      this.handlePermissionAsked(event, target);
      return;
    }

    if (event.type === 'question.asked') {
      this.logTag('subagent', `child question routed target=${this.describeTarget(target)} questionID=${event.properties.id}`);
      this.startQuestion(event, target);
      return;
    }

    if (event.type === 'session.updated') {
      const info = (event.properties as { info?: { title?: string } } | undefined)?.info;
      if (info?.title) {
        this.logTag('subagent', `child session.updated write meta title="${info.title}" target=${this.describeTarget(target)}`);
        target.writeMeta({ title: info.title, titleSource: 'backend' });
      }
      return;
    }

    if (event.type === 'session.diff') {
      const diff = (event.properties as { diff?: unknown[] }).diff;
      if (diff) {
        this.logTag('subagent', `child session.diff write meta files=${diff.length} target=${this.describeTarget(target)}`);
        target.writeMeta({ changeSummary: { files: diff.length } });
      }
      return;
    }

    if (event.type === 'session.status') {
      const status = (event.properties as { status?: unknown }).status;
      this.logTag('subagent', `child session.status write meta status=${JSON.stringify(status)} target=${this.describeTarget(target)}`);
      target.writeMeta({ status });
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
    if (event.type === 'message.part.updated') {
      const part = event.properties.part;
      if (part.type === 'tool') {
        const toolPart = part;
        this.logTag('subagent', `child tool captured tool=${toolPart.tool} callID=${toolPart.callID ?? toolPart.id} status=${toolPart.state?.status ?? '<none>'} scope=${this.describeScope(scope)}`);
        this.handleSubagentToolPart(scope, toolPart, eventSessionId);
        return;
      }

      this.handlePartUpdatedForTarget(event, target, false);
      // Capture child text/reasoning for the parent subagent card result.
      if (part.type === 'text' || part.type === 'reasoning') {
        const streamPart = part as TextStreamPart | ReasoningStreamPart;
        const isCapturedPart = part.type === 'text'
          ? this.isAssistantTextPart(target, streamPart.id)
          : this.isReasoningPart(target, streamPart.id);
        if (isCapturedPart) {
          const streamedText = streamPart.id ? this.getDeltaText(target, streamPart.id) : undefined;
          this.updateScopeSummary(scope, part.type, streamedText ?? streamPart.text);
        } else {
          this.logTag('subagent', `child ${part.type} not captured partID=${streamPart.id ?? '<none>'} route=${streamPart.id ? this.getNodeState(target).partRoutes.get(streamPart.id) ?? '<none>' : '<none>'} target=${this.describeTarget(target)}`);
        }
      }
      return;
    }

    if (event.type === 'message.part.delta') {
      this.renderDeltaToTarget(event, target);
      const partId = event.properties.partID;
      const kind = this.isAssistantTextPart(target, partId)
        ? 'text'
        : this.isReasoningPart(target, partId)
          ? 'reasoning'
          : undefined;
      const text = kind
        ? this.getDeltaText(target, partId)
        : undefined;
      if (kind) {
        this.updateScopeSummary(scope, kind, text);
      }
      if (!text) {
        this.logTag('subagent', `child delta no summary partID=${partId} route=${this.getNodeState(target).partRoutes.get(partId) ?? '<none>'} target=${this.describeTarget(target)}`);
      }
      return;
    }
  }

  /**
   * Resolve a child session error as a terminal failed turn. OpenCode may emit
   * this event without a matching child idle (and sometimes without a parent
   * task update), so leaving the scope active would keep deferred idle waiting
   * until its safety timeout.
   */
  private handleChildSessionError(
    event: OpenCodeEvent,
    eventSessionId: string,
    scope: SubagentScope,
    target: SessionStreamNode,
  ): void {
    const properties = event.properties as {
      sessionID?: string;
      sessionId?: string;
      error?: unknown;
    } | undefined;
    const error = formatOpenCodeError(properties?.error) ?? 'OpenCode session error';

    scope.descendantSessionIds.add(eventSessionId);
    this.recordAncestorDescendantSessions(scope, eventSessionId);
    // Keep the child record truthful.  A failed child task is local to its
    // scope; the parent may continue producing events and complete normally.
    target.writeMeta({ status: 'failed', error });
    target.push(new SessionLifecycleSSP({
      eventType: 'session.error',
      sessionId: properties?.sessionID ?? properties?.sessionId ?? eventSessionId,
      error,
    }));

    const failedScope = this.subagents.failSubagent(scope.callId, error);
    if (failedScope) {
      this.finalizeScopeTool(failedScope);
    }
    // If root idle was already deferred on this scope, its terminal error is a
    // valid resolution of that wait.  Otherwise leave the iterator alone so
    // subsequent parent events are consumed instead of being truncated.
    if (this.deferredIdle) {
      this.checkDeferredIdleResolution();
    }
    this.logTag('error', `child session error sessionID=${eventSessionId} message="${previewText(error)}" scope=${this.describeScope(scope)}`);
  }

  private findScopeForSession(sessionId: string): SubagentScope | undefined {
    return this.subagents.findScopeForSession(sessionId);
  }

  private findBindableScopeForChildSession(sessionId: string): SubagentScope | undefined {
    const parentId = this.childSessionHints.get(sessionId);
    const unbound = this.subagents.listScopes().filter(scope => !scope.childSessionId);
    if (unbound.length === 0) {return undefined;}

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
    if (scope.childSessionId === childSessionId) {return;}
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

  private bufferChildEvent(sessionId: string, event: OpenCodeEvent): void {
    const existing = this.pendingChildEvents.get(sessionId) ?? [];
    existing.push(event);
    this.pendingChildEvents.set(sessionId, existing);
    this.logTag('subagent', `pending child buffer sessionID=${sessionId} count=${existing.length} ${this.describeEvent(event)}`);
  }

  private drainPendingChildEvents(sessionId: string): void {
    const pending = this.pendingChildEvents.get(sessionId);
    if (!pending || pending.length === 0) {return;}
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
      if (!parent) {break;}
      depth += 1;
      current = parent;
    }
    return depth;
  }

  private handleSubagentToolPart(
    scope: SubagentScope,
    toolPart: StreamToolPart,
    eventSessionId = toolPart.sessionID,
  ): void {
    const childCallId = toolPart.callID ?? toolPart.id;
    const rawState = toolPart.state;
    const childStatus = rawState?.status ?? 'running';
    const sub = this.getSubsessionStream(scope.subAgentInvocationId!);
    this.logTag('subagent', `child tool route scope=${this.describeScope(scope)} target=${this.describeTarget(sub)} tool=${toolPart.tool} callID=${childCallId} status=${childStatus} eventSession=${eventSessionId ?? '<none>'}`);

    // Write/edit tools: defer until permission.asked creates ExternalEditSSP.
    if (this.isWriteEditTool(toolPart.tool)) {
      if (this.hasExternalEdit(childCallId, sub)) {
        if (childStatus === 'completed' || childStatus === 'error') {
          this.completeExternalEdit(childCallId, sub);
          this.subagents.recordChildToolCall(scope.callId, {
            name: toolPart.tool,
            title: getToolStateTitle(rawState),
            status: childStatus,
          });
          this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
        }
        return;
      }
      // No ExternalEditSSP yet; keep deferring at pending/running
      if (childStatus === 'pending' || childStatus === 'running') {return;}
      // completed/error without permission: fall through to normal handling
    }
    let nestedScope: SubagentScope | undefined;
    if (toolPart.tool === 'task' || toolPart.tool === 'subagent') {
      nestedScope = this.subagents.getScope(childCallId);
      if (!nestedScope) {
        nestedScope = this.subagents.startSubagent(
          childCallId,
          {
            toolName: toolPart.tool,
            title: getToolStateTitle(rawState) ?? '',
            input: rawState?.input ?? {},
          },
          scope.subAgentInvocationId,
        );
        this.logTag('subagent', `nested scope started ${this.describeScope(nestedScope)} parent=${this.describeScope(scope)}`);
      }
      const childSessionId = this.getToolSessionId(rawState);
      if (childSessionId) {
        this.bindScopeToChildSession(nestedScope, childSessionId);
      }
    }
    const flatState = rawState ? flattenToolState(rawState) : undefined;
    const payload = {
      partId: `subagent-child-${childCallId}`,
      toolName: toolPart.tool,
      callId: childCallId,
      state: flatState!,
      messageId: toolPart.messageID,
      sessionId: eventSessionId,
      subAgentId: scope.subAgentInvocationId,
      subAgentInvocationId: scope.subAgentInvocationId,
    };

    const isFirstChildToolEvent = !sub.has(childCallId);
    if (isFirstChildToolEvent) {
      sub.push(new ToolInvocationSSP(payload));
      this.logTag('subagent', `child tool push callID=${childCallId} subAgentInvocationId=${scope.subAgentInvocationId ?? '<none>'}`);
    } else {
      const updateState = flatState ?? {};
      sub.update(childCallId, { state: updateState });
      this.logTag('subagent', `child tool update callID=${childCallId} subAgentInvocationId=${scope.subAgentInvocationId ?? '<none>'}`);
    }

    if (childStatus === 'completed' || childStatus === 'error') {
      if (nestedScope) {
        const output = rawState?.status === 'completed' ? rawState.output : undefined;
        this.subagents.completeSubagent(childCallId, output);
      }
      this.subagents.recordChildToolCall(scope.callId, {
        name: toolPart.tool,
        title: getToolStateTitle(rawState),
        status: childStatus,
      });
      this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
    }
  }

  private updateScopeTool(scope: SubagentScope, state: Partial<PipelineToolState>): void {
    const renderMode = isSubagentProgressTitleUpdate(state) ? 'updateOnly' : undefined;
    const target = scope.parentSubAgentInvocationId
      ? this.getSubsessionStream(scope.parentSubAgentInvocationId)
      : this.sss;
    this.logTag('subagent', `update scope tool callID=${scope.callId} target=${this.describeTarget(target)} state=${this.describeToolStatePatch(state)} scope=${this.describeScope(scope)}`);
    target.update(scope.callId, { state, renderMode });
  }

  private finalizeScopeTool(scope: SubagentScope): void {
    const failed = scope.failed === true;
    const output = failed
      ? scope.error ?? scope.output ?? ''
      : scope.lastAssistantText?.trim() || scope.output || '';
    this.logTag('subagent', `finalize scope ${this.describeScope(scope)} output="${previewText(output)}" progress="${formatSubagentProgress(scope)}"`);
    this.updateScopeTool(scope, {
      status: failed ? 'error' : 'completed',
      output,
      ...(failed && scope.error ? { error: scope.error } : {}),
      title: formatSubagentProgress(scope) || scope.toolMeta?.title,
    });
  }

  private recordAncestorDescendantSessions(scope: SubagentScope | undefined, sessionId: string): void {
    let current = scope;
    while (current?.parentSubAgentInvocationId) {
      const parent = this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId);
      if (!parent) {return;}
      this.subagents.addDescendantSession(parent.callId, sessionId);
      current = parent;
    }
  }

  private getSubsessionStream(subAgentInvocationId: string): SessionStreamNode {
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

  private getToolSessionId(state: StreamToolState | undefined): string | undefined {
    if (!state || state.status === 'pending') {return undefined;}
    const raw = state.metadata?.sessionId ?? state.metadata?.sessionID;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private isWriteEditTool(toolName: string): boolean {
    return toolName === 'write' || toolName === 'edit';
  }

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

  private describeEvent(event: OpenCodeEvent): string {
    const sessionId = getRawEventSessionId(event);
    switch (event.type) {
      case 'message.part.updated':
        return `type=message.part.updated eventSession=${sessionId ?? '<none>'} ${this.describePart(event.properties.part)}`;
      case 'message.part.delta':
        return `type=message.part.delta sessionID=${event.properties.sessionID ?? '<none>'} partID=${event.properties.partID} field=${event.properties.field ?? '<none>'} text="${previewText(event.properties.delta)}"`;
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'session.error': {
        const info = (event.properties as { info?: { parentID?: string; title?: string } }).info;
        return `type=${event.type} sessionID=${sessionId ?? '<none>'} parentID=${info?.parentID ?? '<none>'} title="${previewText(info?.title)}"`;
      }
      case 'session.idle':
        return `type=session.idle sessionID=${sessionId ?? '<none>'}`;
      case 'session.status': {
        const status = (event.properties as { status?: unknown }).status;
        return `type=session.status sessionID=${sessionId ?? '<none>'} status=${JSON.stringify(status)}`;
      }
      case 'session.diff': {
        const diff = (event.properties as { diff?: unknown[] }).diff;
        return `type=session.diff sessionID=${sessionId ?? '<none>'} files=${diff?.length ?? 0}`;
      }
      case 'permission.asked':
        return `type=permission.asked sessionID=${event.properties.sessionID} permissionID=${event.properties.id} toolCallID=${event.properties.tool?.callID ?? '<none>'}`;
      case 'question.asked':
        return `type=question.asked sessionID=${event.properties.sessionID} questionID=${event.properties.id}`;
      default:
        return `type=${event.type}`;
    }
  }

  private describePart(part: MessagePartUpdatedEvent['properties']['part']): string {
    if (part.type === 'tool') {
      return `partType=tool partID=${part.id} callID=${part.callID ?? part.id} tool=${part.tool} status=${part.state?.status ?? '<none>'} partSession=${part.sessionID ?? '<none>'} title="${previewText(getToolStateTitle(part.state))}"`;
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      return `partType=${part.type} partID=${part.id} messageID=${part.messageID ?? '<none>'} partSession=${part.sessionID ?? '<none>'} text="${previewText(part.text)}"`;
    }
    return `partType=${part.type} partID=${part.id} messageID=${part.messageID ?? '<none>'} partSession=${part.sessionID ?? '<none>'}`;
  }

  private describeToolStatePatch(state: Partial<PipelineToolState>): string {
    return [
      state.status ? `status=${state.status}` : '',
      state.title ? `title="${previewText(state.title)}"` : '',
      state.output ? `output="${previewText(state.output)}"` : '',
    ].filter(Boolean).join(' ') || JSON.stringify(state);
  }
}

function getPermissionResponse(result: unknown): 'once' | 'always' | 'reject' {
  if (!result || typeof result !== 'object') {return 'reject';}

  const answer = (result as Record<string, unknown>).q_0;
  if (typeof answer === 'string') {
    return answer === 'once' || answer === 'always' ? answer : 'reject';
  }
  if (!answer || typeof answer !== 'object') {return 'reject';}

  const selected = (answer as Record<string, unknown>).selectedValue;
  return selected === 'once' || selected === 'always' ? selected : 'reject';
}

function isMutatingOpenCodePermission(permission: string | undefined): boolean {
  return permission === 'edit'
    || permission === 'write'
    || permission === 'patch'
    || permission === 'multiedit'
    || permission === 'bash'
    || permission === 'task'
    || permission === 'external_directory';
}

function previewText(text: unknown, maxLen = 80): string {
  if (text === undefined || text === null) {return '';}
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length > maxLen ? normalized.slice(0, maxLen - 3) + '...' : normalized;
}

/** Extract a useful message from the SDK's structured session error payload. */
function formatOpenCodeError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {return value;}
  if (value instanceof Error && value.message.trim()) {return value.message;}
  if (!value || typeof value !== 'object') {return undefined;}

  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object') {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {return message;}
  }
  if (typeof record.message === 'string' && record.message.trim()) {return record.message;}
  if (typeof record.name === 'string' && record.name.trim()) {return record.name;}
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== '{}' ? serialized : undefined;
  } catch {
    return String(value);
  }
}
