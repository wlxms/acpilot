import * as vscode from 'vscode';
import type { ExtensionState, BackendContext } from '../types';
import { applySessionTitle, isPlaceholderSessionTitle } from './session-title';

// ===========================================================================
// Title Generation via VS Code LM
// ===========================================================================

/**
 * Generate a short, descriptive session title from the first user prompt.
 *
 * This deliberately uses VS Code's language model API only. Backend-specific
 * event streams stay inside the bridge, and backend sessions are not used as a
 * title-generation fallback.
 *
 * @returns The generated title, or `undefined` when VS Code LM is unavailable
 *          or returns an unusable title.
 */
export async function generateSessionTitle(
  firstPrompt: string,
  state: ExtensionState,
): Promise<string | undefined> {
  return generateSessionTitleWithVsCodeLm(firstPrompt, state.outputChannel);
}

export async function generateSessionTitleWithVsCodeLm(
  firstPrompt: string,
  loggerOrState: ExtensionState | { appendLine(message: string): void },
): Promise<string | undefined> {
  const normalized = firstPrompt.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 3) {
    return undefined;
  }

  const logger = 'outputChannel' in loggerOrState ? loggerOrState.outputChannel : loggerOrState;
  const title = await generateTitleWithVsCodeLm(normalized, logger);
  if (title) {
    logger.appendLine(`[title-generator] VS Code LM generated title: "${title}"`);
  }
  return title;
}

export async function generateTitleWithVsCodeLm(
  prompt: string,
  logger: { appendLine(message: string): void },
): Promise<string | undefined> {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  if (!normalizedPrompt || normalizedPrompt.length < 3) {
    return undefined;
  }

  const lm = vscode.lm as unknown as {
    selectChatModels?: (selector?: vscode.LanguageModelChatSelector) => Thenable<vscode.LanguageModelChat[]>;
    languageModelAccessInformation?: { canSendRequest(chat: vscode.LanguageModelChat): boolean | undefined };
  };

  if (typeof lm.selectChatModels !== 'function' || !vscode.LanguageModelChatMessage?.User) {
    return undefined;
  }

  try {
    const allModels = await lm.selectChatModels();
    const model = pickTitleModel(allModels, lm.languageModelAccessInformation);
    if (!model) {
      logger.appendLine('[title-generator] No VS Code LM available for title generation');
      return undefined;
    }

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(buildTitlePrompt(normalizedPrompt))],
      {},
      undefined,
    );

    const text = await collectLmText(response.text);
    const cleaned = cleanGeneratedTitle(text);
    if (!cleaned) {
      logger.appendLine(`[title-generator] VS Code LM unusable response: "${text.slice(0, 80)}"`);
      return undefined;
    }

    return cleaned;
  } catch (err) {
    logger.appendLine(
      `[title-generator] VS Code LM title generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function pickTitleModel(
  models: readonly vscode.LanguageModelChat[],
  access: { canSendRequest(chat: vscode.LanguageModelChat): boolean | undefined } | undefined,
): vscode.LanguageModelChat | undefined {
  const allowed = models.filter((model) =>
    model.vendor === 'copilot' &&
    access?.canSendRequest(model) !== false,
  );
  if (allowed.length === 0) {
    return undefined;
  }

  const score = (model: vscode.LanguageModelChat): number => {
    const haystack = `${model.vendor} ${model.id} ${model.name} ${model.family}`.toLowerCase();
    let value = 0;
    value += 100;
    if (/nano|mini|small|fast|flash|haiku|lite/.test(haystack)) value += 25;
    if (/gpt-4\.1|gpt-4o|gpt-5/.test(haystack)) value += 10;
    return value;
  };

  return [...allowed].sort((a, b) => score(b) - score(a))[0];
}

async function collectLmText(text: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of text) {
    result += chunk;
  }
  return result.trim();
}

/**
 * Fire-and-forget helper used by the `/retitle` command. Calls
 * `generateSessionTitle`, then applies the result to the real session
 * (backend update + sessionMap + sidebar refresh).
 *
 * @returns The generated title, or `undefined` on failure.
 */
export async function retitleSession(
  prompt: string,
  state: ExtensionState,
  ctx: BackendContext,
  backendSessionId: string,
  vscodeSessionId: string,
  directory: string | undefined,
): Promise<string | undefined> {
  const logger = state.outputChannel;
  const llmTitle = await generateSessionTitle(prompt, state);
  if (llmTitle && !isPlaceholderSessionTitle(llmTitle)) {
    await applySessionTitle(state, ctx, {
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

// ===========================================================================
// Prompt construction
// ===========================================================================

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
  const cleaned = raw
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
