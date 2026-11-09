import type {
  ActiveSessionMessage,
  SessionConfigOption,
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
  parseDshBridgeCatalogLine,
  parseDshDesktopSavedSelectionLine,
  DSH_DESKTOP_SAVED_SELECTION_PREFIX,
  type DshDesktopSavedSelection,
  parseDshBridgeDiagnosticLine,
  parseDshBridgeReadyLine,
  parseDshBridgeToolLine,
  type DshBridgeCatalogModel,
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
  private desktopSavedSelection: DshDesktopSavedSelection | undefined;
  private readonly pipelines = new Map<string, DshPipeline>();
  private readonly pendingBridgeMessages = new Map<string, DshBridgeToolMessage[]>();
  /** Exact model metadata emitted after the DSH LLM service is ready. */
  private bridgeCatalog = new Map<string, DshBridgeCatalogModel>();
  /** Notified after bridge metadata invalidates the backend model catalog. */
  private readonly bridgeCatalogChangedEmitter = new SimpleEventEmitter<void>();

  /**
   * Subscribe to bridge model-capability updates. The DSH bridge can publish its
   * catalog after ACP model discovery, so the host must re-query the catalog
   * instead of retaining the earlier model list.
   */
  onDidChangeModelCatalog(listener: () => void): () => void {
    return this.bridgeCatalogChangedEmitter.on(listener);
  }

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

  protected override async configModels(directory?: string) {
    const result = await super.configModels(directory);
    if (result.error !== undefined) {return result;}
    // DSH ACP exposes route ids only. Wait for bridge metadata before publishing
    // a model with a misleading default context window.
    if (this.bridgeCatalog.size === 0) {return { data: [] }; }
    return {
      data: (result.data ?? []).flatMap(model => {
        const route = parseDshAcpModelRoute(model);
        const bridge = route
          ? this.bridgeCatalog.get(`${route.provider}/${route.model}`)
          : undefined;
        // A route-only ACP entry has no trustworthy context window. Expose it
        // only after the bridge supplies exact model metadata.
        if (!bridge) {return [];}
        return [{
          ...model,
          displayProviderID: route!.provider,
          name: bridge.name ?? model.name ?? route!.model,
          maxInputTokens: bridge.contextWindow ?? model.maxInputTokens,
          maxOutputTokens: bridge.maxOutputTokens ?? model.maxOutputTokens,
          ...(bridge.reasoningEfforts?.length
            ? {
                reasoningEfforts: bridge.reasoningEfforts,
                defaultReasoningEffort: bridge.defaultReasoningEffort,
              }
            : {}),
        }];
      }),
    };
  }
  protected override async initializeNewSessionConfig(
    options: SessionConfigOption[],
    setOption: (configId: string, value: string) => Promise<SessionConfigOption[]>,
    launchEnv?: NodeJS.ProcessEnv,
  ): Promise<SessionConfigOption[]> {
    const saved = this.desktopSavedSelection;
    if (!saved || saved.nonce !== launchEnv?.ACPILOT_DSH_BRIDGE_NONCE) {return options;}
    const model = options.find(option => option.type === 'select' && option.category === 'model');
    const thought = options.find(option => option.type === 'select' && option.category === 'thought_level');
    if (!model || model.type !== 'select' || !thought || thought.type !== 'select' || thought.currentValue !== '') {return options;}
    const selected = parseDshAcpModelRoute({ id: model.currentValue });
    const efforts = thought.options.flatMap(item => 'options' in item ? item.options : [item]);
    if (selected?.provider !== saved.provider || selected.model !== saved.model
      || !efforts.some(effort => effort.value === saved.reasoningEffort)) {return options;}
    try {
      const updated = await setOption(thought.id, saved.reasoningEffort);
      this.logMessage('desktop.saved-selection initialized');
      return updated;
    } catch {
      this.logMessage('desktop.saved-selection could not be applied; retaining ACP session defaults');
      return options;
    }
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
    this.desktopSavedSelection = undefined;
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

  protected override onLocalStderrLine(line: string, launchEnv?: NodeJS.ProcessEnv): void {
    if (line.startsWith(DSH_DESKTOP_SAVED_SELECTION_PREFIX)) {
      const saved = parseDshDesktopSavedSelectionLine(line, launchEnv?.ACPILOT_DSH_BRIDGE_NONCE ?? '');
      if (saved) {
        this.desktopSavedSelection = saved;
        this.logMessage('desktop.saved-selection received');
      }
      return;
    }
    const ready = parseDshBridgeReadyLine(line);
    if (ready) {
      this.logMessage(`bridge.ready protocol=${ready.protocol}`);
      return;
    }
    const catalog = parseDshBridgeCatalogLine(line);
    if (catalog) {
      this.bridgeCatalog = new Map(catalog.models.map(model => [`${model.provider}/${model.model}`, model]));
      this.logMessage(`bridge.catalog models=${this.bridgeCatalog.size}`);
      this.bridgeCatalogChangedEmitter.emit();
      return;
    }
    const diagnostic = parseDshBridgeDiagnosticLine(line);
    if (diagnostic) {
      this.logMessage(
        `bridge.diagnostic event=${diagnostic.event} ${formatDiagnosticFields(diagnostic)}`.trim(),
      );
      return;
    }
    const message = parseDshBridgeToolLine(line);
    if (!message) {
      this.logMessage(`stderr: ${line}`);
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

function formatDiagnosticFields(diagnostic: Record<string, unknown>): string {
  return Object.entries(diagnostic)
    .filter(([key]) => key !== 'protocol' && key !== 'event')
    .map(([key, value]) => `${key}=${formatDiagnosticValue(value)}`)
    .join(' ');
}

function formatDiagnosticValue(value: unknown): string {
  if (value === null) {return 'null';}
  if (typeof value === 'string') {
    return /^[^\s=]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {return String(value);}
  try {return JSON.stringify(value);}
  catch {return String(value);}
}

/** Decode the opaque ACP model selector into DSH's provider/model route. */
function parseDshAcpModelRoute(
  model: { id: string; provider?: string },
): { provider: string; model: string } | undefined {
  const id = model.id.trim();
  if (!id) {return undefined;}
  try {
    const parsed = JSON.parse(id) as unknown;
    if (Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && parsed[0].length > 0
      && typeof parsed[1] === 'string'
      && parsed[1].length > 0) {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch {
    // Ordinary provider/model ids below are not JSON.
  }
  const provider = model.provider?.trim();
  if (provider && provider !== 'dsh') {
    return { provider, model: id };
  }
  const separator = id.indexOf('/');
  if (separator > 0 && separator < id.length - 1) {
    return { provider: id.slice(0, separator), model: id.slice(separator + 1) };
  }
  return undefined;
}
class SimpleEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}
