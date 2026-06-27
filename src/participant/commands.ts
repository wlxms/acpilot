import * as vscode from 'vscode';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync, exec } from 'child_process';
import type { ExtensionState, BackendContext } from '../types';
import type {
  ChatToolResourcesInvocationData,
  ChatTerminalToolInvocationData,
  ChatSimpleToolResultData,
  ChatToolInvocationPart,
  ChatSubagentToolInvocationData,
} from '../types/vscode-proposed-additions';
import { ChatQuestion, ChatQuestionType } from '../types/vscode-proposed-additions';
import { ErrorMessages } from './errors';
import { ensureServer } from './handler';
import type {
  MessagePartDeltaEvent,
  OpenCodeEvent,
  OpenCodeStreamEvent,
  PermissionAskedEvent,
  SessionDiffEvent,
} from '../backends/opencode/sdk-events';

// Minimal inline tracker for diagnostic commands (replaces deleted ExternalEditTracker)
class DiagnosticEditTracker {
  private _edits = new Map<string, { resolve: () => void; onDidComplete: Thenable<string> }>();
  hasEdit(key: string) { return this._edits.has(key); }
  isTrackingAny(_uris: unknown[]) { return this._edits.size > 0; }
  trackEdit(key: string, uris: vscode.Uri[], stream: unknown): Promise<void> {
    const s = stream as { externalEdit?: (t: unknown, cb: () => Thenable<unknown>) => Thenable<string> };
    if (!s.externalEdit) return Promise.resolve();
    return new Promise(resolve => {
      let r: () => void = () => {};
      const deferred = new Promise<void>(res => { r = res; });
      const cb = async () => { resolve(); await deferred; };
      this._edits.set(key, { resolve: r, onDidComplete: s.externalEdit!(uris, cb) });
    });
  }
  completeEdit(key: string): Thenable<string> | undefined {
    const e = this._edits.get(key);
    if (!e) return undefined;
    this._edits.delete(key);
    e.resolve();
    return e.onDidComplete;
  }
  dispose() { for (const e of this._edits.values()) e.resolve(); this._edits.clear(); }
}

function unwrapOpenCodeEvent(rawEvent: unknown): OpenCodeEvent | undefined {
  if (!rawEvent || typeof rawEvent !== 'object') return undefined;
  const maybeEnvelope = rawEvent as Partial<OpenCodeStreamEvent> & { payload?: OpenCodeEvent };
  if (maybeEnvelope.payload) return maybeEnvelope.payload;
  if (typeof (rawEvent as { type?: unknown }).type === 'string') {
    return rawEvent as OpenCodeEvent;
  }
  return undefined;
}

async function* readOpenCodeEvents(stream: AsyncIterable<unknown>): AsyncIterable<OpenCodeEvent> {
  for await (const rawEvent of stream) {
    const event = unwrapOpenCodeEvent(rawEvent);
    if (event) yield event;
  }
}

export async function routeCommand(
  command: string,
  state: ExtensionState,
  ctx: BackendContext,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  switch (command.toLowerCase()) {
    case 'new':
      await handleNewCommand(state, ctx, stream);
      break;
    case 'help':
      handleHelpCommand(stream);
      break;
    case 'model':
      await handleModelCommand(state, ctx, stream);
      break;
    case 'test-external-edit':
      await handleTestExternalEditCommand(state, ctx, stream, _token);
      break;
    case 'test-external-edit-real':
      await handleTestExternalEditRealCommand(state, ctx, stream, _token);
      break;
    case 'test-external-edit-e2e':
      await handleTestExternalEditE2ECommand(state, ctx, stream, _token);
      break;
    case 'test-subagent-single-blocking':
      await handleTestSubagentSingleBlockingCommand(stream, _token);
      break;
    case 'test-subagent-multi-blocking':
      await handleTestSubagentMultiBlockingCommand(stream, _token);
      break;
    case 'test-subagent-single-parallel':
      await handleTestSubagentSingleParallelCommand(stream, _token);
      break;
    case 'test-subagent-multi-parallel':
      await handleTestSubagentMultiParallelCommand(stream, _token);
      break;
    case 'test-file-read-stream':
      await handleTestFileReadStreamCommand(stream, _token);
      break;
    case 'test-stream-latency':
      await handleTestStreamLatencyCommand(state, ctx, stream, _token);
      break;
    case 'test-thinking':
      await handleTestThinkingCommand(stream, _token);
      break;
    case 'test-question':
      await handleTestQuestionCommand(stream, _token);
      break;
    default:
      stream.markdown(
        `⚠️ Unknown command '/${command}'. Use **/help** to see available commands.`,
      );
  }
  return { metadata: {} };
}

async function handleNewCommand(
  state: ExtensionState,
  ctx: BackendContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const ready = await ensureServer(state, ctx, stream);
  if (!ready) {return;}
  try {
    const result = await ctx.backend.sessions.create();
    const sessionId = result.data?.id;
    if (!sessionId) {
      throw new Error('Session not created');
    }
    stream.markdown('🆕 Started a new conversation session.');
    state.outputChannel.appendLine(`[commands] New session: ${sessionId}`);
  } catch {
    stream.markdown(ErrorMessages.SESSION_ERROR);
  }
}

function handleHelpCommand(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    [
      '## Available Commands',
      '',
      '- **/new** — Start a new conversation session',
      '- **/help** — Show this help message',
      '- **/model** — Show the current active model',
      '- **/test-external-edit** — Test externalEdit bubble push (VSCode API)',
      '- **/test-external-edit-real** — Test externalEdit with direct disk write (simulates server)',
      '- **/test-external-edit-e2e** — End-to-end test via real OpenCode prompt',
      '- **/test-subagent-single-blocking** — Single subagent, blocking',
      '- **/test-subagent-multi-blocking** — Multi subagent, sequential blocking',
      '- **/test-subagent-single-parallel** — Single subagent, parallel/callback',
      '- **/test-subagent-multi-parallel** — Multi subagent, all parallel',
      '- **/test-file-read-stream** — Run file-bubble lifecycle experiment matrix',
      '- **/test-stream-latency** — Measure streaming delta latency from backend (batch detection + timing)',
      '- **/test-thinking** — Diagnostic: verify thinkingProgress API and reasoning/text boundary rendering',
      '- **/test-question** — Test questionCarousel UI flow',
      '',
      'Just type your message to chat with OpenCode!',
    ].join('\n'),
  );
}

async function handleModelCommand(
  state: ExtensionState,
  ctx: BackendContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const ready = await ensureServer(state, ctx, stream);
  if (!ready) {return;}
  try {
    const modelsResp = await ctx.backend.config.models();
    const modelList = modelsResp.data ?? [];
    if (modelList.length > 0) {
      const lines: string[] = ['## Available Models', ''];
      const grouped = new Map<string, Array<{ id: string; name?: string }>>();
      for (const model of modelList) {
        const provider = model.provider ?? 'unknown';
        const existing = grouped.get(provider) ?? [];
        existing.push({ id: model.id, name: model.name });
        grouped.set(provider, existing);
      }
      for (const [provider, models] of grouped) {
        lines.push(`**${provider}**:`);
        for (const model of models) {
          lines.push(`  - \`${model.id}\`${model.name ? ` — ${model.name}` : ''}`);
        }
      }
      stream.markdown(lines.join('\n'));
    } else {
      stream.markdown('No providers configured.');
    }
  } catch {
    stream.markdown('Unable to retrieve model information.');
  }
}

/**
 * Test command: simulates an externalEdit lifecycle to verify bubble pushing.
 *
 * Creates a temporary file, starts stream.externalEdit tracking,
 * writes content to the file (simulating an external edit), then completes
 * the edit. Cleans up the temp file afterwards.
 */
