/**
 * Copilot native language-model adapter.
 *
 * This module is deliberately thin: VS Code messages are serialized into the
 * backend-neutral prompt shape, then the selected BackendModelProvider owns
 * session creation, event consumption, pipeline execution, cancellation, and
 * cleanup. Backend SSPs are rendered into the native LM progress sink.
 */

import * as vscode from 'vscode';
import {
  BackendRuntimeChangedError,
  type BackendModelRequestPurpose,
  type BackendModelOptions,
  type BackendRuntimeGuard,
} from '../../backend/backend';
import type { BackendFileAttachment, PermissionMode } from '../../backend/types';
import type { BackendContext } from '../../types';
import type { SspStream } from '../../ssp/types';
import { TransientSessionStream } from '../../backend/transient-session-stream';

export interface BackendChatModel {
  providerID: string;
  modelID: string;
}

export interface BackendChatLogger {
  appendLine(message: string): void;
}

export interface BackendChatResponseOptions {
  ctx: BackendContext;
  /** Runtime lease captured by the Copilot surface for this request. */
  runtime?: BackendRuntimeGuard;
  model: BackendChatModel;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
  token: vscode.CancellationToken;
  /** Opaque per-request options; the owning backend may allow-list supported keys. */
  modelOptions?: BackendModelOptions;
  /** Identifies host-internal requests such as session title generation. */
  purpose?: BackendModelRequestPurpose;
  directory?: string;
  agent?: string;
  permissionMode?: PermissionMode;
  /** Native LM has no participant interaction channel for permission prompts. */
  allowUserInteraction?: boolean;
  title?: string;
  logger?: BackendChatLogger;
}

export interface SerializedLanguageModelPrompt {
  text: string;
  attachments: BackendFileAttachment[];
}

/** Bound the final native stream drain so host callbacks cannot block forever. */
export const NATIVE_STREAM_FLUSH_TIMEOUT_MS = 2_000;
const FLUSH_TIMEOUT = Symbol('native-stream-flush-timeout');

/** Convert VS Code's structured history into a backend prompt. */
export function serializeLanguageModelMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): SerializedLanguageModelPrompt {
  const attachments: BackendFileAttachment[] = [];
  const sections: string[] = [];

  for (const message of messages) {
    // The enum is numeric at runtime; using the numeric value also keeps this
    // adapter compatible with the lightweight VS Code test shim.
    const role = (message.role as unknown as number) === 2 ? 'Assistant' : 'User';
    const parts: string[] = [];
    for (const rawPart of message.content) {
      const rendered = serializeInputPart(rawPart, attachments);
      if (rendered) {parts.push(rendered);}
    }
    if (parts.length > 0) {
      sections.push(`${role}:\n${parts.join('\n')}`);
    }
  }

  const text = sections.length === 1
    ? sections[0].replace(/^(?:User|Assistant):\n/, '')
    : sections.join('\n\n');
  return { text, attachments };
}

function serializeInputPart(part: unknown, attachments: BackendFileAttachment[]): string {
  if (isTextPart(part)) {return part.value;}

  if (isDataPart(part)) {
    const mime = part.mimeType || 'application/octet-stream';
    const bytes = toUint8Array(part.data ?? part.value);
    if (bytes && bytes.byteLength > 0) {
      attachments.push({
        mime,
        url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      });
    } else {
      attachments.push({ mime, url: `data:${mime};base64,` });
    }
    return `[Attached data: ${mime}]`;
  }

  if (isToolCallPart(part)) {
    return `[Tool call ${part.name} (${part.callId})]\n${jsonForPrompt(part.input)}`;
  }
  if (isToolResultPart(part)) {
    return `[Tool result (${part.callId})]\n${serializeUnknownContent(part.content)}`;
  }
  if (typeof part === 'string') {return part;}
  if (part === undefined || part === null) {return '';}
  return jsonForPrompt(part);
}

function isTextPart(value: unknown): value is { value: string } {
  if (!value || typeof value !== 'object') {return false;}
  const part = value as Record<string, unknown>;
  return typeof part.value === 'string' && typeof part.mimeType !== 'string' && !('callId' in part);
}

