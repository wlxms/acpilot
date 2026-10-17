/**
 * Runtime gating helpers for VS Code proposed and experimental APIs.
 *
 * Provides type-safe capability checks so callers can detect what APIs
 * are available at runtime without unsafe casts or `any`. Every proposed
 * API is checked via `typeof` / `in` before use.
 *
 * == Stable API surface (always available via `vscode.ChatResponseStream`) ==
 * - `stream.markdown()`
 * - `stream.progress()`
 * - `stream.push()`
 * - `stream.button()`
 *
 * == Proposed APIs (chatParticipantAdditions, gated at runtime) ==
 * - `stream.thinkingProgress()`                     — real-time thinking display
 * - `stream.beginToolInvocation()` / `updateToolInvocation()`  — streaming tool spinner
 * - `ChatToolInvocationPart`                        — rich expandable tool cards
 * - `ChatResponseMultiDiffPart`                     — file diff display
 * - `stream.externalEdit()`                         — external edit tracking
 * - `ChatResponseWorkspaceEditPart`                 — new file creation tracking
 * - `ChatSubagentToolInvocationData`                — subagent expandable card
 *
 * All checks return boolean. Extending types are provided for optional use
 * when the consumer wants to cast a stream reference only after the check
 * passes.
 */
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Internal cast helpers (never exported)
// ---------------------------------------------------------------------------

/** Narrow cast to check for optional methods on ChatResponseStream */
interface StreamWithThinking extends vscode.ChatResponseStream {
  thinkingProgress?(delta: {
    text?: string | string[];
    id?: string;
    metadata?: { readonly [key: string]: unknown };
  }): void;
}
interface StreamWithToolInvocation extends vscode.ChatResponseStream {
  beginToolInvocation?(callId: string, name: string, data?: unknown): void;
  updateToolInvocation?(callId: string, data: unknown): void;
}

// ---------------------------------------------------------------------------
// Per-API capability checks
// ---------------------------------------------------------------------------

/**
 * `true` if the stream supports `thinkingProgress()` for real-time
 * reasoning display (`chatParticipantAdditions` proposal).
 */
export function hasThinkingProgress(
  stream: vscode.ChatResponseStream,
): stream is StreamWithThinking {
  return typeof (stream as StreamWithThinking).thinkingProgress === 'function';
}

/**
 * `true` if the stream supports `beginToolInvocation()` /
 * `updateToolInvocation()` for streaming tool spinners.
 */
export function hasToolUI(
  stream: vscode.ChatResponseStream,
): stream is StreamWithToolInvocation {
  return typeof (stream as StreamWithToolInvocation).beginToolInvocation === 'function';
}

/**
 * `true` if `ChatToolInvocationPart` is available at runtime.
 * This is the class constructor for rich expandable tool cards.
 */
export function hasChatToolInvocationPart(): boolean {
  return (
    typeof (vscode as Record<string, unknown>).ChatToolInvocationPart === 'function'
  );
}

/**
 * `true` if `ChatResponseMultiDiffPart` is available at runtime.
 * Renders +/- diffs in the chat response.
 */
export function hasChatResponseMultiDiffPart(): boolean {
  return (
    typeof (vscode as Record<string, unknown>).ChatResponseMultiDiffPart === 'function'
  );
}

/**
 * `true` if the stream supports `externalEdit()` for tracking edits
 * made outside of VS Code.
 */
export function hasExternalEdit(
  stream: vscode.ChatResponseStream,
): stream is vscode.ChatResponseStream & {
  externalEdit(target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>): Thenable<string>;
} {
  return typeof (stream as {
    externalEdit?: unknown;
  }).externalEdit === 'function';
}

/**
 * `true` if `ChatResponseWorkspaceEditPart` is available at runtime.
 * Registers newly created files in the workspace.
 */
export function hasChatResponseWorkspaceEditPart(): boolean {
  return (
    typeof (vscode as Record<string, unknown>).ChatResponseWorkspaceEditPart === 'function'
  );
}

/**
 * `true` if `ChatSubagentToolInvocationData` is available at runtime.
 * Provides the constructor for subagent expandable cards.
 */
export function hasChatSubagentToolInvocationData(): boolean {
  return (
    typeof (vscode as Record<string, unknown>).ChatSubagentToolInvocationData === 'function'
  );
}

// ---------------------------------------------------------------------------
// Aggregate checks
// ---------------------------------------------------------------------------

/** Every proposed tool-invocation part type we use */
export interface ToolInvocationCapabilities {
  toolInvocationPart: boolean;
  multiDiffPart: boolean;
  workspaceEditPart: boolean;
  subagentData: boolean;
}

/**
 * Check all tool-invocation part capabilities in a single call.
 * Useful for initialisation-time probing.
 */
export function getToolInvocationCapabilities(): ToolInvocationCapabilities {
  return {
    toolInvocationPart: hasChatToolInvocationPart(),
    multiDiffPart: hasChatResponseMultiDiffPart(),
    workspaceEditPart: hasChatResponseWorkspaceEditPart(),
    subagentData: hasChatSubagentToolInvocationData(),
  };
}

/**
 * `true` if the stream has the full proposed chat participant additions
 * surface (thinking progress + tool invocation methods).
 */
export function hasFullProposedSurface(
  stream: vscode.ChatResponseStream,
): stream is StreamWithThinking & StreamWithToolInvocation {
  return hasThinkingProgress(stream) && hasToolUI(stream);
}

// ---------------------------------------------------------------------------
// Future API stubs (for experimental surfaces)
// ---------------------------------------------------------------------------

/**
 * Check whether `registerChatSessionContentProvider` is available on the
 * `vscode.chat` namespace. This is a future proposed API not yet in any
 * published proposal — the check exists to allow forward-compatible
 * experimental surfaces.
 */
export function hasRegisterChatSessionContentProvider(): boolean {
  try {
    const chat = vscode.chat as Record<string, unknown>;
    return typeof chat.registerChatSessionContentProvider === 'function';
  } catch {
    // Proposed API proxies can reject even a capability lookup when the host
    // has not enabled the proposal for an installed extension.
    return false;
  }
}

/**
 * Check whether `ChatSessionContentProvider` (experimental) is available.
 * This surface would allow fully custom rendering of chat session content
 * beyond the current participant model.
 */
export function hasChatSessionContentProviderAPI(): boolean {
  const vsc = vscode as Record<string, unknown>;
  return (
    typeof vsc.ChatSessionContentProvider === 'function' ||
    typeof vsc.chatSessionContentProvider === 'function'
  );
}

// ---------------------------------------------------------------------------
// Re-usable stream type exports for consumers that gate via the checks above
// ---------------------------------------------------------------------------

/** Stream narrowed to include `thinkingProgress()` */
export type ThinkingStream = StreamWithThinking;

/** Stream narrowed to include tool invocation methods */
export type ToolUIStream = StreamWithToolInvocation;

/** Stream with the full proposed surface */
export type FullProposedStream = StreamWithThinking & StreamWithToolInvocation;