async function handleTestExternalEditCommand(
  state: ExtensionState,
  _ctx: BackendContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open. Open a folder and try again.');
    return;
  }

  const tracker = new DiagnosticEditTracker();
  const editKey = `test-${Date.now()}`;
  const tmpPath = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    `.opencode-external-edit-test-${Date.now()}.tmp`,
  );

  stream.markdown(`🧪 **Testing externalEdit bubble push...**\n\n`);
  stream.markdown(`Temporary file: \`${tmpPath.fsPath}\`\n\n`);

  try {
    // 1. Create the temp file so it exists on disk (baseline capture needs this)
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tmpPath, encoder.encode('// original content\n'));

    // 2. Push the externalEdit bubble
    stream.markdown('📤 Starting `stream.externalEdit` tracking...\n\n');

    const trackPromise = tracker.trackEdit(editKey, [tmpPath], stream);
    await trackPromise;

    stream.markdown('✅ `trackEdit` resolved — baseline captured by VSCode.\n\n');

    // 3. Simulate an external edit: modify the file content
    stream.markdown('✏️ Simulating external edit (writing new content)...\n\n');
    await vscode.workspace.fs.writeFile(tmpPath, encoder.encode('// modified by externalEdit test\n'));

    // 4. Complete the edit — VSCode will snapshot the diff
    const result = tracker.completeEdit(editKey);
    if (result) {
      const undoStopId = await result;
      stream.markdown(
        `✅ ` +
        `\`completeEdit\` resolved — undoStopId: \`${undoStopId || '(empty)'}\`\n\n`,
      );
    } else {
      stream.markdown('⚠️ `completeEdit` returned undefined — edit may not have been tracked.\n\n');
    }

    stream.markdown(
      '**Result:** externalEdit bubble lifecycle completed successfully. ' +
      'Check the chat UI above for the edit checkpoint bubble.\n',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ **Error:** ${msg}\n`);
    stream.markdown(
      '\nThe externalEdit API may not be available in this VSCode version. ' +
      'Ensure `chatParticipantAdditions` proposal is enabled.\n',
    );
  } finally {
    // 5. Cleanup temp file
    try {
      await vscode.workspace.fs.delete(tmpPath);
    } catch {
      // best effort
    }
    tracker.dispose();
  }

  state.outputChannel.appendLine('[commands] test-external-edit completed');
}

// ---------------------------------------------------------------------------
// /test-external-edit-real — simulate server-side disk write + timing analysis
// ---------------------------------------------------------------------------

/** Read file content from disk via Node fs (bypasses VSCode entry model) */
function readDiskContent(fsPath: string): string {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    return readFileSync(fsPath, 'utf-8');
  } catch {
    return '(read failed)';
  }
}

/** Read file content as VSCode sees it (through text document model) */
function readVscodeModelContent(uri: vscode.Uri): string {
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  return doc ? doc.getText() : '(not in VSCode model)';
}

/**
 * Wait for VSCode's file watcher to detect a change on disk for the given URI.
 * Returns true if detected within timeout, false otherwise.
 * This is the "sync lock" — ensures VSCode's entry model is up-to-date.
 */
function waitForVscodeFileChange(uri: vscode.Uri, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const done = (result: boolean) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      sub.dispose();
      resolve(result);
    };

    const timer = setTimeout(() => { done(false); }, timeoutMs);

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === uri.toString()) {
        done(true);
      }
    });

    // Also watch for file system changes (file may not be open as text doc)
    const fsWatcher = vscode.workspace.createFileSystemWatcher(uri.fsPath);
    fsWatcher.onDidChange(() => { done(true); });
  });
}

/**
 * Test command: simulates the REAL OpenCode server flow.
 *
 * Key difference from /test-external-edit:
 *   - Uses Node.js `fs.writeFileSync` (direct disk write) instead of
 *     `vscode.workspace.fs.writeFile` (which updates VSCode's entry model
 *     immediately).
 *   - Runs TWO rounds: immediate completeEdit vs delayed completeEdit,
 *     to diagnose whether VSCode's file watcher has time to detect the
 *     external change before diff capture.
 *
 * Usage: @opencode /test-external-edit-real [delay_ms]
 *   delay_ms: milliseconds to wait before completeEdit (default: 0)
 */
async function handleTestExternalEditRealCommand(
  state: ExtensionState,
  _ctx: BackendContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open. Open a folder and try again.');
    return;
  }

  // Parse optional delay from... we use a fixed 2-round test
  const ROUND1_LABEL = 'Round 1: fs.writeFileSync + immediate completeEdit';
  const ROUND2_LABEL = 'Round 2: fs.writeFileSync + 500ms delayed completeEdit';
  const ROUND3_LABEL = 'Round 3: powershell write + immediate completeEdit';
  const ROUND4_LABEL = 'Round 4: node child process + immediate completeEdit';
  const ROUND5_LABEL = 'Round 5: async child process + waitForSync completeEdit';

  const tmpDir = workspaceFolders[0].uri;

  // ── Helpers ─────────────────────────────────────────────────────────

  function tmpFileUri(tag: string) {
    return vscode.Uri.joinPath(tmpDir, `.ext-edit-real-${tag}-${Date.now()}.tmp`);
  }

  async function runRound(
    label: string,
    delayMs: number,
    roundStream: vscode.ChatResponseStream,
    writeMethod: 'fs' | 'cmd' | 'powershell' | 'async' = 'fs',
  ): Promise<void> {
    const tracker = new DiagnosticEditTracker();
    const editKey = `round-${Date.now()}`;
    const tag = `${writeMethod}-d${delayMs}`;
    const uri = tmpFileUri(tag);
    const fsPath = uri.fsPath;
    const original = '// original content\n';
    const methodLabel = writeMethod === 'async' ? 'async child process + waitForSync'
      : writeMethod === 'powershell' ? 'powershell'
      : writeMethod === 'cmd' ? 'node -e (child process)'
      : 'fs.writeFileSync';
    const modified = `// MODIFIED by ${methodLabel}\n`;

    roundStream.markdown(`### ${label}\n\n`);
    roundStream.markdown(`File: \`${fsPath}\`\n\n`);

    try {
      // 1. Create file
      writeFileSync(fsPath, original, 'utf-8');
      roundStream.markdown(`1️⃣ File created on disk: \`${original.trim()}\`\n\n`);
      roundStream.markdown(
        `   VSCode model: \`${readVscodeModelContent(uri).trim()}\`\n\n`,
      );

      // 2. Push externalEdit bubble
      roundStream.markdown('2️⃣ Starting `stream.externalEdit` tracking...\n\n');

      const trackPromise = tracker.trackEdit(editKey, [uri], roundStream);
      await trackPromise;
      roundStream.markdown('   ✅ `trackEdit` resolved — baseline captured.\n\n');

      // 3. Modify file — via fs, powershell, cmd child process, or async
      if (writeMethod === 'async') {
        // --- ASYNC FLOW: spawn child process + wait for VSCode sync ---

        // 3a. Set up close listener BEFORE spawning (avoids race condition)
        const b64 = Buffer.from(modified, 'utf-8').toString('base64');
        const escaped = fsPath.replace(/\\/g, '\\\\');
        const child = exec(
          `node -e "require('fs').writeFileSync('${escaped}', Buffer.from('${b64}','base64'))"`,
          { windowsHide: true },
        );
        const childExitPromise = new Promise<void>((resolve) => {
          child.on('close', () => { resolve(); });
          child.on('error', () => { resolve(); });
        });

        roundStream.markdown(
          `3️⃣ Async child process spawned — waiting for VSCode file watcher sync...\n\n`,
        );

        // 3b. Start sync lock: wait for VSCode file watcher OR child exit
        const syncResult = await waitForVscodeFileChange(uri, 2000);
        roundStream.markdown(
          syncResult
            ? `   ✅ VSCode detected file change (sync lock released).\n\n`
            : `   ⚠️ Sync lock timed out after 2000ms — VSCode did not detect change.\n\n`,
        );

        // 3c. Ensure child process has fully exited (listener was attached before spawn)
        await childExitPromise;

        const diskContent = readDiskContent(fsPath);
        const vscodeContent = readVscodeModelContent(uri);
        roundStream.markdown(
          `   Disk:  \`${diskContent.trim()}\`\n` +
          `   Model: \`${vscodeContent.trim()}\`\n\n`,
        );
      } else if (writeMethod === 'powershell') {
        const b64 = Buffer.from(modified, 'utf-8').toString('base64');
        execSync(
          `powershell -NoProfile -Command "[System.IO.File]::WriteAllBytes('${fsPath}', [System.Convert]::FromBase64String('${b64}'))"`,
          { windowsHide: true },
        );
        roundStream.markdown(
          `3️⃣ File modified via \`powershell\`: \`${original.trim()}\` → \`${modified.trim()}\`\n\n`,
        );
      } else if (writeMethod === 'cmd') {
        // Spawn a separate node process to write — simulates server process
        const b64 = Buffer.from(modified, 'utf-8').toString('base64');
        execSync(
          `node -e "require('fs').writeFileSync('${fsPath.replace(/\\/g, '\\\\')}', Buffer.from('${b64}','base64'))"`,
          { windowsHide: true },
        );
        roundStream.markdown(
          `3️⃣ File modified via \`node -e\` (child process): \`${original.trim()}\` → \`${modified.trim()}\`\n\n`,
        );
      } else {
        writeFileSync(fsPath, modified, 'utf-8');
        roundStream.markdown(
          `3️⃣ Direct disk write: \`${original.trim()}\` → \`${modified.trim()}\`\n\n`,
        );
      }

      // Snapshot: what's actually on disk vs what VSCode thinks
      const diskContent = readDiskContent(fsPath);
      const vscodeContent = readVscodeModelContent(uri);
      roundStream.markdown(
        `   Disk content:  \`${diskContent.trim()}\`\n` +
        `   VSCode model:  \`${vscodeContent.trim()}\`\n\n`,
      );

      // 4. Wait the specified delay
      if (delayMs > 0) {
        roundStream.markdown(`4️⃣ Waiting ${delayMs}ms for VSCode file watcher...\n\n`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          token.onCancellationRequested(() => {
            clearTimeout(timer);
            resolve();
          });
        });

        const vscodeAfterWait = readVscodeModelContent(uri);
        roundStream.markdown(
          `   After wait — VSCode model: \`${vscodeAfterWait.trim()}\`\n\n`,
        );
      }

      // 5. Complete the edit
      roundStream.markdown(`5️⃣ Calling \`completeEdit\`...\n\n`);
      const result = tracker.completeEdit(editKey);
      if (result) {
        const t0 = Date.now();
        const undoStopId = await result;
        const elapsed = Date.now() - t0;
        roundStream.markdown(
          `   ✅ \`completeEdit\` resolved in ${elapsed}ms — undoStopId: \`${undoStopId || '(empty)'}\`\n\n`,
        );

        // Final snapshot
        const finalVscode = readVscodeModelContent(uri);
        const finalDisk = readDiskContent(fsPath);
        roundStream.markdown(
          `   Final VSCode model: \`${finalVscode.trim()}\`\n` +
          `   Final disk content: \`${finalDisk.trim()}\`\n\n`,
        );

        if (undoStopId) {
          roundStream.markdown(
            '**✅ VERDICT:** Bubble pushed with undoStopId — VSCode captured the diff.\n\n',
          );
        } else {
          roundStream.markdown(
            '**⚠️ VERDICT:** undoStopId is empty — VSCode may not have captured the diff.\n\n',
          );
        }
      } else {
        roundStream.markdown(
          '   ⚠️ `completeEdit` returned undefined — edit was not tracked.\n\n' +
          '   This likely means `stream.externalEdit` is not available.\n\n',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      roundStream.markdown(`❌ **Error:** ${msg}\n\n`);
    } finally {
      tracker.dispose();
      // NOTE: temp files are intentionally NOT deleted so user can inspect them
    }
  }

  // ── Run both rounds ─────────────────────────────────────────────────

  stream.markdown(
    '🧪 **externalEdit real-flow diagnostic**\n\n' +
    'Comparing write methods and timing.\n\n' +
    '---\n\n',
  );

  await runRound(ROUND1_LABEL, 0, stream, 'fs');

  stream.markdown('---\n\n');

  await runRound(ROUND2_LABEL, 500, stream, 'fs');

  stream.markdown('---\n\n');

  await runRound(ROUND3_LABEL, 0, stream, 'powershell');

  stream.markdown('---\n\n');

  await runRound(ROUND4_LABEL, 0, stream, 'cmd');

  stream.markdown('---\n\n');

  await runRound(ROUND5_LABEL, 0, stream, 'async');

  stream.markdown(
    '---\n\n' +
    '### How to interpret\n\n' +
    '- **Round 5** is the key test: async child process + sync lock.\n' +
    '  If it succeeds → the sync lock pattern works and can be applied to\n' +
    '  the real flow (`streaming.ts` `handleToolState` → wait for file change\n' +
    '  before `completeEdit`).\n\n' +
    '- If **all rounds succeed** → externalEdit works with all write methods.\n\n' +
    '- If **Round 4/5 fail** but **1-3 succeed** → child process writes have issues.\n\n' +
    '- If **all fail** → `stream.externalEdit` not available.\n',
  );

  state.outputChannel.appendLine('[commands] test-external-edit-real completed');
}

