import type { ExtensionState, BackendContext } from '../types';
import type { SessionTitleSource } from '../acp/serializable/types';

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

export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? '';
  return !normalized
    || normalized === 'New OpenCode Session'
    || normalized.startsWith('OpenCode Session ')
    || normalized.startsWith('Session ');
}

function titlePriority(source: SessionTitleSource | undefined): number {
  switch (source) {
    case 'manual': return 60;
    case 'copilot-style': return 50;
    case 'backend': return 40;
    case 'restore': return 35;
    case 'history': return 30;
    case 'legacy': return 20;
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
    if (!stateKey) return;
    const sessionState = ctx.sessions.get(stateKey);
    if (!sessionState || sessionState.backendSessionId !== options.backendSessionId) return;
    createdAt = createdAt ?? sessionState.createdAt;
    if (shouldOverwriteTitle(sessionState.title, sessionState.titleSource, options.source, options.overwrite)) {
      sessionState.title = title;
      sessionState.titleSource = options.source;
      sessionState.provisionalTitle = false;
    }
  };

  updateState(options.vscodeSessionId);
  for (const sessionState of ctx.sessions.values()) {
    if (sessionState.backendSessionId !== options.backendSessionId) continue;
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
      backendName: ctx.backend.name,
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
    if (!stateKey) return;
    const sessionState = ctx.sessions.get(stateKey);
    if (!sessionState || sessionState.backendSessionId !== options.backendSessionId) return;
    createdAt = createdAt ?? sessionState.createdAt;
    if (isPlaceholderSessionTitle(sessionState.title) || sessionState.provisionalTitle) {
      sessionState.title = title;
      sessionState.titleSource = 'history';
      sessionState.provisionalTitle = true;
    }
  };

  updateState(options.vscodeSessionId);
  for (const sessionState of ctx.sessions.values()) {
    if (sessionState.backendSessionId !== options.backendSessionId) continue;
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
      backendName: ctx.backend.name,
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

/**
 * Backward-compatible wrapper for old call sites. New code should pass
 * `backendSessionId` explicitly.
 */
export async function applySessionTitleLegacy(
  state: ExtensionState,
  ctx: BackendContext,
  options: Omit<ApplySessionTitleOptions, 'backendSessionId'> & { sessionId: string },
): Promise<string | undefined> {
  const { sessionId, ...rest } = options;
  return applySessionTitle(state, ctx, { ...rest, backendSessionId: sessionId });
}
