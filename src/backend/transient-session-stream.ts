import {
  SessionStreamNodeBase,
  type SessionStreamNodeConfig,
  type SessionStreamSchedulingMode,
} from './streaming/session-stream-node';
import type { SessionTitleSource } from './serializable/types';
import type { SspStream } from '../ssp/types';

/**
 * In-memory stream used by Agent-vendor model invocations.
 *
 * It deliberately reuses SessionStreamNodeBase so a temporary model request
 * observes the same SSP scheduling, mutation, and interaction lifecycle as a
 * normal Copilot chat turn, while omitting session.jsonl persistence. The
 * ordinary Copilot-vendor provider does not instantiate this stream.
 */
export class TransientSessionStream extends SessionStreamNodeBase<TransientSubsessionStream> {
  private firstPrompt: string | undefined;
  constructor(
    sink: SspStream,
    options: {
      sessionId: string;
      turnIndex?: number;
      requestId?: string;
      schedulingMode?: SessionStreamSchedulingMode;
    },
  ) {
    super(
      sink,
      {
        sessionId: options.sessionId,
        turnIndex: options.turnIndex ?? 0,
        requestId: options.requestId ?? `transient-${options.sessionId}`,
        schedulingMode: options.schedulingMode,
      },
      { dir: null, streamPath: null, metaPath: null },
      '[TransientSessionStream]',
    );
  }

  writeMeta(_patch: Record<string, unknown>): void {
    // Native model requests have no durable Copilot chat session.
  }

  recordFirstPrompt(prompt: string | undefined): void {
    const normalized = prompt?.replace(/\s+/g, ' ').trim();
    if (normalized && !this.firstPrompt) {
      this.firstPrompt = normalized;
    }
  }

  getFirstPrompt(): string | undefined {
    return this.firstPrompt;
  }

  /** Stop late backend events from reaching the native LM response sink. */
  close(): void {
    for (const child of this.subsessions.values()) {
      child.close();
    }
    this.deactivate();
  }

  updateTitle(
    title: string,
    _source: SessionTitleSource,
    _options?: { provisional?: boolean },
  ): string | undefined {
    const normalized = title.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
  }

  protected createSubsession(subAgentInvocationId: string): TransientSubsessionStream {
    return new TransientSubsessionStream(
      this.stream,
      {
        sessionId: this.config.sessionId,
        turnIndex: this.config.turnIndex,
        requestId: this.config.requestId,
        parentSessionId: this.config.sessionId,
        subAgentInvocationId,
        subAgentPath: [subAgentInvocationId],
        scheduler: this.scheduler,
      },
    );
  }
}

class TransientSubsessionStream extends SessionStreamNodeBase<TransientSubsessionStream> {
  constructor(sink: SspStream, config: SessionStreamNodeConfig) {
    super(
      sink,
      config,
      { dir: null, streamPath: null, metaPath: null },
      '[TransientSubsessionStream]',
    );
  }

  writeMeta(_patch: Record<string, unknown>): void {
    // Child metadata is intentionally ephemeral for native model requests.
  }

  close(): void {
    for (const child of this.subsessions.values()) {
      child.close();
    }
    this.deactivate();
  }

  protected createSubsession(subAgentInvocationId: string): TransientSubsessionStream {
    return new TransientSubsessionStream(
      this.stream,
      {
        sessionId: this.config.sessionId,
        turnIndex: this.config.turnIndex,
        requestId: this.config.requestId,
        parentSessionId: this.config.sessionId,
        subAgentInvocationId,
        parentSubAgentInvocationId: this.config.subAgentInvocationId,
        subAgentPath: [...(this.config.subAgentPath ?? []), subAgentInvocationId],
        scheduler: this.scheduler,
      },
    );
  }
}
