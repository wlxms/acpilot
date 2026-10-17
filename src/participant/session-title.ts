import * as vscode from 'vscode';
import type { ExtensionState, BackendContext } from '../types';
import type { SerializableSessionMeta, SessionTitleSource } from '../backend/serializable/types';
import type { SessionState } from '../types';

export interface ApplySessionTitleOptions {
  /** Real backend session id. */
  backendSessionId: string;
  vscodeSessionId?: string;
  title: string | undefined;
  directory?: string;
  createdAt?: Date;
  updateBackend?: boolean;
  overwrite?: boolean;
  emitListChanged?: boolean;
  source?: SessionTitleSource;
}

export interface ApplyProvisionalSessionTitleOptions {
  backendSessionId: string;
  vscodeSessionId?: string;
  title: string | undefined;
  directory?: string;
  createdAt?: Date;
  updateBackend?: boolean;
  emitListChanged?: boolean;
}

export interface ResolvedSessionTitle {
  title: string;
  source: SessionTitleSource;
}

export interface ResolveRestoredSessionTitleOptions {
  backendSessionId: string;
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[];
  meta?: SerializableSessionMeta;
  backendTitle?: string;
}

export interface ResolveLiveBackendTitleOptions {
  rawTitle: string | undefined;
  firstPrompt?: string;
}

export interface ResolveLiveBackendTitleResult {
  title?: string;
  source?: SessionTitleSource;
  ignoredTitle?: string;
  reason?: 'placeholder' | 'prompt-echo-generator-unavailable';
}

export interface ResolveFinalTurnTitleOptions {
  backendSessionId: string;
  directory?: string;
  pipelineTitle?: string;
  pipelineTitleSource?: SessionTitleSource;
  chatState?: {
    title?: string;
    titleSource?: SessionTitleSource;
    provisionalTitle?: boolean;
  };
}

export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? '';
  return !normalized
    || normalized === 'New OpenCode Session'
    || normalized === 'New ACP Agent Session'
    || normalized === 'New Reasonix Session'
    || normalized.startsWith('OpenCode Session ')
    || normalized.startsWith('ACP Session ')
    || normalized.startsWith('ACP Agent Session ')
    || normalized.startsWith('Reasonix Session ')
    || normalized.startsWith('Session ');
}

function titlePriority(source: SessionTitleSource | undefined): number {
  switch (source) {
    case 'manual': return 60;
    case 'copilot-style': return 50;
    case 'backend': return 40;
    case 'restore': return 35;
    case 'history': return 30;
    case 'placeholder': return 10;
    default: return 0;
  }
}

function shouldOverwriteTitle(
  existingTitle: string | undefined,
  existingSource: SessionTitleSource | undefined,
  nextSource: SessionTitleSource | undefined,
  forceOverwrite: boolean | undefined,
): boolean {
  if (forceOverwrite) {
    return true;
  }
  if (isPlaceholderSessionTitle(existingTitle)) {
    return true;
  }
  return titlePriority(nextSource) >= titlePriority(existingSource);
}

function normalizeTitleText(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function normalizeEchoPrefixText(title: string | undefined): string | undefined {
  const normalized = normalizeTitleText(title)
    ?.replace(/(?:\s*(?:\.{3}|\u2026))+$/u, '')
    .trim();
  return normalized || undefined;
}

function isPromptEchoTitle(firstPrompt: string, title: string): boolean {
  const prompt = normalizeTitleText(firstPrompt);
  const candidate = normalizeEchoPrefixText(title);
  return !!prompt && !!candidate && prompt.startsWith(candidate);
}

function isProvisionalTitleEcho(
  title: string | undefined,
  chatState: { title?: string; provisionalTitle?: boolean } | undefined,
): boolean {
  return !!title
    && !!chatState?.provisionalTitle
    && title.trim() === chatState.title?.trim();
}

function createSessionLabelFromPrompt(prompt: string | undefined, sessionId: string): string {
  const normalized = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return `Session ${sessionId.slice(0, 8)}`;
  }

  return normalized.length > 60 ? `${normalized.slice(0, 57).trimEnd()}...` : normalized;
}

