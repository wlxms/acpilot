import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  BackendPipelineOptions,
} from '../../backend/backend';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { AcpPipeline } from '../acp/pipeline';
import { resolveToolCallPath } from '../acp/filepath-resolver';
const DSH_BRIDGE_PERMISSION_WAIT_MS = 1_500;
const DSH_BRIDGE_TOOL_WAIT_MS = 100;
const DSH_BRIDGE_CACHE_LIMIT = 256;

interface DeferredAcpToolCall {
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;
  eventSessionId: string | null | undefined;
  updates: Array<{
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;
    eventSessionId: string | null | undefined;
  }>;
  timer?: ReturnType<typeof setTimeout>;
}

import type {
  DshBridgePresentation,
  DshBridgeToolCallMessage,
  DshBridgeToolMessage,
  DshBridgeToolResultMessage,
} from './bridge-protocol';

/**

 * DSH's ACP stream intentionally stays generic. This pipeline consumes the
 * optional stderr bridge as a second, presentation-only data plane and merges
 * it into the same SSPs used by OpenCode and ordinary ACP agents.
 */
export class DshPipeline extends AcpPipeline {
  private readonly observedAcpToolCalls = new Set<string>();
  private readonly bridgeCalls = new Map<string, DshBridgeToolCallMessage>();
  private readonly bridgeResults = new Map<string, DshBridgeToolResultMessage>();
  private readonly bridgePermissionWaiters = new Map<string, Set<(message: DshBridgeToolCallMessage) => void>>();
  private readonly pendingAcpToolCalls = new Map<string, DeferredAcpToolCall>();
  private readonly deferredDiffToolCalls = new Set<string>();
  private disposed = false;

  constructor(options: BackendPipelineOptions) {
    super(options);
  }

  /** Called by DshBackend when one bridge line is received from the user's DSH process. */
  handleBridgeMessage(message: DshBridgeToolMessage): void {
    if (this.disposed || message.sessionId !== this.sessionId) {return;}
    if (message.type === 'tool_call') {
      this.bridgeCalls.set(message.toolCallId, message);
      trimMap(this.bridgeCalls);
      this.flushPendingAcpToolCall(message.toolCallId);
      this.applyBridgeCall(message);
      const waiters = this.bridgePermissionWaiters.get(message.toolCallId);
      if (waiters) {
        this.bridgePermissionWaiters.delete(message.toolCallId);
        for (const resolve of waiters) {resolve(message);}
      }
      const result = this.bridgeResults.get(message.toolCallId);
      if (result) {this.applyBridgeResult(result);}
      return;
    }

    this.bridgeResults.set(message.toolCallId, message);
    trimMap(this.bridgeResults);
    // A result-only event still releases a queued ACP call promptly. This is
    // the path used when a policy listener rejects before the bridge's
    // pre-execute listener can emit a call presentation.
    if (!this.bridgeCalls.has(message.toolCallId)) {
      this.flushPendingAcpToolCall(message.toolCallId);
    }
    this.applyBridgeResult(message);
  }