function isDataPart(value: unknown): value is { mimeType?: string; data?: Uint8Array; value?: Uint8Array } {
  if (!value || typeof value !== 'object') {return false;}
  const part = value as Record<string, unknown>;
  return typeof part.mimeType === 'string' || part.data instanceof Uint8Array || part.value instanceof Uint8Array;
}

function isToolCallPart(value: unknown): value is { callId: string; name: string; input: unknown } {
  if (!value || typeof value !== 'object') {return false;}
  const part = value as Record<string, unknown>;
  return typeof part.callId === 'string' && typeof part.name === 'string' && 'input' in part;
}

function isToolResultPart(value: unknown): value is { callId: string; content: unknown } {
  if (!value || typeof value !== 'object') {return false;}
  const part = value as Record<string, unknown>;
  return typeof part.callId === 'string' && 'content' in part && !('name' in part);
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {return value;}
  if (value instanceof ArrayBuffer) {return new Uint8Array(value);}
  return undefined;
}

function serializeUnknownContent(value: unknown): string {
  if (Array.isArray(value)) {return value.map(serializeUnknownContent).filter(Boolean).join('\n');}
  if (isTextPart(value)) {return value.value;}
  if (typeof value === 'string') {return value;}
  return jsonForPrompt(value);
}

function jsonForPrompt(value: unknown): string {
  try {return JSON.stringify(value);}
  catch {return String(value);}
}

/** Run one native LM request through the owning backend's model capability. */
export async function streamBackendChatResponse(options: BackendChatResponseOptions): Promise<void> {
  const prompt = serializeLanguageModelMessages(options.messages);
  // Validate the runtime before the empty-prompt fast path.  An invocation
  // that races a backend target switch must not resolve successfully merely
  // because serialization produced no content.
  if (options.runtime && !isRuntimeCurrent(options.runtime)) {
    throw new BackendRuntimeChangedError(options.runtime.instanceKey);
  }
  if (!prompt.text.trim() && prompt.attachments.length === 0) {return;}

  const provider = options.ctx.backend.modelProvider;
  if (!provider) {
    throw new Error(`Backend "${options.ctx.displayName}" does not provide native model invocation.`);
  }

  const transientSessionId = `native-lm-${randomId()}`;
  const stream = new TransientSessionStream(createProgressStream(options.progress), {
    sessionId: transientSessionId,
    requestId: transientSessionId,
  });
  stream.recordFirstPrompt(prompt.text);

  let runtimeInvalidated = false;
  const runtimeDispose = options.runtime?.onInvalidated?.(() => {
    runtimeInvalidated = true;
    // Stop rendering immediately. The backend provider may be a plugin that
    // does not implement the optional runtime lease itself; closing this
    // transient stream still prevents late SSPs from reaching Copilot.
    stream.close();
  });

  options.logger?.appendLine(
    `[lm-provider:${provider.vendor}] invoking backend model ${options.model.providerID}/${options.model.modelID}`,
  );

  const token = {
    get isCancellationRequested(): boolean {
      if (options.token.isCancellationRequested) {return true;}
      try {
        return options.runtime ? !isRuntimeCurrent(options.runtime) : false;
      } catch {
        return true;
      }
    },
  };

  let invocationError: unknown;
  try {
    const result = await provider.invoke({
      model: options.model,
      runtime: options.runtime,
      modelOptions: options.modelOptions === undefined
        ? undefined
        : { ...options.modelOptions },
      purpose: options.purpose,
      prompt: {
        text: prompt.text,
        attachments: prompt.attachments,
      },
      directory: options.directory,
      agent: options.agent,
      permissionMode: options.permissionMode,
      allowUserInteraction: options.allowUserInteraction,
      title: options.title ?? 'LM Provider Chat',
      stream,
      token,
      logger: options.logger,
    });
    if (runtimeInvalidated || (options.runtime && !isRuntimeCurrent(options.runtime))) {
      runtimeInvalidated = true;
      stream.close();
      invocationError = new BackendRuntimeChangedError(options.runtime?.instanceKey ?? 'unknown');
    } else if (!result.completed) {
      invocationError = new Error('Backend model invocation did not complete');
    }
  } catch (error) {
    if (!runtimeInvalidated && options.runtime && !isRuntimeCurrent(options.runtime)) {
      runtimeInvalidated = true;
      stream.close();
    }
    invocationError = runtimeInvalidated
      ? new BackendRuntimeChangedError(options.runtime?.instanceKey ?? 'unknown')
      : error;
  } finally {
    try {
      if (!runtimeInvalidated && (!options.runtime || isRuntimeCurrent(options.runtime))) {
        // Flush while the transient stream is still active. Closing first would
        // discard scheduled SSP work; closing after this flush blocks any event
        // that arrives after the backend invocation has ended.
        const flushOutcome = await flushWithTimeout(stream, options.logger);
        if (flushOutcome.status === 'error' && invocationError === undefined) {
          invocationError = flushOutcome.error;
        } else if (flushOutcome.status === 'timeout') {
          const timeoutError = new Error(
            `Transient stream flush timed out after ${NATIVE_STREAM_FLUSH_TIMEOUT_MS}ms`,
          );
          if (invocationError === undefined) {
            invocationError = timeoutError;
          } else {
            options.logger?.appendLine(
              `[lm-provider:${provider.vendor}] ${timeoutError.message}`,
            );
          }
        }
      }
    } catch (flushError) {
      if (invocationError === undefined) {
        invocationError = flushError;
      } else {
        options.logger?.appendLine(
          `[lm-provider:${provider.vendor}] transient stream flush failed: ${formatError(flushError)}`,
        );
      }
    } finally {
      stream.close();
      runtimeDispose?.();
    }
  }
  if (!runtimeInvalidated && options.runtime && !isRuntimeCurrent(options.runtime)) {
    runtimeInvalidated = true;
  }
  if (runtimeInvalidated) {
    throw new BackendRuntimeChangedError(options.runtime?.instanceKey ?? 'unknown');
  }
  if (invocationError !== undefined) {throw invocationError;}
}

