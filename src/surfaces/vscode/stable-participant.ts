/**
 * Stable participant surface.
 *
 * The stable surface now uses the same request handler as the session-provider
 * surface. Rendering is owned by SSP/SSS and falls back based on the available
 * VS Code stream capabilities, so there is no separate ACP renderer path.
 */

import type * as vscode from 'vscode';
import type { ExtensionState, BackendContext } from '../../types';
import { createParticipantHandler } from '../../participant/handler';

export interface StableHandlerOptions {
  logger?: { appendLine(message: string): void };
}

export function createStableHandler(
  state: ExtensionState,
  ctx: BackendContext,
  _options?: StableHandlerOptions,
): vscode.ChatRequestHandler {
  return createParticipantHandler(state, ctx);
}