  /** Drop pending ACP fallback state when the owning backend is replaced. */
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pendingAcpToolCalls.values()) {
      if (pending.timer !== undefined) {clearTimeout(pending.timer);}
    }
    this.pendingAcpToolCalls.clear();
    this.bridgePermissionWaiters.clear();
    this.bridgeCalls.clear();
    this.bridgeResults.clear();
    this.observedAcpToolCalls.clear();
    this.deferredDiffToolCalls.clear();
  }

  protected override beforeStop(): void {
    for (const toolCallId of [...this.pendingAcpToolCalls.keys()]) {
      this.flushPendingAcpToolCall(toolCallId);
    }
  }

  /**
   * DSH request_permission currently carries only a toolCallId. Rehydrate the
   * tool facts from the bridge before AcpPipeline creates ExternalEditSSP.
   */
  override async resolvePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    let bridgeCall = this.bridgeCalls.get(params.toolCall.toolCallId);
    if (!bridgeCall && (shouldWaitForBridge(params)
      || (this.pendingAcpToolCalls.has(params.toolCall.toolCallId) && !isReadOnlyPermissionKind(params.toolCall.kind)))) {
      bridgeCall = await this.waitForBridgeCall(params.toolCall.toolCallId);
    }
    if (!bridgeCall) {
      this.flushPendingAcpToolCall(params.toolCall.toolCallId);
      return super.resolvePermission(params);
    }

    const presentation = bridgeCall.presentation;
    const toolCall = {
      ...params.toolCall,
      title: presentationTitle(presentation) ?? params.toolCall.title ?? bridgeCall.toolName,
      kind: presentationKind(presentation) ?? params.toolCall.kind,
      rawInput: bridgeCall.rawInput ?? params.toolCall.rawInput ?? presentationInput(presentation),
      locations: mergeToolLocations(params.toolCall.locations, presentationLocations(presentation)),
    };
    return super.resolvePermission({ ...params, toolCall });
  }

  private waitForBridgeCall(toolCallId: string): Promise<DshBridgeToolCallMessage | undefined> {
    const current = this.bridgeCalls.get(toolCallId);
    if (current) {return Promise.resolve(current);}
    return new Promise(resolve => {
      const waiters = this.bridgePermissionWaiters.get(toolCallId) ?? new Set();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (message?: DshBridgeToolCallMessage): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        waiters.delete(finish);
        if (waiters.size === 0) {this.bridgePermissionWaiters.delete(toolCallId);}
        resolve(message);
      };
      waiters.add(finish);
      this.bridgePermissionWaiters.set(toolCallId, waiters);
      timer = setTimeout(() => finish(), DSH_BRIDGE_PERMISSION_WAIT_MS);
    });
  }

  /** A diff presentation is handled by ExternalEditSSP when permission gates it. */
  protected override shouldDeferToolCall(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  ): boolean {
    const bridgeCall = this.bridgeCalls.get(update.toolCallId);
    return bridgeCall?.presentation.card === 'diff';
  }

  /**
   * Keep ACP tool calls pending until the optional bridge identifies them or ACP
   * supplies a terminal update. This prevents a late diff presentation from
   * creating a second card after the generic ACP card was already rendered.
   */
  protected override handleSessionUpdate(
    update: SessionUpdate,
    eventSessionId: string | null | undefined,
  ): void {
    if (update.sessionUpdate === 'tool_call') {
      this.observedAcpToolCalls.add(update.toolCallId);
      trimSet(this.observedAcpToolCalls);
      this.deferAcpToolCall(update, eventSessionId);
      return;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      this.observedAcpToolCalls.add(update.toolCallId);
      trimSet(this.observedAcpToolCalls);
      const pending = this.pendingAcpToolCalls.get(update.toolCallId);
      if (pending) {
        pending.updates.push({ update, eventSessionId });
        if ((update.status === 'completed' || update.status === 'failed')
          && !this.bridgeCalls.has(update.toolCallId)
          && !this.bridgeResults.has(update.toolCallId)) {
          this.flushPendingAcpToolCall(update.toolCallId);
        }
        return;
      }
      if (this.deferredDiffToolCalls.has(update.toolCallId)) {
        this.applyDeferredDiffUpdate(update);
        return;
      }
    }

    this.dispatchAcpUpdate(update, eventSessionId);
  }

  private deferAcpToolCall(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
    eventSessionId: string | null | undefined,
  ): void {
    const existing = this.pendingAcpToolCalls.get(update.toolCallId);
    if (existing) {
      if (existing.timer !== undefined) {clearTimeout(existing.timer);}
      this.pendingAcpToolCalls.delete(update.toolCallId);
    }
    const pending: DeferredAcpToolCall = {
      update,
      eventSessionId,
      updates: [],
    };
    if (shouldRenderGenericBeforeBridge(update)) {
      pending.timer = setTimeout(() => this.flushPendingAcpToolCall(update.toolCallId), DSH_BRIDGE_TOOL_WAIT_MS);
    }
    this.pendingAcpToolCalls.set(update.toolCallId, pending);
    if (this.bridgeCalls.has(update.toolCallId) || this.bridgeResults.has(update.toolCallId)) {
      this.flushPendingAcpToolCall(update.toolCallId);
    }
  }

  private flushPendingAcpToolCall(toolCallId: string): void {
    const pending = this.pendingAcpToolCalls.get(toolCallId);
    if (!pending) {return;}
    if (pending.timer !== undefined) {clearTimeout(pending.timer);}
    this.pendingAcpToolCalls.delete(toolCallId);
    if (this.bridgeCalls.get(toolCallId)?.presentation.card === 'diff') {
      this.deferredDiffToolCalls.add(toolCallId);
    }
    this.dispatchAcpUpdate(pending.update, pending.eventSessionId);
    for (const buffered of pending.updates) {
      if (this.deferredDiffToolCalls.has(toolCallId)) {
        this.applyDeferredDiffUpdate(buffered.update);
      } else {
        this.dispatchAcpUpdate(buffered.update, buffered.eventSessionId);
      }
    }
  }

  private dispatchAcpUpdate(update: SessionUpdate, eventSessionId: string | null | undefined): void {
    if (update.sessionUpdate === 'tool_call_update' && this.deferredDiffToolCalls.has(update.toolCallId)) {
      this.applyDeferredDiffUpdate(update);
      return;
    }
    super.handleSessionUpdate(update, eventSessionId);
    if (update.sessionUpdate === 'tool_call') {
      const bridgeCall = this.bridgeCalls.get(update.toolCallId);
      if (bridgeCall) {
        this.applyBridgeCall(bridgeCall);
        const result = this.bridgeResults.get(update.toolCallId);
        if (result) {this.applyBridgeResult(result);}
      }
      return;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const result = this.bridgeResults.get(update.toolCallId);
      if (result) {this.applyBridgeResult(result);}
    }
  }

  private applyDeferredDiffUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  ): void {
    if (update.status !== 'completed' && update.status !== 'failed') {return;}
    const externalEditId = `external-edit-${update.toolCallId}`;
    if (this.sss.has(externalEditId)) {
      this.sss.update(externalEditId, {
        status: update.status === 'failed' ? 'error' : 'completed',
        error: update.status === 'failed' ? dshToolOutputToText(update) : undefined,
      });
    } else {
      const bridgeCall = this.bridgeCalls.get(update.toolCallId);
      if (bridgeCall && !this.sss.has(update.toolCallId)) {
        const presentation = bridgeCall.presentation;
        const output = dshToolOutputToText(update);
        this.sss.push(new ToolInvocationSSP({
          partId: update.toolCallId,
          toolName: displayToolName(bridgeCall.toolName, presentation),
          callId: update.toolCallId,
          state: {
            status: update.status === 'failed' ? 'error' : 'completed',
            input: presentationInput(presentation, bridgeCall.rawInput),
            title: presentationTitle(presentation) ?? bridgeCall.toolName,
            originalToolName: bridgeCall.toolName,
            output,
            error: update.status === 'failed' ? output : undefined,
            metadata: presentationMetadata(bridgeCall.toolName, presentation),
          },
          sessionId: bridgeCall.sessionId,
        }));
      }
    }
    this.deferredDiffToolCalls.delete(update.toolCallId);
    this.clearExternalEditTracking(update.toolCallId);

    // A bridge result may have arrived before the ACP terminal update. Apply it
    // after the fallback card is created, or update ExternalEditSSP when the
    // permission path already owns the call.
    const result = this.bridgeResults.get(update.toolCallId);
    if (result) {this.applyBridgeResult(result);}
  }

  private applyBridgeCall(message: DshBridgeToolCallMessage): void {
    const partId = message.toolCallId;
    if (!this.sss.has(partId)) {return;}
    const presentation = message.presentation;
    const input = presentationInput(presentation, message.rawInput);
    const title = presentationTitle(presentation) ?? message.toolName;
    this.sss.update(partId, {
      toolName: displayToolName(message.toolName, presentation),
      state: {
        input,
        title,
        originalToolName: message.toolName,
        metadata: presentationMetadata(message.toolName, presentation),
      },
    });
  }

  private applyBridgeResult(message: DshBridgeToolResultMessage): void {
    const call = this.bridgeCalls.get(message.toolCallId);
    const callPresentation = call?.presentation;
    const presentation = message.presentation ?? callPresentation;
    const input = presentationInput(presentation, call?.rawInput);
    const title = presentationTitle(presentation) ?? call?.toolName ?? message.toolName;
    const output = bridgeOutputText(message, presentation);
    const status = message.isError ? 'error' : 'completed';
    const metadata = presentationMetadata(message.toolName, presentation, message);

    const externalEditId = `external-edit-${message.toolCallId}`;
    if (this.sss.has(externalEditId)) {
      this.sss.update(externalEditId, {
        status,
        error: message.isError ? output : undefined,
      });
      this.clearExternalEditTracking(message.toolCallId);
    }

    const partId = message.toolCallId;
    // A diff is represented by ExternalEditSSP when permission gating is
    // active. Before the ACP terminal update arrives, keep the deferred call
    // hidden so a later permission request cannot create a duplicate card.
    if (presentation?.card === 'diff' && !this.sss.has(partId)) {return;}
    if (this.sss.has(partId)) {
      this.sss.update(partId, {
        toolName: displayToolName(message.toolName, presentation),
        state: {
          status,
          input,
          title,
          originalToolName: message.toolName,
          output,
          error: message.isError ? output : undefined,
          metadata,
        },
      });
      return;
    }

    if (!this.observedAcpToolCalls.has(message.toolCallId)) {
      return;
    }

    // If DSH did not ask for permission, a deferred diff call still needs a
    // terminal SSP at completion. This also makes a bridge-only update useful
    // for an already-running endpoint whose ACP tool event was missed.
    this.sss.push(new ToolInvocationSSP({
      partId,
      toolName: displayToolName(message.toolName, presentation),
      callId: message.toolCallId,
      state: {
        status,
        input,
        title,
        originalToolName: message.toolName,
        output,
        error: message.isError ? output : undefined,
        metadata,
      },
      sessionId: message.sessionId,
    }));
  }
}