function getHistoryDerivedSessionTitle(
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
  sessionId: string,
): string {
  const firstRequest = history.find(
    (turn): turn is vscode.ChatRequestTurn => turn instanceof vscode.ChatRequestTurn,
  );
  return createSessionLabelFromPrompt(firstRequest?.prompt, sessionId);
}

function getPersistedFinalSessionTitle(
  meta: SerializableSessionMeta | undefined,
): ResolvedSessionTitle | undefined {
  const title = normalizeTitleText(meta?.title);
  if (!title || isPlaceholderSessionTitle(title) || meta?.provisionalTitle === true) {
    return undefined;
  }
  return { title, source: meta?.titleSource ?? 'restore' };
}

function getMeaningfulRestoredTitle(title: string | undefined): string | undefined {
  const normalized = normalizeTitleText(title);
  if (!normalized || isPlaceholderSessionTitle(normalized)) {
    return undefined;
  }
  return normalized;
}

function getRuntimeTitleSource(sessionState: SessionState): SessionTitleSource {
  if (sessionState.titleSource && sessionState.titleSource !== 'placeholder') {
    return sessionState.titleSource;
  }
  return sessionState.provisionalTitle ? 'history' : 'restore';
}

export class SessionTitleService {
  constructor(
    private readonly state: ExtensionState,
    private readonly ctx: BackendContext,
  ) {}

  static isPlaceholder(title: string | undefined): boolean {
    return isPlaceholderSessionTitle(title);
  }

  static createProvisionalTitleFromPrompt(prompt: string | undefined, sessionId: string): string {
    return createSessionLabelFromPrompt(prompt, sessionId);
  }

  static async generateWithVsCodeLm(
    firstPrompt: string,
    loggerOrState: ExtensionState | { appendLine(message: string): void },
    preferredVendor?: string,
    preferredModel?: vscode.LanguageModelChat,
  ): Promise<string | undefined> {
    const normalized = firstPrompt.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length < 3) {
      return undefined;
    }

