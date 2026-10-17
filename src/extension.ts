import * as vscode from "vscode";
import { join } from "node:path";
import type {
  BackendAgent,
  BackendModel,
  BackendProviderConfig,
  BackendSettingsDescriptor,
} from "./backend/types";
import { normalizePermissionMode } from "./backend/types";
import {
  assertBuiltinBackendAssembly,
  BUILTIN_BACKENDS,
} from "./backends/registry";
import { createReasonixBackendOptions } from "./backends/reasonix";
import {
  createDshBridgeLaunchNonce,
  parseDshBridgeReadyLine,
} from "./backends/dsh/bridge-protocol";
import {
  DEFAULT_DSH_COMMAND,
  DEFAULT_DSH_PACKAGE_SPEC,
} from "./backends/dsh/target";
import {
  commandAfterDshInstall,
  defaultDshArgs,
  installDsh,
} from "./backends/dsh/installer";
import { createSessionContentProvider } from "./surfaces/vscode/experimental-session";
import { createStableHandler } from "./surfaces/vscode/stable-participant";
import { hasRegisterChatSessionContentProvider } from "./surfaces/vscode/capabilities";
import { registerLanguageModelChatProvider } from "./surfaces/vscode/language-model-provider";
import { StatusBarManager } from "./statusbar";
import {
  SettingsPanel,
  type SettingsMessage,
  type SettingsData,
  type DirectoryField,
  type GlobalSettingItem,
  type BackendTargetItem,
} from "./settings/panel";
import {
  getActiveAcpTarget,
  getActiveDshTarget,
  getActiveAcpTargetWithAuth,
  loadAcpTargetState,
  loadDshTargetState,
  loadPersistedSettingsState,
  removeAcpTarget,
  removeDshTarget,
  savePersistedSettingsState,
  setActiveAcpTarget,
  setActiveDshTarget,
  upsertAcpTarget,
  upsertDshTarget,
} from "./settings/state-persistence";
import { AppEventBus } from "./backend/app-event-bus";
import { SelectionStore } from "./backend/selection-store";
import { SessionManager } from "./backend/session-manager";
import { SessionStore } from "./backend/streaming/session-store";
import {
  createBackendInstanceKey,
  getBackendStorageNamespace,
} from "./backend/backend-instance";
import type { ExtensionState, BackendContext } from "./types";
import { createCopilotModelCatalog } from "./surfaces/vscode/model-catalog";
import type { AcpBackendOptions } from "./backends/acp";
import type { DshTargetInput } from "./backends/dsh/target";
import { startRuntimeTestControlServer } from "./test-control/server";
import { createRuntimeTestApi } from "./test-control/runtime-api";
import { beginBackendRuntimeTransition } from "./runtime/backend-transition";

export async function chooseDshDirectory(
  field: DirectoryField,
  currentValue: string,
  workspacePath: string | undefined,
  showOpenDialog: (options: vscode.OpenDialogOptions) => Thenable<readonly vscode.Uri[] | undefined> = (options) =>
    vscode.window.showOpenDialog(options),
): Promise<{ field: DirectoryField; value: string } | undefined> {
  const candidate = currentValue.trim() || workspacePath?.trim();
  const options: vscode.OpenDialogOptions = {
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select folder",
  };
  if (candidate) {
    try {
      options.defaultUri = vscode.Uri.file(candidate);
    } catch {
      // Ignore malformed input and let VS Code open the default location.
    }
  }
  const selected = await showOpenDialog(options);
  const uri = selected?.[0];
  return uri ? { field, value: uri.fsPath } : undefined;
}

const KNOWN_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-4o, GPT-4o-mini",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udfe2",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude 3.5 Sonnet, Opus",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udfe0",
  },
  {
    id: "google",
    name: "Google",
    description: "Gemini Pro, Flash",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udfe1",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Fast inference",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\u26a1",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok models",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83c\udf11",
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral, Codestral",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udd34",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek V3, Coder",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udc33",
  },
  {
    id: "together",
    name: "Together AI",
    description: "Open model hub",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udfe3",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    description: "Fast inference",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83c\udf86",
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    description: "Managed models",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\u2601\ufe0f",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    description: "Azure-hosted OpenAI",
    requiresBaseURL: true,
    isOpenAICompatible: false,
    icon: "\ud83d\udd37",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    description: "Copilot models",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83d\udc19",
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local models",
    requiresBaseURL: true,
    isOpenAICompatible: false,
    icon: "\ud83e\udd99",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Multi-model gateway",
    requiresBaseURL: false,
    isOpenAICompatible: false,
    icon: "\ud83c\udf10",
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    description: "Any OpenAI-compatible endpoint",
    requiresBaseURL: true,
    isOpenAICompatible: true,
    icon: "\ud83d\udd0c",
  },
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
  type: "toggle" | "select";
  default: boolean | string;
  options?: Array<{ value: string; label: string }>;
}

const GLOBAL_SETTINGS_DESCRIPTOR: GlobalSettingDescriptor[] = [
  {
    key: "streamSchedulingMode",
    label: "Stream Scheduling Mode",
    description:
      "Controls how ACP stream parts are scheduled before rendering to VS Code chat.",
    type: "select",
    default: "tool-first",
    options: [
      {
        value: "immediate",
        label: "Immediate — render stream parts as they arrive",
      },
      {
        value: "continuous",
        label: "Continuous — keep root reasoning/markdown/tools continuous",
      },
      {
        value: "tool-first",
        label: "Tool-first — render tools immediately, buffer reasoning",
      },
    ],
  },
];

function getWorkspaceDirectory(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return workspaceFolders?.[0]?.uri?.fsPath;
}

let state: ExtensionState | undefined;
let activationGeneration = 0;
let deactivating = false;
/**
 * VS Code must be able to tear down the extension host even when a backend
 * transport is already broken. Backend stop implementations are bounded on
 * their normal cleanup paths, but this composition-root bound protects the
 * host from an unexpected promise that never settles.
 */
const DEACTIVATE_STOP_TIMEOUT_MS = 5_000;

async function stopBackendForDeactivation(
  ctx: BackendContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const stop = Promise.resolve().then(() => ctx.backend.stop());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stop,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          outputChannel.appendLine(
            `[extension] Stop timeout (${ctx.id}) after ${DEACTIVATE_STOP_TIMEOUT_MS}ms`,
          );
          resolve();
        }, DEACTIVATE_STOP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Participant implementations are registered in VS Code's main process, not
 * in the extension host. During a reload the old host can still be disposing
 * while the new host is already activating, so blindly calling
 * createChatParticipant again can race into "Agent already registered".
 * Reusing the main-process registration also keeps the hand-off atomic: only
 * the request handler and feedback sink change between activations.
 */
