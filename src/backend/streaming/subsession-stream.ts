/**
 * SubsessionStream - semantic stream node for a subagent session.
 *
 * It shares push/update/meta behavior with the root SSS via SessionStreamNodeBase,
 * but owns subagent-specific paths and ancestry metadata.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AnySerializableStreamPart, SspStream } from '../../ssp/types';
import { SessionStreamNodeBase } from './session-stream-node';
import type { SessionStreamNodeConfig, SessionStreamScheduler } from './session-stream-node';

export interface SubsessionStreamConfig {
  turnIndex: number;
  requestId: string;
  parentSessionId?: string;
  parentSubAgentInvocationId?: string;
  subAgentPath?: string[];
  scheduler?: SessionStreamScheduler;
}

export class SubsessionStream extends SessionStreamNodeBase<SubsessionStream> {
  private readonly subDir: string | null;

  constructor(
    parentDir: string | null,
    private readonly subAgentInvocationId: string,
    stream: SspStream,
    config: SubsessionStreamConfig,
  ) {
    const subAgentPath = config.subAgentPath ?? [subAgentInvocationId];
    const nodeConfig: SessionStreamNodeConfig = {
      turnIndex: config.turnIndex,
      requestId: config.requestId,
      parentSessionId: config.parentSessionId,
      subAgentInvocationId,
      parentSubAgentInvocationId: config.parentSubAgentInvocationId,
      subAgentPath,
      scheduler: config.scheduler,
    };
    const subDir = parentDir ? path.join(parentDir, 'subsessions', subAgentInvocationId) : null;
    super(stream, nodeConfig, {
      dir: subDir,
      streamPath: subDir ? path.join(subDir, 'subsession.jsonl') : null,
      metaPath: subDir ? path.join(subDir, 'meta.jsonl') : null,
    }, '[SubsessionStream]');
    this.subDir = subDir;
  }

  getSubDir(): string { return this.subDir ?? ''; }

  writeMeta(patch: Record<string, unknown>): void {
    if (!this.isActive) return;
    this.appendMeta({ type: 'session', ...patch });
  }

  protected createSubsession(subAgentInvocationId: string): SubsessionStream {
    return new SubsessionStream(
      this.subDir,
      subAgentInvocationId,
      this.stream,
      {
        turnIndex: this.config.turnIndex,
        requestId: this.config.requestId,
        parentSessionId: this.config.parentSessionId,
        parentSubAgentInvocationId: this.subAgentInvocationId,
        subAgentPath: [...(this.config.subAgentPath ?? [this.subAgentInvocationId]), subAgentInvocationId],
        scheduler: this.scheduler,
      },
    );
  }

  protected override async beforeAppendStream(): Promise<void> {
    if (this.subDir) {
      await fs.mkdir(this.subDir, { recursive: true });
    }
  }

  protected override shouldRender(ssp: AnySerializableStreamPart): boolean {
    return ssp.kind !== 'assistantText' && ssp.kind !== 'reasoning';
  }

  protected override appendMeta(data: Record<string, unknown>): void {
    this.enqueueWrite(async () => {
      if (!this.subDir || !this.metaPath) return;
      await fs.mkdir(this.subDir, { recursive: true });
      await fs.appendFile(this.metaPath, JSON.stringify({ v: 2, ...data }) + '\n');
    });
  }
}