function trimMap<T>(value: Map<string, T>): void {
  while (value.size > DSH_BRIDGE_CACHE_LIMIT) {
    const oldest = value.keys().next().value;
    if (typeof oldest !== 'string') {return;}
    value.delete(oldest);
  }
}

function trimSet(value: Set<string>): void {
  while (value.size > DSH_BRIDGE_CACHE_LIMIT) {
    const oldest = value.values().next().value;
    if (typeof oldest !== 'string') {return;}
    value.delete(oldest);
  }
}

function shouldWaitForBridge(params: RequestPermissionRequest): boolean {
  const toolCall = params.toolCall;
  if (toolCall.kind === 'edit' || toolCall.kind === 'delete' || toolCall.kind === 'move') {
    return true;
  }
  const hasLocation = resolveToolCallPath(toolCall.rawInput)
    ?? toolCall.locations?.find(location => typeof location.path === 'string')?.path;
  if (hasLocation && !isReadOnlyPermissionKind(toolCall.kind)) {
    return true;
  }
  return toolCall.rawInput === undefined
    && (toolCall.kind === undefined || toolCall.kind === null || toolCall.kind === 'other')
    && !toolCall.title;
}

function isReadOnlyPermissionKind(kind: RequestPermissionRequest['toolCall']['kind']): boolean {
  return kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch';
}