interface ParticipantRegistration {
  readonly participant: vscode.ChatParticipant;
  ownerGeneration: number;
  feedbackDisposable?: vscode.Disposable;
}

const participantRegistrations = new Map<string, ParticipantRegistration>();

function registerParticipant(
  context: vscode.ExtensionContext,
  generation: number,
  ctx: BackendContext,
  outputChannel: vscode.OutputChannel,
): vscode.ChatParticipant {
  const handler = createStableHandler(state!, ctx);
  let registration = participantRegistrations.get(ctx.scheme);

  if (!registration) {
    registration = {
      participant: vscode.chat.createChatParticipant(ctx.scheme, handler),
      ownerGeneration: generation,
    };
    participantRegistrations.set(ctx.scheme, registration);
  } else {
    // Keep the already registered agent implementation and replace only the
    // closure it invokes. This avoids a duplicate main-process registration
    // when VS Code overlaps old/new extension activations.
    registration.participant.requestHandler = handler;
    registration.ownerGeneration = generation;
    registration.feedbackDisposable?.dispose();
  }

  if (ctx.id === "opencode") {
    registration.participant.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "resources", "opencode-icon-light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "resources", "opencode-icon-dark.svg"),
    };
  }

  registration.feedbackDisposable = registration.participant.onDidReceiveFeedback(
    (feedback: vscode.ChatResultFeedback) => {
      outputChannel.appendLine(
        `[feedback:${ctx.id}] ${feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? "helpful" : "unhelpful"}`,
      );
    },
  );

  const ownedRegistration = registration;
  context.subscriptions.push({
    dispose: () => {
      // An older activation must not dispose a registration now owned by a
      // newer activation. The newer activation will release it normally.
      if (participantRegistrations.get(ctx.scheme) !== ownedRegistration
        || ownedRegistration.ownerGeneration !== generation) {
        return;
      }
      participantRegistrations.delete(ctx.scheme);
      ownedRegistration.feedbackDisposable?.dispose();
      ownedRegistration.feedbackDisposable = undefined;
      ownedRegistration.participant.dispose();
    },
  });

  return registration.participant;
}

function isCurrentActivation(generation: number): boolean {
  return !deactivating && activationGeneration === generation;
}

function isCurrentState(candidate: ExtensionState): boolean {
  return !deactivating && state === candidate;
}

function getContextDisplayName(ctx: BackendContext): string {
  return ctx.displayName;
}

interface DynamicAcpBackend {
  setOptionsProvider(
    provider: () =>
      AcpBackendOptions | undefined | Promise<AcpBackendOptions | undefined>,
  ): void;
}

function isDynamicAcpBackend(value: unknown): value is DynamicAcpBackend {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as DynamicAcpBackend).setOptionsProvider === "function"
  );
}

async function resolveSelectedAcpBackendOptions(
  context: vscode.ExtensionContext,
): Promise<AcpBackendOptions | undefined> {
  const target = await getActiveAcpTargetWithAuth(context);
  if (!target) {
    return undefined;
  }
  return {
    remote: {
      url: target.endpoint,
      authToken: target.authToken,
    },
  };
}

async function resolveSelectedDshBackendOptions(
  context: vscode.ExtensionContext,
): Promise<AcpBackendOptions | undefined> {
  const target = getActiveDshTarget(context);
  if (!target) {
    return undefined;
  }
  const nonce = createDshBridgeLaunchNonce();
  return {
    local: {
      command: target.command,
      args: target.args,
      cwd: target.launchCwd,
      // The bridge is optional. A user's normal `dsh --profile acp` process
      // speaks ACP directly; an installed ACPilot bridge can use this nonce to
      // publish its readiness marker for future protocol extensions.
      env: { ACPILOT_DSH_BRIDGE_NONCE: nonce },
      stderr: 'pipe',
      shell: process.platform === 'win32',
      onStderrLine: (line) => {
        // Consume only the ACPilot bridge marker as a recognized extension
        // signal. Ordinary DSH diagnostics remain out-of-band and are ignored.
        void parseDshBridgeReadyLine(line, nonce);
      },
    },
  };
}

function getBackendTargets(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  activeId: string,
): BackendTargetItem[] {
  const targetState = loadAcpTargetState(context);
  const dshTargetState = loadDshTargetState(context);
  return [
    ...[...s.backends.values()]
      .filter((ctx) => ctx.id !== "acp")
      .map((ctx) => ({
        id: `builtin:${ctx.id}`,
        kind: "builtin" as const,
        name: getContextDisplayName(ctx),
        description: ctx.id === "dsh"
          ? "Configure a user-owned DeepSeek Harness command"
          : `${getContextDisplayName(ctx)} backend`,
        active: activeId === `builtin:${ctx.id}`,
        editable: false,
      })),
    ...targetState.targets.map((target) => ({
      id: `acp:${target.id}`,
      kind: "acp" as const,
      name: target.name,
      description: "Remote ACP endpoint",
      endpoint: target.endpoint,
      active: activeId === `acp:${target.id}`,
      editable: true,
    })),
    ...dshTargetState.targets.map((target) => ({
      id: `dsh:${target.id}`,
      kind: "dsh" as const,
      name: target.name,
      description: `${target.command} (${target.launchCwd})`,
      command: target.command,
      args: target.args,
      launchCwd: target.launchCwd,
      installDirectory: target.installDirectory,
      packageSpec: target.packageSpec,
      active: activeId === `dsh:${target.id}`,
      editable: true,
    })),
  ];
}

function getSettingsBackendContext(
  s: ExtensionState,
  targetId: string,
): BackendContext | undefined {
  const backendId = targetId.startsWith("acp:") || targetId.startsWith("dsh:")
    ? targetId.split(":", 1)[0]
    : targetId.replace(/^builtin:/, "");
  return s.backends.get(backendId);
}

function getAcpInstanceKey(context: vscode.ExtensionContext): string {
  const target = getActiveAcpTarget(context);
  if (target) {
    return createBackendInstanceKey("acp", target.id);
  }
  return createBackendInstanceKey("acp", "unconfigured");
}

function getDshInstanceKey(context: vscode.ExtensionContext): string {
  const target = getActiveDshTarget(context);
  if (target) {
    return createBackendInstanceKey("dsh", target.id);
  }
  return createBackendInstanceKey("dsh", "unconfigured");
}

