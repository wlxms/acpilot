import * as vscode from 'vscode';
import type { BackendAgent, BackendModel, BackendConfig, BackendProviderConfig, BackendSettingsDescriptor } from './backend/types';
import { BUILTIN_BACKENDS } from './backends/registry';
import { createParticipantHandler } from './participant/handler';
import { createSessionContentProvider, ACP_SESSION_SCHEME } from './surfaces/vscode/experimental-session';
import { hasRegisterChatSessionContentProvider } from './surfaces/vscode/capabilities';
import { registerLanguageModelChatProvider } from './surfaces/vscode/language-model-provider';
import { StatusBarManager } from './statusbar';
import { SettingsPanel, type SettingsMessage, type SettingsData, type GlobalSettingItem } from './settings/panel';
import { loadPersistedSettingsState, savePersistedSettingsState } from './settings/state-persistence';
import { AppEventBus } from './backend/app-event-bus';
import { SelectionStore } from './backend/selection-store';
import { SessionManager } from './backend/session-manager';
import { SessionStore } from './backend/streaming/session-store';
import type { ExtensionState, BackendContext } from './types';
import { createAcpModels } from './backendmodels/index';
import { AuthReader } from './backendmodels/auth-reader';
import { runActivationMigration } from './backend/streaming/migrate';

