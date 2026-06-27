import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { FileSnapshotRecord } from '../serializable/types';

export interface ReplayResult {
  applied: number;
  skipped: number;
  conflicts: Array<{ uri: string; reason: string }>;
  externalEdits: number;
  fallbackEdits: number;
  appliedHunks: number;
  skippedHunks: number;
}

export interface ReplayOptions {
  stream?: unknown;
  preferExternalEdit?: boolean;
  redoAlreadyApplied?: boolean;
  token?: vscode.CancellationToken;
}

export interface TextEditPartsReplayResult {
  pushed: number;
  skipped: number;
  conflicts: Array<{ uri: string; reason: string }>;
}

export interface SnapshotLineDiffSummary {
  added: number;
  removed: number;
  replacements: number;
}

type ApplyPatchResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

interface SnapshotPair {
  before: FileSnapshotRecord;
  after: FileSnapshotRecord;
}

interface ChangeRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface HunkReplacement {
  start: number;
  end: number;
  newText: string;
}

interface HunkConflict {
  reason: string;
  oldStart?: number;
  oldEnd?: number;
}

interface PrepareBaselineResult {
  ok: boolean;
  baseline: FileState;
  conflicts: HunkConflict[];
  reversedHunks: number;
  reason?: string;
}

interface ReplayPlan {
  uri: vscode.Uri;
  target: FileState;
  before: string;
  after: string;
  reversedHunks: number;
  editIndex: number;
}

type HunkPatchResult =
  | { ok: true; text: string; replacements: HunkReplacement[]; conflicts: HunkConflict[] }
  | { ok: false; reason: string; conflicts: HunkConflict[] };

type DiffOp =
  | { type: 'equal'; value: string }
  | { type: 'delete'; value: string }
  | { type: 'insert'; value: string };

export async function replaySnapshotsToWorkspace(
  snapshots: readonly FileSnapshotRecord[],
  logger?: { appendLine(message: string): void },
  options?: ReplayOptions,
): Promise<ReplayResult> {
  const result: ReplayResult = {
    applied: 0,
    skipped: 0,
    conflicts: [],
    externalEdits: 0,
    fallbackEdits: 0,
    appliedHunks: 0,
    skippedHunks: 0,
  };
  const pairs = pairSnapshots(snapshots);
  const groups = groupPairsByUri(pairs);
  const plans: ReplayPlan[] = [];

  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const uri = toFileUri(first.after.uri || first.before.uri);
    if (!uri) {
      result.conflicts.push({ uri: first.after.uri || first.before.uri, reason: 'Unsupported URI' });
      continue;
    }

    const beforeMissing = !!first.before.missing;
    const afterMissing = !!last.after.missing;
    const before = beforeMissing ? '' : first.before.content;
    const after = afterMissing ? '' : last.after.content;
    const current = readCurrent(uri);

    if (current.text === after && current.missing === afterMissing) {
      if (!options?.redoAlreadyApplied || options.token?.isCancellationRequested) {
        result.skipped += group.length;
        continue;
      }
    }

    logger?.appendLine(
      `[checkpoint-replay] baseline restore before: uri=${uri.toString()} current=${formatContentForLog(current)} ` +
      `checkpointBefore=${formatContentForLog({ text: before, missing: beforeMissing })} ` +
      `checkpointAfter=${formatContentForLog({ text: after, missing: afterMissing })}`,
    );
    const prepared = prepareCheckpointBaseline(uri, current, before, after, beforeMissing, afterMissing);
    logger?.appendLine(
      `[checkpoint-replay] baseline restore after: uri=${uri.toString()} restored=${formatContentForLog(readCurrent(uri))} ` +
      `ok=${prepared.ok} reversedHunks=${prepared.reversedHunks}`,
    );
    for (const conflict of prepared.conflicts) {
      result.skippedHunks++;
      result.conflicts.push({ uri: uri.toString(), reason: conflict.reason });
      logger?.appendLine(`[checkpoint-replay] hunk conflict: ${uri.toString()} - ${conflict.reason}`);
    }
    if (!prepared.ok) {
      result.conflicts.push({ uri: uri.toString(), reason: prepared.reason ?? 'Cannot safely restore checkpoint baseline' });
      logger?.appendLine(`[checkpoint-replay] conflict: ${uri.toString()} - ${prepared.reason ?? 'Cannot safely restore checkpoint baseline'}`);
      continue;
    }

    group.forEach((pair, index) => {
      const pairAfterMissing = !!pair.after.missing;
      plans.push({
        uri,
        target: { text: pairAfterMissing ? '' : pair.after.content, missing: pairAfterMissing },
        before: pair.before.missing ? '' : pair.before.content,
        after: pairAfterMissing ? '' : pair.after.content,
        reversedHunks: index === 0 ? prepared.reversedHunks : 0,
        editIndex: pair.before.editIndex,
      });
    });
  }

  plans.sort((a, b) => a.editIndex - b.editIndex);

  for (const plan of plans) {
    const current = readCurrent(plan.uri);
    const forwardPatch = buildForwardReplayPatch(current, plan.before, plan.after, plan.target.missing);
    if (!forwardPatch.ok) {
      result.conflicts.push({ uri: plan.uri.toString(), reason: forwardPatch.reason });
      logger?.appendLine(`[checkpoint-replay] conflict: ${plan.uri.toString()} - ${forwardPatch.reason}`);
      continue;
    }
    for (const conflict of forwardPatch.conflicts) {
      result.skippedHunks++;
      result.conflicts.push({ uri: plan.uri.toString(), reason: conflict.reason });
      logger?.appendLine(`[checkpoint-replay] hunk conflict: ${plan.uri.toString()} - ${conflict.reason}`);
    }
    result.appliedHunks += forwardPatch.replacements;
    if (forwardPatch.replacements === 0 && forwardPatch.conflicts.length > 0) {
      result.skipped++;
      continue;
    }

    const mode = await writeWithBestCheckpointIntegration(
      plan.uri,
      current,
      forwardPatch.target,
      plan.before,
      plan.after,
      options,
      logger,
    );
    if (mode === 'externalEdit') {
      result.externalEdits++;
    } else {
      result.fallbackEdits++;
    }
    result.applied++;
    logger?.appendLine(`[checkpoint-replay] applied (${mode}, rewind=${plan.reversedHunks}): ${plan.uri.toString()}`);
  }

  return result;
}