function getDshSettingsTarget(
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
) {
  const installDirectory = context.globalStorageUri
    ? vscode.Uri.joinPath(context.globalStorageUri, "dsh").fsPath
    : join(workspacePath ?? process.cwd(), ".acpilot-dsh");
  const active = getActiveDshTarget(context);
  if (active) {
    return {
      ...active,
      installDirectory: active.installDirectory ?? installDirectory,
    };
  }
  return {
    name: "DeepSeek Harness",
    command: DEFAULT_DSH_COMMAND,
    args: defaultDshArgs(),
    launchCwd: workspacePath ?? process.cwd(),
    installDirectory,
    packageSpec: DEFAULT_DSH_PACKAGE_SPEC,
  };
}

function createContextRuntime(
  backend: BackendContext["backend"],
  bus: AppEventBus,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  backendId: string,
  instanceKey: string,
): Pick<
  BackendContext,
  "storageNamespace" | "selection" | "sessions" | "sessionStore"
> {
  const storageNamespace = getBackendStorageNamespace(instanceKey);
  const storage = {
    load: () => loadPersistedSettingsState(context, instanceKey),
    save: (
      selectionState: Parameters<typeof savePersistedSettingsState>[2],
    ) => {
      savePersistedSettingsState(context, instanceKey, selectionState);
    },
  };
  const selection = new SelectionStore(backend, bus, backendId, storage);
  selection.hydrate(storage.load());
  return {
    storageNamespace,
    selection,
    sessions: new SessionManager(backend, bus, backendId),
    sessionStore: new SessionStore({
      workspaceRoot: workspacePath ?? "",
      backendName: storageNamespace,
    }),
  };
}

function resetContextRuntime(
  ctx: BackendContext,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  instanceKey: string,
  bus: AppEventBus,
): void {
  ctx.instanceKey = instanceKey;
  const runtime = createContextRuntime(
    ctx.backend,
    bus,
    context,
    workspacePath,
    ctx.id,
    instanceKey,
  );
  ctx.storageNamespace = runtime.storageNamespace;
  ctx.selection = runtime.selection;
  ctx.sessions = runtime.sessions;
  ctx.sessionStore = runtime.sessionStore;
}

let acpRestartQueue: Promise<void> = Promise.resolve();

interface AcpRuntimeTransition {
  readonly context: BackendContext;
  readonly generation: number;
}

/**
 * Invalidate the current ACP runtime before an asynchronous target mutation.
 *
 * Target state is persisted through VS Code's async globalState API. The
 * runtime must stop accepting work before that await, otherwise a request can
 * enter the old connection while the target change is being written.
 */
function invalidateAcpBackendRuntime(
  s: ExtensionState,
): AcpRuntimeTransition | undefined {
  if (!isCurrentState(s)) {
    return undefined;
  }
  const acpCtx = s.backends.get("acp");
  if (!acpCtx) {
    return undefined;
  }
  const generation = beginBackendRuntimeTransition(acpCtx, s.bus);
  s.modelCatalog.clearBackend(acpCtx.id);
  s.bus.emit("models-changed", { backendId: acpCtx.id });
  return { context: acpCtx, generation };
}

/**
 * Persist an ACP target mutation with the runtime transition as one serialized
 * operation. A failed mutation still queues a restart so the old target is
 * restored and the context does not remain permanently invalidated.
 */