type AcpToolCall = Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;

function shouldRenderGenericBeforeBridge(update: AcpToolCall): boolean {
  switch (update.kind) {
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
    case 'execute':
      return true;
    case 'edit':
    case 'delete':
    case 'move':
      return false;
    default:
      break;
  }

  const title = (update.title ?? '').toLowerCase();
  if (/(read|search|grep|glob|list|find|fetch|bash|shell|pwsh|exec|command|terminal)/u.test(title)) {
    return true;
  }
  return false;
}

function dshToolOutputToText(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
): string | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presentationTitle(presentation: DshBridgePresentation | undefined): string | undefined {
  const title = presentation?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}
type DshAcpToolKind = NonNullable<RequestPermissionRequest['toolCall']['kind']>;

function isDshAcpToolKind(value: unknown): value is DshAcpToolKind {
  return value === 'read' || value === 'edit' || value === 'delete' || value === 'move'
    || value === 'search' || value === 'execute' || value === 'fetch' || value === 'think' || value === 'other';
}

function presentationKind(presentation: DshBridgePresentation | undefined): DshAcpToolKind | undefined {
  const kind = presentation?.kind;
  if (isDshAcpToolKind(kind)) {return kind;}
  switch (presentation?.card) {
    case 'diff': return 'edit';
    case 'search': return 'search';
    case 'read': return 'read';
    case 'terminal': return 'execute';
    default: return undefined;
  }
}

function presentationLocations(presentation: DshBridgePresentation | undefined): Array<{ path: string; line?: number }> | undefined {
  const result: Array<{ path: string; line?: number }> = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (!isRecord(value) || typeof value.path !== 'string' || value.path.trim() === '') {return;}
    const location = {
      path: value.path,
      ...(typeof value.line === 'number' ? { line: value.line } : {}),
    };
    const key = `${location.path}|${location.line ?? ''}`;
    if (seen.has(key)) {return;}
    seen.add(key);
    result.push(location);
  };
  if (Array.isArray(presentation?.locations)) {
    for (const location of presentation.locations) {add(location);}
  }
  if (Array.isArray(presentation?.diffs)) {
    for (const diff of presentation.diffs) {add(diff);}
  }
  return result.length > 0 ? result : undefined;
}