export function pushSnapshotTextEditParts(
  snapshots: readonly FileSnapshotRecord[],
  stream: unknown,
  logger?: { appendLine(message: string): void },
): TextEditPartsReplayResult {
  const result: TextEditPartsReplayResult = {
    pushed: 0,
    skipped: 0,
    conflicts: [],
  };
  const target = stream as { markdown?: (value: string) => void; push?: (part: unknown) => void } | undefined;
  const CodeblockUriCtor = (vscode as unknown as {
    ChatResponseCodeblockUriPart?: new (uri: vscode.Uri, isEdit?: boolean, undoStopId?: string) => unknown;
  }).ChatResponseCodeblockUriPart;
  const TextEditPartCtor = (vscode as unknown as {
    ChatResponseTextEditPart?: new (uri: vscode.Uri, editsOrDone: unknown) => unknown;
  }).ChatResponseTextEditPart;

  if (!target?.push || !CodeblockUriCtor || !TextEditPartCtor) {
    result.conflicts.push({ uri: '', reason: 'Restored text edit part APIs are unavailable' });
    logger?.appendLine(
      `[checkpoint-replay] restored text edit parts skipped: ` +
      `hasPush=${typeof target?.push === 'function'} ` +
      `hasCodeblockUri=${typeof CodeblockUriCtor === 'function'} ` +
      `hasTextEdit=${typeof TextEditPartCtor === 'function'}`,
    );
    return result;
  }

  for (const pair of pairSnapshotsByToolCall(snapshots)) {
    const uri = toFileUri(pair.after.uri || pair.before.uri);
    if (!uri) {
      const unsupported = pair.after.uri || pair.before.uri;
      result.conflicts.push({ uri: unsupported, reason: 'Unsupported URI' });
      continue;
    }

    const editId = pair.after.undoStopId;
    if (!editId) {
      result.conflicts.push({ uri: uri.toString(), reason: 'Missing undo stop id for restored edit' });
      result.skipped++;
      continue;
    }

    const before = pair.before.missing ? '' : pair.before.content;
    const after = pair.after.missing ? '' : pair.after.content;
    if (before === after && !!pair.before.missing === !!pair.after.missing) {
      result.skipped++;
      continue;
    }

    const summary = summarizeLineDiff(before, after);
    logger?.appendLine(
      `[checkpoint-replay] restored text edit diff: uri=${uri.toString()} ` +
      `toolCallId=${pair.after.toolCallId || pair.before.toolCallId || '(none)'} ` +
      `editId=${editId} added=${summary.added} removed=${summary.removed} ` +
      `replacements=${summary.replacements} textEditPayload=empty+done`,
    );

    target.markdown?.call(target, '\n````\n');
    target.push.call(target, new CodeblockUriCtor(uri, true, editId));
    target.push.call(target, new TextEditPartCtor(uri, []));
    target.push.call(target, new TextEditPartCtor(uri, true));
    target.markdown?.call(target, '\n````\n');
    result.pushed++;
    logger?.appendLine(
      `[checkpoint-replay] restored text edit parts pushed: uri=${uri.toString()} ` +
      `editId=${editId}`,
    );
  }

  return result;
}

