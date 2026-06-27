import { promises as fs } from 'node:fs';
import {
  type AnySerializableStreamPart,
  type SerializableStreamPartMeta,
  type SspStream,
  type StreamPartRecord,
  isAsyncMetadataProvider,
  isMetadataProvider,
  isMutable,
} from '../../ssp/types';
import { buildLine } from '../serializable/serializer';

export type SessionStreamSchedulingMode = 'immediate' | 'continuous' | 'tool-first';

type SessionStreamScheduleRole =
  | 'rootReasoning'
  | 'rootMarkdown'
  | 'rootTool'
  | 'subagentTool';

export interface SessionStreamNode {
  push(ssp: AnySerializableStreamPart): void;
  update(id: string, data: Record<string, unknown>): void;
  subsession(subAgentInvocationId: string): SessionStreamNode;
  writeMeta(patch: Record<string, unknown>): void;
  has(id: string): boolean;
  flushAppendBuffer(reason?: string): void;
  flushScheduled(reason?: string): void;
  getSchedulingMode(): SessionStreamSchedulingMode;
  setSchedulingMode(mode: SessionStreamSchedulingMode): void;
  flush(): Promise<void>;
}

export interface SessionStreamNodeConfig {
  turnIndex: number;
  requestId: string;
  parentSessionId?: string;
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
  subAgentPath?: string[];
  scheduler?: SessionStreamScheduler;
  schedulingMode?: SessionStreamSchedulingMode;
}

export interface SessionStreamNodePaths {
  dir: string | null;
  streamPath: string | null;
  metaPath: string | null;
}

type MainScheduleRole = Exclude<SessionStreamScheduleRole, 'subagentTool'>;

interface ScheduledStreamOperation {
  order: number;
  role: SessionStreamScheduleRole;
  label: string;
  run: () => void;
}

type SubagentActivity =
  | { type: 'activate'; id: string }
  | { type: 'deactivate'; id: string };

type StreamBoundary = 'root' | 'subagent';

interface SessionStreamScheduleInfo {
  role?: SessionStreamScheduleRole;
  activity?: SubagentActivity;
  boundary?: StreamBoundary;
}

export class SessionStreamScheduler {
  private nextOrder = 0;
  private continuousLastMainRole: MainScheduleRole | null = null;
  private continuousSubagentQueue: ScheduledStreamOperation[] = [];
  private toolFirstAppendQueue: ScheduledStreamOperation[] = [];
  private activeSubagents = new Set<string>();

  constructor(private mode: SessionStreamSchedulingMode = 'tool-first') {}

  getMode(): SessionStreamSchedulingMode {
    return this.mode;
  }

  setMode(mode: SessionStreamSchedulingMode): void {
    if (this.mode === mode) return;
    this.flush(`mode switch ${this.mode} -> ${mode}`);
    this.mode = mode;
    this.continuousLastMainRole = null;
    this.activeSubagents.clear();
  }

  schedule(
    info: SessionStreamScheduleInfo | SessionStreamScheduleRole | undefined,
    label: string | undefined,
    run: () => void,
  ): void {
    const scheduleInfo = typeof info === 'string' ? { role: info } : info;
    const role = scheduleInfo?.role;

    if (!role) {
      run();
      this.applyActivity(scheduleInfo?.activity);
      if (scheduleInfo?.boundary) {
        this.applyBoundary(scheduleInfo.boundary);
      }
      return;
    }

    if (this.mode === 'immediate') {
      run();
      this.applyActivity(scheduleInfo?.activity);
      if (scheduleInfo?.boundary) {
        this.applyBoundary(scheduleInfo.boundary);
      }
      return;
    }

    const operation: ScheduledStreamOperation = {
      role,
      run,
      label: label ?? role,
      order: this.nextOrder++,
    };

    if (this.mode === 'tool-first') {
      this.scheduleToolFirst(operation, scheduleInfo);
      return;
    }

    this.scheduleContinuous(operation);
    this.applyActivity(scheduleInfo?.activity);
    if (scheduleInfo?.boundary) {
      this.applyBoundary(scheduleInfo.boundary);
    }
  }