    const logger = 'outputChannel' in loggerOrState ? loggerOrState.outputChannel : loggerOrState;
    const title = await generateTitleWithVsCodeLm(normalized, logger, preferredVendor, preferredModel);
    if (title) {
      logger.appendLine(`[title-generator] VS Code LM generated title: "${title}"`);
    }
    return title;
  }

  async generateFromPrompt(
    firstPrompt: string,
    preferredModel?: vscode.LanguageModelChat,
  ): Promise<string | undefined> {
    return SessionTitleService.generateWithVsCodeLm(
      firstPrompt,
      this.state,
      this.ctx.vendor,
      preferredModel,
    );
  }

  async applyFinal(options: ApplySessionTitleOptions): Promise<string | undefined> {
    return applySessionTitle(this.state, this.ctx, options);
  }

  async applyProvisional(options: ApplyProvisionalSessionTitleOptions): Promise<string | undefined> {
    return applyProvisionalSessionTitle(this.state, this.ctx, options);
  }

  resolveRestoredTitle(options: ResolveRestoredSessionTitleOptions): ResolvedSessionTitle {
    const persistedTitle = getPersistedFinalSessionTitle(options.meta);
    if (persistedTitle) {
      return persistedTitle;
    }

    const candidates: Array<{ title: string; source: SessionTitleSource; order: number }> = [];
    let order = 0;
    const addCandidate = (title: string | undefined, source: SessionTitleSource) => {
      const normalized = getMeaningfulRestoredTitle(title);
      if (!normalized) {
        return;
      }
      candidates.push({ title: normalized, source, order: order++ });
    };

    // Fresh backend metadata wins ties with cached runtime titles from the
    // same source; stronger runtime provenance (manual/copilot-style) still
    // outranks plain backend/history titles.
    addCandidate(options.backendTitle, 'backend');

    const seenStates = new Set<SessionState>();
    for (const sessionState of this.ctx.sessions.values()) {
      if (sessionState.backendSessionId !== options.backendSessionId || seenStates.has(sessionState)) {
        continue;
      }
      seenStates.add(sessionState);
      addCandidate(sessionState.title, getRuntimeTitleSource(sessionState));
    }

    candidates.sort((a, b) => {
      const priorityDelta = titlePriority(b.source) - titlePriority(a.source);
      return priorityDelta !== 0 ? priorityDelta : a.order - b.order;
    });

    const best = candidates[0];
    if (best) {
      return { title: best.title, source: best.source };
    }

    return {
      title: getHistoryDerivedSessionTitle(options.history, options.backendSessionId),
      source: 'history',
    };
  }

  async applyRestoredTitle(
    options: ResolveRestoredSessionTitleOptions & {
      vscodeSessionId?: string;
      createdAt?: Date;
      overwrite?: boolean;
      emitListChanged?: boolean;
    },
  ): Promise<ResolvedSessionTitle> {
    const resolved = this.resolveRestoredTitle(options);
    if (!isPlaceholderSessionTitle(resolved.title)) {
      await this.applyFinal({
        backendSessionId: options.backendSessionId,
        vscodeSessionId: options.vscodeSessionId,
        title: resolved.title,
        createdAt: options.createdAt,
        overwrite: options.overwrite,
        emitListChanged: options.emitListChanged,
        source: resolved.source,
      });
    }
    return resolved;
  }

  async resolveLiveBackendTitle(
    options: ResolveLiveBackendTitleOptions,
  ): Promise<ResolveLiveBackendTitleResult> {
    return SessionTitleService.resolveBackendTitleUpdate(
      options,
      this.state,
      this.ctx.vendor,
    );
  }

  static async resolveBackendTitleUpdate(
    options: ResolveLiveBackendTitleOptions,
    loggerOrState: ExtensionState | { appendLine(message: string): void },
    preferredVendor?: string,
  ): Promise<ResolveLiveBackendTitleResult> {
    const title = normalizeTitleText(options.rawTitle);
    if (!title || isPlaceholderSessionTitle(title)) {
      return { ignoredTitle: title, reason: 'placeholder' };
    }

    if (options.firstPrompt && isPromptEchoTitle(options.firstPrompt, title)) {
      const generatedTitle = await SessionTitleService.generateWithVsCodeLm(
        options.firstPrompt,
        loggerOrState,
        preferredVendor,
      );
      if (!generatedTitle || isPlaceholderSessionTitle(generatedTitle)) {
        return { ignoredTitle: title, reason: 'prompt-echo-generator-unavailable' };
      }
      return { title: generatedTitle, source: 'copilot-style' };
    }

    return { title, source: 'backend' };
  }

  async resolveFinalTurnTitle(
    options: ResolveFinalTurnTitleOptions,
  ): Promise<ResolvedSessionTitle | undefined> {
    let resolvedTitle = normalizeTitleText(options.pipelineTitle);
    let resolvedSource = options.pipelineTitleSource;
    const logger = this.state.outputChannel;

    // A generated/manual title is already authoritative for this session.
    // Backend streams commonly echo the provisional prompt title during the
    // same turn; allowing that lower-priority value through here would write
    // the fallback back over the generated title in SessionStore.
    const currentTitle = normalizeTitleText(options.chatState?.title);
    const currentSource = options.chatState?.titleSource;
    if (currentTitle
      && !isPlaceholderSessionTitle(currentTitle)
      && options.chatState?.provisionalTitle !== true
      && (currentSource === 'manual' || currentSource === 'copilot-style')) {
      logger.appendLine(
        `[session-title] Keeping authoritative ${currentSource} title: "${currentTitle}"`,
      );
      return { title: currentTitle, source: currentSource };
    }

    if (isProvisionalTitleEcho(resolvedTitle, options.chatState)) {
      logger.appendLine(`[session-title] Ignoring provisional session title echo: "${resolvedTitle}"`);
      resolvedTitle = undefined;
      resolvedSource = undefined;
    }

    if (!resolvedTitle || isPlaceholderSessionTitle(resolvedTitle)) {
      try {
        const sessionInfo = await this.ctx.backend.sessions.get(options.backendSessionId, options.directory);
        const backendTitle = normalizeTitleText(sessionInfo.data?.title);
        if (isProvisionalTitleEcho(backendTitle, options.chatState)) {
          logger.appendLine(`[session-title] Ignoring provisional backend title echo: "${backendTitle}"`);
        } else if (backendTitle && !isPlaceholderSessionTitle(backendTitle)) {
          resolvedTitle = backendTitle;
          resolvedSource = 'backend';
          logger.appendLine(`[session-title] Title from sessions.get(): "${backendTitle}"`);
        }
      } catch (err: unknown) {
        logger.appendLine(
          `[session-title] sessions.get() for title failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!resolvedTitle || isPlaceholderSessionTitle(resolvedTitle)) {
      return undefined;
    }

    return { title: resolvedTitle, source: resolvedSource ?? 'backend' };
  }

  async retitleSession(
    prompt: string,
    backendSessionId: string,
    vscodeSessionId: string,
    directory: string | undefined,
  ): Promise<string | undefined> {
    const logger = this.state.outputChannel;
    const llmTitle = await this.generateFromPrompt(prompt);
    if (llmTitle && !isPlaceholderSessionTitle(llmTitle)) {
      await this.applyFinal({
        backendSessionId,
        vscodeSessionId,
        title: llmTitle,
        directory,
        updateBackend: true,
        overwrite: true,
        source: 'manual',
      });
      logger.appendLine(`[title-gen] Title applied: "${llmTitle}"`);
    } else {
      logger.appendLine(`[title-gen] LLM returned unusable title: ${llmTitle ?? 'undefined'}`);
    }
    return llmTitle;
  }
}

/**
 * Keep the three title surfaces in sync:
 * backend session, in-memory VS Code session mapping, and SessionStore metadata.
 */
export async function applySessionTitle(
  state: ExtensionState,
  ctx: BackendContext,
  options: ApplySessionTitleOptions,
): Promise<string | undefined> {
  let title = options.title?.replace(/\s+/g, ' ').trim();
  if (!title || isPlaceholderSessionTitle(title)) {
    return undefined;
  }

  const logger = state.outputChannel;

  if (options.updateBackend) {
    try {
      const updateResult = await ctx.backend.sessions.update(options.backendSessionId, {
        title,
        directory: options.directory,
      });
      title = updateResult.data?.title?.trim() || title;
      logger.appendLine(
        `[session-title] Backend title updated (${options.source ?? 'unknown'}): "${title}"`,
      );
    } catch (err) {
      logger.appendLine(
        `[session-title] Backend title update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let createdAt = options.createdAt;
  const updateState = (stateKey?: string) => {
    if (!stateKey) {return;}
    const sessionState = ctx.sessions.get(stateKey);
    if (!sessionState || sessionState.backendSessionId !== options.backendSessionId) {return;}
    createdAt = createdAt ?? sessionState.createdAt;
    if (shouldOverwriteTitle(sessionState.title, sessionState.titleSource, options.source, options.overwrite)) {
      sessionState.title = title;
      sessionState.titleSource = options.source;
      sessionState.provisionalTitle = false;
    }
  };

  updateState(options.vscodeSessionId);
  for (const sessionState of ctx.sessions.values()) {
    if (sessionState.backendSessionId !== options.backendSessionId) {continue;}
    createdAt = createdAt ?? sessionState.createdAt;
    if (shouldOverwriteTitle(sessionState.title, sessionState.titleSource, options.source, options.overwrite)) {
      sessionState.title = title;
      sessionState.titleSource = options.source;
      sessionState.provisionalTitle = false;
    }
  }

  try {
    await ctx.sessionStore.updateMeta(options.backendSessionId, {
      title,
      titleSource: options.source,
      titleUpdatedAt: new Date().toISOString(),
      provisionalTitle: false,
      createdAt: (createdAt ?? new Date()).toISOString(),
      backendName: ctx.id,
      backendInstanceKey: ctx.instanceKey,
    });
  } catch (err) {
    logger.appendLine(
      `[session-title] SessionStore title write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (options.emitListChanged !== false) {
    state.bus.emit('session-list-changed', { backendId: ctx.id });
  }
  return title;
}

export async function applyProvisionalSessionTitle(
  state: ExtensionState,
  ctx: BackendContext,
  options: ApplyProvisionalSessionTitleOptions,
): Promise<string | undefined> {
  let title = options.title?.replace(/\s+/g, ' ').trim();
  if (!title || isPlaceholderSessionTitle(title)) {
    return undefined;
  }

  const logger = state.outputChannel;
  if (options.updateBackend) {
    try {
      const updateResult = await ctx.backend.sessions.update(options.backendSessionId, {
        title,
        directory: options.directory,
      });
      title = updateResult.data?.title?.trim() || title;
      logger.appendLine(`[session-title] Provisional backend title updated: "${title}"`);
    } catch (err) {
      logger.appendLine(
        `[session-title] Provisional backend title update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let createdAt = options.createdAt;
  const updateState = (stateKey?: string) => {
    if (!stateKey) {return;}
    const sessionState = ctx.sessions.get(stateKey);
    if (!sessionState || sessionState.backendSessionId !== options.backendSessionId) {return;}
    createdAt = createdAt ?? sessionState.createdAt;
    if (isPlaceholderSessionTitle(sessionState.title) || sessionState.provisionalTitle) {
      sessionState.title = title;
      sessionState.titleSource = 'history';
      sessionState.provisionalTitle = true;
    }
  };

  updateState(options.vscodeSessionId);
  for (const sessionState of ctx.sessions.values()) {
    if (sessionState.backendSessionId !== options.backendSessionId) {continue;}
    createdAt = createdAt ?? sessionState.createdAt;
    if (isPlaceholderSessionTitle(sessionState.title) || sessionState.provisionalTitle) {
      sessionState.title = title;
      sessionState.titleSource = 'history';
      sessionState.provisionalTitle = true;
    }
  }

  try {
    await ctx.sessionStore.updateMeta(options.backendSessionId, {
      title,
      titleSource: 'history',
      titleUpdatedAt: new Date().toISOString(),
      provisionalTitle: true,
      createdAt: (createdAt ?? new Date()).toISOString(),
      backendName: ctx.id,
      backendInstanceKey: ctx.instanceKey,
    });
  } catch (err) {
    logger.appendLine(
      `[session-title] Provisional SessionStore title write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (options.emitListChanged !== false) {
    state.bus.emit('session-list-changed', { backendId: ctx.id });
  }
  return title;
}

export async function generateTitleWithVsCodeLm(
  prompt: string,
  logger: { appendLine(message: string): void },
  preferredVendor?: string,
  preferredModel?: vscode.LanguageModelChat,
): Promise<string | undefined> {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  if (!normalizedPrompt || normalizedPrompt.length < 3) {
    return undefined;
  }

  const lm = vscode.lm as unknown as {
    selectChatModels?: (selector?: vscode.LanguageModelChatSelector) => Thenable<vscode.LanguageModelChat[]>;
    languageModelAccessInformation?: { canSendRequest(chat: vscode.LanguageModelChat): boolean | undefined };
  };

  if (!vscode.LanguageModelChatMessage?.User
    || (typeof lm.selectChatModels !== 'function' && !preferredModel)) {
    return undefined;
  }

  try {
    const requestTitle = async (model: vscode.LanguageModelChat): Promise<string | undefined> => {
      if (typeof model.sendRequest !== 'function') {
        return undefined;
      }
      // `acpilotPurpose` is an ACPilot-internal option. Passing it to the
      // Copilot provider can make otherwise valid Copilot title requests
      // fail because providers are free to reject unknown model options.
      const requestOptions = model.vendor === 'copilot' || model.vendor?.endsWith('-copilot')
        ? undefined
        : { modelOptions: { acpilotPurpose: 'title-generation' } };
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(buildTitlePrompt(normalizedPrompt))],
        requestOptions,
        undefined,
      );
      return cleanGeneratedTitle(await collectLmText(response.text));
    };

    // A model selected in the current request is already a fully-resolved
    // VS Code model handle. Try it before querying the global model pool so
    // title generation cannot fall back merely because provider discovery is
    // still catching up with the picker selection.
    if (preferredModel) {
      try {
        const selectedTitle = await requestTitle(preferredModel);
        if (selectedTitle) {
          return selectedTitle;
        }
        logger.appendLine(
          `[title-generator] Selected VS Code LM returned an unusable response: "${preferredModel.id}"`,
        );
      } catch (err) {
        logger.appendLine(
          `[title-generator] Selected VS Code LM ${preferredModel.vendor ?? 'unknown'}/${preferredModel.id} failed:`
            + ` ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Ask for Copilot models explicitly so VS Code activates the Copilot
    // provider even when it has not been resolved by another extension yet.
    // Also resolve the active ACPilot vendor explicitly. VS Code's unscoped
    // selector may only return vendors that have already been resolved by a
    // consumer, which made backend title generation silently fall back even
    // though the model was present in the vendor picker.
    let copilotModels: vscode.LanguageModelChat[] = [];
    if (typeof lm.selectChatModels === 'function') {
      try {
        copilotModels = await lm.selectChatModels({ vendor: 'copilot' });
      } catch (error) {
        logger.appendLine(
          `[title-generator] Copilot model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let preferredModels: vscode.LanguageModelChat[] = [];
    if (typeof lm.selectChatModels === 'function' && preferredVendor && preferredVendor !== 'copilot') {
      try {
        preferredModels = await lm.selectChatModels({ vendor: preferredVendor });
      } catch (error) {
        logger.appendLine(
          `[title-generator] Preferred vendor discovery failed (${preferredVendor}): `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    let allModels: vscode.LanguageModelChat[] = [];
    try {
      const unscopedModels = typeof lm.selectChatModels === 'function'
        ? await lm.selectChatModels()
        : [];
      const seen = new Set<string>();
      allModels = [];
      for (const model of [...copilotModels, ...preferredModels, ...unscopedModels]) {
        const key = `${model.vendor ?? ''}/${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          allModels.push(model);
        }
      }
    } catch (error) {
      logger.appendLine(
        `[title-generator] Unscoped model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      allModels = [...copilotModels, ...preferredModels];
    }
    const models = pickTitleModels(
      allModels,
      lm.languageModelAccessInformation,
      preferredVendor,
    );
    if (models.length === 0) {
      logger.appendLine('[title-generator] No VS Code LM available for title generation');
      return undefined;
    }

    for (const model of models) {
      try {
        const cleaned = await requestTitle(model);
        if (cleaned) {
          return cleaned;
        }
        logger.appendLine(
          `[title-generator] VS Code LM unusable response from ${model.vendor ?? 'unknown'}:`
            + ` "${model.id}"`,
        );
      } catch (err) {
        logger.appendLine(
          `[title-generator] VS Code LM model ${model.vendor ?? 'unknown'}/${model.id} failed:`
            + ` ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return undefined;
  } catch (err) {
    logger.appendLine(
      `[title-generator] VS Code LM title generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Order title candidates without treating a negative access snapshot as a
 * permanent capability declaration. VS Code can report `false` while a
 * provider is still resolving authentication/entitlement; the actual
 * `sendRequest` call remains the authoritative check.
 */
export function pickTitleModels(
  models: readonly vscode.LanguageModelChat[],
  access: { canSendRequest(chat: vscode.LanguageModelChat): boolean | undefined } | undefined,
  preferredVendor?: string,
  preferredModel?: vscode.LanguageModelChat,
): vscode.LanguageModelChat[] {
  const candidates = [...(preferredModel ? [preferredModel] : []), ...models].flatMap((model, index) => {
    if (typeof model.sendRequest !== 'function') {
      return [];
    }
    let canSend: boolean | undefined;
    try {
      canSend = access?.canSendRequest(model);
    } catch {
      // A stale access-information object must not make title generation
      // fall back before the provider has had a chance to answer.
      canSend = undefined;
    }
    return [{ model, index, canSend }];
  });

  const uniqueCandidates = candidates.filter((candidate, index, all) => {
    const key = `${candidate.model.vendor ?? ''}/${candidate.model.id}`;
    return all.findIndex(other => `${other.model.vendor ?? ''}/${other.model.id}` === key) === index;
  });

  const score = (model: vscode.LanguageModelChat): number => {
    const haystack = `${model.vendor} ${model.id} ${model.name} ${model.family}`.toLowerCase();
    let value = 0;
    // Copilot is the stable title-generation path. ACPilot vendors remain a
    // fallback when Copilot is unavailable, but must never win merely because
    // the active participant backend is also the preferred vendor.
    if (model.vendor === 'copilot' || model.vendor?.endsWith('-copilot')) {value += 10_000;}
    if (preferredVendor && model.vendor === preferredVendor) {value += 1_500;}
    value += 100;
    if (/nano|mini|small|fast|flash|haiku|lite/.test(haystack)) {value += 25;}
    if (/gpt-4\.1|gpt-4o|gpt-5/.test(haystack)) {value += 10;}
    return value;
  };

  return uniqueCandidates
    .sort((a, b) => {
      // Prefer models that are currently known to be usable, while retaining
      // blocked/unknown candidates as a final attempt. `sendRequest` can
      // still succeed after VS Code refreshes access during this call.
      const accessDelta = Number(a.canSend === false) - Number(b.canSend === false);
      return accessDelta || score(b.model) - score(a.model) || a.index - b.index;
    })
    .map(candidate => candidate.model);
}

async function collectLmText(text: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of text) {
    result += chunk;
  }
  return result.trim();
}

/**
 * Build a focused, low-token prompt that asks the model to produce a short
 * title. Rules are included inline so every model produces something usable.
 */
export function buildTitlePrompt(userMessage: string): string {
  const truncated =
    userMessage.length > 360
      ? `${userMessage.slice(0, 357)}...`
      : userMessage;

  return [
    'Generate a short, descriptive title for a coding conversation.',
    '',
    'Rules:',
    '- Respond with ONLY the title text; no quotes, no explanation, no punctuation at the end',
    '- The title must capture the main topic or task the user is asking about',
    '- Write the title in the same natural language as the user request when clear',
    '- If the request mixes languages, use the dominant natural language',
    '- Preserve product names, APIs, file names, commands, code symbols, and proper nouns exactly',
    '- Keep it concise and specific to coding',
    '- Aim for 3-6 words; for languages without spaces, keep it similarly brief',
    '- Drop filler like "help with", "question about", "request for", or their equivalents',
    '- Examples: "React auth middleware" | "\u4fee\u590d session \u6807\u9898" | "VS Code tree view"',
    '',
    `User message: "${truncated}"`,
  ].join('\n');
}

/**
 * Strip formatting artifacts from an LLM-generated title and validate it.
 * Returns `undefined` if the result is unusable.
 */
export function cleanGeneratedTitle(raw: string): string | undefined {
  let value = raw.trim();
  if (/^```/.test(value)) {
    value = value
      .replace(/^```[^\r\n]*\r?\n/, '')
      .replace(/\r?\n```\s*$/, '')
      .replace(/^```([^\r\n]*)```$/, '$1');
  }
  const firstLine = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && !/^```/.test(line));
  const cleaned = (firstLine ?? value)
    .replace(/^(?:[-*]|\d+[.)])\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();

  if (!cleaned) {
    return undefined;
  }

  if (cleaned.length > 80 || /^(i'm |i am |here|sorry|i can)/i.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}
