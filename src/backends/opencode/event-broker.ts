import type { OpenCodeClient } from './sdk-types';
import type { OpenCodeEvent, OpenCodeEventStream, OpenCodeStreamEvent } from './sdk-events';

interface LoggerLike {
  appendLine(message: string): void;
}

interface SessionChannel {
  push(event: OpenCodeStreamEvent): void;
  close(): void;
  isIdle(): boolean;
  stream(): AsyncIterable<OpenCodeStreamEvent>;
}

class BufferedSessionChannel implements SessionChannel {
  private queue: OpenCodeStreamEvent[] = [];
  private waiters: Array<(result: IteratorResult<OpenCodeStreamEvent>) => void> = [];
  private closed = false;
  /**
   * Set to true when `session.idle` is received. The channel stays open
   * so consumers can continue receiving events (e.g. from subagents),
   * but `idle` flag lets consumers know the parent turn is logically done.
   */
  private idle = false;

  push(event: OpenCodeStreamEvent): void {
    if (this.closed) {return;}
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) {return;}
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  isIdle(): boolean {
    this.idle = true;
    return this.idle;
  }

  async *stream(): AsyncIterable<OpenCodeStreamEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as OpenCodeStreamEvent;
        continue;
      }
      if (this.closed) {
        return;
      }

      const result = await new Promise<IteratorResult<OpenCodeStreamEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

export class GlobalEventBroker {
  private connectPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private activeClient: OpenCodeClient | null = null;
  private activeIterator: AsyncIterator<OpenCodeStreamEvent> | null = null;
  private pendingReadyReject: ((error: unknown) => void) | null = null;
  private generation = 0;
  private stopped = false;
  private logger?: LoggerLike;
  private sessionChannels: Map<string, SessionChannel> = new Map();
  private partSessions: Map<string, string> = new Map();
  private sessionParts: Map<string, Set<string>> = new Map();
  private pendingPartDeltas: Map<string, OpenCodeStreamEvent[]> = new Map();
  private childToParent: Map<string, string> = new Map();

  async ensureStarted(client: OpenCodeClient, logger?: LoggerLike): Promise<void> {
    if (logger) {
      this.logger = logger;
    }

    if (this.connectPromise && this.activeClient !== client) {
      await this.stop();
    }

    this.stopped = false;
    if (this.connectPromise && this.activeClient === client) {
      await this.connectPromise;
      return;
    }

    if (!this.connectPromise) {
      this.activeClient = client;
      const generation = this.generation;
      const pending = this.connect(client, generation);
      this.connectPromise = pending;
    }

    await this.connectPromise;
  }

  /** Stop the global pump and invalidate all correlation state. */
  async stop(): Promise<void> {
    const generation = ++this.generation;
    this.stopped = true;

    const rejectReady = this.pendingReadyReject;
    this.pendingReadyReject = null;
    rejectReady?.(new Error('OpenCode event broker stopped'));

    const iterator = this.activeIterator;
    this.activeIterator = null;
    if (iterator?.return) {
      try {
        // OpenCode's SSE stream is an async generator. If pumpWithReconnect is
        // currently awaiting iterator.next(), async-generator return() is
        // queued behind that read and awaiting it here deadlocks stop(). Start
        // the cleanup, but let generation invalidation and channel closure make
        // stop() complete immediately; observe any late rejection.
        void Promise.resolve(iterator.return()).catch(() => undefined);
      } catch {
        // The underlying SSE transport may already be closed.
      }
    }

    this.closeAllSessionStreams();
    if (generation === this.generation) {
      this.connectPromise = null;
      this.pumpPromise = null;
      this.activeClient = null;
    }
  }

  openSessionStream(sessionId: string): OpenCodeEventStream {
    const existing = this.sessionChannels.get(sessionId);
    if (existing) {
      existing.close();
    }

    const channel = new BufferedSessionChannel();
    this.sessionChannels.set(sessionId, channel);
    this.log(`open session stream: sessionID=${sessionId}`);
    return { stream: channel.stream() };
  }

  closeSessionStream(sessionId: string): void {
    const channel = this.sessionChannels.get(sessionId);
    if (!channel) {return;}
    channel.close();
    this.sessionChannels.delete(sessionId);
    this.clearSessionParts(sessionId);
    // Clean up child→parent mappings for this parent
    for (const [childId, parentId] of this.childToParent.entries()) {
      if (parentId === sessionId) {
        this.childToParent.delete(childId);
      }
    }
    this.log(`close session stream: sessionID=${sessionId}`);
  }