function createProgressStream(
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
): SspStream {
  const sink = progress as unknown as Record<string, unknown>;
  return {
    markdown(value) {
      progress.report(typeof value === 'string'
        ? new vscode.LanguageModelTextPart(value)
        : new vscode.LanguageModelTextPart(value.value));
    },
    progress(value) {
      progress.report(new vscode.LanguageModelTextPart(value));
    },
    push(part) {
      const responsePart = toLanguageModelResponsePart(part);
      if (responsePart) {progress.report(responsePart);}
    },
    thinkingProgress(value) {
      const text = typeof value === 'string' ? value : value.text;
      if (!text) {return;}
      const ThinkingPart = (vscode as typeof vscode & {
        LanguageModelThinkingPart?: new (value: string, id?: string, metadata?: Record<string, unknown>) => vscode.LanguageModelResponsePart2;
      }).LanguageModelThinkingPart;
      if (ThinkingPart) {
        progress.report(new ThinkingPart(
          text,
          typeof value === 'string' ? undefined : value.id,
          typeof value === 'string' ? undefined : value.metadata,
        ));
      } else {
        progress.report(new vscode.LanguageModelTextPart(text));
      }
    },
    beginToolInvocation(toolCallId, toolName, streamData) {
      void toolCallId;
      void streamData;
      progress.report(new vscode.LanguageModelTextPart(`Tool: ${toolName}`));
    },
    updateToolInvocation(toolCallId, streamData) {
      void toolCallId;
      const message = isRecord(streamData) && typeof streamData.invocationMessage === 'string'
        ? streamData.invocationMessage
        : isRecord(streamData) && typeof streamData.pastTenseMessage === 'string'
          ? streamData.pastTenseMessage
          : undefined;
      if (message) {progress.report(new vscode.LanguageModelTextPart(message));}
    },
    reference(value, iconPath) {
      const method = sink.reference;
      if (typeof method === 'function') {method.call(sink, value, iconPath);}
    },
    anchor(value, title) {
      const method = sink.anchor;
      if (typeof method === 'function') {method.call(sink, value, title);}
    },
    button(value) {
      const method = sink.button;
      if (typeof method === 'function') {method.call(sink, value);}
    },
    filetree(value, baseUri) {
      const method = sink.filetree;
      if (typeof method === 'function') {method.call(sink, value, baseUri);}
    },
    externalEdit(_target, callback) {
      // Agent-vendor model calls may still use this SSP external-edit bridge.
      // The ordinary Copilot-vendor path never creates this stream, so its
      // own external-edit implementation remains Copilot-owned.
      // Invoke it synchronously up to its first await. ExternalEditSSP creates
      // its deferred completion gate inside this callback; deferring callback
      // invocation by one microtask allows a fast backend `completed` update to
      // arrive first and leaves that gate unresolvable.
      let callbackResult: Thenable<unknown>;
      try {
        callbackResult = callback();
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(callbackResult)
        .then(() => `native-lm-edit-${Date.now()}`);
    },
    questionCarousel() {
      // A native LM provider cannot present the participant question carousel;
      // QuestionSSP interprets undefined as a skipped/rejected interaction.
      return Promise.resolve(undefined);
    },
  };
}

type FlushOutcome =
  | { status: 'ok' }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

/**
 * Wait for transient SSP metadata/scheduling work for a bounded period.
 * `stream.flush()` may include host interaction promises (for example
 * ExternalEditSSP metadata) that cannot be cancelled by a native LM request.
 */
async function flushWithTimeout(
  stream: TransientSessionStream,
  logger?: BackendChatLogger,
): Promise<FlushOutcome> {
  const flushPromise = Promise.resolve().then(() => stream.flush());
  let timedOut = false;
  // Keep observing a late rejection after timeout so it cannot become an
  // unhandled rejection in the extension host.
  void flushPromise.then(
    () => undefined,
    error => {
      if (timedOut) {
        logger?.appendLine(`[lm-provider] transient stream flush rejected after timeout: ${formatError(error)}`);
      }
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<void | typeof FLUSH_TIMEOUT>([
      flushPromise,
      new Promise<typeof FLUSH_TIMEOUT>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(FLUSH_TIMEOUT);
        }, NATIVE_STREAM_FLUSH_TIMEOUT_MS);
      }),
    ]);
    if (result === FLUSH_TIMEOUT) {
      logger?.appendLine(`[lm-provider] transient stream flush timed out after ${NATIVE_STREAM_FLUSH_TIMEOUT_MS}ms`);
      return { status: 'timeout' };
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', error };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

type LanguageModelResponsePart = vscode.LanguageModelResponsePart2;

function toLanguageModelResponsePart(part: unknown): LanguageModelResponsePart | undefined {
  if (!isRecord(part)) {return undefined;}
  if (part instanceof vscode.LanguageModelTextPart) {
    return part;
  }

  const constructorName = part.constructor?.name;
  if (constructorName === 'LanguageModelThinkingPart'
      || constructorName === 'LanguageModelToolCallPart'
      || constructorName === 'LanguageModelDataPart') {
    return part as unknown as LanguageModelResponsePart;
  }

  // ChatToolInvocationPart is a participant-only UI object. Native LM
  // responses cannot contain it, so preserve the internal tool progress as a
  // legal text response instead of reporting the object across the API.
  if (constructorName === 'ChatToolInvocationPart'
      || (typeof part.toolName === 'string' && typeof part.toolCallId === 'string')) {
    const text = typeof part.pastTenseMessage === 'string'
      ? part.pastTenseMessage
      : typeof part.invocationMessage === 'string'
        ? part.invocationMessage
        : `Tool: ${part.toolName}`;
    return new vscode.LanguageModelTextPart(text);
  }

  if (typeof part.value === 'string') {
    return new vscode.LanguageModelTextPart(part.value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeCurrent(runtime: BackendRuntimeGuard): boolean {
  try {
    return runtime.isCurrent();
  } catch {
    return false;
  }
}

function randomId(): string {
  const cryptoValue = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return cryptoValue?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
