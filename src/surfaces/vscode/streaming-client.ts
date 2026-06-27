/**
 * Streaming clients for per-provider LM API calls.
 *
 * Supports: text, reasoning (thinking), and tool calling.
 *
 * @module
 */

import * as vscode from 'vscode';
import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { BackendProviderMeta } from '../../backendmodels/types';

// ===========================================================================
// Types
// ===========================================================================

interface PerProviderCallOptions {
  providerMeta: BackendProviderMeta;
  apiKey: string;
  modelId: string;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
  token: vscode.CancellationToken;
}

// ===========================================================================
// Public API
// ===========================================================================

export async function streamViaProvider(opts: PerProviderCallOptions): Promise<void> {
  const { providerMeta, apiKey, modelId, messages, tools, progress, token } = opts;

  const aiMessages: any[] = [];
  for (const msg of messages) {
    const parts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        const last = parts[parts.length - 1];
        if (last && last.type === 'text') {
          last.text = (last.text ?? '') + '\n' + part.value;
        } else {
          parts.push({ type: 'text', text: part.value });
        }
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        try {
          const raw = part as unknown as { mimeType?: string; value?: Uint8Array };
          const mime = raw.mimeType ?? 'image/png';
          const base64 = Buffer.from(raw.value ?? new Uint8Array(0)).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
        } catch { /* skip */ }
      }
    }
    if (parts.length > 0) {
      aiMessages.push({
        role: msg.role === 1 ? 'user' : 'assistant',
        content: parts.length === 1 && parts[0].type === 'text' ? (parts[0].text ?? '') : parts,
      });
    }
  }

  const abortController = new AbortController();
  token.onCancellationRequested(() => abortController.abort());

  // Convert VS Code tools → AI SDK tools
  const aiTools = convertTools(tools) as any;

  // ── OpenCode Zen: multi-endpoint routing by apiMode ──
  if (providerMeta.id === 'opencode' || providerMeta.id === 'opencode-zen') {
    const key = apiKey || 'public';
    if (modelId.startsWith('claude-')) {
      await doStreamAnthropic(key, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
    } else if (modelId.startsWith('gpt-')) {
      await streamOpenCodeResponses(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    } else if (modelId.startsWith('gemini-')) {
      await streamOpenCodeGemini(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    } else if (getZenModelConfig(modelId).apiMode === 'anthropic') {
      // Anthropic Messages API format — structured thinking blocks
      await streamOpenCodeAnthropic(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    } else {
      // OpenAI Chat Completions format — delta.reasoning_content
      await streamOpenCodeOAI(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    }
    return;
  }

  // ── Standard routing by npm ──
  const npm = providerMeta.npm;
  if (npm.includes('@ai-sdk/anthropic')) {
    await doStreamAnthropic(apiKey, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
  } else if (npm.includes('@ai-sdk/openai') && !npm.includes('compatible')) {
    await doStreamOpenAI(apiKey, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
  } else if (npm.includes('@ai-sdk/google')) {
    await doStreamGoogle(apiKey, modelId, aiMessages, aiTools, progress, abortController);
  } else {
    await doStreamOAICompat(apiKey, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
  }
}

// ===========================================================================
// Tool conversion
// ===========================================================================

function convertTools(tools?: readonly vscode.LanguageModelChatTool[]): Record<string, unknown> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const result: Record<string, unknown> = {};
  for (const t of tools) {
    result[t.name] = {
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ===========================================================================
// Stream → VS Code progress (handles text + reasoning + tool calls)
// ===========================================================================

async function streamResultToProgress(
  result: Awaited<ReturnType<typeof streamText>>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): Promise<void> {
  let hadContent = false;

  // Stream reasoning text when available (non-streaming — full text after completion)
  try {
    const reasoning = await result.reasoningText;
    if (reasoning) {
      const id = `reason-${Date.now()}`;
      progress.report(new vscode.LanguageModelThinkingPart(reasoning, id));
      progress.report(new vscode.LanguageModelThinkingPart('', id, { vscode_reasoning_done: true } as any));
      hadContent = true;
    }
  } catch { /* model may not support reasoning */ }

  // Stream text content
  try {
    for await (const chunk of result.textStream) {
      progress.report(new vscode.LanguageModelTextPart(chunk));
      hadContent = true;
    }
  } catch (err) {
    if (!hadContent) throw err;
  }

  // Report tool calls (after full response)
  try {
    const toolCalls = await result.toolCalls;
    for (const tc of toolCalls) {
      const input = (tc as unknown as { input?: Record<string, unknown> }).input
        ?? (tc as unknown as { args?: Record<string, unknown> }).args
        ?? {};
      progress.report(new vscode.LanguageModelToolCallPart(
        tc.toolCallId,
        tc.toolName,
        input,
      ));
    }
  } catch { /* tool calls may error */ }
}

// ===========================================================================
// OpenCode Zen model config — per-model apiMode and thinking mode
// ===========================================================================
// Based on opencode-go-copilot's zenModels.ts reference.
// apiMode determines which endpoint and wire format to use:
//   "openai"    → /zen/v1/chat/completions (delta.reasoning_content)
//   "anthropic" → /zen/v1/messages (Anthropic SSE with thinking blocks)

type ZenApiMode = 'openai' | 'anthropic';

interface ZenModelConfig {
  apiMode: ZenApiMode;
  thinkingMode?: 'always' | 'switchable' | 'adaptive';
  vision?: boolean;
}

const ZEN_MODEL_CONFIGS: Record<string, ZenModelConfig> = {
  'big-pickle':              { apiMode: 'openai',    thinkingMode: 'always' },
  'deepseek-v4-flash-free':  { apiMode: 'openai',    thinkingMode: 'switchable' },
  'mimo-v2.5-free':          { apiMode: 'openai',    thinkingMode: 'switchable' },
  'minimax-m3-free':         { apiMode: 'anthropic', thinkingMode: 'adaptive', vision: true },
  'nemotron-3-super-free':   { apiMode: 'openai',    thinkingMode: 'switchable' },
};

function getZenModelConfig(modelId: string): ZenModelConfig {
  return ZEN_MODEL_CONFIGS[modelId] ?? { apiMode: 'openai' };
}

// Change all internal function signatures to accept `any` for messages
// (handles both plain-text and multimodal content arrays)

async function doStreamOAICompat(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createOpenAICompatible({ apiKey, baseURL, name: 'acp' });
  const result = streamText({
    model: provider.chatModel(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

async function doStreamAnthropic(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createAnthropic({ apiKey, baseURL });
  const result = streamText({
    model: provider(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

async function doStreamOpenAI(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createOpenAI({ apiKey, baseURL });
  const result = streamText({
    model: provider(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

async function doStreamGoogle(
  apiKey: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createGoogleGenerativeAI({ apiKey });
  const result = streamText({
    model: provider(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

// ===========================================================================
// OpenCode Zen custom routes (raw fetch)
// ===========================================================================

/**
 * OpenAI-compatible Chat Completions endpoint for OpenCode Zen.
 * Uses raw fetch to avoid AI SDK compatibility issues with the "public" auth.
 */
async function streamOpenCodeOAI(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
  abortController: AbortController,
) {
  // Convert messages: OpenAI Chat Completions expects string content.
  // VS Code roles: 1=User, 2=Assistant. Map to OAI strings.
  const flatMessages: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    let role: string;
    const r = m.role as number;
    if (r === 1) role = 'user';
    else if (r === 2) role = 'assistant';
    else if (r === 0) role = 'system';
    else role = 'user';

    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
          ? m.content
              .map((p: any) => p.type === 'text' ? (p.text ?? '') : `[${p.type}]`)
              .join('\n')
          : String(m.content ?? ''));

    if (content) {
      flatMessages.push({ role, content });
    }
  }

  const body = JSON.stringify({
    model: modelId,
    messages: flatMessages,
    stream: true,
  });

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: abortController.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Zen /chat/completions ${response.status}: ${errText.slice(0, 400)}`);
  }

  // Parse SSE stream using structured delta fields.
  // Zen gateway follows standard OpenAI Chat Completions SSE format.
  //
  // KEY FINDING from integration tests:
  //   Free Zen models (deepseek-v4-flash-free, big-pickle, etc.)
  //   put ALL output in delta.reasoning_content and NONE in delta.content.
  //   Paid models (Claude, GPT-4) put thinking in reasoning_content
  //   and final text in delta.content.
  //
  // Strategy: track whether we ever see delta.content. If we do,
  // treat reasoning_content as thinking blocks. If we don't (stream end),
  // flush all reasoning_content as text output.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let rawBuffer = '';
  let thinkingActive = false;
  let thinkingId: string | undefined;
  let textBuffer = '';
  let sawContent = false;          // Did we ever see delta.content with text?
  let reasoningBuffer = '';        // Accumulated reasoning if content hasn't appeared yet
  let hasFlushedReasoning = false; // Whether we've promoted reasoning→text

  // Debounced thinking flush (from opencode-go-copilot reference)
  let thinkingFlushBuffer = '';    // Buffer for thinking chunks after content mode determined
  let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // Tool call accumulator: map index → accumulated call state
  const toolCallAccs = new Map<number, { id: string; name: string; args: string; emitted: boolean }>();

  function flushText() {
    if (textBuffer) {
      progress.report(new vscode.LanguageModelTextPart(textBuffer));
      textBuffer = '';
    }
  }

  /** Flush debounced thinking buffer to VS Code (called by timer or explicitly) */
  function flushThinkingBuffer() {
    if (thinkingFlushTimer) {
      clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = null;
    }
    if (thinkingFlushBuffer && thinkingId) {
      progress.report(new vscode.LanguageModelThinkingPart(thinkingFlushBuffer, thinkingId));
      thinkingFlushBuffer = '';
    }
  }

  /** Buffer thinking content and schedule a debounced flush (100ms debounce like opencode-go-copilot) */
  function bufferThinkingChunk(text: string) {
    thinkingFlushBuffer += text;
    if (!thinkingFlushTimer) {
      thinkingFlushTimer = setTimeout(() => flushThinkingBuffer(), 100);
    }
  }

  /** Flush all pending thinking and clear timer state */
  function flushAllThinking() {
    flushThinkingBuffer();
    if (thinkingFlushTimer) {
      clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = null;
    }
  }

  /** Promote all buffered reasoning to text output (used when no delta.content ever appears) */
  function flushReasoningAsText() {
    if (reasoningBuffer && !hasFlushedReasoning) {
      hasFlushedReasoning = true;
      progress.report(new vscode.LanguageModelTextPart(reasoningBuffer));
      reasoningBuffer = '';
    }
  }

  function startThinking() {
    flushText();
    // If we had buffered reasoning, convert it to thinking block now
    if (reasoningBuffer) {
      const id = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      progress.report(new vscode.LanguageModelThinkingPart(reasoningBuffer, id));
      reasoningBuffer = '';
      thinkingId = id;
      thinkingActive = true;
    } else {
      thinkingId = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      thinkingActive = true;
    }
  }

  function endThinking() {
    flushAllThinking();
    if (thinkingActive) {
      progress.report(new vscode.LanguageModelThinkingPart('', thinkingId, { vscode_reasoning_done: true } as any));
      thinkingActive = false;
      thinkingId = undefined;
    }
  }

  function emitToolCalls() {
    for (const [, acc] of toolCallAccs) {
      if (!acc.emitted) {
        acc.emitted = true;
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(acc.args || '{}'); } catch { /* keep empty */ }
        progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, parsed));
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });

      const lines = rawBuffer.split('\n');
      rawBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          // Stream ended — flush remaining state
          // If we never saw delta.content, reasoning IS the text
          if (!sawContent) flushReasoningAsText();
          else endThinking();
          flushText();
          emitToolCalls();
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          // ── Reasoning / thinking ──
          // Detection chain (from opencode-go-copilot reference):
          //   choice.thinking → delta.thinking → delta.reasoning → delta.reasoning_content
          const rawThinking =
            (choice as Record<string, unknown> | undefined)?.thinking ??
            (delta as Record<string, unknown> | undefined)?.thinking ??
            (delta as Record<string, unknown> | undefined)?.reasoning ??
            delta.reasoning_content;
          const reasoning = typeof rawThinking === 'string' ? rawThinking
            : (rawThinking && typeof rawThinking === 'object')
              ? String((rawThinking as Record<string, string>)['text'] ?? JSON.stringify(rawThinking))
              : undefined;
          const content = delta.content;

          // ── Content appears → we're in "split" mode ──
          if (typeof content === 'string' && content.length > 0) {
            sawContent = true;
            // Content appeared after reasoning → flush reasoning as thinking block
            if (!hasFlushedReasoning && reasoningBuffer) {
              // Create thinking block from buffered reasoning
              const id = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              progress.report(new vscode.LanguageModelThinkingPart(reasoningBuffer, id));
              progress.report(new vscode.LanguageModelThinkingPart('', id, { vscode_reasoning_done: true } as any));
              reasoningBuffer = '';
              hasFlushedReasoning = true;
            }
            endThinking();
            textBuffer += content;
            flushText();
            continue;
          }

          // ── Reasoning content (no content seen yet) ──
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            if (sawContent) {
              // We're in split mode — buffer and flush with debounce (like opencode-go-copilot)
              if (!thinkingActive) startThinking();
              bufferThinkingChunk(reasoning);
            } else {
              // Don't know yet if this is thinking or text — buffer it
              reasoningBuffer += reasoning;
            }
            continue;
          }

          // ── Tool calls ──
          if (delta.tool_calls) {
            if (!sawContent) {
              // Tool call arrived before any content → reasoning WAS the text
              flushReasoningAsText();
            } else {
              endThinking();
            }
            flushText();
            for (const tc of delta.tool_calls) {
              if (!tc.function) continue;
              const idx = tc.index ?? 0;
              let acc = toolCallAccs.get(idx);
              if (!acc) {
                acc = { id: tc.id ?? '', name: '', args: '', emitted: false };
                toolCallAccs.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function.name) acc.name = tc.function.name;
              if (tc.function.arguments) acc.args += tc.function.arguments;
            }
          }
        } catch { /* skip malformed JSON */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Stream ended without [DONE] — flush remaining state
  if (!sawContent) flushReasoningAsText();
  else endThinking();
  flushText();
  emitToolCalls();
}

// ===========================================================================
// SSE streaming utility
// ===========================================================================

/**
 * Read an SSE stream line by line, calling onData for each `data: ...` line.
 * Returns when [DONE] is received or the stream ends.
 */
async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          onData(data);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch and stream the /responses endpoint.
 * OpenAI Responses API format: { delta?: string, content?: Array<{type, text}> }
 */
async function streamOpenCodeResponses(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const lastMsg = messages[messages.length - 1]?.content ?? '';
  const resp = await fetch(`${baseURL}/responses`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, input: lastMsg, stream: true }),
    signal: abortController.signal,
  });
  if (!resp.ok) throw new Error(`OpenCode GPT /responses returned ${resp.status}`);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  await readSSEStream(reader, (data) => {
    try {
      const d = JSON.parse(data);
      if (d.delta) progress.report(new vscode.LanguageModelTextPart(d.delta));
      if (Array.isArray(d.content)) {
        for (const p of d.content) {
          if (p.type === 'output_text' && p.text) progress.report(new vscode.LanguageModelTextPart(p.text));
        }
      }
    } catch { /* skip */ }
  });
}

/**
 * Fetch and stream the Gemini-compatible endpoint.
 * Google SSE format: { candidates: [{ content: { parts: [{ text }] } }] }
 */
async function streamOpenCodeGemini(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const body = JSON.stringify({
    contents: messages.map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    })),
  });
  const resp = await fetch(`${baseURL}/models/${modelId}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: abortController.signal,
  });
  if (!resp.ok) throw new Error(`OpenCode Gemini returned ${resp.status}`);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  await readSSEStream(reader, (data) => {
    try {
      const d = JSON.parse(data);
      const parts = d.candidates?.[0]?.content?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) progress.report(new vscode.LanguageModelTextPart(p.text));
        }
      }
    } catch { /* skip */ }
  });
}

// ===========================================================================
// Anthropic Messages API streaming for Zen models with apiMode: "anthropic"
// ===========================================================================
//
// SSE event format:
//   event: content_block_start
//   data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"..."}}
//
//   event: content_block_delta
//   data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}
//
//   event: content_block_stop
//   data: {"type":"content_block_stop","index":0}
//
//   event: content_block_start
//   data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}
//
// Thinking blocks are properly structured (not XML tags), and signature_delta can be ignored.
// ===========================================================================

/**
 * Header used for Anthropic Messages API calls to Zen gateway.
 * Models like minimax-m3-free use apiMode: "anthropic" and require this format.
 */
async function streamOpenCodeAnthropic(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  // Convert messages from aiMessages format to Anthropic format.
  // aiMessages roles are already strings ('user'/'assistant') from streamViaProvider,
  // but content may be string or array — flatten to string for Anthropic.
  const anthropicMessages: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    const role = typeof m.role === 'number' ? (m.role === 1 ? 'user' : 'assistant') : (m.role || 'user');
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
          ? m.content.map((p: any) => p.type === 'text' ? (p.text ?? '') : '').join('\n').trim()
          : String(m.content ?? ''));
    if (content) {
      anthropicMessages.push({ role, content });
    }
  }

  const resp = await fetch(`${baseURL}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      messages: anthropicMessages,
      stream: true,
    }),
    signal: abortController.signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Zen /messages ${resp.status}: ${errText.slice(0, 400)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let rawBuffer = '';
  let currentEvent = '';
  let thinkingId: string | undefined;
  let thinkingActive = false;
  let thinkingFlushBuffer = '';
  let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let textBuffer = '';

  // Debounced thinking flush (same pattern as streamOpenCodeOAI)
  function flushThinkingBuffer() {
    if (thinkingFlushTimer) clearTimeout(thinkingFlushTimer);
    thinkingFlushTimer = null;
    if (thinkingFlushBuffer && thinkingId) {
      progress.report(new vscode.LanguageModelThinkingPart(thinkingFlushBuffer, thinkingId));
      thinkingFlushBuffer = '';
    }
  }

  function bufferThinking(text: string) {
    thinkingFlushBuffer += text;
    if (!thinkingFlushTimer) {
      thinkingFlushTimer = setTimeout(() => flushThinkingBuffer(), 100);
    }
  }

  function flushAllThinking() {
    flushThinkingBuffer();
    if (thinkingFlushTimer) clearTimeout(thinkingFlushTimer);
    thinkingFlushTimer = null;
  }

  function flushText() {
    if (textBuffer) {
      progress.report(new vscode.LanguageModelTextPart(textBuffer));
      textBuffer = '';
    }
  }

  function endThinking() {
    flushAllThinking();
    if (thinkingActive) {
      progress.report(new vscode.LanguageModelThinkingPart('', thinkingId, { vscode_reasoning_done: true } as any));
      thinkingActive = false;
      thinkingId = undefined;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });

      const lines = rawBuffer.split('\n');
      rawBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7);
          continue;
        }

        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const eventType = parsed.type ?? currentEvent;

          switch (eventType) {
            case 'content_block_start': {
              const block = parsed.content_block as Record<string, unknown> | undefined;
              if (block?.type === 'thinking') {
                // Thinking block begins
                flushText();
                thinkingId = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                thinkingActive = true;
                // Initial empty thinking string — skip
              } else if (block?.type === 'text') {
                // Text block begins after thinking
                endThinking();
              }
              break;
            }

            case 'content_block_delta': {
              const delta = parsed.delta as Record<string, unknown> | undefined;
              if (!delta) break;
              if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                bufferThinking(delta.thinking);
              } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                textBuffer += delta.text;
                flushText();
              }
              // signature_delta → ignore
              break;
            }

            case 'content_block_stop': {
              // End of current block — handled by the next content_block_start
              break;
            }

            case 'message_start':
            case 'ping':
              // No action needed
              break;

            case 'message_delta':
            case 'message_stop':
              // Stream ending
              break;
          }
        } catch { /* skip malformed JSON */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Stream ended
  endThinking();
  flushText();
}