// ---------------------------------------------------------------------------
// /test-external-edit-e2e — End-to-end test via real OpenCode prompt
// Two modes:
//   @opencode /test-external-edit-e2e         → Mode B: pre-turn monitoring
//   @opencode /test-external-edit-e2e per-edit → Mode A: per-edit tracking
// ---------------------------------------------------------------------------

async function handleTestExternalEditE2ECommand(
  state: ExtensionState,
  ctx: BackendContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open.');
    return;
  }

  // 1. Start server
  stream.markdown('🧪 **E2E Test: real OpenCode prompt → file edit → externalEdit**\n\n');
  stream.markdown('1️⃣ Starting OpenCode server...\n\n');
  const ready = await ensureServer(state, ctx, stream);
  if (!ready) {return;}
  const directory = workspaceFolders[0].uri.fsPath;

  // 2. Create temp file for the edit target
  const tmpUri = vscode.Uri.joinPath(workspaceFolders[0].uri, `.e2e-edit-target-${Date.now()}.txt`);
  const tmpPath = tmpUri.fsPath;
  const originalContent = 'hello world';
  writeFileSync(tmpPath, originalContent, 'utf-8');
  stream.markdown(`2️⃣ Created test file: \`${tmpPath}\`\n\n`);

  // 3. Create session
  stream.markdown('3️⃣ Creating session...\n\n');
  let sessionId: string;
  try {
      const sessionResp = await ctx.backend.sessions.create({ directory });
      sessionId = sessionResp.data?.id ?? '';
    if (!sessionId) {throw new Error('empty session id');}
    stream.markdown(`   Session: \`${sessionId}\`\n\n`);
  } catch (err) {
    stream.markdown(`❌ Failed to create session: ${err}\n\n`);
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    return;
  }

  const tracker = new DiagnosticEditTracker();
  const editKey = `ask-${Date.now()}`;
  let baselineCaptured = false;
  let editComplete = false;
  let undoStopId = '';

  // 4. Subscribe to SSE + send prompt
  stream.markdown('4️⃣ Subscribing to SSE and sending prompt...\n\n');

  const prompt = `Edit the file ${tmpPath}: replace "hello world" with "hello e2e test". Do not add any other text.`;
  state.outputChannel.appendLine(`[e2e] Prompt: ${prompt}`);

  let eventStream: import('../backend/backend').AcpEventStream;
  try {
    await ctx.backend.events.ensureStarted();
    eventStream = ctx.backend.events.openSessionStream(sessionId);
  } catch (err) {
    stream.markdown(`❌ Failed to subscribe to events: ${err}\n\n`);
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    tracker.dispose();
    return;
  }

  // Send prompt (fire and don't await)
  const promptPromise = ctx.backend.sessions.prompt(sessionId, prompt, directory).catch((err: unknown) => {
    state.outputChannel.appendLine(`[e2e] Prompt error: ${err}`);
  });

  // 5. Process SSE events
  stream.markdown('5️⃣ Processing SSE event stream...\n\n');
  stream.markdown('```\n');

  let eventCount = 0;
  let permissionAskedCount = 0;
  let toolCompletedCount = 0;
  let editCallID = '';

  try {
    for await (const evt of readOpenCodeEvents(eventStream.stream)) {
      if (token.isCancellationRequested) {break;}
      eventCount++;
      const evtType = evt.type;

      if (evtType === 'permission.asked') {
        const properties = (evt as PermissionAskedEvent).properties;
        permissionAskedCount++;
        const callID = properties.tool?.callID ?? '';
        const filepath = properties.metadata?.filepath ?? '';
        stream.markdown(
          `[${eventCount}] 🔐 permission.asked id=${properties.id ?? '?'} ` +
          `callID=${callID || '(empty)'} ` +
          `filepath=${filepath || '(empty)'}\n`,
        );
        // If filepath matches target, parallel trackEdit + "once"
        if (typeof filepath === 'string' && filepath?.toLowerCase() === tmpPath?.toLowerCase()) {
          editCallID = callID;
          stream.markdown(`     🎯 Matched target file — parallel trackEdit + "once"\n`);
          await Promise.all([
            tracker.trackEdit(editKey, [tmpUri], stream).then(() => {
              baselineCaptured = true;
              stream.markdown(`     ✅ trackEdit resolved — baseline captured\n`);
            }).catch((err: unknown) => {
              stream.markdown(`     ❌ trackEdit error: ${err}\n`);
            }),
            (async () => {
              if (properties.sessionID && properties.id) {
                try {
                  await ctx.backend.permissions.reply(properties.sessionID, properties.id, 'once', directory);
                  stream.markdown(`     ✅ Replied "once"\n`);
                } catch (err) {
                  stream.markdown(`     ❌ Reply failed: ${err}\n`);
                }
              }
            })(),
          ]);
        } else if (properties.sessionID && properties.id) {
          // Non-matching filepath — just reply "once"
          try {
            await ctx.backend.permissions.reply(properties.sessionID, properties.id, 'once', directory);
            stream.markdown(`     ✅ Replied "once"\n`);
          } catch (err) {
            stream.markdown(`     ❌ Reply failed: ${err}\n`);
          }
        }
      } else if (evtType === 'message.part.updated') {
        const part = evt.properties.part;
        if (part?.type === 'tool' && part?.state?.status === 'completed') {
          toolCompletedCount++;
          const toolCallID = part.callID ?? part.id ?? '';
          stream.markdown(
            `[${eventCount}] 🔧 tool completed: ${part.tool ?? '?'} callID=${toolCallID}\n`,
          );
          // completeEdit when the matched tool finishes
          if (baselineCaptured && !editComplete && editCallID && toolCallID === editCallID) {
            const result = tracker.completeEdit(editKey);
            if (result) {
              undoStopId = (await result) || '';
              editComplete = true;
              stream.markdown(`     ✅ completeEdit at tool.completed — undoStopId: \`${undoStopId || '(empty)'}\`\n`);
            } else {
              stream.markdown(`     ⚠️ completeEdit returned undefined\n`);
            }
          }
        } else if (part?.type === 'tool' && part?.state?.status) {
          stream.markdown(
            `[${eventCount}] 🔧 tool ${part.state.status}: ${part.tool ?? '?'}\n`,
          );
        }
      } else if (evtType === 'session.idle') {
        stream.markdown(`[${eventCount}] ✅ session.idle — turn complete\n`);
        break;
      } else if (evtType === 'session.diff') {
        const diffs = (evt as any).properties?.diff;
        stream.markdown(`[${eventCount}] 📄 session.diff: ${diffs?.length ?? 0} file(s)\n`);
      }
    }
  } catch (err) {
    stream.markdown(`\n❌ Event stream error: ${err}\n`);
  }

  stream.markdown('```\n\n');

  // 6. Summary
  const fileContent = existsSync(tmpPath) ? readDiskContent(tmpPath) : '(file deleted)';
  const fileChanged = fileContent.includes('hello e2e test');

  stream.markdown([
    '---\n\n',
    '### E2E Summary (Ask-time trackEdit + parallel once)\n\n',
    `| Metric | Value |\n`,
    `|---|---|\n`,
    `| Events received | ${eventCount} |\n`,
    `| permission.asked | ${permissionAskedCount} |\n`,
    `| tool completed | ${toolCompletedCount} |\n`,
    `| Baseline captured (at ask) | ${baselineCaptured} |\n`,
    `| completeEdit (at tool.completed) | ${editComplete} |\n`,
    `| undoStopId | \`${undoStopId || '(none)'}\` |\n`,
    `| File changed on disk | ${fileChanged} |\n`,
    `| File content | \`${fileContent.trim()}\` |\n\n`,
  ].join(''));

  if (editComplete && undoStopId) {
    stream.markdown('**✅ Ask-time parallel approach worked!** Check the bubble above for the diff.\n\n');
  } else if (editComplete && !undoStopId) {
    stream.markdown(
      '**⚠️ completeEdit resolved but undoStopId is empty.**\n' +
      'VSCode may not have captured the diff — file watcher latency?\n\n',
    );
  } else if (!baselineCaptured && permissionAskedCount > 0) {
    stream.markdown(
      '**❌ permission.asked received but trackEdit failed.**\n\n',
    );
  } else if (permissionAskedCount === 0) {
    stream.markdown(
      '**⚠️ No `permission.asked` event received.** Check opencode.json `permission.edit` setting.\n\n',
    );
  }

  // Cleanup
  ctx.backend.events.closeSessionStream(sessionId);
  try { if (existsSync(tmpPath)) { unlinkSync(tmpPath); } } catch { /* best effort */ }
  tracker.dispose();

  state.outputChannel.appendLine('[commands] test-external-edit-e2e completed');
}