export function summarizeSnapshotLineDiff(
  before: string,
  after: string,
): SnapshotLineDiffSummary {
  return summarizeLineDiff(before, after);
}

async function writeWithBestCheckpointIntegration(
  uri: vscode.Uri,
  current: FileState,
  next: FileState,
  before: string,
  after: string,
  options?: ReplayOptions,
  logger?: { appendLine(message: string): void },
): Promise<'externalEdit' | 'workspace'> {
  const stream = options?.stream as {
    externalEdit?: (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => Thenable<string>;
  } | undefined;

  if (options?.preferExternalEdit && stream?.externalEdit && !options.token?.isCancellationRequested) {
    logger?.appendLine(
      `[checkpoint-replay] externalEdit begin: uri=${uri.toString()} fsPath=${uri.fsPath} ` +
      `disk=${describeFileState(readCurrent(uri))} expectedBefore=${describeTextState(before, false)} ` +
      `expectedAfter=${describeTextState(after, next.missing)} target=${describeFileState(next)}`,
    );
    logger?.appendLine(
      `[checkpoint-replay] replay before: uri=${uri.toString()} current=${formatContentForLog(readCurrent(uri))} ` +
      `replayBefore=${formatContentForLog({ text: before, missing: false })} ` +
      `replayAfter=${formatContentForLog({ text: after, missing: next.missing })} ` +
      `target=${formatContentForLog(next)}`,
    );

    const settled = await settleWithTimeoutStatus(stream.externalEdit(uri, async () => {
      const beforeWrite = readCurrent(uri);
      logger?.appendLine(
        `[checkpoint-replay] externalEdit callback before-write: uri=${uri.toString()} ` +
        `disk=${describeFileState(beforeWrite)} content=${formatContentForLog(beforeWrite)}`,
      );
      if (!options.token?.isCancellationRequested) {
        writeDirectFromCheckpointPatch(uri, next, before, after);
      }
      const afterWrite = readCurrent(uri);
      logger?.appendLine(
        `[checkpoint-replay] externalEdit callback after-write: uri=${uri.toString()} ` +
        `disk=${describeFileState(afterWrite)} content=${formatContentForLog(afterWrite)}`,
      );
    }), 10_000);

    if (settled.error) {
      logger?.appendLine(
        `[checkpoint-replay] externalEdit end: uri=${uri.toString()} error=${
          settled.error instanceof Error ? settled.error.message : String(settled.error)
        }`,
      );
    } else if (settled.timedOut) {
      logger?.appendLine(`[checkpoint-replay] externalEdit end: uri=${uri.toString()} timeout=10000ms`);
    } else {
      logger?.appendLine(
        `[checkpoint-replay] externalEdit end: uri=${uri.toString()} undoStopId=${settled.value ?? '(empty)'}`,
      );
    }

    const observed = readCurrent(uri);
    logger?.appendLine(
      `[checkpoint-replay] externalEdit observed: uri=${uri.toString()} ` +
      `disk=${describeFileState(observed)} matchesTarget=${observed.text === next.text && observed.missing === next.missing}`,
    );
    logger?.appendLine(
      `[checkpoint-replay] replay after: uri=${uri.toString()} observed=${formatContentForLog(observed)} ` +
      `target=${formatContentForLog(next)}`,
    );
    if (observed.text === next.text && observed.missing === next.missing) {
      return 'externalEdit';
    }
  }

  await writeViaWorkspaceEdit(uri, current, next, before, after);
  return 'workspace';
}

async function settleWithTimeoutStatus<T>(
  promise: Thenable<T>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; value?: T; error?: unknown }> {
  const timeoutSentinel = Symbol('timeout');
  try {
    const value = await Promise.race<T | typeof timeoutSentinel>([
      Promise.resolve(promise),
      new Promise<typeof timeoutSentinel>((resolve) => setTimeout(() => resolve(timeoutSentinel), timeoutMs)),
    ]);
    if (value === timeoutSentinel) {
      return { timedOut: true };
    }
    return { timedOut: false, value };
  } catch (error) {
    return { timedOut: false, error };
  }
}

export function applyPatchSafely(
  before: string,
  after: string,
  current: string,
): ApplyPatchResult {
  const patch = buildHunkPatch(before, after, current, false);
  if (!patch.ok) {
    return patch;
  }
  return { ok: true, text: patch.text };
}

function buildHunkPatch(
  before: string,
  after: string,
  current: string,
  allowPartial = false,
): HunkPatchResult {
  if (current === after) {
    return { ok: true, text: current, replacements: [], conflicts: [] };
  }
  if (current === before) {
    return buildDirectHunkPatch(before, after, current);
  }

  const changes = buildChangeRanges(before, after);
  if (changes.length === 0) {
    return { ok: true, text: current, replacements: [], conflicts: [] };
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let next = current;
  let cursor = 0;
  let delta = 0;
  const replacements: HunkReplacement[] = [];
  const conflicts: HunkConflict[] = [];
  for (const change of changes) {
    const oldText = beforeLines.slice(change.oldStart, change.oldEnd).join('');
    const newText = afterLines.slice(change.newStart, change.newEnd).join('');
    const match = findChangeMatch(next, beforeLines, oldText, newText, change, cursor);

    if (match.kind === 'already-applied') {
      cursor = match.end;
      continue;
    }

    if (match.kind === 'missing') {
      const conflict = {
        reason: match.reason,
        oldStart: change.oldStart,
        oldEnd: change.oldEnd,
      };
      if (!allowPartial) {
        return { ok: false, reason: match.reason, conflicts: [conflict] };
      }
      conflicts.push(conflict);
      continue;
    }

    const index = match.start;
    const end = match.end;
    next = next.slice(0, index) + newText + next.slice(end);
    replacements.push({ start: index - delta, end: end - delta, newText });
    delta += newText.length - (end - index);
    cursor = index + newText.length;
  }

  return { ok: true, text: next, replacements, conflicts };
}

function findChangeMatch(
  text: string,
  beforeLines: string[],
  oldText: string,
  newText: string,
  change: ChangeRange,
  cursor: number,
): { kind: 'replace'; start: number; end: number }
  | { kind: 'already-applied'; end: number }
  | { kind: 'missing'; reason: string } {
  if (oldText.length > 0) {
    const windowMatch = findContextWindowMatch(text, beforeLines, change, cursor);
    if (windowMatch) {
      return {
        kind: 'replace',
        start: windowMatch.start,
        end: windowMatch.end,
      };
    }

    const changedOnlyIndex = findUniqueLineBoundaryIndex(beforeLines.join(''), oldText, 0) === -2
      ? -2
      : findUniqueLineBoundaryIndex(text, oldText, cursor);
    if (changedOnlyIndex === -2) {
      return { kind: 'missing', reason: 'Current file has ambiguous matches inside an edited region' };
    }
    if (changedOnlyIndex >= 0) {
      return {
        kind: 'replace',
        start: changedOnlyIndex,
        end: changedOnlyIndex + oldText.length,
      };
    }

    const alreadyAppliedIndex = findLineBoundaryIndex(text, newText, cursor);
    if (alreadyAppliedIndex >= 0) {
      return { kind: 'already-applied', end: alreadyAppliedIndex + newText.length };
    }

    return { kind: 'missing', reason: 'Current file changed inside an edited region' };
  }

  const insertionPoint = findInsertionPoint(text, beforeLines, change, cursor);
  if (insertionPoint >= 0) {
    if (newText.length > 0 && text.slice(insertionPoint, insertionPoint + newText.length) === newText) {
      return { kind: 'already-applied', end: insertionPoint + newText.length };
    }
    return { kind: 'replace', start: insertionPoint, end: insertionPoint };
  }

  const alreadyAppliedIndex = findLineBoundaryIndex(text, newText, cursor);
  if (alreadyAppliedIndex >= 0) {
    return { kind: 'already-applied', end: alreadyAppliedIndex + newText.length };
  }

  return { kind: 'missing', reason: 'Cannot safely apply insertion without stable context' };
}

function findContextWindowMatch(
  text: string,
  beforeLines: string[],
  change: ChangeRange,
  cursor: number,
): { start: number; end: number } | undefined {
  const context = 3;
  const oldStart = Math.max(0, change.oldStart - context);
  const oldEnd = Math.min(beforeLines.length, change.oldEnd + context);
  const oldWindow = beforeLines.slice(oldStart, oldEnd).join('');
  if (!oldWindow) {
    return undefined;
  }

  const index = findLineBoundaryIndex(text, oldWindow, cursor);
  if (index < 0) {
    return undefined;
  }

  const changedStart = beforeLines.slice(oldStart, change.oldStart).join('').length;
  const oldTextLength = beforeLines.slice(change.oldStart, change.oldEnd).join('').length;
  return {
    start: index + changedStart,
    end: index + changedStart + oldTextLength,
  };
}

function findInsertionPoint(
  text: string,
  beforeLines: string[],
  change: ChangeRange,
  cursor: number,
): number {
  const windowMatch = findContextWindowMatch(text, beforeLines, change, cursor);
  if (windowMatch) {
    return windowMatch.start;
  }

  const previousLine = change.oldStart > 0 ? beforeLines[change.oldStart - 1] : '';
  const nextLine = change.oldStart < beforeLines.length ? beforeLines[change.oldStart] : '';

  if (previousLine) {
    const prefixIndex = findLineBoundaryIndex(text, previousLine, cursor);
    if (prefixIndex >= 0) {
      const point = prefixIndex + previousLine.length;
      if (!nextLine || text.slice(point, point + nextLine.length) === nextLine) {
        return point;
      }
    }
  }

  if (nextLine) {
    const suffixIndex = findLineBoundaryIndex(text, nextLine, cursor);
    if (suffixIndex >= 0) {
      return suffixIndex;
    }
  }

  if (beforeLines.length === 0 && text.length === 0) {
    return 0;
  }

  return -1;
}

function buildChangeRanges(before: string, after: string): ChangeRange[] {
  const ops = diffLines(splitLines(before), splitLines(after));
  const changes: ChangeRange[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let active: ChangeRange | undefined;

  const flush = () => {
    if (active) {
      changes.push(active);
      active = undefined;
    }
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      flush();
      oldIndex++;
      newIndex++;
      continue;
    }

    if (!active) {
      active = { oldStart: oldIndex, oldEnd: oldIndex, newStart: newIndex, newEnd: newIndex };
    }

    if (op.type === 'delete') {
      oldIndex++;
      active.oldEnd = oldIndex;
    } else {
      newIndex++;
      active.newEnd = newIndex;
    }
  }
  flush();
  return changes;
}

function summarizeLineDiff(before: string, after: string): SnapshotLineDiffSummary {
  let added = 0;
  let removed = 0;
  const changes = buildChangeRanges(before, after);

  for (const change of changes) {
    added += Math.max(0, change.newEnd - change.newStart);
    removed += Math.max(0, change.oldEnd - change.oldStart);
  }

  return { added, removed, replacements: changes.length };
}

function lineOffset(lines: readonly string[], line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += lines[i]?.length ?? 0;
  }
  return offset;
}

function applyReplacements(text: string, replacements: readonly HunkReplacement[]): string {
  let next = text;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, replacement.start) + replacement.newText + next.slice(replacement.end);
  }
  return next;
}

