import type {
  ActiveSessionMessage,
} from '@agentclientprotocol/sdk';
import type {
  BackendPipeline,
  BackendPipelineOptions,
} from '../../backend/backend';
import {
  AcpBackend,
  type AcpBackendOptions,
} from '../acp/adapter';
import {
  parseDshBridgeReadyLine,
  parseDshBridgeToolLine,
  type DshBridgeToolMessage,
} from './bridge-protocol';
import { DshPipeline } from './pipeline';

export type DshBackendOptions = AcpBackendOptions;

/**
 * First-class DeepSeek Harness backend.
 *
 * ACP remains the transport and session protocol. DSH-specific behavior is
 * limited to the optional stderr bridge and the presentation-aware pipeline,
 * so an ordinary user-owned `dsh --profile acp` process still works without
 * installing ACPilot's plugin.
 */
export class DshBackend extends AcpBackend {
  private readonly pipelines = new Map<string, DshPipeline>();
  private readonly pendingBridgeMessages = new Map<string, DshBridgeToolMessage[]>();

  constructor(options: DshBackendOptions = {}) {
    super({
      ...options,
      name: options.name ?? 'dsh',
      clientName: options.clientName ?? 'acpilot-dsh-backend',
      sessionTitlePrefix: options.sessionTitlePrefix ?? 'DSH Session',
      missingOptionsMessage: options.missingOptionsMessage
        ?? 'No DSH target selected. Configure a DSH command in ACP Settings.',
    });
  }

  override createPipeline(options: BackendPipelineOptions): BackendPipeline<ActiveSessionMessage> {
    const pipeline = new DshPipeline(options);
    this.pipelines.set(options.sessionId, pipeline);
    const pending = this.pendingBridgeMessages.get(options.sessionId);
    if (pending) {
      this.pendingBridgeMessages.delete(options.sessionId);
      for (const message of pending) {
        pipeline.handleBridgeMessage(message);
      }
    }
    this.setPermissionResolver(options.sessionId, params => pipeline.resolvePermission(params));
    return pipeline;
  }

  override async stop(): Promise<void> {
    for (const pipeline of this.pipelines.values()) {
      pipeline.dispose();
    }
    try {
      await super.stop();
    } finally {
      this.pipelines.clear();
      this.pendingBridgeMessages.clear();
    }
  }

  protected override shouldObserveLocalStderr(): boolean {
    return true;
  }

  protected override onLocalStderrLine(line: string): void {
    const ready = parseDshBridgeReadyLine(line);
    if (ready) {
      this.logMessage(`bridge.ready protocol=${ready.protocol}`);
      return;
    }
    const message = parseDshBridgeToolLine(line);
    if (!message) {
      return;
    }
    this.logMessage(`bridge.${message.type} session=${message.sessionId} call=${message.toolCallId} tool=${message.toolName}`);
    this.routeBridgeMessage(message);
  }

  private routeBridgeMessage(message: DshBridgeToolMessage): void {
    const pipeline = this.pipelines.get(message.sessionId);
    if (pipeline) {
      pipeline.handleBridgeMessage(message);
      return;
    }
    const pending = this.pendingBridgeMessages.get(message.sessionId) ?? [];
    // A broken/malicious bridge must not grow memory without a bound before an
    // ACP session is created. The newest messages are the useful ones.
    pending.push(message);
    if (pending.length > 128) {pending.splice(0, pending.length - 128);}
    this.pendingBridgeMessages.set(message.sessionId, pending);
  }
}