  private async connect(client: OpenCodeClient, generation: number): Promise<void> {
    this.log('connecting to /global/event SSE stream');
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.pendingReadyReject = rejectReady;

    // `global.event()` returns a lazy SSE generator.  Start the first
    // `iterator.next()` before resolving `ensureStarted()` so callers can
    // safely send a prompt immediately after subscribing their session
    // channel.  The pump owns all later reconnects.
    this.pumpPromise = this.pumpWithReconnect(client, resolveReady, rejectReady, generation).catch(() => {
      // Rejection is expected when the client/stream throws (e.g. during tests or shutdown).
      // The error is logged inside pumpWithReconnect; no need to propagate further.
    });
    try {
      await ready;
    } finally {
      if (this.pendingReadyReject === rejectReady) {
        this.pendingReadyReject = null;
      }
    }
  }

  /**
   * Pump events from the global SSE stream with automatic reconnection.
   * When the stream ends normally (server closes connection), reconnect
   * after a short delay to continue receiving events (e.g. after question replies).
   * On error, close all session streams and reset state.
   */
  private async pumpWithReconnect(
    client: OpenCodeClient,
    onFirstReadStarted?: () => void,
    onFirstReadFailed?: (error: unknown) => void,
    generation = this.generation,
  ): Promise<void> {
    let reconnectDelay = 1000; // start with 1s, exponential backoff
    const maxDelay = 30_000;
    let firstReadPending = true;

    try {
      while (!this.stopped && generation === this.generation) {
        let events: { stream: AsyncIterable<OpenCodeStreamEvent> };
        try {
          events = (await client.global.event()) as { stream: AsyncIterable<OpenCodeStreamEvent> };
          this.log('subscribed to /global/event SSE stream');
          reconnectDelay = 1000; // reset on successful connect
        } catch (error) {
          if (firstReadPending) {
            firstReadPending = false;
            onFirstReadFailed?.(error);
          }
          throw error;
        }

        let iterator: AsyncIterator<OpenCodeStreamEvent>;
        let nextPromise: Promise<IteratorResult<OpenCodeStreamEvent>>;
        try {
          // Some SDK adapters construct the async iterator lazily and may
          // throw synchronously here (for example when the response body is
          // already unusable). Keep iterator creation inside the readiness
          // guard; otherwise `ensureStarted()` would wait forever because no
          // first-read callback could be delivered.
          iterator = events.stream[Symbol.asyncIterator]();
          this.activeIterator = iterator;
          // Calling next() is what causes the SDK's lazy SSE generator to
          // issue its fetch.  Resolve readiness after that call has started,
          // while retaining the promise so the first event is still handled.
          nextPromise = Promise.resolve(iterator.next());
          if (firstReadPending) {
            firstReadPending = false;
            onFirstReadStarted?.();
          }
        } catch (error) {
          if (firstReadPending) {
            firstReadPending = false;
            onFirstReadFailed?.(error);
          }
          throw error;
        }

        try {
          while (!this.stopped && generation === this.generation) {
            const result = await nextPromise;
            // `stop()` can invalidate this pump while `next()` is pending.
            // Do not dispatch an event that belongs to the invalidated SSE
            // connection after its correlation indexes have been cleared.
            if (this.stopped || generation !== this.generation) {
              return;
            }
            if (result.done) {break;}
            this.dispatch(result.value);
            nextPromise = Promise.resolve(iterator.next());
          }
        } finally {
          if (this.activeIterator === iterator) {
            this.activeIterator = null;
          }
        }

        if (this.stopped || generation !== this.generation) {return;}

        // Stream ended normally — server closed the connection.
        // Don't close session channels; instead reconnect to receive
        // subsequent events (e.g. after a question.asked reply).
        this.log(`global event stream completed, reconnecting in ${reconnectDelay}ms...`);

        // Only reconnect if there are still active consumers
        if (this.sessionChannels.size === 0) {
          this.log('no active session channels after stream end, stopping');
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`global event stream error: ${msg}`);
      if (!this.stopped && generation === this.generation) {
        this.closeAllSessionStreams();
      }
      throw error;
    } finally {
      if (generation === this.generation) {
        this.connectPromise = null;
        this.pumpPromise = null;
        this.activeClient = null;
      }
    }
  }

  private dispatch(rawEvent: OpenCodeStreamEvent): void {
    const event = unwrapStreamEvent(rawEvent);
    const sessionId = this.getSessionId(event);
    this.log(`dispatch: type=${event.type}, sessionId=${sessionId ?? 'none'}, channels=${this.sessionChannels.size}`);
    if (!sessionId) {
      // OpenCode declares session.error.sessionID optional.  A single active
      // channel is unambiguous, so route the error there.  With more than one
      // active channel the event is a backend/global failure (there is no safe
      // way to choose a session), therefore broadcast it so every waiting
      // pipeline can terminate instead of hanging indefinitely.
      if (event.type === 'session.error') {
        const channels = [...this.sessionChannels.values()];
        if (channels.length === 1) {
          channels[0].push(rawEvent);
          this.log('session.error without sessionID routed to the only active channel');
        } else if (channels.length > 1) {
          for (const channel of channels) {
            channel.push(rawEvent);
          }
          this.log(`session.error without sessionID broadcast to ${channels.length} active channels`);
        } else {
          this.log('session.error without sessionID dropped because no channel is active');
        }
      }
      if (event.type === 'message.part.delta') {
        this.bufferPendingPartDelta(event.properties.partID, rawEvent);
      }
      return;
    }

    let channel = this.sessionChannels.get(sessionId);
    if (!channel) {
      // No direct channel — trace the parent chain upward (child → parent → grandparent)
      // to find a channel that's listening. This handles nested background tasks
      // where grandchildren events need to reach the root parent's channel.
      let currentId = sessionId;
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const parentId = this.childToParent.get(currentId);
        if (!parentId) {break;}
        channel = this.sessionChannels.get(parentId);
        if (channel) {
          this.log(`forwarding descendant event: childSessionId=${sessionId} → parentId=${parentId}, type=${event.type}`);
          break;
        }
        currentId = parentId;
      }
    }
    if (!channel) {
      return; // truly no channel, drop event
    }

    for (const eventToPush of this.eventsForDispatch(rawEvent, event, sessionId)) {
      channel.push(eventToPush);
    }
    if (event.type === 'session.idle') {
      // Mark the channel as idle but do NOT close it. The consumer
      // (Pipeline) decides when to actually close the stream —
      // e.g. after all active subagent scopes are resolved.
      // This prevents losing events from still-running subagents.
      channel.isIdle();
      this.log(`session idle (channel kept open): sessionID=${sessionId}`);
    }
  }