function mergeToolLocations(
  primary: RequestPermissionRequest['toolCall']['locations'],
  fallback: Array<{ path: string; line?: number }> | undefined,
): RequestPermissionRequest['toolCall']['locations'] | undefined {
  const result = [...(primary ?? [])];
  const seen = new Set(result.map(location => `${location.path}|${location.line ?? ''}`));
  for (const location of fallback ?? []) {
    const key = `${location.path}|${location.line ?? ''}`;
    if (seen.has(key)) {continue;}
    seen.add(key);
    result.push(location);
  }
  return result.length > 0 ? result : undefined;
}

function presentationInput(
  presentation: DshBridgePresentation | undefined,
  rawInput?: unknown,
): Record<string, unknown> {
  if (isRecord(rawInput)) {return rawInput;}
  if (rawInput !== undefined) {return { value: rawInput };
  }

  if (!presentation) {return {};}
  if (isRecord(presentation.rawInput)) {return presentation.rawInput;}
  const locations = presentationLocations(presentation);
  const firstLocation = locations?.[0];
  if (presentation.card === 'terminal') {
    return {
      ...(typeof presentation.title === 'string' ? { command: presentation.title } : {}),
      ...(typeof presentation.cwd === 'string' ? { cwd: presentation.cwd } : {}),
    };
  }
  if (firstLocation) {
    return {
      filePath: firstLocation.path,
      ...(firstLocation.line !== undefined ? { line: firstLocation.line } : {}),
    };
  }
  return {};
}

function displayToolName(toolName: string, presentation: DshBridgePresentation | undefined): string {
  switch (presentation?.card) {
    case 'terminal': return 'bash';
    case 'read': return 'read';
    case 'search': {
      return presentation.shape === 'paths' ? 'glob' : 'grep';
    }
    case 'diff': {
      const lowered = toolName.toLowerCase();
      return lowered.includes('write') || lowered.includes('create') ? 'write' : 'edit';
    }
    default: return toolName;
  }
}

function presentationMetadata(
  toolName: string,
  presentation: DshBridgePresentation | undefined,
  result?: DshBridgeToolResultMessage,
): Record<string, unknown> | undefined {
  if (!presentation && result === undefined) {return undefined;}
  return {
    ...(presentation ? { dshPresentation: presentation } : {}),
    dshToolName: toolName,
    ...(result ? { dshResult: { isError: result.isError, presentation: result.presentation } } : {}),
    ...(presentation?.card === 'diff' ? { externalEdit: true } : {}),
  };
}

function bridgeOutputText(
  message: DshBridgeToolResultMessage,
  presentation: DshBridgePresentation | undefined,
): string | undefined {
  if (typeof message.output === 'string') {return message.output;}
  if (message.output !== undefined) {
    try {return JSON.stringify(message.output);}
    catch {return String(message.output);}
  }
  if (!presentation) {return undefined;}
  const output = presentation.output;
  if (typeof output === 'string') {return output;}
  if (output !== undefined) {
    try {return JSON.stringify(output);}
    catch {return String(output);}
  }
  if (presentation.card === 'diff' && Array.isArray(presentation.diffs)) {
    return presentation.diffs
      .filter(isRecord)
      .map(diff => typeof diff.path === 'string' ? `Updated ${diff.path}` : '')
      .filter(Boolean)
      .join('\n') || undefined;
  }
  if (presentation.card === 'read' && Array.isArray(presentation.lines)) {
    return presentation.lines
      .filter(isRecord)
      .map(line => `${String(line.number ?? '')}: ${String(line.text ?? '')}`)
      .join('\n') || undefined;
  }
  if (presentation.card === 'search') {
    if (Array.isArray(presentation.paths)) {
      return presentation.paths.filter(value => typeof value === 'string').join('\n') || undefined;
    }
    if (Array.isArray(presentation.files)) {
      return presentation.files
        .filter(isRecord)
        .map(file => typeof file.path === 'string' ? file.path : '')
        .filter(Boolean)
        .join('\n') || undefined;
    }
  }
  return undefined;
}