// ---------------------------------------------------------------------------
// Test-subagent helpers
// ---------------------------------------------------------------------------

type Stream = vscode.ChatResponseStream & {
  beginToolInvocation?(callId: string, name: string, data?: Record<string, unknown>): void;
  updateToolInvocation?(callId: string, data: Record<string, unknown>): void;
};

type ProposedVscode = typeof vscode & {
  ChatToolInvocationPart?: new (toolName: string, toolCallId: string, errorMessage?: string) => ChatToolInvocationPart;
  ChatSubagentToolInvocationData?: new (description?: string, agentName?: string, prompt?: string, result?: string) => ChatSubagentToolInvocationData;
};

const VS = vscode as ProposedVscode;
let _uid = 0;
const uid = () => `t_${++_uid}_${Date.now().toString(36)}`;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function checkSubagentApi(stream: vscode.ChatResponseStream): Stream | null {
  const s = stream as Stream;
  if (!VS.ChatToolInvocationPart) {
    stream.markdown('⚠️ `ChatToolInvocationPart` API not available.\n');
    return null;
  }
  if (!s.beginToolInvocation) {
    stream.markdown('⚠️ `beginToolInvocation` not available on stream.\n');
    return null;
  }
  return s;
}

function pushProgressiveCard(
  stream: Stream, callId: string, toolName: string, invocationMessage: string,
): void {
  if (VS.ChatToolInvocationPart && (stream as any).push) {
    const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart(toolName, callId);
    (part as any).enablePartialUpdate = true;
    part.isComplete = false;
    part.invocationMessage = invocationMessage;
    (stream as any).push(part);
  }
}

function pushSubagentCard(
  stream: Stream,
  callId: string,
  agentName: string,
  description: string,
  prompt: string,
  result: string,
  subAgentInvocationId: string,
  invocationMessage: string,
  pastTenseMessage: string,
): void {
  if (VS.ChatToolInvocationPart && (stream as any).push) {
    const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
    (part as any).enablePartialUpdate = true;
    (part as any).subAgentInvocationId = subAgentInvocationId;
    part.isComplete = true;
    part.isError = false;
    part.invocationMessage = invocationMessage;
    part.pastTenseMessage = pastTenseMessage;
    if (VS.ChatSubagentToolInvocationData) {
      part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt, result);
    }
    (stream as any).push(part);
  }
}

function pushChildTool(
  stream: Stream,
  callId: string,
  toolName: string,
  subagentInvocationId: string,
  title: string,
  toolSpecificData?: Record<string, unknown>,
): void {
  if (stream.beginToolInvocation) {
    stream.beginToolInvocation(callId, toolName, { subagentInvocationId });
  }
  if (VS.ChatToolInvocationPart && (stream as any).push) {
    const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart(toolName, callId);
    (part as any).subAgentInvocationId = subagentInvocationId;
    part.isComplete = true;
    part.isError = false;
    part.invocationMessage = title;
    if (toolSpecificData) {
      (part as any).toolSpecificData = toolSpecificData;
    }
    (stream as any).push(part);
  }
}

function updateSubagentProgress(stream: Stream, callId: string, message: string): void {
  if (stream.updateToolInvocation) {
    try { stream.updateToolInvocation(callId, { invocationMessage: message }); } catch { /* best-effort */ }
  }
}

/**
 * Push a "result" tool card INSIDE the subagent card (with subAgentInvocationId).
 * This simulates how Copilot shows the agent's final result as a tool inside the expandable card.
 */
function pushResultTool(
  stream: Stream,
  subagentInvocationId: string,
  resultText: string,
): void {
  const resultCallId = `result_${uid()}`;
  const toolName = 'result';

  // Register as child of subagent
  if (stream.beginToolInvocation) {
    stream.beginToolInvocation(resultCallId, toolName, {
      subagentInvocationId,
    });
  }

  // Push completed result card grouped under the subagent
  if (VS.ChatToolInvocationPart && (stream as any).push) {
    const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart(toolName, resultCallId);
    (part as any).subAgentInvocationId = subagentInvocationId;
    part.isComplete = true;
    part.isError = false;
    part.invocationMessage = resultText;
    // Render as collapsible input/output block (ChatSimpleToolResultData)
    (part as any).toolSpecificData = {
      input: 'subagent execution',
      output: resultText,
    } satisfies ChatSimpleToolResultData;
    (stream as any).push(part);
  }
}

// ---------------------------------------------------------------------------
// /test-subagent-single-blocking
// ---------------------------------------------------------------------------
// Follows Copilot Chat's official pattern from copilotCLITools.ts:
//   1. beginToolInvocation(callId, 'task')
//   2. push ChatToolInvocationPart with ChatSubagentToolInvocationData(description, agentName, prompt)
//      — result is undefined at this point
//   3. push child tools with subAgentInvocationId for VSCode grouping
//   4. update toolSpecificData.result directly on the existing ChatSubagentToolInvocationData
//   5. push final ChatToolInvocationPart (enablePartialUpdate replaces the card in-place)
//      with pastTenseMessage + completed result
// ---------------------------------------------------------------------------

async function handleTestSubagentSingleBlockingCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const s = checkSubagentApi(stream);
  if (!s) {return;}

  const callId = uid();
  const description = 'Explore codebase structure';
  const agentName = 'explore';
  const prompt = 'List all TypeScript source files in the project, identify the main entry points, and report the total count of .ts files across all directories.';
  stream.markdown('# 🔵 Single Subagent (Blocking)\n\n');

  try {
    // Phase 1: Begin — register the tool invocation
    if (s.beginToolInvocation) {
      s.beginToolInvocation(callId, 'task');
    }

    // Phase 2: Push running card with ChatSubagentToolInvocationData (result = undefined)
    // Matches copilotCLITools.ts formatTaskInvocation:
    //   new ChatSubagentToolInvocationData(description, agentName, prompt)
    if (VS.ChatToolInvocationPart && (stream as any).push) {
      const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
      (part as any).enablePartialUpdate = true;
      part.isComplete = false;
      part.invocationMessage = description;
      if (VS.ChatSubagentToolInvocationData) {
        part.toolSpecificData = new VS.ChatSubagentToolInvocationData(
          description,
          agentName,
          prompt,
        );
      }
      (stream as any).push(part);
    }
    await delay(500);
    if (token.isCancellationRequested) {return;}

    // Phase 3: Push child tools with subAgentInvocationId = parent task callId.
    // VSCode groups child tools under the parent subagent by matching
    // child.subAgentInvocationId === parent.toolCallId.
    pushChildTool(s, uid(), 'read', callId, 'package.json', {
      values: [vscode.Uri.file('package.json')],
    } satisfies ChatToolResourcesInvocationData);
    await delay(300);
    if (token.isCancellationRequested) {return;}

    pushChildTool(s, uid(), 'bash', callId, 'npm test', {
      commandLine: { original: 'npm test' },
      language: 'bash',
      output: { text: '✓ 67 tests passed' },
      state: { exitCode: 0, duration: 1200 },
    } satisfies ChatTerminalToolInvocationData);
    await delay(300);
    if (token.isCancellationRequested) {return;}

    // Public-API-friendly plain text output: render a generic child tool
    // with ChatSimpleToolResultData instead of relying on subagent result page.
    pushChildTool(s, uid(), 'summary', callId, 'Found 42 TypeScript files', {
      input: 'subagent summary',
      output: 'Found 42 TypeScript files across 8 directories. Key entry points: src/extension.ts, src/participant/handler.ts, src/participant/streaming.ts.',
    } satisfies ChatSimpleToolResultData);

    // Phase 4: Push completed card (enablePartialUpdate replaces in-place)
    // Keep the subagent card + child tools + completion summary.
    if (VS.ChatToolInvocationPart && (stream as any).push) {
      const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
      (part as any).enablePartialUpdate = true;
      part.isComplete = true;
      part.invocationMessage = description;
      part.pastTenseMessage = 'Found 42 TypeScript files';
      if (VS.ChatSubagentToolInvocationData) {
        part.toolSpecificData = new VS.ChatSubagentToolInvocationData(
          description,
          agentName,
          prompt,
        );
      }
      (stream as any).push(part);
    }
  } catch (err) {
    stream.markdown(`\n❌ **Error:** ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// /test-subagent-multi-blocking
// ---------------------------------------------------------------------------

async function handleTestSubagentMultiBlockingCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const s = checkSubagentApi(stream);
  if (!s) {return;}

  stream.markdown('# 🟢 Multi Subagent (Sequential Blocking)\n\n');

  try {
    // First subagent
    {
      const callId = uid();
      const description = 'Analyze database schema';
      const agentName = 'explore';
      const prompt = 'Analyze the database schema in src/models/. Find all model definitions and map their relationships (foreign keys, associations, indexes).';

      if (s.beginToolInvocation) {
        s.beginToolInvocation(callId, 'task');
      }
      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = false;
        part.invocationMessage = description;
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt);
        }
        (stream as any).push(part);
      }
      await delay(400);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'read', callId, 'src/models/user.ts');
      pushChildTool(s, uid(), 'read', callId, 'src/models/post.ts');
      await delay(300);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'summary', callId, '5 models found, relationships mapped', {
        input: 'subagent summary',
        output: 'Found 5 models: User, Post, Comment, Tag, Session.\nUser → has many Posts, Post → has many Comments.',
      } satisfies ChatSimpleToolResultData);

      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = true;
        part.invocationMessage = description;
        part.pastTenseMessage = '5 models found, relationships mapped';
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt);
        }
        (stream as any).push(part);
      }
    }

    await delay(200);
    if (token.isCancellationRequested) {return;}

    // Second subagent
    {
      const callId = uid();
      const description = 'Create API endpoints';
      const agentName = 'build';
      const prompt = 'Based on the database models found (User, Post, Comment, Tag, Session), generate REST API endpoint files with CRUD operations for each model. Run lint after to verify.';

      if (s.beginToolInvocation) {
        s.beginToolInvocation(callId, 'task');
      }
      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = false;
        part.invocationMessage = description;
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt);
        }
        (stream as any).push(part);
      }
      await delay(400);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'write', callId, 'src/api/users.ts');
      pushChildTool(s, uid(), 'write', callId, 'src/api/posts.ts');
      pushChildTool(s, uid(), 'bash', callId, 'npm run lint');
      await delay(300);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'summary', callId, '15 API endpoints created', {
        input: 'subagent summary',
        output: 'Created 15 endpoints across 5 resource files. All endpoints pass lint checks.',
      } satisfies ChatSimpleToolResultData);

      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = true;
        part.invocationMessage = description;
        part.pastTenseMessage = '15 API endpoints created';
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt);
        }
        (stream as any).push(part);
      }
    }
  } catch (err) {
    stream.markdown(`\n❌ **Error:** ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// /test-subagent-single-parallel
// ---------------------------------------------------------------------------

async function handleTestSubagentSingleParallelCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const s = checkSubagentApi(stream);
  if (!s) {return;}

  const callId = uid();
  const description = 'Search for TODO patterns';
  const agentName = 'explore';
  const prompt = 'Search the codebase for all TODO comments. List each TODO with its file path, line number, and surrounding context. Categorize by urgency if possible.';

  stream.markdown('# 🟡 Single Subagent (Parallel/Callback)\n\n');

  try {
    // Start subagent
    if (s.beginToolInvocation) {
      s.beginToolInvocation(callId, 'task');
    }
    if (VS.ChatToolInvocationPart && (stream as any).push) {
      const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
      (part as any).enablePartialUpdate = true;
      part.isComplete = false;
      part.invocationMessage = description;
      if (VS.ChatSubagentToolInvocationData) {
        part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt);
      }
      (stream as any).push(part);
    }

    // Main agent continues — output text while subagent runs
    stream.markdown('I\'ll search for TODO patterns in the background while I continue analyzing the project structure.\n\n');
    await delay(200);

    // Subagent completes asynchronously (ACP callback pattern)
    const asyncComplete = (async () => {
      await delay(800);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'grep', callId, 'TODO comments');

      await delay(400);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'summary', callId, '5 TODOs found', {
        input: 'subagent summary',
        output: 'Found 5 TODO comments across 3 files:\n- src/auth/middleware.ts (2 TODOs: token refresh, error mapping)\n- src/api/routes.ts (1 TODO: input validation)\n- src/utils/helpers.ts (2 TODOs: caching, type narrowing)',
      } satisfies ChatSimpleToolResultData);

      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = true;
        part.invocationMessage = description;
        part.pastTenseMessage = '5 TODOs found';
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(description, agentName, prompt);
        }
        (stream as any).push(part);
      }
    })();

    // Main agent keeps producing output while subagent runs
    await delay(300);
    stream.markdown('The project follows a layered architecture with ACP protocol abstraction...\n');
    await delay(300);
    stream.markdown('Entry points are well-separated between extension, participant, and surface layers.\n\n');

    await asyncComplete;
  } catch (err) {
    stream.markdown(`\n❌ **Error:** ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// /test-subagent-multi-parallel
// ---------------------------------------------------------------------------

async function handleTestSubagentMultiParallelCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const s = checkSubagentApi(stream);
  if (!s) {return;}

  stream.markdown('# 🔴 Multi Subagent (All Parallel)\n\n');

  const agents = [
    {
      name: 'explore',
      desc: 'Analyze project structure',
      prompt: 'Scan the src/ directory, list all TypeScript modules grouped by layer (acp/, backends/, participant/, surfaces/), and identify the main entry points and their dependencies.',
      resultText: 'Found 12 modules in src/, 3 entry points.\nMain layers: acp/, backends/, participant/, surfaces/.',
      summary: '12 modules found',
      childTools: [{ name: 'list', title: 'src/' }, { name: 'read', title: 'package.json' }],
    },
    {
      name: 'build',
      desc: 'Fix TypeScript errors',
      prompt: 'Run the TypeScript compiler in check mode, find all type errors, fix them by adding missing interfaces and type annotations, then verify the fix with a clean compile.',
      resultText: 'Fixed 3 type errors:\n- src/auth/types.ts: added missing Session interface\n- src/auth/middleware.ts: fixed string→enum cast\n- src/auth/jwt.ts: added return type annotation',
      summary: '3 type errors fixed',
      childTools: [{ name: 'grep', title: 'error TS' }, { name: 'edit', title: 'src/auth/types.ts' }, { name: 'bash', title: 'npx tsc --noEmit' }],
    },
    {
      name: 'test',
      desc: 'Run test suite',
      prompt: 'Run the full test suite with coverage reporting. Identify files or modules with less than 50% branch coverage and list them as coverage gaps to address.',
      resultText: 'Coverage: 78% statements, 65% branches.\n42 of 54 tests passing.\nGaps: surfaces/vscode/ (12%), backends/opencode/ (34%).',
      summary: '78% coverage, 42/54 tests passing',
      childTools: [{ name: 'bash', title: 'npm test -- --coverage' }, { name: 'read', title: 'coverage/summary.json' }],
    },
  ];

  try {
    const tasks = agents.map(async (agent, i) => {
      const callId = uid();

      if (s.beginToolInvocation) {
        s.beginToolInvocation(callId, 'task');
      }
      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = false;
        part.invocationMessage = agent.desc;
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(agent.desc, agent.name, agent.prompt);
        }
        (stream as any).push(part);
      }

      const delayMs = 600 + i * 400;
      await delay(delayMs);
      if (token.isCancellationRequested) {return;}

      for (const child of agent.childTools) {
        pushChildTool(s, uid(), child.name, callId, child.title);
      }

      await delay(300);
      if (token.isCancellationRequested) {return;}

      pushChildTool(s, uid(), 'summary', callId, agent.summary, {
        input: 'subagent summary',
        output: agent.resultText,
      } satisfies ChatSimpleToolResultData);

      if (VS.ChatToolInvocationPart && (stream as any).push) {
        const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('task', callId);
        (part as any).enablePartialUpdate = true;
        part.isComplete = true;
        part.invocationMessage = agent.desc;
        part.pastTenseMessage = agent.summary;
        if (VS.ChatSubagentToolInvocationData) {
          part.toolSpecificData = new VS.ChatSubagentToolInvocationData(agent.desc, agent.name, agent.prompt);
        }
        (stream as any).push(part);
      }
    });

    // Main agent output while subagents run
    stream.markdown('Dispatching 3 parallel subagents to analyze the project...\n\n');
    await Promise.all(tasks);
  } catch (err) {
    stream.markdown(`\n❌ **Error:** ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// /test-file-read-stream — file bubble lifecycle experiment matrix
// ---------------------------------------------------------------------------
// Runs lifecycle cases to isolate what overwrites or preserves a VSCode-style file bubble:
//   A. Initial-only markdown bubble
//   B. Initial markdown bubble + updateToolInvocation overwrite
//   C. Initial markdown bubble + completed pastTenseMessage overwrite
//   D. Resources/Location control case (stable public API path)
//   E. Completed state without pastTenseMessage
//   F. Completed state with Markdown pastTenseMessage
//
// Experimental conclusion from this matrix:
//   - A/B were stable in the target environment.
//   - C failed.
//   - E/F were stable again.
// Therefore the key regression point is plain-string `pastTenseMessage` during the
// completed state, not the initial Markdown bubble format and not updateToolInvocation.
// ---------------------------------------------------------------------------

async function handleTestFileReadStreamCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open. Open a folder and try again.\n');
    return;
  }

  const s = checkSubagentApi(stream);
  if (!s) {return;}

  // Create a temp file with sample content
  const tmpUri = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    `.opencode-read-stream-test-${Date.now()}.txt`,
  );
  const fileContent = [
    '// Sample file for streaming read test',
    'function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'const message = greet("OpenCode");',
    'console.log(message);',
    '',
    '// End of file',
  ].join('\n');

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(tmpUri, encoder.encode(fileContent));

  const filePath = tmpUri.fsPath;
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  const lowerCaseFileUri = (uri: vscode.Uri): vscode.Uri => {
    const value = uri.toString().toLowerCase();
    return vscode.Uri.parse(value);
  };

  const readLocation = (startLine: number, endLine: number): vscode.Location => {
    const normalizedUri = lowerCaseFileUri(tmpUri);
    return new vscode.Location(
      normalizedUri,
      new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0),
    );
  };

  const bubbleMarkdown = (startLine?: number, endLine?: number): vscode.MarkdownString => {
    const uri = lowerCaseFileUri(tmpUri).toString();
    const range = startLine != null && endLine != null ? `#${startLine}-${endLine}` : '';
    return new vscode.MarkdownString(`Read [](${uri}${range})`);
  };

  const pushPartial = (
    callId: string,
    invocationMessage: string | vscode.MarkdownString,
    options?: {
      isComplete?: boolean;
      pastTenseMessage?: string | vscode.MarkdownString;
      resourcesRange?: { start: number; end: number };
    },
  ): void => {
    if (!VS.ChatToolInvocationPart || !(stream as any).push) {
      return;
    }

    const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('read', callId);
    (part as any).enablePartialUpdate = true;
    part.isComplete = options?.isComplete ?? false;
    part.isError = false;
    part.invocationMessage = invocationMessage;
    if (options?.pastTenseMessage) {
      part.pastTenseMessage = options.pastTenseMessage;
    }
    if (options?.resourcesRange) {
      part.toolSpecificData = {
        values: [readLocation(options.resourcesRange.start, options.resourcesRange.end)],
      } satisfies ChatToolResourcesInvocationData;
    }
    (stream as any).push(part);
  };

  const beginReadInvocation = (callId: string): void => {
    if (s.beginToolInvocation) {
      s.beginToolInvocation(callId, 'read');
    }
  };

  stream.markdown('# 📂 File Bubble Lifecycle Matrix\n\n');
  stream.markdown(`Created temp file: ${fileName}\n\n`);

  const lines = fileContent.split('\n');
  const totalLines = lines.length;
  const chunkSize = 3;

  try {
    const cases = [
      {
        title: 'Case A — Initial Markdown bubble only',
        description: 'Only initial push with MarkdownString bubble. No update, no completion overwrite.',
        run: async () => {
          const callId = uid();
          beginReadInvocation(callId);
          pushPartial(callId, bubbleMarkdown(1, totalLines));
        },
      },
      {
        title: 'Case B — Bubble then updateToolInvocation overwrite',
        description: 'Start with Markdown bubble, then update invocationMessage as plain string.',
        run: async () => {
          const callId = uid();
          beginReadInvocation(callId);
          pushPartial(callId, bubbleMarkdown(1, totalLines));
          await delay(400);
          if (token.isCancellationRequested) {return;}
          if (s.updateToolInvocation) {
            s.updateToolInvocation(callId, {
              invocationMessage: `Reading ${fileName} lines 1-${chunkSize} (updated plain text)`,
            });
          }
        },
      },
      {
        title: 'Case C — Bubble then completed-state overwrite',
        description: 'Start with Markdown bubble, then complete with plain pastTenseMessage/invocationMessage.',
        run: async () => {
          const callId = uid();
          beginReadInvocation(callId);
          pushPartial(callId, bubbleMarkdown(1, totalLines));
          await delay(400);
          if (token.isCancellationRequested) {return;}
          pushPartial(callId, `Read ${fileName}`, {
            isComplete: true,
            pastTenseMessage: `Read ${fileName}`,
          });
        },
      },
      {
        title: 'Case D — Resources/Location control',
        description: 'Public API control case using toolSpecificData.values = [Location].',
        run: async () => {
          const callId = uid();
          beginReadInvocation(callId);
          pushPartial(callId, `Read ${fileName}`, {
            resourcesRange: { start: 1, end: totalLines },
          });
          await delay(300);
          if (token.isCancellationRequested) {return;}
          pushPartial(callId, `Read ${fileName}`, {
            isComplete: true,
            pastTenseMessage: `Read ${fileName}`,
            resourcesRange: { start: 1, end: totalLines },
          });
        },
      },
      {
        title: 'Case E — Complete without pastTenseMessage',
        description: 'Start with Markdown bubble, then complete while keeping invocationMessage as MarkdownString and omitting pastTenseMessage.',
        run: async () => {
          const callId = uid();
          beginReadInvocation(callId);
          pushPartial(callId, bubbleMarkdown(1, totalLines));
          await delay(400);
          if (token.isCancellationRequested) {return;}
          pushPartial(callId, bubbleMarkdown(1, totalLines), {
            isComplete: true,
          });
        },
      },
      {
        title: 'Case F — Complete with Markdown pastTenseMessage',
        description: 'Start with Markdown bubble, then complete while both invocationMessage and pastTenseMessage remain MarkdownString bubbles.',
        run: async () => {
          const callId = uid();
          beginReadInvocation(callId);
          pushPartial(callId, bubbleMarkdown(1, totalLines));
          await delay(400);
          if (token.isCancellationRequested) {return;}
          pushPartial(callId, bubbleMarkdown(1, totalLines), {
            isComplete: true,
            pastTenseMessage: bubbleMarkdown(1, totalLines),
          });
        },
      },
    ] as const;

    for (const item of cases) {
      if (token.isCancellationRequested) {return;}
      stream.markdown(`## ${item.title}\n\n`);
      stream.markdown(`${item.description}\n\n`);
      await item.run();
      await delay(600);
    }

    stream.markdown('## Observation Guide\n\n');
    stream.markdown('- Case A：如果它能稳定保留气泡，说明初始 push 本身没有问题。\n');
    stream.markdown('- Case B：如果这里退化，说明 `updateToolInvocation` 很可能覆盖了气泡。\n');
    stream.markdown('- Case C：如果这里退化，说明完成态/pastTenseMessage 覆盖了气泡。\n');
    stream.markdown('- Case D：这是公开 API 的稳定对照组。\n\n');
    stream.markdown('- Case E：如果 E 正常而 C 异常，说明 completed 本身没问题，问题更偏向 `pastTenseMessage`。\n');
    stream.markdown('- Case F：如果 F 也异常，说明 completed renderer 可能整体不保留这种 bubble。\n\n');

    stream.markdown('✅ **File bubble experiment matrix completed successfully!**\n');
    stream.markdown(`- File: ${fileName}\n`);
    stream.markdown(`- Lines: ${totalLines}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`\n❌ **Error:** ${msg}\n`);
    stream.markdown(
      '\nThe proposed API may not be available in this VSCode version. ' +
      'Ensure `chatParticipantAdditions` proposal is enabled.\n',
    );
  }
}

// ===========================================================================
// /test-stream-latency — Streaming latency diagnostic
// ===========================================================================

interface DeltaTiming {
  /** High-resolution timestamp when this delta was received */
  ts: number;
  /** Sequence number (0-based) */
  seq: number;
  /** Delta text content */
  text: string;
  /** Text length */
  len: number;
  /** Gap since previous delta (ms), 0 for first */
  gapMs: number;
  /** Event type (raw ACP type) */
  eventType: string;
}

/**
 * Diagnostic: connects to real backend, sends a prompt that triggers
 * long thinking/reasoning output, and measures the latency profile of
 * streaming delta events.
 *
 * Outputs:
 *  - Inter-delta gap statistics (avg, median, p95, max)
 *  - Batch detection: how often deltas arrive in bursts
 *  - Time-to-first-delta (TTFT)
 *  - Per-second throughput histogram
 *  - Streams thinking content via thinkingProgress in real-time
 */
async function handleTestStreamLatencyCommand(
  state: ExtensionState,
  ctx: BackendContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const ready = await ensureServer(state, ctx, stream);
  if (!ready) {return;}

  // The prompt must trigger a long reasoning/thinking response.
  // We ask the model to think step-by-step about a complex topic.
  const THINKING_PROMPT = [
    'Please think step-by-step in detail about the following problem. Show ALL your reasoning.',
    '',
    'Consider a hypothetical distributed system with 100 nodes arranged in a ring topology.',
    'Each node can send messages to its 2 neighbors (left and right).',
    'A leader election algorithm must be designed where:',
    '1. Exactly one leader is elected in O(n log n) messages',
    '2. The algorithm handles simultaneous node failures gracefully',
    '3. The algorithm works correctly even with variable message delays',
    '',
    'For each aspect, provide:',
    '- The theoretical foundation (what principle/theorem applies)',
    '- A concrete algorithm outline with pseudocode',
    '- Complexity analysis (message complexity, time complexity)',
    '- Edge cases and failure modes',
    '- Comparison with alternative approaches',
    '',
    'Be extremely thorough. Write at least 2000 words of reasoning.',
  ].join('\n');

  // Use performance.now() for sub-millisecond precision
  const perfNow = () => performance.now();
  const allEvents: { ts: number; type: string }[] = [];
  const deltas: DeltaTiming[] = [];

  try {
    stream.markdown('## 🔬 Streaming Latency Diagnostic\n\n');
    stream.progress('Creating session...');

    // 1. Create a new session
    const sessionResult = await ctx.backend.sessions.create({
      title: 'stream-latency-test',
    });
    if (sessionResult.error || !sessionResult.data) {
      stream.markdown(`❌ Failed to create session: ${sessionResult.error ?? 'unknown'}\n`);
      return;
    }
    const sessionId = sessionResult.data.id;
    stream.markdown(`- Session: \`${sessionId.slice(0, 12)}...\`\n`);

    // 2. Subscribe to global events
    stream.progress('Subscribing to event stream...');
    await ctx.backend.events.ensureStarted();

    // 3. Open per-session stream
    const eventStream = ctx.backend.events.openSessionStream(sessionId);

    // 4. Fire the prompt (non-blocking)
    stream.progress('Sending thinking prompt...');
    const promptStart = perfNow();
    const promptPromise = ctx.backend.sessions
      .prompt(sessionId, THINKING_PROMPT)
      .then((result: { error?: unknown; data?: unknown }) => {
        if (result.error) {
          state.outputChannel.appendLine(
            `[stream-latency] Prompt error: ${String(result.error)}`,
          );
        }
      })
      .catch((err: unknown) => {
        state.outputChannel.appendLine(
          `[stream-latency] Prompt exception: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // 5. Consume the event stream with timing instrumentation
    stream.progress('Collecting delta timing data...');
    stream.markdown('\n### Live Thinking Stream\n\n');

    const extendedStream = stream as vscode.ChatResponseStream & {
      thinkingProgress?(delta: { text?: string | string[]; id?: string }): void;
    };
    const hasThinking = typeof extendedStream.thinkingProgress === 'function';

    let firstDeltaTs = 0;
    let lastDeltaTs = 0;
    let seq = 0;
    const eventTypes = new Map<string, number>();

    // Timeout safety: 120s max
    const TIMEOUT_MS = 120_000;
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        stream.markdown('\n⏱️ **Timeout reached (120s). Stopping collection.**\n');
        resolve();
      }, TIMEOUT_MS);
    });

    const collectPromise = (async () => {
      for await (const event of readOpenCodeEvents(eventStream.stream)) {
        if (token.isCancellationRequested) {break;}

        const now = perfNow();
        const eventType = event.type;

        // Track event type counts
        eventTypes.set(eventType, (eventTypes.get(eventType) ?? 0) + 1);
        allEvents.push({ ts: now, type: eventType });

        // Track deltas (the streaming tokens)
        if (event.type === 'message.part.delta') {
          const deltaEvent = event as MessagePartDeltaEvent;
          const deltaText = deltaEvent.properties.delta ?? '';
          const gapMs = lastDeltaTs > 0 ? now - lastDeltaTs : 0;

          if (firstDeltaTs === 0) {
            firstDeltaTs = now;
          }

          deltas.push({
            ts: now,
            seq,
            text: deltaText,
            len: deltaText.length,
            gapMs: Math.round(gapMs * 100) / 100,
            eventType,
          });

          // Stream thinking content in real-time
          if (hasThinking && extendedStream.thinkingProgress) {
            extendedStream.thinkingProgress({ text: deltaText, id: deltaEvent.properties.partID });
          }

          lastDeltaTs = now;
          seq++;

          // Stop after session.idle
        } else if (event.type === 'session.idle') {
          break;
        }
      }
    })();

    // Race between collection and timeout
    await Promise.race([collectPromise, timeoutPromise]);

    // Ensure prompt settles
    await promptPromise;

    // Close the stream
    ctx.backend.events.closeSessionStream(sessionId);

    // 6. Compute and display statistics
    if (deltas.length === 0) {
      stream.markdown('\n### Result\n\n');
      stream.markdown('⚠️ **No delta events received.** The model may not have produced reasoning output.\n');
      stream.markdown(`Events received: ${allEvents.length}\n`);
      for (const [type, count] of eventTypes) {
        stream.markdown(`- \`${type}\`: ${count}\n`);
      }
      return;
    }

    // Compute statistics
    const gaps = deltas.slice(1).map((d) => d.gapMs);
    const totalDuration = lastDeltaTs - firstDeltaTs;
    const ttfFirstDelta = firstDeltaTs - promptStart;

    // Sort gaps for percentile calculation
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianIdx = Math.floor(sortedGaps.length / 2);
    const p95Idx = Math.floor(sortedGaps.length * 0.95);

    // Burst detection: consecutive deltas with <1ms gap
    const burstSizes: number[] = [];
    let currentBurst = 1;
    for (let i = 1; i < deltas.length; i++) {
      if (deltas[i].gapMs < 1) {
        currentBurst++;
      } else {
        if (currentBurst > 1) {burstSizes.push(currentBurst);}
        currentBurst = 1;
      }
    }
    if (currentBurst > 1) {burstSizes.push(currentBurst);}

    // Batch detection: gaps > 50ms (likely server-side buffering)
    const batchGaps = gaps.filter((g) => g > 50).length;

    // Per-second throughput histogram
    const histBins = new Map<number, number>();
    for (const d of deltas) {
      const bucket = Math.floor((d.ts - firstDeltaTs) / 1000);
      histBins.set(bucket, (histBins.get(bucket) ?? 0) + 1);
    }

    // Report
    stream.markdown('\n### 📊 Latency Statistics\n\n');
    stream.markdown('| Metric | Value |\n');
    stream.markdown('|--------|-------|\n');
    stream.markdown(`| **Deltas received** | ${deltas.length} |\n`);
    stream.markdown(`| **Total text length** | ${deltas.reduce((s, d) => s + d.len, 0).toLocaleString()} chars |\n`);
    stream.markdown(`| **Wall-clock duration** | ${Math.round(totalDuration)} ms |\n`);
    stream.markdown(`| **TTFT (time to first delta)** | ${Math.round(ttfFirstDelta)} ms |\n`);
    stream.markdown(`| **Avg inter-delta gap** | ${gaps.length > 0 ? (gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(1) : 'N/A'} ms |\n`);
    stream.markdown(`| **Median inter-delta gap** | ${sortedGaps.length > 0 ? sortedGaps[medianIdx].toFixed(1) : 'N/A'} ms |\n`);
    stream.markdown(`| **P95 inter-delta gap** | ${sortedGaps.length > 0 ? sortedGaps[p95Idx].toFixed(1) : 'N/A'} ms |\n`);
    stream.markdown(`| **Min gap** | ${sortedGaps.length > 0 ? sortedGaps[0].toFixed(1) : 'N/A'} ms |\n`);
    stream.markdown(`| **Max gap** | ${sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1].toFixed(1) : 'N/A'} ms |\n`);
    stream.markdown(`| **Batch gaps (>50ms)** | ${batchGaps} |\n`);
    stream.markdown(`| **Burst groups (<1ms gap)** | ${burstSizes.length} |\n`);
    stream.markdown(`| **Avg burst size** | ${burstSizes.length > 0 ? (burstSizes.reduce((s, b) => s + b, 0) / burstSizes.length).toFixed(1) : 'N/A'} |\n`);

    // Event type breakdown
    stream.markdown('\n### Event Types\n\n');
    for (const [type, count] of eventTypes) {
      stream.markdown(`- \`${type}\`: ${count}\n`);
    }

    // Per-second throughput
    if (histBins.size > 0) {
      stream.markdown('\n### Throughput (deltas/sec)\n\n');
      stream.markdown('```\n');
      const maxBucket = Math.max(...histBins.keys());
      for (let i = 0; i <= maxBucket; i++) {
        const count = histBins.get(i) ?? 0;
        const bar = '█'.repeat(Math.min(count, 60));
        const label = String(i).padStart(2, ' ');
        stream.markdown(`${label}s | ${bar} ${count}\n`);
      }
      stream.markdown('```\n');
    }

    // Top-10 largest gaps (batch detection detail)
    const topGaps = deltas
      .slice(1)
      .sort((a, b) => b.gapMs - a.gapMs)
      .slice(0, 10);

    if (topGaps.length > 0) {
      stream.markdown('\n### Top-10 Largest Gaps (possible batch events)\n\n');
      stream.markdown('| Seq | Gap (ms) | Delta Length | Preview |\n');
      stream.markdown('|-----|----------|-------------|----------|\n');
      for (const d of topGaps) {
        const preview = d.text.slice(0, 30).replace(/\n/g, '\\n');
        stream.markdown(`| ${d.seq} | ${d.gapMs.toFixed(1)} | ${d.len} | \`${preview}...\` |\n`);
      }
    }

    // Diagnosis
    stream.markdown('\n### 🔍 Diagnosis\n\n');
    if (batchGaps > deltas.length * 0.3) {
      stream.markdown(
        '⚠️ **Server-side batching likely**: >30% of gaps exceed 50ms. ' +
        'The OpenCode server may be buffering tokens before flushing SSE events.\n',
      );
    } else if (burstSizes.length > deltas.length * 0.1 && burstSizes.reduce((s, b) => s + b, 0) > deltas.length * 0.5) {
      stream.markdown(
        '⚠️ **Burst delivery pattern detected**: Many deltas arrive in rapid bursts (<1ms apart) ' +
        'separated by long gaps. This suggests the server batches events or the SSE transport ' +
        'delivers multiple events per TCP segment.\n',
      );
    } else {
      stream.markdown(
        '✅ **Streaming looks healthy**: Delta delivery appears relatively even. ' +
        'If you still see lag, check VSCode UI rendering latency.\n',
      );
    }

    // Raw delta log (first 50)
    const logLimit = Math.min(deltas.length, 50);
    stream.markdown(`\n### Raw Delta Log (first ${logLimit} of ${deltas.length})\n\n`);
    stream.markdown('```\n');
    for (let i = 0; i < logLimit; i++) {
      const d = deltas[i];
      const gap = d.gapMs > 0 ? ` +${d.gapMs.toFixed(1)}ms` : '';
      const preview = d.text.slice(0, 20).replace(/\n/g, '\\n');
      stream.markdown(`[${String(d.seq).padStart(3, ' ')}] t=${Math.round(d.ts - firstDeltaTs).toString().padStart(6, ' ')}ms${gap} len=${d.len} "${preview}"\n`);
    }
    if (deltas.length > logLimit) {
      stream.markdown(`... (${deltas.length - logLimit} more deltas)\n`);
    }
    stream.markdown('```\n');

    stream.markdown('\n✅ **Streaming latency diagnostic complete.**\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`\n❌ **Error:** ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// /test-thinking — thinkingProgress API diagnostic
// ---------------------------------------------------------------------------

async function handleTestThinkingCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const extendedStream = stream as vscode.ChatResponseStream & {
    thinkingProgress?(delta: { text?: string | string[]; id?: string; metadata?: { readonly [key: string]: unknown } }): void;
    beginToolInvocation?(callId: string, name: string, data?: Record<string, unknown>): void;
    updateToolInvocation?(callId: string, data: Record<string, unknown>): void;
  };

  const hasThinking = typeof extendedStream.thinkingProgress === 'function';
  const hasToolUI = typeof extendedStream.beginToolInvocation === 'function';

  stream.markdown('## 🧠 thinkingProgress API Diagnostic\n\n');

  // --- Phase 1: Capability Check ---
  stream.markdown('### 1. API Capabilities\n\n');
  stream.markdown(`- \`thinkingProgress\`: ${hasThinking ? '✅ available' : '❌ NOT available'}\n`);
  stream.markdown(`- \`beginToolInvocation\`: ${hasToolUI ? '✅ available' : '❌ NOT available'}\n`);
  stream.markdown(`- \`ChatToolInvocationPart\`: ${(vscode as any).ChatToolInvocationPart ? '✅ available' : '❌ NOT available'}\n`);
  stream.markdown('\n');

  if (!hasThinking) {
    stream.markdown(
      '⚠️ **`thinkingProgress` is not available.** This means the VSCode version or extension host ' +
      'does not expose the proposed `chatParticipantAdditions` API. Reasoning content will be dropped ' +
      'or fall back to markdown.\n\n',
    );
    stream.markdown('**Skipping live tests — API not present.**\n');
    return;
  }

  // --- Phase 2: Single thinkingProgress block ---
  stream.markdown('### 2. Single thinkingProgress Block (progressive)\n\n');
  stream.markdown('_Pushing 10 progressive deltas into one thinking block (id=`test-1`)..._\n\n');

  const thinkingId1 = 'test-1';
  for (let i = 1; i <= 10; i++) {
    if (token.isCancellationRequested) {break;}
    extendedStream.thinkingProgress!({
      text: `[${i}/10] This is thinking delta #${i}. Analyzing the problem step by step...\n`,
      id: thinkingId1,
    });
    await new Promise<void>(r => setTimeout(r, 200));
  }

  stream.markdown('\n✅ Single block test done. Check if the thinking content above rendered in a collapsible block.\n\n');

  // --- Phase 3: thinking → markdown boundary ---
  stream.markdown('### 3. Reasoning → Text Boundary\n\n');
  stream.markdown('_Pushing thinking block (id=`test-2`), then switching to markdown..._\n\n');

  // Thinking phase
  extendedStream.thinkingProgress!({
    text: 'Let me reason about this problem. First, I need to understand the requirements...',
    id: 'test-2',
  });
  await new Promise<void>(r => setTimeout(r, 300));

  extendedStream.thinkingProgress!({
    text: '\nSecond, I should consider edge cases and potential issues with the implementation.',
    id: 'test-2',
  });
  await new Promise<void>(r => setTimeout(r, 300));

  extendedStream.thinkingProgress!({
    text: '\nFinally, I have a clear plan. Let me write the response.',
    id: 'test-2',
  });
  await new Promise<void>(r => setTimeout(r, 500));

  // Switch to markdown
  stream.markdown('**This is the actual text response.** It should appear AFTER the thinking block, not inside it.\n\n');
  stream.markdown('If you see this text inside the thinking area, there is a boundary bug. ✅\n\n');

  // --- Phase 4: Multiple thinking blocks with interleaved text ---
  stream.markdown('### 4. Multiple Reasoning Blocks (reasoning → text → reasoning → text)\n\n');
  stream.markdown('_Testing the exact pattern that causes markdown confusion..._\n\n');

  // Block A: reasoning
  extendedStream.thinkingProgress!({
    text: '[Block A] First reasoning pass — understanding the user request.',
    id: 'test-3a',
  });
  await new Promise<void>(r => setTimeout(r, 300));

  extendedStream.thinkingProgress!({
    text: '\n[Block A] Deep analysis of the codebase structure and patterns.',
    id: 'test-3a',
  });
  await new Promise<void>(r => setTimeout(r, 300));

  // Block A: text
  stream.markdown('**[Text A]** This is the first text response. It should be clearly separate from thinking.\n\n');

  // Block B: reasoning
  extendedStream.thinkingProgress!({
    text: '[Block B] Second reasoning pass — refining the implementation plan.',
    id: 'test-3b',
  });
  await new Promise<void>(r => setTimeout(r, 300));

  extendedStream.thinkingProgress!({
    text: '\n[Block B] Considering alternative approaches and their trade-offs.',
    id: 'test-3b',
  });
  await new Promise<void>(r => setTimeout(r, 300));

  // Block B: text
  stream.markdown('**[Text B]** This is the second text response. It should also be clearly separate.\n\n');

  // --- Phase 5: Rapid-fire thinking deltas (stress test) ---
  stream.markdown('### 5. Rapid-Fire Stress Test\n\n');
  stream.markdown('_Pushing 50 rapid deltas into a single thinking block (id=`test-4`) with no delays..._\n\n');

  for (let i = 1; i <= 50; i++) {
    if (token.isCancellationRequested) {break;}
    extendedStream.thinkingProgress!({
      text: `[${i}] `,
      id: 'test-4',
    });
  }

  stream.markdown('\n✅ Rapid-fire test done. Check if all 50 deltas aggregated correctly.\n\n');

  // --- Phase 6: Summary checklist ---
  stream.markdown('### 6. Verification Checklist\n\n');
  stream.markdown(
    'Please verify the following:\n\n' +
    '- [ ] **Phase 2**: Single thinking block appeared as a collapsible/dedicated thinking area\n' +
    '- [ ] **Phase 3**: Thinking block and text are visually separated — text is NOT inside thinking\n' +
    '- [ ] **Phase 4**: Two distinct thinking blocks (A & B), each followed by distinct text\n' +
    '  - [ ] Text A is NOT inside thinking block A\n' +
    '  - [ ] Thinking block B is NOT merged with text A\n' +
    '  - [ ] Text B is NOT inside thinking block B\n' +
    '- [ ] **Phase 5**: All 50 rapid deltas aggregated into one thinking block (not 50 separate ones)\n\n' +
    'If any of these fail, report which phase and what you saw vs. what you expected.\n',
  );
}

// ---------------------------------------------------------------------------
// /test-question — Test questionCarousel UI flow
// ---------------------------------------------------------------------------

async function handleTestQuestionCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const s = stream as vscode.ChatResponseStream & {
    questionCarousel?(questions: ChatQuestion[], allowSkip?: boolean): Thenable<Record<string, unknown> | undefined>;
  };

  if (typeof s.questionCarousel !== 'function') {
    stream.markdown('⚠️ `questionCarousel` API not available. This requires VSCode proposed API `chatParticipantAdditions`.\n');
    return;
  }

  stream.markdown('# 🧪 Question Carousel Test\n\n');

  // Phase 1: Single-select question
  stream.markdown('### Phase 1: Single-Select Question\n\n');
  const q1 = new ChatQuestion(
    'q1',
    ChatQuestionType.SingleSelect,
    'Choose a language',
    {
      message: 'Which programming language do you prefer?',
      options: [
        { id: 'ts', label: 'TypeScript', value: 'TypeScript', detail: 'Typed JavaScript superset' },
        { id: 'py', label: 'Python', value: 'Python', detail: 'General purpose scripting' },
        { id: 'go', label: 'Go', value: 'Go', detail: 'Compiled systems language' },
        { id: 'rs', label: 'Rust', value: 'Rust', detail: 'Memory-safe systems language' },
      ],
    },
  );

  try {
    const result1 = await s.questionCarousel([q1], true);
    stream.markdown(`✅ **Phase 1 result**: ${JSON.stringify(result1)}\n\n`);
  } catch (err) {
    stream.markdown(`❌ **Phase 1 error**: ${err}\n\n`);
  }

  if (token.isCancellationRequested) {return;}

  // Phase 2: Multi-select question
  stream.markdown('### Phase 2: Multi-Select Question\n\n');
  const q2 = new ChatQuestion(
    'q2',
    ChatQuestionType.MultiSelect,
    'Select features',
    {
      message: 'Which features do you want?',
      options: [
        { id: 'auth', label: 'Authentication', value: 'Authentication' },
        { id: 'cache', label: 'Caching', value: 'Caching' },
        { id: 'log', label: 'Logging', value: 'Logging' },
        { id: 'test', label: 'Testing', value: 'Testing' },
      ],
    },
  );

  try {
    const result2 = await s.questionCarousel([q2], true);
    stream.markdown(`✅ **Phase 2 result**: ${JSON.stringify(result2)}\n\n`);
  } catch (err) {
    stream.markdown(`❌ **Phase 2 error**: ${err}\n\n`);
  }

  if (token.isCancellationRequested) {return;}

  // Phase 3: Text input question
  stream.markdown('### Phase 3: Text Input Question\n\n');
  const q3 = new ChatQuestion(
    'q3',
    ChatQuestionType.Text,
    'Project name',
    {
      message: 'What should we name the project?',
      placeholder: 'my-awesome-project',
    },
  );

  try {
    const result3 = await s.questionCarousel([q3], true);
    stream.markdown(`✅ **Phase 3 result**: ${JSON.stringify(result3)}\n\n`);
  } catch (err) {
    stream.markdown(`❌ **Phase 3 error**: ${err}\n\n`);
  }

  // Phase 4: Multiple questions at once (carousel)
  if (token.isCancellationRequested) {return;}

  stream.markdown('### Phase 4: Multi-Question Carousel\n\n');
  const q4a = new ChatQuestion(
    'q4a',
    ChatQuestionType.SingleSelect,
    'Deployment target',
    {
      message: 'Where do you want to deploy?',
      options: [
        { id: 'azure', label: 'Azure', value: 'Azure' },
        { id: 'aws', label: 'AWS', value: 'AWS' },
        { id: 'gcp', label: 'GCP', value: 'GCP' },
      ],
    },
  );
  const q4b = new ChatQuestion(
    'q4b',
    ChatQuestionType.Text,
    'Region',
    {
      message: 'Which region?',
      placeholder: 'e.g., eastus, us-west-2',
    },
  );

  try {
    const result4 = await s.questionCarousel([q4a, q4b], true);
    stream.markdown(`✅ **Phase 4 result**: ${JSON.stringify(result4)}\n\n`);
  } catch (err) {
    stream.markdown(`❌ **Phase 4 error**: ${err}\n\n`);
  }

  stream.markdown('---\n✅ Question carousel test complete.\n');
}