async function mutateAcpTarget<T>(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  const transition = invalidateAcpBackendRuntime(s);
  let result: T;
  try {
    result = await mutation();
  } catch (error) {
    if (transition) {
      try {
        // Read the persisted state (which is still the old target when the
        // mutation failed) and restore a usable runtime before rethrowing.
        await restartAcpBackendForTarget(s, context, workspacePath, transition);
      } catch (recoveryError) {
        s.outputChannel.appendLine(
          `[settings] ACP target recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    }
    throw error;
  }
  if (transition) {
    await restartAcpBackendForTarget(s, context, workspacePath, transition);
  }
  return result;
}

function restartAcpBackendForTarget(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  transition?: AcpRuntimeTransition,
): Promise<void> {
  if (!isCurrentState(s)) {
    return Promise.resolve();
  }
  const acpCtx = s.backends.get("acp");
  if (!acpCtx) {
    return Promise.resolve();
  }

  // Invalidate synchronously when no caller has already done so. Callers that
  // mutate persisted target state use `mutateAcpTarget`, which performs this
  // step before the globalState await.
  const activeTransition = transition?.context === acpCtx
    ? transition
    : invalidateAcpBackendRuntime(s);
  if (!activeTransition) {
    return Promise.resolve();
  }
  const transitionGeneration = activeTransition.generation;

  const restart = acpRestartQueue.then(() =>
    doRestartAcpBackendForTarget(s, context, workspacePath, transitionGeneration),
  );
  acpRestartQueue = restart.catch(() => {});
  return restart;
}

async function doRestartAcpBackendForTarget(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  transitionGeneration: number,
): Promise<void> {
  if (!isCurrentState(s)) {
    return;
  }
  const acpCtx = s.backends.get("acp");
  if (!acpCtx) {
    return;
  }
  const isCurrentTransition = (): boolean =>
    isCurrentState(s) && acpCtx.runtimeGeneration === transitionGeneration;
  const discardSupersededModels = (): boolean => {
    if (isCurrentTransition()) {
      return false;
    }
    // A refresh that started just before a newer transition can complete after
    // that transition's initial clear. Clear again so its stale snapshot is
    // never left visible while the newer queued restart is waiting.
    s.modelCatalog.clearBackend(acpCtx.id);
    s.bus.emit("models-changed", { backendId: acpCtx.id });
    return true;
  };
  if (!isCurrentTransition()) {
    return;
  }
  try {
    const selected = await getActiveAcpTargetWithAuth(context);
    if (!isCurrentTransition()) {
      return;
    }
    const instanceKey = selected
      ? createBackendInstanceKey("acp", selected.id)
      : createBackendInstanceKey("acp", "unconfigured");
    const selectedOptions: AcpBackendOptions | undefined = selected
      ? { remote: { url: selected.endpoint, authToken: selected.authToken } }
      : undefined;
    if (isDynamicAcpBackend(acpCtx.backend)) {
      acpCtx.backend.setOptionsProvider(() => selectedOptions);
    }
    if (acpCtx.backend.isRunning() || acpCtx.backend.getStatus() === "starting") {
      await acpCtx.backend.stop();
    }

    if (!isCurrentTransition()) {
      return;
    }

    resetContextRuntime(acpCtx, context, workspacePath, instanceKey, s.bus);

    if (!selected) {
      s.statusBar.updateError(acpCtx.id, getContextDisplayName(acpCtx));
      s.bus.emit("backend-ready", { backendId: acpCtx.id });
      return;
    }

    const result = await acpCtx.backend.start(workspacePath);
    if (!isCurrentTransition()) {
      // Deactivation may have begun while the backend was starting. The stop
      // path owns the final cleanup, but close a late successful start here as
      // well so a queued target switch cannot resurrect the backend.
      if (!result.error) {
        await acpCtx.backend.stop();
      }
      return;
    }
    if (result.error) {
      s.outputChannel.appendLine(
        `[settings] ACP target start failed: ${String(result.error)}`,
      );
      s.statusBar.updateError(acpCtx.id, getContextDisplayName(acpCtx));
      return;
    }
    await acpCtx.selection.resolveDefaults();
    if (!isCurrentTransition()) {
      return;
    }
    await s.modelCatalog.refresh(workspacePath);
    if (discardSupersededModels()) {
      return;
    }
    await refreshStatusBar(acpCtx, s.statusBar);
    if (!isCurrentTransition()) {
      return;
    }
    s.bus.emit("backend-ready", { backendId: acpCtx.id });
  } finally {
    if (isCurrentState(s) && acpCtx.runtimeGeneration === transitionGeneration) {
      acpCtx.acceptingRequests = true;
    }
  }
}

let dshRestartQueue: Promise<void> = Promise.resolve();

interface DshRuntimeTransition {
  readonly context: BackendContext;
  readonly generation: number;
}

function invalidateDshBackendRuntime(
  s: ExtensionState,
): DshRuntimeTransition | undefined {
  if (!isCurrentState(s)) {
    return undefined;
  }
  const dshCtx = s.backends.get("dsh");
  if (!dshCtx) {
    return undefined;
  }
  const generation = beginBackendRuntimeTransition(dshCtx, s.bus);
  s.modelCatalog.clearBackend(dshCtx.id);
  s.bus.emit("models-changed", { backendId: dshCtx.id });
  return { context: dshCtx, generation };
}

async function mutateDshTarget<T>(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  const transition = invalidateDshBackendRuntime(s);
  let result: T;
  try {
    result = await mutation();
  } catch (error) {
    if (transition) {
      try {
        await restartDshBackendForTarget(s, context, workspacePath, transition);
      } catch (recoveryError) {
        s.outputChannel.appendLine(
          `[settings] DSH target recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    }
    throw error;
  }
  if (transition) {
    await restartDshBackendForTarget(s, context, workspacePath, transition);
  }
  return result;
}

function restartDshBackendForTarget(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  transition?: DshRuntimeTransition,
): Promise<void> {
  if (!isCurrentState(s)) {
    return Promise.resolve();
  }
  const dshCtx = s.backends.get("dsh");
  if (!dshCtx) {
    return Promise.resolve();
  }
  const activeTransition = transition?.context === dshCtx
    ? transition
    : invalidateDshBackendRuntime(s);
  if (!activeTransition) {
    return Promise.resolve();
  }
  const restart = dshRestartQueue.then(() =>
    doRestartDshBackendForTarget(s, context, workspacePath, activeTransition.generation),
  );
  dshRestartQueue = restart.catch(() => {});
  return restart;
}

async function doRestartDshBackendForTarget(
  s: ExtensionState,
  context: vscode.ExtensionContext,
  workspacePath: string | undefined,
  transitionGeneration: number,
): Promise<void> {
  if (!isCurrentState(s)) {
    return;
  }
  const dshCtx = s.backends.get("dsh");
  if (!dshCtx) {
    return;
  }
  const isCurrentTransition = (): boolean =>
    isCurrentState(s) && dshCtx.runtimeGeneration === transitionGeneration;
  if (!isCurrentTransition()) {
    return;
  }
  try {
    const selected = getActiveDshTarget(context);
    const instanceKey = selected
      ? createBackendInstanceKey("dsh", selected.id)
      : createBackendInstanceKey("dsh", "unconfigured");
    if (isDynamicAcpBackend(dshCtx.backend)) {
      dshCtx.backend.setOptionsProvider(() => resolveSelectedDshBackendOptions(context));
    }
    if (dshCtx.backend.isRunning() || dshCtx.backend.getStatus() === "starting") {
      await dshCtx.backend.stop();
    }
    if (!isCurrentTransition()) {
      return;
    }
    resetContextRuntime(dshCtx, context, workspacePath, instanceKey, s.bus);
    if (!selected) {
      s.statusBar.updateError(dshCtx.id, getContextDisplayName(dshCtx));
      s.bus.emit("backend-ready", { backendId: dshCtx.id });
      return;
    }
    const result = await dshCtx.backend.start(workspacePath);
    if (!isCurrentTransition()) {
      if (!result.error) {
        await dshCtx.backend.stop();
      }
      return;
    }
    if (result.error) {
      s.outputChannel.appendLine(
        `[settings] DSH target start failed: ${String(result.error)}`,
      );
      s.statusBar.updateError(dshCtx.id, getContextDisplayName(dshCtx));
      return;
    }
    await dshCtx.selection.resolveDefaults();
    if (!isCurrentTransition()) {
      return;
    }
    await s.modelCatalog.refresh(workspacePath);
    if (!isCurrentTransition()) {
      s.modelCatalog.clearBackend(dshCtx.id);
      s.bus.emit("models-changed", { backendId: dshCtx.id });
      return;
    }
    await refreshStatusBar(dshCtx, s.statusBar);
    if (isCurrentTransition()) {
      s.bus.emit("backend-ready", { backendId: dshCtx.id });
    }
  } finally {
    if (isCurrentState(s) && dshCtx.runtimeGeneration === transitionGeneration) {
      dshCtx.acceptingRequests = true;
    }
  }
}

/** Refresh status bar items from the given backend context */
async function refreshStatusBar(
  ctx: BackendContext,
  statusBar: StatusBarManager,
): Promise<void> {
  try {
    const sel = ctx.selection.get();
    const agentName = sel.agent ?? "--";
    const modelName = sel.modelDisplayName ?? sel.model?.modelID ?? "--";

    statusBar.update(ctx.id, {
      backendName: getContextDisplayName(ctx),
      agentName,
      modelName,
      isBackendActive: ctx.backend.isRunning(),
    });
  } catch {
    // non-critical
  }
}

export function activate(context: vscode.ExtensionContext) {
  // VS Code normally serializes activation, but a proposed chat-session
  // activation can overlap a reload-triggered activation in the same host.
  // Do not replace a live composition root: doing so duplicates backend
  // listeners and Copilot registrations, and the rejected registration RPC
  // can otherwise surface as an unhandled Extension Host failure.
  if (state && !deactivating) {
    state.outputChannel.appendLine(
      "[extension] Activation already completed; ignoring duplicate activation request",
    );
    return;
  }
  const generation = ++activationGeneration;
  deactivating = false;
  const outputChannel = vscode.window.createOutputChannel("ACPilot");
  outputChannel.appendLine("[extension] ACPilot activating...");

  const statusBar = new StatusBarManager();
  const bus = new AppEventBus();
  const workspacePath = getWorkspaceDirectory();

  // -- Assemble per-backend contexts in a loop --------------------------------
  const backends = new Map<string, BackendContext>();
  // Keep eager starts until the complete composition root (catalog + state)
  // exists. Backend.start() may resolve synchronously, and its completion
  // handler refreshes the Copilot model catalog through that shared state.
  const eagerBackends: Array<{
    desc: (typeof BUILTIN_BACKENDS)[number];
    backend: BackendContext["backend"];
    ctx: BackendContext;
  }> = [];
  const assemblyContext = {
    getBooleanSetting: (section: string, key: string, defaultValue: boolean): boolean =>
      vscode.workspace.getConfiguration(section).get<boolean>(key, defaultValue),
  };

  for (const desc of BUILTIN_BACKENDS) {
    if (desc.isEnabled && !desc.isEnabled(assemblyContext)) {
      outputChannel.appendLine(
        `[extension] Backend '${desc.id}' disabled — skipping`,
      );
      continue;
    }

    const backend = desc.factory();
    try {
      assertBuiltinBackendAssembly(desc, backend);
    } catch (error) {
      outputChannel.appendLine(
        `[extension] Backend '${desc.id}' assembly failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    if (desc.id === "acp" && isDynamicAcpBackend(backend)) {
      backend.setOptionsProvider(() =>
        resolveSelectedAcpBackendOptions(context),
      );
    }
    if (desc.id === "dsh" && isDynamicAcpBackend(backend)) {
      backend.setOptionsProvider(() => resolveSelectedDshBackendOptions(context));
    }
    if (desc.id === "reasonix" && isDynamicAcpBackend(backend)) {
      backend.setOptionsProvider(() => {
        const config = vscode.workspace.getConfiguration("acpilot.backends.reasonix");
        return createReasonixBackendOptions({
          command: config.get<string>("command", "npx"),
          args: config.get<string[]>("args", ["-y", "reasonix", "acp"]),
        });
      });
    }
    const instanceKey = desc.id === "acp"
      ? getAcpInstanceKey(context)
      : desc.id === "dsh"
        ? getDshInstanceKey(context)
        : desc.id;
    const runtime = createContextRuntime(
      backend,
      bus,
      context,
      workspacePath,
      desc.id,
      instanceKey,
    );

    const ctx: BackendContext = {
      id: desc.id,
      instanceKey,
      runtimeGeneration: 0,
      acceptingRequests: true,
      displayName: desc.displayName,
      scheme: desc.scheme,
      vendor: desc.vendor,
      backend,
      ...runtime,
    };

    const shouldAutoStart =
      desc.autoStart !== false &&
      !(desc.id === "acp" && !getActiveAcpTarget(context)) &&
      !(desc.id === "dsh" && !getActiveDshTarget(context));
    if (!shouldAutoStart) {
      outputChannel.appendLine(
        `[extension] Backend '${desc.id}' registered (lazy start)`,
      );
      backends.set(desc.id, ctx);
      continue;
    }

    // Register every context before starting any eager backend. This makes
    // backend completion callbacks safe to run after state/modelCatalog are
    // installed below.
    backends.set(desc.id, ctx);
    eagerBackends.push({ desc, backend, ctx });
  }

  // Build the Copilot-facing catalog from all assembled backends.
  const modelCatalog = createCopilotModelCatalog({
    backends: new Map(
      [...backends.entries()].map(([id, ctx]) => [id, ctx.backend]),
    ),
    backendVendors: new Map(
      [...backends.entries()].map(([id, ctx]) => [id, ctx.vendor]),
    ),
    backendInstanceKeys: new Map(
      [...backends.entries()].map(([id, ctx]) => [id, () => ctx.instanceKey]),
    ),
    logger: outputChannel,
  });

  state = {
    backends,
    modelCatalog,
    bus,
    outputChannel,
    statusBar,
  };

  const defaultBackendId = backends.has("opencode")
    ? "opencode"
    : backends.keys().next().value;
  if (defaultBackendId) {
    statusBar.setActiveBackend(defaultBackendId);
  }
  const defaultSettingsTargetId = `builtin:${defaultBackendId ?? ""}`;

  // -- Register the settings panel command ------------------------------------
  const openSettingsCommand = vscode.commands.registerCommand(
    "acpilot.openSettings",
    async () => {
      if (backends.size === 0) {
        return;
      }
      const panel = SettingsPanel.createOrShow(context.extensionUri);
      let selectedTargetId = defaultSettingsTargetId;

      // Wire up message handler
      panel.onDidRequestChange = async (message: SettingsMessage) => {
        if (!state) {
          return;
        }
        const s = state;
        const selectedCtx = getSettingsBackendContext(s, selectedTargetId);
        if (!selectedCtx) {
          return;
        }

        try {
          switch (message.type) {
            case "ready":
            case "refreshData": {
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "selectDirectory": {
              const selection = await chooseDshDirectory(
                message.field,
                message.currentValue,
                workspacePath,
              );
              if (selection) {
                await panel.postMessage({
                  type: "directorySelected",
                  ...selection,
                });
              }
              break;
            }
            case "setAgent": {
              await selectedCtx.selection.setAgent(message.agentId);
              await refreshStatusBar(selectedCtx, state.statusBar);
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "setPermissionMode": {
              await selectedCtx.selection.setPermissionMode(normalizePermissionMode(message.permissionMode));
              await refreshStatusBar(selectedCtx, state.statusBar);
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "setModel": {
              await selectedCtx.selection.setModel(
                message.providerID,
                message.modelID,
              );
              await refreshStatusBar(selectedCtx, state.statusBar);
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "setDefaultAgent": {
              await selectedCtx.backend.config.update({
                default_agent: message.agent || undefined,
              });
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "setDefaultModel": {
              await selectedCtx.backend.config.update({
                model: message.model || undefined,
              });
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "saveBackendSettings": {
              await selectedCtx.backend.settingsProvider?.saveValues(
                message.values,
              );
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "setGlobalSetting": {
              await vscode.workspace
                .getConfiguration("acpilot")
                .update(
                  `experimental.${message.key}`,
                  message.value,
                  vscode.ConfigurationTarget.Global,
                );
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "setBackendTarget": {
              if (message.targetId.startsWith("acp:")) {
                const targetId = message.targetId.slice(4);
                await mutateAcpTarget(
                  s,
                  context,
                  workspacePath,
                  () => setActiveAcpTarget(context, targetId),
                );
              } else if (message.targetId.startsWith("dsh:")) {
                const targetId = message.targetId.slice(4);
                await mutateDshTarget(
                  s,
                  context,
                  workspacePath,
                  () => setActiveDshTarget(context, targetId),
                );
              }
              selectedTargetId = message.targetId;
              const nextCtx = getSettingsBackendContext(s, selectedTargetId);
              if (nextCtx) {
                s.statusBar.setActiveBackend(nextCtx.id);
                await pushDataToPanel(
                  s,
                  nextCtx,
                  panel,
                  context,
                  selectedTargetId,
                );
              }
              break;
            }
            case "createAcpTarget": {
              const createdTarget = await mutateAcpTarget(
                s,
                context,
                workspacePath,
                () => upsertAcpTarget(
                  context,
                  {
                    name: message.name,
                    endpoint: message.endpoint,
                    authToken: message.authToken,
                  },
                  { makeActive: true },
                ),
              );
              selectedTargetId = `acp:${createdTarget.id}`;
              const nextCtx = getSettingsBackendContext(s, selectedTargetId);
              if (nextCtx) {
                await pushDataToPanel(
                  s,
                  nextCtx,
                  panel,
                  context,
                  selectedTargetId,
                );
              }
              break;
            }
            case "updateAcpTarget": {
              const before = loadAcpTargetState(context);
              if (before.activeTargetId === message.targetId) {
                await mutateAcpTarget(
                  s,
                  context,
                  workspacePath,
                  () => upsertAcpTarget(
                    context,
                    {
                      id: message.targetId,
                      name: message.name,
                      endpoint: message.endpoint,
                      authToken: message.authToken,
                    },
                    { makeActive: true },
                  ).then(() => undefined),
                );
              } else {
                await upsertAcpTarget(
                  context,
                  {
                    id: message.targetId,
                    name: message.name,
                    endpoint: message.endpoint,
                    authToken: message.authToken,
                  },
                  { makeActive: false },
                );
              }
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "deleteAcpTarget": {
              const before = loadAcpTargetState(context);
              let nextTargetState;
              if (before.activeTargetId === message.targetId) {
                nextTargetState = await mutateAcpTarget(
                  s,
                  context,
                  workspacePath,
                  () => removeAcpTarget(context, message.targetId),
                );
              } else {
                nextTargetState = await removeAcpTarget(context, message.targetId);
              }
              if (selectedTargetId === `acp:${message.targetId}`) {
                selectedTargetId = nextTargetState.activeTargetId
                  ? `acp:${nextTargetState.activeTargetId}`
                  : defaultSettingsTargetId;
              }
              const nextCtx = getSettingsBackendContext(s, selectedTargetId);
              if (nextCtx) {
                await pushDataToPanel(
                  s,
                  nextCtx,
                  panel,
                  context,
                  selectedTargetId,
                );
              }
              break;
            }
            case "createDshTarget": {
              const createdTarget = await mutateDshTarget(
                s,
                context,
                workspacePath,
                () => upsertDshTarget(
                  context,
                  {
                    name: message.name,
                    command: message.command,
                    args: message.args,
                    launchCwd: message.launchCwd,
                    installDirectory: message.installDirectory,
                    packageSpec: message.packageSpec,
                  },
                  { makeActive: true },
                ),
              );
              selectedTargetId = `dsh:${createdTarget.id}`;
              const nextCtx = getSettingsBackendContext(s, selectedTargetId);
              if (nextCtx) {
                s.statusBar.setActiveBackend(nextCtx.id);
                await pushDataToPanel(s, nextCtx, panel, context, selectedTargetId);
              }
              break;
            }
            case "updateDshTarget": {
              const before = loadDshTargetState(context);
              const input: DshTargetInput = {
                id: message.targetId,
                name: message.name,
                command: message.command,
                args: message.args,
                launchCwd: message.launchCwd,
                installDirectory: message.installDirectory,
                packageSpec: message.packageSpec,
              };
              if (before.activeTargetId === message.targetId) {
                await mutateDshTarget(
                  s,
                  context,
                  workspacePath,
                  () => upsertDshTarget(context, input, { makeActive: true }).then(() => undefined),
                );
              } else {
                await upsertDshTarget(context, input, { makeActive: false });
              }
              await pushDataToPanel(s, selectedCtx, panel, context, selectedTargetId);
              break;
            }
            case "deleteDshTarget": {
              const before = loadDshTargetState(context);
              let nextTargetState;
              if (before.activeTargetId === message.targetId) {
                nextTargetState = await mutateDshTarget(
                  s,
                  context,
                  workspacePath,
                  () => removeDshTarget(context, message.targetId),
                );
              } else {
                nextTargetState = await removeDshTarget(context, message.targetId);
              }
              if (selectedTargetId === `dsh:${message.targetId}`) {
                selectedTargetId = nextTargetState.activeTargetId
                  ? `dsh:${nextTargetState.activeTargetId}`
                  : `builtin:dsh`;
              }
              const nextCtx = getSettingsBackendContext(s, selectedTargetId);
              if (nextCtx) {
                await pushDataToPanel(s, nextCtx, panel, context, selectedTargetId);
              }
              break;
            }
            case "installDsh":
            case "updateDsh": {
              const installed = await installDsh({
                installDirectory: message.installDirectory,
                packageSpec: message.packageSpec,
              });
              const args = message.args.length > 0 ? message.args : defaultDshArgs();
              const input: DshTargetInput = {
                id: message.targetId,
                name: message.name,
                command: commandAfterDshInstall(
                  message.command,
                  installed.executable,
                  message.targetId,
                ),
                args,
                launchCwd: message.launchCwd,
                installDirectory: installed.installDirectory,
                packageSpec: installed.packageSpec,
              };
              const target = await mutateDshTarget(
                s,
                context,
                workspacePath,
                () => upsertDshTarget(context, input, { makeActive: true }),
              );
              selectedTargetId = `dsh:${target.id}`;
              const nextCtx = getSettingsBackendContext(s, selectedTargetId);
              if (nextCtx) {
                s.statusBar.setActiveBackend(nextCtx.id);
                await pushDataToPanel(s, nextCtx, panel, context, selectedTargetId);
              }
              void vscode.window.showInformationMessage(
                message.type === "installDsh" ? "DeepSeek Harness installed." : "DeepSeek Harness updated.",
              );
              break;
            }
            case "connectProvider": {
              const known = KNOWN_PROVIDERS.find(
                (p) => p.id === message.providerId,
              );
              const apiType =
                message.providerId === "openai-compatible"
                  ? "openai"
                  : message.providerId;
              const providerConfig: BackendProviderConfig = {
                api: apiType,
                id: message.providerId,
                name: message.displayName || known?.name || message.providerId,
                options: {
                  apiKey: message.apiKey,
                  ...(message.baseURL ? { baseURL: message.baseURL } : {}),
                },
              };
              const configKey =
                message.providerId === "openai-compatible"
                  ? message.displayName
                      ?.toLowerCase()
                      .replace(/[^a-z0-9]/g, "-") || "custom-" + Date.now()
                  : message.providerId;
              await selectedCtx.backend.config.update({
                provider: { [configKey]: providerConfig },
              });
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "disconnectProvider": {
              const currentConfig = await selectedCtx.backend.config.get();
              const currentProviders = {
                ...(currentConfig.data?.provider ?? {}),
              };
              delete currentProviders[message.configKey];
              await selectedCtx.backend.config.update({
                provider: currentProviders,
              });
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
            case "updateProvider": {
              const currentCfg = await selectedCtx.backend.config.get();
              const existing = currentCfg.data?.provider?.[message.configKey];
              const updateConfig: BackendProviderConfig = {
                options: {
                  apiKey: message.apiKey,
                  ...(message.baseURL ? { baseURL: message.baseURL } : {}),
                },
              };
              if (existing?.id) {
                updateConfig.id = existing.id;
              }
              if (existing?.name) {
                updateConfig.name = existing.name;
              }
              if (existing?.api) {
                updateConfig.api = existing.api;
              }
              await selectedCtx.backend.config.update({
                provider: { [message.configKey]: updateConfig },
              });
              await pushDataToPanel(
                s,
                selectedCtx,
                panel,
                context,
                selectedTargetId,
              );
              break;
            }
          }
        } catch (err) {
          outputChannel.appendLine(
            `[settings] Error handling message: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      };

      // Push initial data
      const initialCtx = getSettingsBackendContext(state!, selectedTargetId);
      if (initialCtx) {
        await pushDataToPanel(
          state!,
          initialCtx,
          panel,
          context,
          selectedTargetId,
        );
      }
    },
  );

  // -- Register surfaces per backend (participant / session provider / LM) ----
  for (const ctx of backends.values()) {
    // `chatSessions.canDelegate` contributes the agent metadata, but it does
    // not install the request implementation. The participant registration is
    // the implementation VS Code invokes for requests addressed to the
    // session type (for example `acpilot.opencode`).
    let participant: vscode.ChatParticipant | undefined;
    try {
      participant = registerParticipant(context, generation, ctx, outputChannel);
    } catch (error) {
      // A stale main-process participant can briefly survive an extension-host
      // reload and make createChatParticipant reject with "Agent already
      // registered". Do not let one backend prevent the remaining Session and
      // model providers from being assembled.
      outputChannel.appendLine(
        `[extension:${ctx.id}] Participant unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The session content provider is a proposed API. Some hosts expose the
    // function but reject calls when the proposal is not enabled. It is an
    // optional surface and must not prevent the stable language-model
    // provider from registering.
    let sessionController: vscode.ChatSessionItemController | undefined;
    try {
      if (hasRegisterChatSessionContentProvider()) {
        const { provider, controller } = createSessionContentProvider(
          state!,
          ctx,
          context,
        );
        sessionController = controller;
        const registration = vscode.chat.registerChatSessionContentProvider(
          ctx.scheme,
          provider,
          // Keep the participant in the legacy positional slot for hosts that
          // still use it as the default request implementation. Current hosts
          // obtain the same implementation from createChatParticipant above.
          participant,
          { supportsChangingSessionType: true },
        );

        context.subscriptions.push(registration);
        // Controllers own the session-list items and tracked input states.
        // They are separate from the provider registration disposable, so
        // explicitly bind them to the extension lifecycle as well.
        if (sessionController) {
          context.subscriptions.push(sessionController);
        }
        if (controller) {
          outputChannel.appendLine(
            `[extension:${ctx.id}] Session content provider registered (controller id=${controller.id})`,
          );
        } else {
          outputChannel.appendLine(
            `[extension:${ctx.id}] Session content provider registered (no controller)`,
          );
        }
      }
    } catch (error) {
      // A controller may have been created before registration rejected the
      // proposal. Dispose it immediately; the provider's context cleanup is
      // still owned by the extension subscriptions.
      sessionController?.dispose();
      outputChannel.appendLine(
        `[extension:${ctx.id}] Session content provider unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const lmRegistration = registerLanguageModelChatProvider(state!, ctx);
      if (lmRegistration) {
        context.subscriptions.push(lmRegistration);
      }
    } catch (error) {
      // Keep one broken optional vendor from preventing the remaining
      // backends and their model providers from activating.
      outputChannel.appendLine(
        `[extension:${ctx.id}] Language model provider unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

  }

  // Start eager backends only after all Copilot surfaces and language-model
  // providers have been registered.  This ordering matters for providers
  // whose model catalog is populated asynchronously: a backend-ready event
  // must never be emitted before VS Code has a provider listening for it.
  for (const { desc, backend, ctx } of eagerBackends) {
    backend
      .start(workspacePath)
      .then(async (result) => {
        if (!isCurrentActivation(generation)) {
          if (backend.getStatus() !== "stopped") {
            try {
              await backend.stop();
            } catch (error) {
              outputChannel.appendLine(
                `[extension] Stale backend '${desc.id}' stop error: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          return;
        }
        if (result.error) {
          outputChannel.appendLine(
            `[extension] Backend '${desc.id}' start failed: ${String(result.error)}`,
          );
          statusBar.updateError(desc.id, desc.displayName);
          return;
        }
        outputChannel.appendLine(
          `[extension] Backend '${desc.id}' started at ${result.data?.url}`,
        );
        await ctx.selection.resolveDefaults();
        if (!isCurrentActivation(generation)) {
          return;
        }

        try {
          const currentState = state;
          if (!currentState) {
            return;
          }
          await currentState.modelCatalog.refresh(workspacePath);
        } catch (syncErr) {
          outputChannel.appendLine(
            `[extension] Model catalog refresh error: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
          );
        }

        if (!isCurrentActivation(generation)) {
          return;
        }

        await refreshStatusBar(ctx, statusBar);
        bus.emit("backend-ready", { backendId: desc.id });
      })
      .catch((err: unknown) => {
        if (!isCurrentActivation(generation)) {
          return;
        }
        outputChannel.appendLine(
          `[extension] Backend '${desc.id}' start error: ${err instanceof Error ? err.message : String(err)}`,
        );
        statusBar.updateError(desc.id, desc.displayName);
      });
  }

  if (process.env.ACPILOT_TEST_CONTROL === "1") {
    const token = process.env.ACPILOT_TEST_CONTROL_TOKEN;
    if (!token) {
      throw new Error(
        "ACPILOT_TEST_CONTROL_TOKEN is required when runtime test control is enabled",
      );
    }
    const runtimeApi = createRuntimeTestApi(state, context, workspacePath, {
      selectAcpTarget: async (
        targetState,
        targetContext,
        targetWorkspacePath,
        targetId,
      ) => {
        await mutateAcpTarget(
          targetState,
          targetContext,
          targetWorkspacePath,
          () => setActiveAcpTarget(targetContext, targetId).then(() => undefined),
        );
      },
    });
    // Start the control server after provider registration as well.  The
    // descriptor is the test runner's readiness signal, so publishing it
    // earlier would permit an API call while VS Code still has no provider.
    void startRuntimeTestControlServer(runtimeApi, {
      token,
      port: Number(process.env.ACPILOT_TEST_CONTROL_PORT || 0),
      descriptorPath: process.env.ACPILOT_TEST_CONTROL_FILE,
      logger: outputChannel,
    }).then(
      (server) => {
        if (!isCurrentActivation(generation)) {
          server.dispose();
          return;
        }
        context.subscriptions.push(server);
      },
      (error) =>
        isCurrentActivation(generation) &&
        outputChannel.appendLine(
          `[test-control] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  context.subscriptions.push(
    outputChannel,
    statusBar,
    openSettingsCommand,
    bus,
  );
  outputChannel.appendLine("[extension] ACPilot activated");
}

function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
  }
  return key.slice(0, 4) + "\u2022\u2022\u2022\u2022" + key.slice(-4);
}

function computeConnectedProviders(
  config: { provider?: Record<string, BackendProviderConfig> },
  models: BackendModel[],
): SettingsData["connectedProviders"] {
  const result: SettingsData["connectedProviders"] = [];
  const seen = new Set<string>();

  // 1) Explicit provider entries from config.provider (user-configured with API keys)
  const explicitProviders = config.provider ?? {};
  for (const [key, value] of Object.entries(explicitProviders)) {
    if (seen.has(key)) {
      continue;
    }
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
    if (!pid || seen.has(pid)) {
      continue;
    }
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
  const cfg = vscode.workspace.getConfiguration("acpilot");
  return GLOBAL_SETTINGS_DESCRIPTOR.map((d) => {
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
async function pushDataToPanel(
  s: ExtensionState,
  ctx: BackendContext,
  panel: SettingsPanel,
  context: vscode.ExtensionContext,
  activeBackendTargetId: string,
): Promise<void> {
  try {
    const [agentsResp, modelsResp, configResp] = await Promise.all([
      ctx.backend.config.agents().catch(() => ({ data: [] as BackendAgent[] })),
      ctx.backend.config.models().catch(() => ({ data: [] as BackendModel[] })),
      ctx.backend.config.get().catch(() => ({ data: undefined })),
    ]);

    const agents = agentsResp.data ?? [];
    const models = modelsResp.data ?? [];
    const config = configResp.data ?? {};
    const backendTargets = getBackendTargets(s, context, activeBackendTargetId);

    // Get backend settings descriptor if provider exists
    let backendSettings: BackendSettingsDescriptor | undefined;
    if (ctx.backend.settingsProvider) {
      try {
        backendSettings = await ctx.backend.settingsProvider.getDescriptor(
          agents,
          models,
        );
      } catch {
        // non-critical — backend settings UI will show empty state
      }
    }

    const data: SettingsData = {
      backendName: getContextDisplayName(ctx),
      agents: agents.map((a: BackendAgent) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        model:
          typeof a.model === "object" && a.model !== null
            ? (a.model.modelID ?? String(a.model))
            : a.model,
        mode: a.mode,
        hidden: a.hidden,
      })),
      models: models.map((m: BackendModel) => ({
        id: m.id,
        name: m.name,
        provider: m.providerName ?? m.provider,
        providerId: m.provider,
        capabilities: m.capabilitiesRaw
          ? Object.keys(m.capabilitiesRaw).filter((name) =>
              Boolean(m.capabilitiesRaw?.[name]),
            )
          : undefined,
      })),
      currentAgent: ctx.selection.get().agent,
      currentModel: ctx.selection.get().model,
      currentModelDisplayName: ctx.selection.get().modelDisplayName,
      currentPermissionMode: ctx.selection.get().permissionMode,
      defaultAgent: config.default_agent,
      defaultModel: config.model,
      backendSettings,
      connectedProviders: computeConnectedProviders(config, models),
      availableProviders: KNOWN_PROVIDERS,
      globalSettings: readGlobalSettings(),
      backendTargets,
      activeBackendTargetId,
      dshTarget: getDshSettingsTarget(context, getWorkspaceDirectory()),
    };

    s.outputChannel.appendLine(
      `[settings] pushDataToPanel: currentModel=${JSON.stringify(data.currentModel)}, configModel=${config.model}, currentAgent=${data.currentAgent}`,
    );
    s.outputChannel.appendLine(
      `[settings] pushDataToPanel: models count=${data.models.length}, model IDs=${data.models.map((m) => m.id + "(" + m.providerId + ")").join(", ")}`,
    );
    s.outputChannel.appendLine(
      `[settings] pushDataToPanel: agents=${data.agents.map((a) => a.id + ":model=" + (a.model ?? "none")).join(", ")}`,
    );

    panel.updateData(data);
  } catch {
    // non-critical
  }
}

export async function deactivate(): Promise<void> {
  deactivating = true;
  activationGeneration += 1;
  const currentState = state;
  if (!currentState) {
    state = undefined;
    return;
  }

  // Invalidate every request before replacing the composition root. The event
  // wakes handlers that are currently waiting on backend promises; the
  // generation/accepting flag also rejects requests that race this boundary.
  for (const ctx of currentState.backends.values()) {
    beginBackendRuntimeTransition(ctx, currentState.bus);
  }
  state = undefined;

  currentState.outputChannel.appendLine("[extension] Deactivating...");
  currentState.modelCatalog.dispose();
  // No further application events are meaningful once the composition root
  // has been invalidated. Release listeners before waiting on backend teardown.
  currentState.bus.dispose();
  const stopTasks = [...currentState.backends.values()]
    .filter((ctx) => ctx.backend.getStatus() !== "stopped")
    .map(async (ctx) => {
      try {
        await stopBackendForDeactivation(ctx, currentState.outputChannel);
      } catch (err: unknown) {
        currentState.outputChannel.appendLine(
          `[extension] Stop error (${ctx.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
  });
  await Promise.all(stopTasks);
}