  private getSessionId(event: OpenCodeEvent): string | undefined {
    switch (event.type) {
      case 'message.part.updated': {
        // OpenCode has emitted the session on the part, on the event
        // properties, and with both ID spellings across server versions.
        // Prefer the part-local value, then use the envelope as a fallback.
        const part = event.properties?.part;
        const sessionId = part?.sessionID
          ?? part?.sessionId
          ?? event.properties?.sessionID
          ?? event.properties?.sessionId;
        if (sessionId && part?.id) {
          this.trackPart(part.id, sessionId);
        }
        return sessionId;
      }
      case 'message.part.delta':
        // Newer OpenCode versions include the session directly on the delta;
        // older versions require the part-id correlation populated by a prior
        // message.part.updated event. Prefer the explicit value and retain
        // the correlation as a fallback for reordered events.
        return event.properties.sessionID
          ?? (event.properties as { sessionId?: string }).sessionId
          ?? this.partSessions.get(event.properties.partID);
      case 'session.idle':
        return event.properties?.sessionID;
      case 'permission.asked':
        return event.properties?.sessionID;
      case 'permission.replied':
        return event.properties?.sessionID;
      case 'question.asked':
        return event.properties?.sessionID;
      case 'question.replied':
        return event.properties.sessionID;
      case 'question.rejected':
        return event.properties.sessionID;
      case 'session.created':
      case 'session.updated':
      case 'session.deleted': {
        // properties.info.id contains the session ID (from SDK Session type)
        const { info } = event.properties;
        const id: string = info.id;
        if (event.type === 'session.created' && info.parentID) {
          // Auto-detect child sessions from parentID field
          this.childToParent.set(id, info.parentID);
          this.log(`child session detected: childId=${id}, parentId=${info.parentID}`);
        }
        return id;
      }
      case 'session.status':
        return event.properties.sessionID;
      default:
        return getEventSessionIdFromProperties(event);
    }
  }

  private trackPart(partId: string, sessionId: string): void {
    this.partSessions.set(partId, sessionId);
    let parts = this.sessionParts.get(sessionId);
    if (!parts) {
      parts = new Set<string>();
      this.sessionParts.set(sessionId, parts);
    }
    parts.add(partId);
  }

  private bufferPendingPartDelta(partId: string | undefined, event: OpenCodeStreamEvent): void {
    if (!partId) {return;}
    const pending = this.pendingPartDeltas.get(partId) ?? [];
    pending.push(event);
    this.pendingPartDeltas.set(partId, pending);
  }