const KNOWN_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', description: 'GPT-4o, GPT-4o-mini', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe2' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude 3.5 Sonnet, Opus', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe0' },
  { id: 'google', name: 'Google', description: 'Gemini Pro, Flash', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe1' },
  { id: 'groq', name: 'Groq', description: 'Fast inference', requiresBaseURL: false, isOpenAICompatible: false, icon: '\u26a1' },
  { id: 'xai', name: 'xAI', description: 'Grok models', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83c\udf11' },
  { id: 'mistral', name: 'Mistral', description: 'Mistral, Codestral', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udd34' },
  { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek V3, Coder', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udc33' },
  { id: 'together', name: 'Together AI', description: 'Open model hub', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe3' },
  { id: 'fireworks', name: 'Fireworks AI', description: 'Fast inference', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83c\udf86' },
  { id: 'bedrock', name: 'AWS Bedrock', description: 'Managed models', requiresBaseURL: false, isOpenAICompatible: false, icon: '\u2601\ufe0f' },
  { id: 'azure', name: 'Azure OpenAI', description: 'Azure-hosted OpenAI', requiresBaseURL: true, isOpenAICompatible: false, icon: '\ud83d\udd37' },
  { id: 'copilot', name: 'GitHub Copilot', description: 'Copilot models', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udc19' },
  { id: 'ollama', name: 'Ollama', description: 'Local models', requiresBaseURL: true, isOpenAICompatible: false, icon: '\ud83e\udd99' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Multi-model gateway', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83c\udf10' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', description: 'Any OpenAI-compatible endpoint', requiresBaseURL: true, isOpenAICompatible: true, icon: '\ud83d\udd0c' },
];

/**
 * Descriptor for extension-level global settings (acpilot.experimental.*).
 * Mirrors the `contributes.configuration` entries in package.json so the
 * panel can edit them alongside the native VS Code Settings UI.
 */
interface GlobalSettingDescriptor {
  key: string;
  label: string;
  description: string;
  type: 'toggle' | 'select';
  default: boolean | string;
  options?: Array<{ value: string; label: string }>;
}

const GLOBAL_SETTINGS_DESCRIPTOR: GlobalSettingDescriptor[] = [
  {
    key: 'sessionProvider',
    label: 'Session Provider (Experimental)',
    description: 'Enable the experimental ACP-compatible VS Code chat session provider surface when the runtime exposes the required proposed API.',
    type: 'toggle',
    default: false,
  },
  {
    key: 'acpBackendModelSupport',
    label: 'ACP Backend Model Support',
    description: 'When enabled, ACP backend models (e.g. OpenCode Zen/Go) are registered with sessionOnly=false so they appear in all Copilot session targets. Non-specific models get sessionOnly=true (opencode target only). When disabled, all models get sessionOnly=true.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'acpModelBridge',
    label: 'ACP Model Bridge (Experimental)',
    description: '[Experimental] Enable ACP Model Bridge — bridges ACP backend models into Copilot\'s native model picker with full vendor isolation. (Not yet implemented)',
    type: 'toggle',
    default: false,
  },
  {
    key: 'checkpointReplay',
    label: 'Checkpoint Replay',
    description: 'Replay restored session file checkpoints through VS Code chat external edits when available, preserving ordinary workspace edits on conflicts.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'streamSchedulingMode',
    label: 'Stream Scheduling Mode',
    description: 'Controls how ACP stream parts are scheduled before rendering to VS Code chat.',
    type: 'select',
    default: 'tool-first',
    options: [
      { value: 'immediate', label: 'Immediate — render stream parts as they arrive' },
      { value: 'continuous', label: 'Continuous — keep root reasoning/markdown/tools continuous' },
      { value: 'tool-first', label: 'Tool-first — render tools immediately, buffer reasoning' },
    ],
  },
];

function getWorkspaceDirectory(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return workspaceFolders?.[0]?.uri?.fsPath;
}

let state: ExtensionState | undefined;

function getBackendDisplayName(backendName: string): string {
  if (backendName === 'opencode') {return 'OpenCode';}
  if (!backendName) {return '--';}
  return backendName.charAt(0).toUpperCase() + backendName.slice(1);
}

/** Refresh status bar items from the given backend context */
async function refreshStatusBar(ctx: BackendContext, statusBar: StatusBarManager): Promise<void> {
  try {
    const sel = ctx.selection.get();
    const agentName = sel.agent ?? '--';
    const modelName = sel.modelDisplayName ?? sel.model?.modelID ?? '--';

    statusBar.update({
      backendName: getBackendDisplayName(ctx.backend.name),
      agentName,
      modelName,
      isBackendActive: ctx.backend.isRunning(),
    });
  } catch {
    // non-critical
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('ACPilot');
  outputChannel.appendLine('[extension] ACPilot activating...');

  const statusBar = new StatusBarManager();
  const bus = new AppEventBus();
  const authReader = new AuthReader();
  const workspacePath = getWorkspaceDirectory();
  const backendModelSupport = vscode.workspace.getConfiguration('acpilot').get('experimental.acpBackendModelSupport', true);

  // -- One-time on-disk migration: legacy event lines → SSP stream-parts -----
  // Runs once per machine (globalState-guarded). Best-effort, non-blocking;
  // failures retry next activation. See src/backend/streaming/migrate.ts.
  void runActivationMigration(context, undefined, workspacePath);

  // -- Assemble per-backend contexts in a loop --------------------------------
  const backends = new Map<string, BackendContext>();

  for (const desc of BUILTIN_BACKENDS) {
    if (desc.isEnabled && !desc.isEnabled()) {
      outputChannel.appendLine(`[extension] Backend '${desc.id}' disabled — skipping`);
      continue;
    }

    const backend = desc.factory();
    const selection = new SelectionStore(backend, bus, desc.id);
    const sessions = new SessionManager(backend, bus, desc.id);
    const sessionStore = new SessionStore({ workspaceRoot: workspacePath ?? '', backendName: desc.id });

    const ctx: BackendContext = {
      id: desc.id,
      scheme: desc.scheme,
      vendors: desc.vendors,
      backend,
      selection,
      sessions,
      sessionStore,
    };

    // Hydrate persistent settings BEFORE backend starts so resolveDefaults
    // sees the persisted values and won't overwrite them with config defaults.
    const persisted = loadPersistedSettingsState(context, desc.id);
    selection.hydrate(persisted);

    // Start backend immediately on activation
    backend.start(workspacePath).then(async (result) => {
      if (result.error) {
        outputChannel.appendLine(`[extension] Backend '${desc.id}' start failed: ${String(result.error)}`);
        statusBar.updateError(backend.name);
        return;
      }
      outputChannel.appendLine(`[extension] Backend '${desc.id}' started at ${result.data?.url}`);
      // Load default agent/model from config and update status bar
      await selection.resolveDefaults();
      savePersistedSettingsState(context, desc.id, selection.get());

      // Run ACPModels bidirectional sync (Copilot ↔ backend)
      try {
        await state!.acpModels.sync();
      } catch (syncErr) {
        outputChannel.appendLine(`[extension] ACPModels sync error: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
      }

      await refreshStatusBar(ctx, statusBar);

      // Notify session provider that this backend is ready so it can refresh
      // option groups and session list (avoids polling while offline).
      bus.emit('backend-ready', { backendId: desc.id });
    }).catch((err: unknown) => {
      outputChannel.appendLine(
        `[extension] Backend '${desc.id}' start error: ${err instanceof Error ? err.message : String(err)}`,
      );
      statusBar.updateError(backend.name);
    });

    backends.set(desc.id, ctx);
  }

  // Build the shared ACPModels registry from all assembled backends.
  const acpModels = createAcpModels({
    backends: new Map([...backends.entries()].map(([id, ctx]) => [id, ctx.backend])),
    authReader,
    logger: outputChannel,
    backendModelSupport,
  });

  state = {
    backends,
    acpModels,
    bus,
    outputChannel,
    statusBar,
  };

  // The settings panel operates on a single "primary" backend (the first
  // assembled one). Phase 4 will make the panel backend-aware; for now the
  // primary backend (opencode) is the one whose config/agents/models drive
  // the panel.
  const primaryCtx = backends.values().next().value as BackendContext | undefined;

  // -- Register the settings panel command ------------------------------------
  const openSettingsCommand = vscode.commands.registerCommand(
    'acpilot.openSettings',
    async () => {
      if (!primaryCtx) {return;}
      const panel = SettingsPanel.createOrShow(context.extensionUri);

      // Wire up message handler
      panel.onDidRequestChange = async (message: SettingsMessage) => {
        if (!state || !primaryCtx) {return;}
        const s = state;

        try {
          switch (message.type) {
            case 'ready': {
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'refreshData': {
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'setAgent': {
              await primaryCtx.selection.setAgent(message.agentId);
              savePersistedSettingsState(context, primaryCtx.id, primaryCtx.selection.get());
              await refreshStatusBar(primaryCtx, state.statusBar);
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'setModel': {
              await primaryCtx.selection.setModel(message.providerID, message.modelID);
              savePersistedSettingsState(context, primaryCtx.id, primaryCtx.selection.get());
              await refreshStatusBar(primaryCtx, state.statusBar);
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'setDefaultAgent': {
              await primaryCtx.backend.config.update({
                default_agent: message.agent || undefined,
              });
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'setDefaultModel': {
              await primaryCtx.backend.config.update({
                model: message.model || undefined,
              });
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'saveBackendSettings': {
              if (primaryCtx.backend.settingsProvider) {
                await primaryCtx.backend.settingsProvider.saveValues(message.values);
              }
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'setGlobalSetting': {
              await vscode.workspace
                .getConfiguration('acpilot')
                .update(`experimental.${message.key}`, message.value, vscode.ConfigurationTarget.Global);
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'connectProvider': {
              const known = KNOWN_PROVIDERS.find(p => p.id === message.providerId);
              const apiType = message.providerId === 'openai-compatible' ? 'openai' : message.providerId;
              const providerConfig: BackendProviderConfig = {
                api: apiType,
                id: message.providerId,
                name: message.displayName || known?.name || message.providerId,
                options: {
                  apiKey: message.apiKey,
                  ...(message.baseURL ? { baseURL: message.baseURL } : {}),
                },
              };
              const configKey = message.providerId === 'openai-compatible'
                ? (message.displayName?.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'custom-' + Date.now())
                : message.providerId;
              await primaryCtx.backend.config.update({
                provider: { [configKey]: providerConfig },
              });
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'disconnectProvider': {
              const currentConfig = await primaryCtx.backend.config.get();
              const currentProviders = { ...(currentConfig.data?.provider ?? {}) };
              delete currentProviders[message.configKey];
              await primaryCtx.backend.config.update({
                provider: currentProviders,
              });
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
            case 'updateProvider': {
              const currentCfg = await primaryCtx.backend.config.get();
              const existing = currentCfg.data?.provider?.[message.configKey];
              const updateConfig: BackendProviderConfig = {
                options: {
                  apiKey: message.apiKey,
                  ...(message.baseURL ? { baseURL: message.baseURL } : {}),
                },
              };
              if (existing?.id) { updateConfig.id = existing.id; }
              if (existing?.name) { updateConfig.name = existing.name; }
              if (existing?.api) { updateConfig.api = existing.api; }
              await primaryCtx.backend.config.update({
                provider: { [message.configKey]: updateConfig },
              });
              await pushDataToPanel(s, primaryCtx, panel);
              break;
            }
          }
        } catch (err) {
          outputChannel.appendLine(
            `[settings] Error handling message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // Push initial data
      await pushDataToPanel(state!, primaryCtx, panel);
    },
  );

  // -- Register surfaces per backend (participant / session provider / LM) ----
  for (const ctx of backends.values()) {
    const participant = vscode.chat.createChatParticipant(
      ctx.scheme,
      createParticipantHandler(state!, ctx),
    );

    if (ctx.id === 'opencode') {
      participant.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'opencode-icon-light.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'opencode-icon-dark.svg'),
      };
    }

    participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      outputChannel.appendLine(
        `[feedback:${ctx.id}] ${feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? '👍' : '👎'}`,
      );
    });

    if (hasRegisterChatSessionContentProvider()) {
      const { provider, controller } = createSessionContentProvider(state!, ctx, context);
      const registration = vscode.chat.registerChatSessionContentProvider(
        ctx.scheme,
        provider,
        participant,
        { supportsChangingSessionType: true },
      );

      context.subscriptions.push(registration);
      if (controller) {
        outputChannel.appendLine(`[extension:${ctx.id}] Session content provider registered (controller id=${controller.id})`);
      } else {
        outputChannel.appendLine(`[extension:${ctx.id}] Session content provider registered (no controller)`);
      }
    }

    const lmRegistration = registerLanguageModelChatProvider(state!, ctx);
    if (lmRegistration) {
      context.subscriptions.push(lmRegistration);
    }

    context.subscriptions.push(participant);
  }

  context.subscriptions.push(outputChannel, statusBar, openSettingsCommand, bus);
  outputChannel.appendLine('[extension] ACPilot activated');
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  return key.slice(0, 4) + '\u2022\u2022\u2022\u2022' + key.slice(-4);
}

function computeConnectedProviders(
  config: { provider?: Record<string, BackendProviderConfig> },
  models: BackendModel[],
): SettingsData['connectedProviders'] {
  const result: SettingsData['connectedProviders'] = [];
  const seen = new Set<string>();

  // 1) Explicit provider entries from config.provider (user-configured with API keys)
  const explicitProviders = config.provider ?? {};
  for (const [key, value] of Object.entries(explicitProviders)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const apiKey = value.options?.apiKey;
    result.push({
      configKey: key,
      id: value.id || value.api || key,
      name: value.name || key,
      hasApiKey: Boolean(apiKey),
      apiKeyPreview: apiKey ? maskApiKey(apiKey) : undefined,
      baseURL: value.options?.baseURL,
    });
  }

  // 2) Providers discovered from models (populated by SDK from env vars / auth)
  for (const m of models) {
    const pid = m.provider;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    result.push({
      configKey: pid,
      id: pid,
      name: m.providerName || pid,
      hasApiKey: true, // If models show up, the provider is authenticated
      baseURL: undefined,
    });
  }

  return result;
}

/** Read extension-level global settings (acpilot.experimental.*) for the panel. */
function readGlobalSettings(): GlobalSettingItem[] {
  const cfg = vscode.workspace.getConfiguration('acpilot');
  return GLOBAL_SETTINGS_DESCRIPTOR.map(d => {
    const raw = cfg.get<boolean | string>(`experimental.${d.key}`, d.default);
    return {
      key: d.key,
      label: d.label,
      description: d.description,
      type: d.type,
      value: raw,
      options: d.options,
    } satisfies GlobalSettingItem;
  });
}

/** Push current backend data into the settings webview panel */
async function pushDataToPanel(s: ExtensionState, ctx: BackendContext, panel: SettingsPanel): Promise<void> {
  try {
    const [agentsResp, modelsResp, configResp] = await Promise.all([
      ctx.backend.config.agents().catch(() => ({ data: [] as BackendAgent[] })),
      ctx.backend.config.models().catch(() => ({ data: [] as BackendModel[] })),
      ctx.backend.config.get().catch(() => ({ data: undefined })),
    ]);

    const agents = agentsResp.data ?? [];
    const models = modelsResp.data ?? [];
    const config = configResp.data ?? {};

    // Get backend settings descriptor if provider exists
    let backendSettings: BackendSettingsDescriptor | undefined;
    if (ctx.backend.settingsProvider) {
      try {
        backendSettings = await ctx.backend.settingsProvider.getDescriptor(agents, models);
      } catch {
        // non-critical — backend settings UI will show empty state
      }
    }

    const data: SettingsData = {
      backendName: getBackendDisplayName(ctx.backend.name),
      agents: agents.map((a: BackendAgent) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        model: typeof (a).model === 'object' && (a).model !== null
          ? ((a).model.modelID ?? String((a).model))
          : a.model,
        mode: a.mode,
        hidden: a.hidden,
      })),
      models: models.map((m: BackendModel) => ({
        id: m.id,
        name: m.name,
        provider: m.providerName ?? m.provider,
        providerId: m.provider,
        capabilities: m.capabilities,
      })),
      currentAgent: ctx.selection.get().agent,
      currentModel: ctx.selection.get().model,
      currentModelDisplayName: ctx.selection.get().modelDisplayName,
      defaultAgent: config.default_agent,
      defaultModel: config.model,
      backendSettings,
      connectedProviders: computeConnectedProviders(config, models),
      availableProviders: KNOWN_PROVIDERS,
      globalSettings: readGlobalSettings(),
    };

    s.outputChannel.appendLine(`[settings] pushDataToPanel: currentModel=${JSON.stringify(data.currentModel)}, configModel=${config.model}, currentAgent=${data.currentAgent}`);
    s.outputChannel.appendLine(`[settings] pushDataToPanel: models count=${data.models.length}, model IDs=${data.models.map((m) => m.id + '(' + m.providerId + ')').join(', ')}`);
    s.outputChannel.appendLine(`[settings] pushDataToPanel: agents=${data.agents.map((a) => a.id + ':model=' + (a.model ?? 'none')).join(', ')}`);

    panel.updateData(data);
  } catch {
    // non-critical
  }
}

export function deactivate() {
  if (state) {
    state.outputChannel.appendLine('[extension] Deactivating...');
    for (const ctx of state.backends.values()) {
      if (ctx.backend.isRunning()) {
        ctx.backend.stop().catch((err: unknown) => {
          state!.outputChannel.appendLine(
            `[extension] Stop error (${ctx.id}): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }
  }
}