  flush(_reason = 'flush'): void {
    this.flushToolFirstAppendQueue();
    this.flushContinuousSubagentQueue();
    this.activeSubagents.clear();
  }

  flushAppendBuffer(_reason = 'append part complete'): void {
    this.flushToolFirstAppendQueue();
  }

  private scheduleContinuous(operation: ScheduledStreamOperation): void {
    if (operation.role === 'subagentTool') {
      if (this.continuousLastMainRole === null) {
        operation.run();
        return;
      }
      this.continuousSubagentQueue.push(operation);
      return;
    }

    if (
      this.continuousLastMainRole !== null &&
      (this.continuousLastMainRole !== operation.role || operation.role === 'rootTool')
    ) {
      this.flushContinuousSubagentQueue();
    }
    operation.run();
    this.continuousLastMainRole = operation.role;
  }

  private scheduleToolFirst(
    operation: ScheduledStreamOperation,
    info: SessionStreamScheduleInfo | undefined,
  ): void {
    const shouldBufferAppend =
      this.hasActiveSubagent() &&
      (operation.role === 'rootMarkdown' || operation.role === 'rootReasoning');

    if (shouldBufferAppend) {
      this.toolFirstAppendQueue.push(operation);
      return;
    }

    operation.run();
    this.applyActivity(info?.activity);
    if (info?.activity?.type === 'deactivate' && !this.hasActiveSubagent()) {
      this.flushToolFirstAppendQueue();
    }
    if (info?.boundary) {
      this.applyBoundary(info.boundary);
    }
  }

  private applyActivity(activity: SubagentActivity | undefined): void {
    if (!activity) return;
    if (activity.type === 'activate') {
      this.activeSubagents.add(activity.id);
      return;
    }
    this.activeSubagents.delete(activity.id);
  }

  private hasActiveSubagent(): boolean {
    return this.activeSubagents.size > 0;
  }

  private applyBoundary(boundary: StreamBoundary): void {
    if (boundary === 'root') {
      this.flush('root boundary');
      return;
    }

    this.flushContinuousSubagentQueue();
    if (!this.hasActiveSubagent()) {
      this.flushToolFirstAppendQueue();
    }
  }

  private flushContinuousSubagentQueue(): void {
    if (this.continuousSubagentQueue.length === 0) return;
    const queued = [...this.continuousSubagentQueue].sort((a, b) => a.order - b.order);
    this.continuousSubagentQueue = [];
    for (const operation of queued) {
      operation.run();
    }
  }

  private flushToolFirstAppendQueue(): void {
    if (this.toolFirstAppendQueue.length === 0) return;
    const queued = [...this.toolFirstAppendQueue].sort((a, b) => a.order - b.order);
    this.toolFirstAppendQueue = [];
    for (const operation of queued) {
      operation.run();
    }
  }
}