  private eventsForDispatch(
    rawEvent: OpenCodeStreamEvent,
    event: OpenCodeEvent,
    sessionId: string,
  ): OpenCodeStreamEvent[] {
    if (event.type !== 'message.part.updated') {
      return [withInferredSessionId(rawEvent, event, sessionId)];
    }

    const partId = event.properties?.part?.id;
    if (!partId) {
      return [rawEvent];
    }

    const pending = this.pendingPartDeltas.get(partId);
    if (!pending || pending.length === 0) {
      return [rawEvent];
    }

    this.pendingPartDeltas.delete(partId);
    return [
      ...pending.map(pendingEvent =>
        withInferredSessionId(pendingEvent, unwrapStreamEvent(pendingEvent), sessionId),
      ),
      rawEvent,
    ];
  }

  private clearSessionParts(sessionId: string): void {
    const parts = this.sessionParts.get(sessionId);
    if (!parts) {return;}
    for (const partId of parts) {
      this.partSessions.delete(partId);
    }
    this.sessionParts.delete(sessionId);
  }

  private closeAllSessionStreams(): void {
    for (const [sessionId, channel] of this.sessionChannels.entries()) {
      channel.close();
      this.clearSessionParts(sessionId);
    }
    this.sessionChannels.clear();
    // A failed global stream invalidates every correlation collected from the
    // old connection. Retaining these indexes across reconnects can route a
    // reused child/part ID into a newly opened session or prepend a stale
    // delta to a later part.
    this.partSessions.clear();
    this.sessionParts.clear();
    this.pendingPartDeltas.clear();
    this.childToParent.clear();
  }

  private log(message: string): void {
    this.logger?.appendLine(`[broker] ${message}`);
  }

  // -------------------------------------------------------------------
  // Public query methods for session hierarchy
  // -------------------------------------------------------------------

  /**
   * Check whether `sessionId` is a descendant of `ancestorId` in the
   * child→parent session hierarchy.
   * Walks up the childToParent chain until it finds `ancestorId` or runs out.
   */
  isDescendantOf(sessionId: string, ancestorId: string): boolean {
    let current = sessionId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const parent = this.childToParent.get(current);
      if (!parent) {break;}
      if (parent === ancestorId) {return true;}
      current = parent;
    }
    return false;
  }

  /**
   * Find the parent session ID for a given session, or undefined if none.
   */
  getParentSession(sessionId: string): string | undefined {
    return this.childToParent.get(sessionId);
  }

  /**
   * Walk up the parent chain from `sessionId` and return the first session ID
   * that appears in `candidateIds`. Used by the pipeline to find which scope
   * a grandchild event belongs to.
   */
  findAncestorIn(sessionId: string, candidateIds: Set<string>): string | undefined {
    let current = sessionId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (candidateIds.has(current)) {return current;}
      const parent = this.childToParent.get(current);
      if (!parent) {break;}
      current = parent;
    }
    return undefined;
  }

  /**
   * Return all session IDs that are descendants of `parentId` in the
   * child→parent hierarchy (children, grandchildren, etc.).
   * Used for cascade-abort when the user cancels a parent session.
   */
  getDescendantSessions(parentId: string): string[] {
    const descendants: string[] = [];
    // Build reverse index: parent → children
    const parentToChildren = new Map<string, string[]>();
    for (const [childId, pid] of this.childToParent.entries()) {
      let children = parentToChildren.get(pid);
      if (!children) {
        children = [];
        parentToChildren.set(pid, children);
      }
      children.push(childId);
    }
    // BFS from parentId
    const queue = parentToChildren.get(parentId) ?? [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      descendants.push(id);
      const kids = parentToChildren.get(id);
      if (kids) {queue.push(...kids);}
    }
    return descendants;
  }
}

function unwrapStreamEvent(event: OpenCodeStreamEvent): OpenCodeEvent {
  return 'payload' in event ? event.payload : event;
}

function withInferredSessionId(
  rawEvent: OpenCodeStreamEvent,
  event: OpenCodeEvent,
  sessionId: string,
): OpenCodeStreamEvent {
  if (event.type !== 'message.part.delta' || event.properties.sessionID) {
    return rawEvent;
  }
  const payload: OpenCodeEvent = {
    ...event,
    properties: {
      ...event.properties,
      sessionID: sessionId,
    },
  };
  if ('payload' in rawEvent) {
    return { ...rawEvent, payload };
  }
  return payload;
}

function getEventSessionIdFromProperties(event: OpenCodeEvent): string | undefined {
  if (!('properties' in event)) {return undefined;}
  const props = event.properties;
  if (!props || typeof props !== 'object') {return undefined;}

  const propsObj = props as Record<string, unknown>;

  if (typeof propsObj.sessionID === 'string') {
    return propsObj.sessionID;
  }

  if (propsObj.info && typeof propsObj.info === 'object') {
    const info = propsObj.info as Record<string, unknown>;
    if (typeof info.sessionID === 'string') {
      return info.sessionID;
    }
  }

  return undefined;
}
