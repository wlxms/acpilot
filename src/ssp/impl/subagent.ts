/**
 * SubagentManager + SubagentScope + formatSubagentProgress.
 *
 * Fully owned by SSP — no dependency on participant layer.
 * The participant layer and pipelines import FROM here, not the reverse.
 */

// ===========================================================================
// SubagentScope — tracks a running subagent's captured internal events
// ===========================================================================

export interface SubagentScope {
  callId: string;
  toolCalls: Array<{ name: string; title?: string; status: string }>;
  completed: boolean;
  /** True when the backend ended this subagent session with an error. */
  failed?: boolean;
  /** Backend-provided terminal error for a failed subagent session. */
  error?: string;
  childSessionId?: string;
  childIdle?: boolean;
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
  toolMeta?: {
    toolName: string;
    title: string;
    input: Record<string, unknown>;
    timeStart?: number;
  };
  output?: string;
  timeEnd?: number;
  descendantSessionIds: Set<string>;
  lastText?: string;
  lastAssistantText?: string;
  lastReasoningText?: string;
}

// ===========================================================================
// formatSubagentProgress — human-readable subagent activity summary
// ===========================================================================

/** e.g. "3× read, 2× edit, bash" */
export function formatSubagentProgress(scope: SubagentScope): string {
  const counts = new Map<string, number>();
  for (const tc of scope.toolCalls) {
    if (tc.status === 'completed' || tc.status === 'error') {
      counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) { return ''; }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${count}× ${name}` : name);
  }
  return parts.join(', ');
}

// ===========================================================================
// SubagentManager — runtime subagent state tracker
// ===========================================================================

export class SubagentManager {
  private scopes = new Map<string, SubagentScope>();

  startSubagent(
    callId: string,
    toolMeta: SubagentScope['toolMeta'],
    parentSubAgentInvocationId?: string,
  ): SubagentScope {
    const scope: SubagentScope = {
      callId,
      toolCalls: [],
      completed: false,
      descendantSessionIds: new Set(),
      subAgentInvocationId: this.generateSubAgentInvocationId(callId),
      parentSubAgentInvocationId,
      ...toolMeta ? { toolMeta } : {},
    };
    this.scopes.set(callId, scope);
    return scope;
  }

  recordChildToolCall(callId: string, toolCall: { name: string; title?: string; status: string }): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.toolCalls.push(toolCall); }
  }

  completeSubagent(callId: string, output?: string): SubagentScope | undefined {
    const scope = this.scopes.get(callId);
    if (scope) {
      scope.completed = true;
      // A late task.completed event must not overwrite a terminal child error.
      if (output !== undefined && !scope.failed) {scope.output = output;}
    }
    return scope;
  }

  /** Mark a subagent terminally failed and make it no longer busy. */
  failSubagent(callId: string, error: string): SubagentScope | undefined {
    const scope = this.scopes.get(callId);
    if (scope) {
      scope.completed = true;
      scope.childIdle = true;
      scope.failed = true;
      scope.error = error;
      scope.output = error;
      scope.timeEnd = Date.now();
    }
    return scope;
  }

  markChildIdle(callId: string): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.childIdle = true; scope.timeEnd = Date.now(); }
  }

  setChildSession(callId: string, childSessionId: string): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.childSessionId = childSessionId; scope.descendantSessionIds.add(childSessionId); }
  }

  addDescendantSession(callId: string, sessionId: string): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.descendantSessionIds.add(sessionId); }
  }

  getScope(callId: string): SubagentScope | undefined { return this.scopes.get(callId); }

  listScopes(): SubagentScope[] { return [...this.scopes.values()]; }

  findScopeBySubAgentInvocationId(subAgentInvocationId: string): SubagentScope | undefined {
    return this.listScopes().find(scope => scope.subAgentInvocationId === subAgentInvocationId);
  }

  findScopeForSession(sessionId: string): SubagentScope | undefined {
    for (const scope of this.scopes.values()) {
      if (scope.childSessionId === sessionId) {return scope;}
    }
    for (const scope of this.scopes.values()) {
      if (scope.descendantSessionIds.has(sessionId)) {return scope;}
    }
    return undefined;
  }

  hasBusyDescendant(): boolean {
    for (const scope of this.scopes.values()) {
      if (!scope.completed || !scope.childIdle) { return true; }
    }
    return false;
  }

  generateSubAgentInvocationId(callId: string): string {
    return callId;
  }

  getProgressSummary(callId: string): string {
    const scope = this.scopes.get(callId);
    return scope ? formatSubagentProgress(scope) : '';
  }

  removeSubagent(callId: string): void { this.scopes.delete(callId); }
  clear(): void { this.scopes.clear(); }
}