export abstract class SessionStreamNodeBase<TChild extends SessionStreamNode>
implements SessionStreamNode {
  protected nodeDir: string | null;
  protected streamPath: string | null;
  protected metaPath: string | null;
  protected parts = new Map<string, AnySerializableStreamPart>();
  protected subsessions = new Map<string, TChild>();
  protected writeQueue: Promise<void> = Promise.resolve();
  protected sequence = 0;
  protected isActive = true;
  protected readonly scheduler: SessionStreamScheduler;
  private scheduleRoles = new Map<string, SessionStreamScheduleRole | undefined>();
  private scheduleInfos = new Map<string, SessionStreamScheduleInfo>();
  private scheduledPartIds = new Set<string>();
  private streamableState: {
    lastKind: 'assistantText' | 'reasoning' | null;
    activeThinkingId: string | null;
    reasoningThinkingIds: Map<string, string>;
    nextThinkingIndex: number;
  } = {
    lastKind: null,
    activeThinkingId: null,
    reasoningThinkingIds: new Map(),
    nextThinkingIndex: 0,
  };

  protected constructor(
    protected readonly stream: SspStream,
    protected readonly config: SessionStreamNodeConfig,
    paths: SessionStreamNodePaths,
    private readonly logPrefix: string,
  ) {
    this.nodeDir = paths.dir;
    this.streamPath = paths.streamPath;
    this.metaPath = paths.metaPath;
    this.scheduler = config.scheduler ?? new SessionStreamScheduler(config.schedulingMode);
  }

  push(ssp: AnySerializableStreamPart): void {
    if (!this.isActive) return;
    this.preparePart(ssp);
    if (isCompleteAppendPart(ssp)) {
      this.flushAppendBuffer(`${ssp.kind} complete`);
      return;
    }
    const info = this.inferScheduleInfo(ssp);
    this.scheduleRoles.set(ssp.id, info.role);
    this.scheduleInfos.set(ssp.id, info);
    this.scheduledPartIds.add(ssp.id);
    this.scheduler.schedule(info, undefined, () => this.pushNow(ssp));
  }

  update(id: string, data: Record<string, unknown>): void {
    if (!this.isActive) return;
    const info = this.inferScheduleInfoForUpdate(id, data);
    this.scheduler.schedule(info, undefined, () => this.updateNow(id, data));
  }

  flushScheduled(reason = 'flush'): void {
    this.scheduler.flush(reason);
  }

  flushAppendBuffer(reason = 'append part complete'): void {
    this.scheduler.flushAppendBuffer(reason);
  }

  getSchedulingMode(): SessionStreamSchedulingMode {
    return this.scheduler.getMode();
  }

  setSchedulingMode(mode: SessionStreamSchedulingMode): void {
    this.scheduler.setMode(mode);
  }

  private pushNow(ssp: AnySerializableStreamPart): void {
    if (!this.isActive) return;
    this.scheduledPartIds.delete(ssp.id);
    this.scheduleInfos.set(ssp.id, this.inferScheduleInfo(ssp));
    this.parts.set(ssp.id, ssp);
    ssp.onStateChange((s) => {
      this.syncMetadata(s);
    });
    if (this.shouldRender(ssp)) {
      ssp.render(this.stream);
    }
    this.appendStreamRecord(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  private updateNow(id: string, data: Record<string, unknown>): void {
    if (!this.isActive) return;
    const ssp = this.parts.get(id);
    if (!ssp) {
      console.warn(`${this.logPrefix} update: part ${id} not found`);
      return;
    }
    if (!isMutable(ssp)) {
      throw new Error(`${this.logPrefix} Part ${id} (kind=${ssp.kind}) is append-only, update not allowed`);
    }

    ssp.update(data);
    if (this.shouldRender(ssp)) {
      ssp.render(this.stream);
    }
    this.appendStreamRecord(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  private inferScheduleInfo(ssp: AnySerializableStreamPart): SessionStreamScheduleInfo {
    const role = this.inferScheduleRole(ssp);
    return {
      role,
      activity: this.inferSubagentActivity(ssp),
      boundary: this.inferStreamBoundary(ssp),
    };
  }

  private inferScheduleRole(ssp: AnySerializableStreamPart): SessionStreamScheduleRole | undefined {
    if (this.config.subAgentInvocationId) {
      return ssp.kind === 'toolInvocation' ? 'subagentTool' : undefined;
    }

    if (hasSubAgentIdentity(ssp)) {
      return 'subagentTool';
    }

    switch (ssp.kind) {
      case 'reasoning':
        return 'rootReasoning';
      case 'assistantText':
        return 'rootMarkdown';
      case 'toolInvocation':
        return 'rootTool';
      default:
        return undefined;
    }
  }

  private inferScheduleInfoForUpdate(id: string, data: Record<string, unknown>): SessionStreamScheduleInfo {
    const existing = this.parts.get(id);
    if (existing) {
      return {
        role: this.inferScheduleRole(existing),
        activity: this.inferSubagentActivity(existing, data),
      };
    }
    const queuedInfo = this.scheduleInfos.get(id);
    return {
      role: queuedInfo?.role ?? this.scheduleRoles.get(id),
      activity: queuedInfo?.activity,
    };
  }

  private inferStreamBoundary(ssp: AnySerializableStreamPart): StreamBoundary | undefined {
    if (!isStreamBoundaryPart(ssp)) return undefined;
    return this.config.subAgentInvocationId ? 'subagent' : 'root';
  }

  private inferSubagentActivity(
    ssp: AnySerializableStreamPart,
    update?: Record<string, unknown>,
  ): SubagentActivity | undefined {
    if (ssp.kind === 'sessionLifecycle' && isStreamBoundaryPart(ssp)) {
      const id = this.config.subAgentInvocationId ?? getSubagentIdentity(ssp);
      return id ? { type: 'deactivate', id } : undefined;
    }

    if (ssp.kind !== 'toolInvocation') return undefined;
    if (this.config.subAgentInvocationId) return undefined;

    const id = getSubagentIdentity(ssp);
    if (!id) return undefined;

    const status = getToolStatus(ssp, update);
    if (status === 'pending' || status === 'running') {
      return { type: 'activate', id };
    }
    if (status === 'completed' || status === 'error') {
      return { type: 'deactivate', id };
    }
    return undefined;
  }

  subsession(subAgentInvocationId: string): TChild {
    let sub = this.subsessions.get(subAgentInvocationId);
    if (!sub) {
      sub = this.createSubsession(subAgentInvocationId);
      this.subsessions.set(subAgentInvocationId, sub);
    }
    return sub;
  }

  has(id: string): boolean {
    return this.parts.has(id) || this.scheduledPartIds.has(id);
  }

  async flush(): Promise<void> {
    this.flushScheduled('flush');
    await this.writeQueue;
    await this.flushAsyncMetadata();
    await this.writeQueue;
    for (const sub of this.subsessions.values()) {
      await sub.flush();
    }
  }

  abstract writeMeta(patch: Record<string, unknown>): void;

  protected abstract createSubsession(subAgentInvocationId: string): TChild;

  protected setNodePaths(paths: SessionStreamNodePaths): void {
    this.nodeDir = paths.dir;
    this.streamPath = paths.streamPath;
    this.metaPath = paths.metaPath;
  }

  protected deactivate(): void {
    this.isActive = false;
  }

  protected appendMeta(data: Record<string, unknown>): void {
    this.enqueueWrite(async () => {
      if (!this.metaPath) return;
      await fs.appendFile(this.metaPath, JSON.stringify({ v: 2, ...data }) + '\n');
    });
  }

  protected appendStreamLine(line: string): void {
    this.enqueueWrite(async () => {
      if (!this.streamPath) return;
      await this.beforeAppendStream();
      await fs.appendFile(this.streamPath, line);
    });
  }

  protected enqueueWrite(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch(err => {
      console.error(`${this.logPrefix} Write error`, err);
    });
  }

  protected beforeAppendStream(): Promise<void> | void {
    return undefined;
  }

  protected shouldRender(_ssp: AnySerializableStreamPart): boolean {
    return true;
  }

  protected preparePart(ssp: AnySerializableStreamPart): void {
    const meta = ssp.meta as SerializableStreamPartMeta;
    meta.turnIndex = this.config.turnIndex;
    meta.requestId = this.config.requestId;
    meta.sequence = this.sequence++;
    meta.createdAt = meta.createdAt || new Date().toISOString();
    meta.source = meta.source || 'acp-event';
    meta.parentSessionId = meta.parentSessionId ?? this.config.parentSessionId;
    meta.subAgentInvocationId = meta.subAgentInvocationId ?? this.config.subAgentInvocationId;
    meta.parentSubAgentInvocationId = meta.parentSubAgentInvocationId ?? this.config.parentSubAgentInvocationId;
    meta.subAgentPath = meta.subAgentPath ?? this.config.subAgentPath;

    if (this.config.subAgentInvocationId) {
      const payload = ssp.payload as Record<string, unknown>;
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.subAgentInvocationId === undefined) {
        payload.subAgentInvocationId = this.config.subAgentInvocationId;
      }
    }

    this.prepareStreamablePart(ssp);
  }

  private prepareStreamablePart(ssp: AnySerializableStreamPart): void {
    const payload = ssp.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    if (ssp.kind === 'reasoning') {
      const sourcePartId = typeof payload.partId === 'string' ? payload.partId : ssp.id;
      let thinkingId = typeof payload.thinkingId === 'string'
        ? payload.thinkingId
        : this.streamableState.reasoningThinkingIds.get(sourcePartId);
      if (!thinkingId) {
        thinkingId = this.streamableState.lastKind === 'reasoning' && this.streamableState.activeThinkingId
          ? this.streamableState.activeThinkingId
          : `thinking-${++this.streamableState.nextThinkingIndex}`;
      }
      payload.thinkingId = thinkingId;
      this.streamableState.reasoningThinkingIds.set(sourcePartId, thinkingId);
      this.streamableState.lastKind = 'reasoning';
      this.streamableState.activeThinkingId = thinkingId;
      return;
    }

    if (ssp.kind === 'assistantText') {
      this.streamableState.lastKind = 'assistantText';
      this.streamableState.activeThinkingId = null;
    }
  }

  private appendStreamRecord(record: StreamPartRecord): void {
    this.appendStreamLine(buildLine('stream-part', record));
  }

  private syncMetadata(ssp: AnySerializableStreamPart): void {
    if (!isMetadataProvider(ssp)) return;
    const meta = ssp.getMetadata();
    if (!meta) return;
    this.appendMeta({ type: 'part-meta', id: ssp.metaId, ...meta });
  }

  private async flushAsyncMetadata(): Promise<void> {
    const pending = [...this.parts.values()]
      .filter(isAsyncMetadataProvider)
      .map(part => part.whenMetadataSettled());
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

function hasSubAgentIdentity(ssp: AnySerializableStreamPart): boolean {
  return getSubagentIdentity(ssp) !== undefined;
}

function getSubagentIdentity(ssp: AnySerializableStreamPart): string | undefined {
  const payload = ssp.payload as Record<string, unknown> | undefined;
  const meta = ssp.meta as unknown as Record<string, unknown> | undefined;
  return firstString(
    payload?.subAgentInvocationId,
    payload?.subAgentId,
    meta?.subAgentInvocationId,
    meta?.subAgentId,
  );
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function getToolStatus(
  ssp: AnySerializableStreamPart,
  update?: Record<string, unknown>,
): string | undefined {
  const payload = ssp.payload as Record<string, unknown> | undefined;
  const payloadState = payload?.state;
  const updateState = update?.state;
  const status = isRecord(updateState) && typeof updateState.status === 'string'
    ? updateState.status
    : isRecord(payloadState) && typeof payloadState.status === 'string'
      ? payloadState.status
      : undefined;
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompleteAppendPart(ssp: AnySerializableStreamPart): boolean {
  if (ssp.kind !== 'assistantText' && ssp.kind !== 'reasoning') return false;
  const payload = ssp.payload as Record<string, unknown> | undefined;
  return payload?.isComplete === true;
}

function isStreamBoundaryPart(ssp: AnySerializableStreamPart): boolean {
  if (ssp.kind !== 'sessionLifecycle') return false;
  const payload = ssp.payload as Record<string, unknown> | undefined;
  return payload?.eventType === 'session.idle'
    || payload?.eventType === 'session.status'
    || payload?.eventType === 'session.error';
}
