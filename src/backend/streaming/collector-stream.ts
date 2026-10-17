import * as vscode from 'vscode';

/**
 * CollectorStream — captures all rendered `ChatResponseStream` parts into an array,
 * enabling pipeline event replay during session restore.
 *
 * Each method mirrors the corresponding `vscode.ChatResponseStream` method,
 * pushing the created part into an internal array. Proposed API methods
 * (`thinkingProgress`) use runtime detection so they work whether or not
 * the VS Code proposal is enabled.
 *
 * Use `buildTurn()` to construct a chat response turn from the captured
 * parts, and `reset()` to clear the buffer.
 */
export class CollectorStream {
  private _parts: unknown[] = [];
  /** Track tool part indices by callId for progressive updates */
  private toolPartIndices = new Map<string, number>();

  /** Captured parts (read-only access) */
  get parts(): readonly unknown[] {
    return this._parts;
  }

  // ── Stable ChatResponseStream methods ──────────────────────────────────

  /**
   * Capture a markdown string or {@link vscode.MarkdownString} as a
   * `ChatResponseMarkdownPart`.
   */
  markdown(value: string | vscode.MarkdownString): void {
    const md =
      typeof value === 'string' ? new vscode.MarkdownString(value) : value;
    const Part =
      (vscode as any).ChatResponseMarkdownPart ??
      class {
        value: any;
        constructor(v: any) {
          this.value = v;
        }
      };
    this._parts.push(new Part(md));
  }

  /**
   * Push an arbitrary part directly into the captured array.
   * Accepts any `ChatResponsePart` or proposed API part.
   */
  /**
   * Push a part. Tool invocations are deduplicated by callId
   * — progressive updates replace the previous card instead of
   * creating duplicates during replay.
   */
  push(part: unknown): void {
    // Deduplicate tool invocations by callId
    const toolPart = part as { toolCallId?: string };
    if (toolPart.toolCallId) {
      const existingIdx = this.toolPartIndices.get(toolPart.toolCallId);
      if (existingIdx !== undefined) {
        this._parts[existingIdx] = part;
        return;
      }
      this.toolPartIndices.set(toolPart.toolCallId, this._parts.length);
    }
    this._parts.push(part);
  }

  /**
   * Capture a progress message as italic markdown.
   */
  progress(value: string): void {
    this.markdown(`_${value}_`);
  }

  /**
   * Capture a reference value (URI or Location).
   * Uses runtime detection for the proposed `ChatResponseReferencePart2`.
   */
  reference(value: vscode.Uri | vscode.Location): void {
    const RefPart = (vscode as any).ChatResponseReferencePart2;
    if (RefPart) {
      this._parts.push(new RefPart(value, false));
    }
  }

  // ── Proposed API methods (runtime detection) ───────────────────────────

  /**
   * Capture a thinking-progress notification.
   *
   * If the runtime provides `ChatResponseThinkingProgressPart` (from the
   * `chatParticipantAdditions` proposal) it is used; otherwise falls back
   * to a markdown part with a thinking indicator.
   */
  thinkingProgress(data: { text: string; id?: string }): void {
    const ThinkingPart = (vscode as any).ChatResponseThinkingProgressPart;
    if (ThinkingPart) {
      this._parts.push(new ThinkingPart(data.text, data.id));
    } else {
      // Fallback: render as italic markdown with a truncation guard
      const snippet =
        data.text.length > 100
          ? data.text.slice(0, 100) + '…'
          : data.text;
      this.markdown(`💭 Thinking: ${snippet}`);
    }
  }

  /** Track active tool invocation parts by call ID for updates */
  private toolParts = new Map<string, any>();

  /**
   * Begin a tool invocation — creates a ChatToolInvocationPart and pushes it.
   */
  beginToolInvocation(callId: string, toolName: string, data?: { subagentInvocationId?: string; isAttachedToThinking?: boolean }): void {
    const ToolPart = (vscode as any).ChatToolInvocationPart;
    if (ToolPart) {
      const tp = new ToolPart(toolName, callId);
      if (data?.subagentInvocationId) {
        tp.subAgentInvocationId = data.subagentInvocationId;
      }
      if (data?.isAttachedToThinking !== undefined) {
        tp.isAttachedToThinking = data.isAttachedToThinking;
      }
      this.toolParts.set(callId, tp);
      // Use push() for deduplication by callId
      this.push(tp);
    }
  }

  /**
   * Update an active tool invocation — sets fields on the tracked part.
   */
  updateToolInvocation(callId: string, data: { partialInput?: Record<string, unknown>; invocationMessage?: string; isAttachedToThinking?: boolean }): void {
    const tp = this.toolParts.get(callId);
    if (tp) {
      if (data.isAttachedToThinking !== undefined) {
        tp.isAttachedToThinking = data.isAttachedToThinking;
      }
      if (data.invocationMessage !== undefined) {
        tp.invocationMessage = data.invocationMessage;
        tp.isComplete = true;
      }
    }
  }

  // ── Control ────────────────────────────────────────────────────────────

  /**
   * Build a response turn from the currently captured parts.
   *
   * Copilot CLI restores provider history with ChatResponseTurn2. Prefer that
   * shape when available so proposed/extended response parts take VS Code's
   * session-provider restore path, then fall back for older test/runtime shims.
   */
  buildTurn(metadata: Record<string, unknown> = {}, participantId: string = 'acpilot'): vscode.ChatResponseTurn | vscode.ChatResponseTurn2 {
    const result: vscode.ChatResult = { metadata };
    const Turn2Ctor = (vscode as unknown as {
      ChatResponseTurn2?: new (
        r: readonly unknown[],
        res: vscode.ChatResult,
        participant: string,
        command?: string,
      ) => vscode.ChatResponseTurn2;
    }).ChatResponseTurn2;
    if (Turn2Ctor) {
      return new Turn2Ctor(this._parts, result, participantId);
    }

    const TurnCtor = vscode.ChatResponseTurn as unknown as new (
      r: readonly unknown[],
      res: vscode.ChatResult,
      participant: string,
      command?: string,
    ) => vscode.ChatResponseTurn;
    return new TurnCtor(this._parts, result, participantId);
  }

  /** Clear all captured parts. */
  reset(): void {
    this._parts = [];
    this.toolPartIndices.clear();
  }
}
