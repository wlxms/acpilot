import * as vscode from 'vscode';
import type { BackendContext } from '../types';
import { assertSessionResourcePath } from '../backend/backend-instance';

export interface DshRenderSessionRoute {
  readonly sessionKey: string;
  submit(action: string, payload: Record<string, unknown>): Promise<void>;
}

// Use the runtime-owned mapping object so identical native ids in different
// Desktop installations cannot share a busy guard.
const activeSessions = new WeakMap<BackendContext['sessions'], Map<string, number>>();
interface SubmissionLease {
  readonly prompt: string;
  readonly runtime: BackendContext;
  accepted: boolean;
  assertCurrent(): void;
}
const submissions = new WeakMap<BackendContext, Map<string, SubmissionLease>>();

function sameRuntime(left: BackendContext, right: BackendContext): boolean {
  return left.runtimeGeneration === right.runtimeGeneration
    && left.instanceKey === right.instanceKey
    && left.storageNamespace === right.storageNamespace
    && left.selection === right.selection
    && left.sessions === right.sessions
    && left.sessionStore === right.sessionStore;
}

/** Recheck the originating runtime after the command crosses into the workbench. */
export function assertDshRenderSessionSubmission(
  owner: BackendContext,
  runtime: BackendContext,
  resource: vscode.Uri | undefined,
  prompt: string,
): void {
  if (!resource) {return;}
  const lease = submissions.get(owner)?.get(resource.toString());
  if (!lease || lease.prompt !== prompt) {return;}
  lease.assertCurrent();
  if (!sameRuntime(runtime, lease.runtime)) {
    throw new Error('The originating DSH conversation changed before its action was submitted.');
  }
  lease.accepted = true;
}

/** Hold the action guard for the complete visible participant request. */
export function markDshRenderSessionBusy(runtime: BackendContext, backendSessionId: string): () => void {
  let active = activeSessions.get(runtime.sessions);
  if (!active) {
    active = new Map();
    activeSessions.set(runtime.sessions, active);
  }
  active.set(backendSessionId, (active.get(backendSessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {return;}
    released = true;
    const count = active!.get(backendSessionId) ?? 0;
    if (count <= 1) {active!.delete(backendSessionId);}
    else {active!.set(backendSessionId, count - 1);}
  };
}

/**
 * The closure binds a view to its originating contributed VS Code session.
 * The renderer API has no sessionResource, so focused-chat commands cannot
 * safely provide this association.
 */
export function createDshRenderSessionRoute(
  owner: BackendContext,
  runtime: BackendContext,
  resource: vscode.Uri,
  backendSessionId: string,
): DshRenderSessionRoute {
  const sessionKey = resource.toString();
  const command = 'workbench.action.chat.openSessionWithPrompt.' + runtime.scheme;
  let boundState = runtime.sessions.get(sessionKey);
  const assertCurrent = (): void => {
    if (!owner.acceptingRequests
      || !sameRuntime(owner, runtime)
      || resource.scheme !== runtime.scheme
      || runtime.sessions.get(sessionKey)?.backendSessionId !== backendSessionId) {
      throw new Error('The originating DSH conversation changed; reopen its view before trying this action.');
    }
    const currentState = runtime.sessions.get(sessionKey);
    if (boundState && currentState !== boundState) {
      throw new Error('The originating DSH conversation changed; reopen its view before trying this action.');
    }
    boundState = currentState;
    assertSessionResourcePath(resource.path, runtime.id, runtime.instanceKey);
  };

  return {
    sessionKey,
    async submit(action, payload) {
      assertCurrent();
      if ((activeSessions.get(runtime.sessions)?.get(backendSessionId) ?? 0) > 0) {
        throw new Error('The originating DSH conversation is busy. Try again when its response finishes.');
      }
      const release = markDshRenderSessionBusy(runtime, backendSessionId);
      let lease: SubmissionLease | undefined;
      try {
        const commands = vscode.commands;
        if (!commands || typeof commands.getCommands !== 'function'
          || typeof commands.executeCommand !== 'function') {
          throw new Error('Targeted DSH conversation submission is unavailable in this VS Code version.');
        }
        const available = await commands.getCommands(true);
        assertCurrent();
        if (!available.includes(command)) {
          throw new Error('Targeted DSH conversation submission is unavailable in this VS Code version.');
        }
        // This contributed command uses chatService.sendRequest(resource, ...)
        // and the provider requestHandler. That retains visible turns, history,
        // persistence, cancellation and the originating session selection.
        const prompt = '[genui-action] ' + action + ' ' + JSON.stringify(payload);
        lease = { prompt, runtime, assertCurrent, accepted: false };
        let pending = submissions.get(owner);
        if (!pending) {
          pending = new Map();
          submissions.set(owner, pending);
        }
        pending.set(sessionKey, lease);
        await commands.executeCommand(command, { resource, prompt });
        assertCurrent();
        // VS Code also resolves this command when sendRequest rejects. Only
        // the originating participant handler can acknowledge actual admission.
        if (!lease.accepted) {
          throw new Error('The DSH action was not accepted by VS Code. Try again.');
        }
      } finally {
        const pending = submissions.get(owner);
        if (lease && pending?.get(sessionKey) === lease) {pending.delete(sessionKey);}
        release();
      }
    },
  };
}