function buildDirectHunkPatch(before: string, after: string, current: string): HunkPatchResult {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const changes = buildChangeRanges(before, after);
  if (changes.length === 0) {
    return { ok: true, text: current, replacements: [], conflicts: [] };
  }

  const replacements = changes.map((change) => ({
    start: lineOffset(beforeLines, change.oldStart),
    end: lineOffset(beforeLines, change.oldEnd),
    newText: afterLines.slice(change.newStart, change.newEnd).join(''),
  }));

  return { ok: true, text: applyReplacements(current, replacements), replacements, conflicts: [] };
}

function findLineBoundaryIndex(text: string, needle: string, fromIndex: number): number {
  let index = text.indexOf(needle, fromIndex);
  while (index >= 0) {
    if (index === 0 || text[index - 1] === '\n' || text[index - 1] === '\r') {
      return index;
    }
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

function findUniqueLineBoundaryIndex(text: string, needle: string, fromIndex: number): number {
  let match = -1;
  let count = 0;
  let searchFrom = fromIndex;
  while (true) {
    const index = findLineBoundaryIndex(text, needle, searchFrom);
    if (index < 0) {
      break;
    }
    match = index;
    count++;
    if (count > 1) {
      return -2;
    }
    searchFrom = index + Math.max(needle.length, 1);
  }
  return match;
}

function pairSnapshots(snapshots: readonly FileSnapshotRecord[]): SnapshotPair[] {
  const byKey = new Map<string, Partial<SnapshotPair>>();
  for (const snapshot of snapshots) {
    if (!snapshot.toolCallId || !snapshot.uri) continue;
    const key = `${snapshot.toolCallId}\n${normalizeSnapshotUriKey(snapshot.uri)}`;
    const entry = byKey.get(key) ?? {};
    if (snapshot.phase === 'after') {
      entry.after = snapshot;
    } else {
      entry.before = snapshot;
    }
    byKey.set(key, entry);
  }

  const perEditPairs = Array.from(byKey.values())
    .filter((entry): entry is SnapshotPair => !!entry.before && !!entry.after)
    .sort((a, b) => a.before.editIndex - b.before.editIndex);

  return coalescePairsByTurnAndUri(perEditPairs);
}

function pairSnapshotsByToolCall(snapshots: readonly FileSnapshotRecord[]): SnapshotPair[] {
  const byKey = new Map<string, Partial<SnapshotPair>>();
  for (const snapshot of snapshots) {
    if (!snapshot.toolCallId || !snapshot.uri) continue;
    const key = `${snapshot.toolCallId}\n${normalizeSnapshotUriKey(snapshot.uri)}`;
    const entry = byKey.get(key) ?? {};
    if (snapshot.phase === 'after') {
      entry.after = snapshot;
    } else {
      entry.before = snapshot;
    }
    byKey.set(key, entry);
  }

  return Array.from(byKey.values())
    .filter((entry): entry is SnapshotPair => !!entry.before && !!entry.after)
    .sort((a, b) => a.before.editIndex - b.before.editIndex);
}

function coalescePairsByTurnAndUri(pairs: readonly SnapshotPair[]): SnapshotPair[] {
  const byTurnAndUri = new Map<string, SnapshotPair>();
  for (const pair of pairs) {
    const turn = pair.before.turnIndex ?? pair.after.turnIndex;
    const boundary = typeof turn === 'number' && Number.isFinite(turn)
      ? `turn:${turn}`
      : `edit:${pair.before.editIndex}`;
    const key = `${boundary}\n${normalizeSnapshotUriKey(pair.after.uri || pair.before.uri)}`;
    const existing = byTurnAndUri.get(key);
    if (!existing) {
      byTurnAndUri.set(key, pair);
      continue;
    }

    byTurnAndUri.set(key, {
      before: existing.before.editIndex <= pair.before.editIndex ? existing.before : pair.before,
      after: existing.after.editIndex >= pair.after.editIndex ? existing.after : pair.after,
    });
  }

  return Array.from(byTurnAndUri.values()).sort((a, b) => a.before.editIndex - b.before.editIndex);
}

function groupPairsByUri(pairs: readonly SnapshotPair[]): SnapshotPair[][] {
  const byUri = new Map<string, SnapshotPair[]>();
  for (const pair of pairs) {
    const key = normalizeSnapshotUriKey(pair.after.uri || pair.before.uri);
    const group = byUri.get(key) ?? [];
    group.push(pair);
    byUri.set(key, group);
  }

  return Array.from(byUri.values()).map(group => group.sort((a, b) => a.before.editIndex - b.before.editIndex));
}

function toFileUri(value: string): vscode.Uri | null {
  try {
    if (value.startsWith('file:')) {
      return vscode.Uri.parse(value);
    }
    return vscode.Uri.file(value);
  } catch {
    return null;
  }
}

function normalizeSnapshotUriKey(value: string): string {
  const uri = toFileUri(value);
  const key = uri?.toString() ?? value;
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

interface FileState {
  text: string;
  missing: boolean;
}

function describeFileState(state: FileState): string {
  return describeTextState(state.text, state.missing);
}

function formatContentForLog(state: FileState): string {
  if (state.missing) {
    return '{missing=true, content="<missing>"}';
  }
  return `{missing=false, length=${state.text.length}, hash=${hashText(state.text)}, content=${JSON.stringify(state.text)}}`;
}

function describeTextState(text: string, missing: boolean): string {
  if (missing) {
    return 'missing=true length=0 hash=missing';
  }
  return `missing=false length=${text.length} hash=${hashText(text)}`;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function readCurrent(uri: vscode.Uri): FileState {
  if (!existsSync(uri.fsPath)) {
    return { text: '', missing: true };
  }
  return { text: readFileSync(uri.fsPath, 'utf-8'), missing: false };
}

function prepareCheckpointBaseline(
  uri: vscode.Uri,
  current: FileState,
  before: string,
  after: string,
  beforeMissing: boolean,
  afterMissing: boolean,
): PrepareBaselineResult {
  const checkpoint = { text: before, missing: beforeMissing };
  if (current.text === before && current.missing === beforeMissing) {
    return { ok: true, baseline: checkpoint, conflicts: [], reversedHunks: 0 };
  }

  if (beforeMissing || afterMissing) {
    if (afterMissing && current.missing) {
      writeDirect(uri, checkpoint);
      return { ok: true, baseline: checkpoint, conflicts: [], reversedHunks: 0 };
    }
    if (beforeMissing && current.text === after && !current.missing) {
      writeDirect(uri, checkpoint);
      return { ok: true, baseline: checkpoint, conflicts: [], reversedHunks: 0 };
    }
    if (afterMissing && current.text !== before) {
      return {
        ok: false,
        baseline: current,
        conflicts: [],
        reversedHunks: 0,
        reason: 'Current file changed before deletion restore',
      };
    }
    if (beforeMissing && !current.missing && current.text !== '') {
      return {
        ok: false,
        baseline: current,
        conflicts: [],
        reversedHunks: 0,
        reason: 'Current file already exists',
      };
    }
    writeDirect(uri, checkpoint);
    return { ok: true, baseline: checkpoint, conflicts: [], reversedHunks: 0 };
  }

  if (current.missing) {
    return {
      ok: false,
      baseline: current,
      conflicts: [],
      reversedHunks: 0,
      reason: 'Current file missing before checkpoint restore',
    };
  }

  const patch = buildHunkPatch(after, before, current.text, true);
  if (!patch.ok) {
    return {
      ok: false,
      baseline: current,
      conflicts: patch.conflicts,
      reversedHunks: 0,
      reason: patch.reason,
    };
  }
  if (patch.replacements.length > 0) {
    mkdirSync(dirname(uri.fsPath), { recursive: true });
    writeFileSync(uri.fsPath, patch.text, 'utf-8');
  }

  return {
    ok: true,
    baseline: readCurrent(uri),
    conflicts: [],
    reversedHunks: patch.replacements.length,
  };
}

function buildForwardReplayPatch(
  baseline: FileState,
  before: string,
  after: string,
  afterMissing: boolean,
): { ok: true; target: FileState; replacements: number; conflicts: HunkConflict[] } | { ok: false; reason: string; conflicts: HunkConflict[] } {
  if (afterMissing) {
    return { ok: true, target: { text: '', missing: true }, replacements: 1, conflicts: [] };
  }
  if (baseline.missing) {
    return { ok: true, target: { text: after, missing: false }, replacements: 1, conflicts: [] };
  }

  const patch = buildHunkPatch(before, after, baseline.text, true);
  if (!patch.ok) {
    return { ok: false, reason: patch.reason, conflicts: patch.conflicts };
  }
  return {
    ok: true,
    target: { text: patch.text, missing: false },
    replacements: patch.replacements.length,
    conflicts: patch.conflicts,
  };
}

async function writeViaWorkspaceEdit(
  uri: vscode.Uri,
  current: FileState,
  next: FileState,
  before: string,
  after: string,
): Promise<void> {
  const WorkspaceEditCtor = (vscode as unknown as { WorkspaceEdit?: new () => vscode.WorkspaceEdit }).WorkspaceEdit;
  if (!WorkspaceEditCtor || typeof vscode.workspace.applyEdit !== 'function') {
    writeDirectFromCheckpointPatch(uri, next, before, after);
    return;
  }

  const edit = new WorkspaceEditCtor();
  if (next.missing) {
    if (!current.missing && typeof edit.deleteFile === 'function') {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
    } else {
      writeDirect(uri, next);
      return;
    }
  } else if (current.missing && typeof edit.createFile === 'function') {
    edit.createFile(uri, { overwrite: true, ignoreIfExists: true });
    edit.replace(uri, new vscode.Range(0, 0, 0, 0), next.text);
  } else {
    const patch = buildHunkPatch(before, after, current.text, true);
    if (!patch.ok || patch.replacements.length === 0) {
      return;
    }
    for (const replacement of [...patch.replacements].reverse()) {
      edit.replace(uri, rangeFromOffsets(current.text, replacement.start, replacement.end), replacement.newText);
    }
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    writeDirectFromCheckpointPatch(uri, next, before, after);
  }
}

function rangeFromOffsets(text: string, start: number, end: number): vscode.Range {
  const startPos = positionAtOffset(text, start);
  const endPos = positionAtOffset(text, end);
  return new vscode.Range(startPos.line, startPos.character, endPos.line, endPos.character);
}

function positionAtOffset(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  const bounded = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < bounded; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: bounded - lineStart };
}

function writeDirect(uri: vscode.Uri, next: FileState): void {
  if (next.missing) {
    if (existsSync(uri.fsPath)) {
      unlinkSync(uri.fsPath);
    }
    return;
  }

  mkdirSync(dirname(uri.fsPath), { recursive: true });
  writeFileSync(uri.fsPath, next.text, 'utf-8');
}

function writeDirectFromCheckpointPatch(
  uri: vscode.Uri,
  next: FileState,
  before: string,
  after: string,
): void {
  const current = readCurrent(uri);
  if (current.missing || next.missing) {
    writeDirect(uri, next);
    return;
  }

  const patch = buildHunkPatch(before, after, current.text, true);
  if (!patch.ok) {
    throw new Error(patch.reason);
  }
  if (patch.replacements.length === 0) {
    return;
  }

  mkdirSync(dirname(uri.fsPath), { recursive: true });
  writeFileSync(uri.fsPath, patch.text, 'utf-8');
}

function diffLines(before: string[], after: string[]): DiffOp[] {
  const m = before.length;
  const n = after.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', value: before[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', value: before[i++] });
    } else {
      ops.push({ type: 'insert', value: after[j++] });
    }
  }
  while (i < m) ops.push({ type: 'delete', value: before[i++] });
  while (j < n) ops.push({ type: 'insert', value: after[j++] });
  return ops;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}
