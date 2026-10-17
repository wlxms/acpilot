import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyPatchSafely, replaySnapshotsToWorkspace, summarizeSnapshotLineDiff } from '../../backend/checkpoint/replay';
import type { FileSnapshotRecord } from '../../ssp/types';

describe('checkpoint replay', () => {
  it('summarizes restored snapshot line diffs for edit bubble diagnostics', () => {
    expect(summarizeSnapshotLineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
      added: 1,
      removed: 1,
      replacements: 1,
    });
    expect(summarizeSnapshotLineDiff('a\nc\n', 'a\nb\nc\n')).toEqual({
      added: 1,
      removed: 0,
      replacements: 1,
    });
    expect(summarizeSnapshotLineDiff('a\nb\nc\n', 'a\nc\n')).toEqual({
      added: 0,
      removed: 1,
      replacements: 1,
    });
  });

  it('replays agent edits when current still equals baseline', () => {
    const result = applyPatchSafely(
      'a\nb\nc\n',
      'a\nB\nc\n',
      'a\nb\nc\n',
    );

    expect(result).toEqual({ ok: true, text: 'a\nB\nc\n' });
  });

  it('preserves user edits outside the changed region', () => {
    const result = applyPatchSafely(
      'a\nb\nc\nd\ne\nf\ng\nh\n',
      'a\nb\nC\nd\ne\nf\ng\nh\n',
      'USER\nb\nc\nd\ne\nf\ng\nh\n',
    );

    expect(result).toEqual({ ok: true, text: 'USER\nb\nC\nd\ne\nf\ng\nh\n' });
  });

  it('preserves user insertions before restored hunks', () => {
    const result = applyPatchSafely(
      'a\nb\nc\nd\n',
      'a\nB\nc\nD\n',
      'USER\na\nb\nc\nd\n',
    );

    expect(result).toEqual({ ok: true, text: 'USER\na\nB\nc\nD\n' });
  });

  it('applies pure insertions using nearby context', () => {
    const result = applyPatchSafely(
      'a\nb\nc\n',
      'a\nb\nINSERTED\nc\n',
      'USER\na\nb\nc\nTAIL\n',
    );

    expect(result).toEqual({ ok: true, text: 'USER\na\nb\nINSERTED\nc\nTAIL\n' });
  });

  it('detects conflicts when user edits overlap agent edits', () => {
    const result = applyPatchSafely(
      'a\nb\nc\n',
      'a\nB\nc\n',
      'a\nuser-b\nc\n',
    );

    expect(result.ok).toBe(false);
  });

  it('applies clean hunks and skips conflicting hunks during workspace replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-partial-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nuser-b\nc\nd\ne\nf\n', 'utf-8');
    const uri = vscode.Uri.file(file);

    const result = await replaySnapshotsToWorkspace(makePair(
      uri,
      'a\nb\nc\nd\ne\nf\n',
      'a\nB\nc\nd\nE\nf\n',
    ));

    expect(result.applied).toBe(1);
    expect(result.appliedHunks).toBe(1);
    expect(result.skippedHunks).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nuser-b\nc\nd\nE\nf\n');
  });

  it('is idempotent when the agent hunk is already applied', () => {
    const result = applyPatchSafely(
      'a\nb\nc\n',
      'a\nB\nc\n',
      'a\nB\nc\nUSER\n',
    );

    expect(result).toEqual({ ok: true, text: 'a\nB\nc\nUSER\n' });
  });

  it('prefers direct stream.externalEdit for restore replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-external-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const pushed: unknown[] = [];
    const externalEdit = vi.fn(async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      await callback();
      return 'undo-stop';
    });

    const result = await replaySnapshotsToWorkspace(makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n'), undefined, {
      stream: { push: (part: unknown) => pushed.push(part), externalEdit },
      preferExternalEdit: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(result.fallbackEdits).toBe(0);
    expect(externalEdit).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
  });

  it('falls back to workspace edits when only push is available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-external-direct-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const originalApplyEdit = vscode.workspace.applyEdit;
    const applyEdit = vi.fn(originalApplyEdit);
    const pushed: unknown[] = [];

    (vscode.workspace as any).applyEdit = applyEdit;
    try {
      const result = await replaySnapshotsToWorkspace(makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n'), undefined, {
        stream: { push: (part: unknown) => pushed.push(part) },
        preferExternalEdit: true,
      });

      expect(result.applied).toBe(1);
      expect(result.externalEdits).toBe(0);
      expect(result.fallbackEdits).toBe(1);
      expect(pushed).toHaveLength(0);
      expect(applyEdit).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
    } finally {
      (vscode.workspace as any).applyEdit = originalApplyEdit;
    }
  });

  it('uses direct file writes inside stream.externalEdit callbacks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-external-method-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const originalApplyEdit = vscode.workspace.applyEdit;
    const applyEdit = vi.fn(originalApplyEdit);
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      await callback();
      return 'undo-stop';
    };

    (vscode.workspace as any).applyEdit = applyEdit;
    try {
      const result = await replaySnapshotsToWorkspace(makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n'), undefined, {
        stream: { externalEdit },
        preferExternalEdit: true,
      });

      expect(result.applied).toBe(1);
      expect(result.externalEdits).toBe(1);
      expect(result.fallbackEdits).toBe(0);
      expect(applyEdit).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
    } finally {
      (vscode.workspace as any).applyEdit = originalApplyEdit;
    }
  });

  it('does not synthesize ChatResponseExternalEditPart when only push is available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-external-part-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const pushed: unknown[] = [];

    const result = await replaySnapshotsToWorkspace(makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n'), undefined, {
      stream: { push: (part: unknown) => pushed.push(part) },
      preferExternalEdit: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(0);
    expect(result.fallbackEdits).toBe(1);
    expect(pushed).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
  });

  it('restores the checkpoint before starting external edit replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-baseline-first-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nB\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const observedInCallback: string[] = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      observedInCallback.push(fs.readFileSync(file, 'utf-8'));
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n'), undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(observedInCallback).toEqual(['a\nb\nc\n']);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
  });

  it('restores all checkpoints before replaying any external edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-all-baselines-first-'));
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    fs.writeFileSync(first, 'a\nA\n', 'utf-8');
    fs.writeFileSync(second, 'b\nB\n', 'utf-8');
    const firstUri = vscode.Uri.file(first);
    const secondUri = vscode.Uri.file(second);
    const observedAtFirstCallback: string[] = [];
    const externalEdit = async (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const uris = Array.isArray(target) ? target : [target];
      if (uris[0]?.fsPath === firstUri.fsPath) {
        observedAtFirstCallback.push(fs.readFileSync(first, 'utf-8'));
        observedAtFirstCallback.push(fs.readFileSync(second, 'utf-8'));
      }
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace([
      ...makePair(firstUri, 'a\na\n', 'a\nA\n', false, false, 'tool-1', 1, 0),
      ...makePair(secondUri, 'b\nb\n', 'b\nB\n', false, false, 'tool-2', 2, 0),
    ], undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(2);
    expect(observedAtFirstCallback).toEqual(['a\na\n', 'b\nb\n']);
    expect(fs.readFileSync(first, 'utf-8')).toBe('a\nA\n');
    expect(fs.readFileSync(second, 'utf-8')).toBe('b\nB\n');
  });

  it('coalesces repeated snapshots for the same file within a turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-coalesce-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const externalEdit = vi.fn(async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      await callback();
      return 'undo-stop';
    });

    const result = await replaySnapshotsToWorkspace([
      ...makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n', false, false, 'tool-1', 1, 0),
      ...makePair(uri, 'a\nB\nc\n', 'a\nBB\nc\n', false, false, 'tool-2', 2, 0),
    ], undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(externalEdit).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nBB\nc\n');
  });

  it('keeps replay boundaries across turns for the same file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-turn-boundary-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);

    const result = await replaySnapshotsToWorkspace([
      ...makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n', false, false, 'tool-1', 1, 0),
      ...makePair(uri, 'a\nB\nc\n', 'a\nBB\nc\n', false, false, 'tool-2', 2, 1),
    ]);

    expect(result.applied).toBe(2);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nBB\nc\n');
  });

  it('falls back to workspace edits when no restore stream is available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-fallback-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    const uri = vscode.Uri.file(file);

    const result = await replaySnapshotsToWorkspace(makePair(uri, 'a\nb\nc\n', 'a\nB\nc\n'));

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(0);
    expect(result.fallbackEdits).toBe(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nB\nc\n');
  });

  it('writes restore changes as hunk ranges instead of full-document replacement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-hunk-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nb\nc\nd\ne\nf\ng\nh\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const originalApplyEdit = vscode.workspace.applyEdit;
    const operations: any[] = [];

    (vscode.workspace as any).applyEdit = async (edit: any) => {
      operations.push(...edit.operations);
      return originalApplyEdit(edit);
    };

    try {
      const result = await replaySnapshotsToWorkspace(makePair(
        uri,
        'a\nb\nc\nd\ne\nf\ng\nh\n',
        'a\nb\nC\nd\ne\nf\ng\nh\n',
      ));

      expect(result.applied).toBe(1);
      const replaceOps = operations.filter((op) => op.type === 'replace');
      expect(replaceOps).toHaveLength(1);
      expect(replaceOps[0].range.startLine).toBeGreaterThan(0);
      expect(replaceOps[0].range.endLine).toBeLessThan(8);
      expect(replaceOps[0].text).not.toBe('a\nb\nC\nd\ne\nf\ng\nh\n');
      expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\nC\nd\ne\nf\ng\nh\n');
    } finally {
      (vscode.workspace as any).applyEdit = originalApplyEdit;
    }
  });

  it('restores file creation checkpoints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-create-'));
    const file = path.join(dir, 'new.txt');
    const uri = vscode.Uri.file(file);

    const result = await replaySnapshotsToWorkspace(makePair(uri, '', 'created\n', true, false));

    expect(result.applied).toBe(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('created\n');
  });

  it('restores file deletion checkpoints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-delete-'));
    const file = path.join(dir, 'old.txt');
    fs.writeFileSync(file, 'delete me\n', 'utf-8');
    const uri = vscode.Uri.file(file);

    const result = await replaySnapshotsToWorkspace(makePair(uri, 'delete me\n', '', false, true));

    expect(result.applied).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('redoes an already-created file through external edit during restore replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-redo-create-'));
    const file = path.join(dir, 'new.txt');
    fs.writeFileSync(file, 'created\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const externalCalls: Array<{ existsAtStart: boolean; existsAtEnd: boolean }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      externalCalls.push({ existsAtStart: fs.existsSync(file), existsAtEnd: false });
      await callback();
      externalCalls[externalCalls.length - 1].existsAtEnd = fs.existsSync(file);
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(makePair(uri, '', 'created\n', true, false), undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(externalCalls).toEqual([{ existsAtStart: false, existsAtEnd: true }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('created\n');
  });

  it('redoes an already-deleted file through external edit during restore replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-redo-delete-'));
    const file = path.join(dir, 'old.txt');
    const uri = vscode.Uri.file(file);
    const externalCalls: Array<{ contentAtStart: string; existsAtEnd: boolean }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      externalCalls.push({ contentAtStart: fs.readFileSync(file, 'utf-8'), existsAtEnd: true });
      await callback();
      externalCalls[externalCalls.length - 1].existsAtEnd = fs.existsSync(file);
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(makePair(uri, 'delete me\n', '', false, true), undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(externalCalls).toEqual([{ contentAtStart: 'delete me\n', existsAtEnd: false }]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('simulates normal hunk restore and replay for one file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-normal-one-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'one\nTWO\nthree\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const callbackStates: Array<{ beforeCallback: string; afterCallback: string }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const beforeCallback = fs.readFileSync(file, 'utf-8');
      await callback();
      callbackStates.push({ beforeCallback, afterCallback: fs.readFileSync(file, 'utf-8') });
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(
      makePair(uri, 'one\ntwo\nthree\n', 'one\nTWO\nthree\n'),
      undefined,
      { stream: { externalEdit }, preferExternalEdit: true, redoAlreadyApplied: true },
    );

    expect(result).toMatchObject({
      applied: 1,
      conflicts: [],
      externalEdits: 1,
      skippedHunks: 0,
    });
    expect(callbackStates).toEqual([{ beforeCallback: 'one\ntwo\nthree\n', afterCallback: 'one\nTWO\nthree\n' }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('one\nTWO\nthree\n');
  });

  it('simulates normal hunk restore before replaying multiple files and events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-normal-many-'));
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    fs.writeFileSync(first, 'a\nA2\nA3\n', 'utf-8');
    fs.writeFileSync(second, 'b\nB\n', 'utf-8');
    const firstUri = vscode.Uri.file(first);
    const secondUri = vscode.Uri.file(second);
    const firstCallbackStates: string[] = [];
    const externalEdit = async (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const uris = Array.isArray(target) ? target : [target];
      if (uris[0]?.fsPath === firstUri.fsPath) {
        firstCallbackStates.push(fs.readFileSync(first, 'utf-8'));
        firstCallbackStates.push(fs.readFileSync(second, 'utf-8'));
      }
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace([
      ...makePair(firstUri, 'a\na2\na3\n', 'a\nA2\na3\n', false, false, 'tool-1', 1, 0),
      ...makePair(secondUri, 'b\nb\n', 'b\nB\n', false, false, 'tool-2', 2, 0),
      ...makePair(firstUri, 'a\nA2\na3\n', 'a\nA2\nA3\n', false, false, 'tool-3', 3, 1),
    ], undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(3);
    expect(result.conflicts).toEqual([]);
    expect(result.externalEdits).toBe(3);
    expect(firstCallbackStates.slice(0, 2)).toEqual(['a\na2\na3\n', 'b\nb\n']);
    expect(firstCallbackStates).toHaveLength(4);
    expect(fs.readFileSync(first, 'utf-8')).toBe('a\nA2\nA3\n');
    expect(fs.readFileSync(second, 'utf-8')).toBe('b\nB\n');
  });

  it('detects restore-time hunk conflicts while replaying safe hunks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-restore-conflict-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'a\nUSER\nc\nD\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const callbackStates: string[] = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      callbackStates.push(fs.readFileSync(file, 'utf-8'));
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(
      makePair(uri, 'a\nb\nc\nd\n', 'a\nB\nc\nD\n'),
      undefined,
      { stream: { externalEdit }, preferExternalEdit: true, redoAlreadyApplied: true },
    );

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(result.skippedHunks).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toContain('Current file changed inside an edited region');
    expect(callbackStates).toEqual(['a\nUSER\nc\nd\n']);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nUSER\nc\nD\n');
  });

  it('detects replay-time hunk conflicts after baseline restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-replay-conflict-'));
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    fs.writeFileSync(first, 'one\nONE\n', 'utf-8');
    fs.writeFileSync(second, 'two\nTWO\n', 'utf-8');
    const firstUri = vscode.Uri.file(first);
    const secondUri = vscode.Uri.file(second);
    const externalEdit = async (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      await callback();
      const uris = Array.isArray(target) ? target : [target];
      if (uris[0]?.fsPath === firstUri.fsPath) {
        fs.writeFileSync(second, 'two\nUSER\n', 'utf-8');
      }
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace([
      ...makePair(firstUri, 'one\none\n', 'one\nONE\n', false, false, 'tool-1', 1, 0),
      ...makePair(secondUri, 'two\ntwo\n', 'two\nTWO\n', false, false, 'tool-2', 2, 0),
    ], undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(result.skippedHunks).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].uri).toBe(secondUri.toString());
    expect(fs.readFileSync(first, 'utf-8')).toBe('one\nONE\n');
    expect(fs.readFileSync(second, 'utf-8')).toBe('two\nUSER\n');
  });

  it('simulates file creation restore and replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-create-'));
    const file = path.join(dir, 'created.txt');
    fs.writeFileSync(file, 'created\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const existsInCallback: boolean[] = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      existsInCallback.push(fs.existsSync(file));
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(
      makePair(uri, '', 'created\n', true, false),
      undefined,
      { stream: { externalEdit }, preferExternalEdit: true, redoAlreadyApplied: true },
    );

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(existsInCallback).toEqual([false]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('created\n');
  });

  it('simulates file deletion restore and replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-delete-'));
    const file = path.join(dir, 'deleted.txt');
    const uri = vscode.Uri.file(file);
    const contentInCallback: string[] = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      contentInCallback.push(fs.readFileSync(file, 'utf-8'));
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(
      makePair(uri, 'delete me\n', '', false, true),
      undefined,
      { stream: { externalEdit }, preferExternalEdit: true, redoAlreadyApplied: true },
    );

    expect(result.applied).toBe(1);
    expect(result.externalEdits).toBe(1);
    expect(contentInCallback).toEqual(['delete me\n']);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('simulates a modified file that was later deleted and is already missing on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sim-modify-then-delete-'));
    const file = path.join(dir, 'gone.txt');
    const uri = vscode.Uri.file(file);
    const callbackStates: Array<{ exists: boolean; content: string | undefined }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      callbackStates.push({
        exists: fs.existsSync(file),
        content: fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined,
      });
      await callback();
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace([
      ...makePair(uri, 'alpha\nbeta\n', 'alpha\nBETA\n', false, false, 'tool-1', 1, 0),
      ...makePair(uri, 'alpha\nBETA\n', '', false, true, 'tool-2', 2, 1),
    ], undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(result.applied).toBe(2);
    expect(result.externalEdits).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(callbackStates).toEqual([
      { exists: true, content: 'alpha\nbeta\n' },
      { exists: true, content: 'alpha\nBETA\n' },
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('records real edit snapshots and replays them through external edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-real-record-edit-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const trace = await recordTrackedEdit('tool-real-edit', [uri], () => {
      fs.writeFileSync(file, 'one\nTWO\nthree\n', 'utf-8');
    });

    const callbackStates: Array<{ beforeCallback: string; afterCallback: string }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const beforeCallback = fs.readFileSync(file, 'utf-8');
      await callback();
      callbackStates.push({ beforeCallback, afterCallback: fs.readFileSync(file, 'utf-8') });
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(trace.snapshots, undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(trace.beforeDisk).toEqual([{ exists: true, content: 'one\ntwo\nthree\n' }]);
    expect(trace.afterDisk).toEqual([{ exists: true, content: 'one\nTWO\nthree\n' }]);
    expect(snapshotSummary(trace.snapshots)).toEqual([
      { phase: 'before', content: 'one\ntwo\nthree\n', missing: false },
      { phase: 'after', content: 'one\nTWO\nthree\n', missing: false },
    ]);
    expect(callbackStates).toEqual([{ beforeCallback: 'one\ntwo\nthree\n', afterCallback: 'one\nTWO\nthree\n' }]);
    expect(result).toMatchObject({ applied: 1, externalEdits: 1, conflicts: [] });
    expect(fs.readFileSync(file, 'utf-8')).toBe('one\nTWO\nthree\n');
  });

  it('records real create snapshots and replays file creation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-real-record-create-'));
    const file = path.join(dir, 'created.txt');
    const uri = vscode.Uri.file(file);
    const trace = await recordTrackedEdit('tool-real-create', [uri], () => {
      fs.writeFileSync(file, 'created\n', 'utf-8');
    });

    const callbackStates: Array<{ existsBefore: boolean; existsAfter: boolean; afterContent: string }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const existsBefore = fs.existsSync(file);
      await callback();
      callbackStates.push({ existsBefore, existsAfter: fs.existsSync(file), afterContent: fs.readFileSync(file, 'utf-8') });
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(trace.snapshots, undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(trace.beforeDisk).toEqual([{ exists: false, content: undefined }]);
    expect(trace.afterDisk).toEqual([{ exists: true, content: 'created\n' }]);
    expect(snapshotSummary(trace.snapshots)).toEqual([
      { phase: 'before', content: '', missing: true },
      { phase: 'after', content: 'created\n', missing: false },
    ]);
    expect(callbackStates).toEqual([{ existsBefore: false, existsAfter: true, afterContent: 'created\n' }]);
    expect(result).toMatchObject({ applied: 1, externalEdits: 1, conflicts: [] });
    expect(fs.readFileSync(file, 'utf-8')).toBe('created\n');
  });

  it('records real delete snapshots and replays file deletion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-real-record-delete-'));
    const file = path.join(dir, 'deleted.txt');
    fs.writeFileSync(file, 'delete me\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const trace = await recordTrackedEdit('tool-real-delete', [uri], () => {
      fs.unlinkSync(file);
    });

    const callbackStates: Array<{ beforeCallback: string; existsAfter: boolean }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const beforeCallback = fs.readFileSync(file, 'utf-8');
      await callback();
      callbackStates.push({ beforeCallback, existsAfter: fs.existsSync(file) });
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(trace.snapshots, undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(trace.beforeDisk).toEqual([{ exists: true, content: 'delete me\n' }]);
    expect(trace.afterDisk).toEqual([{ exists: false, content: undefined }]);
    expect(snapshotSummary(trace.snapshots)).toEqual([
      { phase: 'before', content: 'delete me\n', missing: false },
      { phase: 'after', content: '', missing: true },
    ]);
    expect(callbackStates).toEqual([{ beforeCallback: 'delete me\n', existsAfter: false }]);
    expect(result).toMatchObject({ applied: 1, externalEdits: 1, conflicts: [] });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('records real modify-then-delete snapshots and replays both events from a missing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-real-record-modify-delete-'));
    const file = path.join(dir, 'gone.txt');
    fs.writeFileSync(file, 'alpha\nbeta\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const editTrace = await recordTrackedEdit('tool-real-modify', [uri], () => {
      fs.writeFileSync(file, 'alpha\nBETA\n', 'utf-8');
    }, 1, 0);
    const deleteTrace = await recordTrackedEdit('tool-real-delete-after-modify', [uri], () => {
      fs.unlinkSync(file);
    }, 2, 1);
    const snapshots = [...editTrace.snapshots, ...deleteTrace.snapshots];

    const callbackStates: Array<{ before: { exists: boolean; content: string | undefined }; after: { exists: boolean; content: string | undefined } }> = [];
    const externalEdit = async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      const before = fileState(file);
      await callback();
      callbackStates.push({ before, after: fileState(file) });
      return 'undo-stop';
    };

    const result = await replaySnapshotsToWorkspace(snapshots, undefined, {
      stream: { externalEdit },
      preferExternalEdit: true,
      redoAlreadyApplied: true,
    });

    expect(editTrace.beforeDisk).toEqual([{ exists: true, content: 'alpha\nbeta\n' }]);
    expect(editTrace.afterDisk).toEqual([{ exists: true, content: 'alpha\nBETA\n' }]);
    expect(deleteTrace.beforeDisk).toEqual([{ exists: true, content: 'alpha\nBETA\n' }]);
    expect(deleteTrace.afterDisk).toEqual([{ exists: false, content: undefined }]);
    expect(snapshotSummary(snapshots)).toEqual([
      { phase: 'before', content: 'alpha\nbeta\n', missing: false },
      { phase: 'after', content: 'alpha\nBETA\n', missing: false },
      { phase: 'before', content: 'alpha\nBETA\n', missing: false },
      { phase: 'after', content: '', missing: true },
    ]);
    expect(callbackStates).toEqual([
      {
        before: { exists: true, content: 'alpha\nbeta\n' },
        after: { exists: true, content: 'alpha\nBETA\n' },
      },
      {
        before: { exists: true, content: 'alpha\nBETA\n' },
        after: { exists: false, content: undefined },
      },
    ]);
    expect(result).toMatchObject({ applied: 2, externalEdits: 2, conflicts: [] });
    expect(fs.existsSync(file)).toBe(false);
  });
});

function makePair(
  uri: vscode.Uri,
  before: string,
  after: string,
  beforeMissing = false,
  afterMissing = false,
  toolCallId = 'tool-1',
  editIndex = 1,
  turnIndex?: number,
): FileSnapshotRecord[] {
  return [
    {
      uri: uri.fsPath,
      content: before,
      phase: 'before',
      missing: beforeMissing,
      editIndex,
      toolCallId,
      turnIndex,
      timestamp: '2026-06-05T00:00:00.000Z',
    },
    {
      uri: uri.fsPath,
      content: after,
      phase: 'after',
      missing: afterMissing,
      editIndex,
      toolCallId,
      turnIndex,
      timestamp: '2026-06-05T00:00:01.000Z',
    },
  ];
}

async function recordTrackedEdit(
  editKey: string,
  uris: vscode.Uri[],
  mutate: () => void,
  editIndexOffset = 0,
  turnIndex?: number,
): Promise<{ snapshots: FileSnapshotRecord[]; beforeDisk: Array<{ exists: boolean; content: string | undefined }>; afterDisk: Array<{ exists: boolean; content: string | undefined }> }> {
  const snapshots: FileSnapshotRecord[] = [];
  const captureSnapshot = (uri: vscode.Uri, phase: 'before' | 'after', i: number): FileSnapshotRecord => {
    const missing = !existsSync(uri.fsPath);
    return {
      uri: uri.toString(),
      content: missing ? '' : readFileSync(uri.fsPath, 'utf-8'),
      phase,
      turnIndex,
      editIndex: i + editIndexOffset,
      toolCallId: editKey,
      timestamp: new Date().toISOString(),
      missing,
    };
  };

  // Inline externalEdit lifecycle (replaces deleted ExternalEditTracker)
  let resolveDeferred: () => void = () => {};
  const beforeSnapshots = uris.map((uri, i) => captureSnapshot(uri, 'before', i));
  const stream = {
    externalEdit: (_target: unknown, callback: () => Thenable<unknown>): Thenable<string> => {
      return new Promise<string>(resolveComplete => {
        const run = async () => {
          await callback();
          resolveComplete('test-undo-stop');
        };
        run();
      });
    },
  } as unknown as vscode.ChatResponseStream;

  const beforeDisk = uris.map(uri => fileState(uri.fsPath));

  // Start externalEdit (baseline captured)
  await new Promise<void>(resolve => {
    const cb = async () => {
      for (const s of beforeSnapshots) {snapshots.push(s);}
      resolve();
      await new Promise<void>(r => { resolveDeferred = r; });
    };
    const externalEdit = (stream as unknown as { externalEdit: (t: unknown, cb: () => Thenable<unknown>) => Thenable<string> }).externalEdit;
    if (externalEdit) {
      externalEdit(uris, cb);
    }
    // Fallback if no externalEdit: just resolve
    if (!externalEdit) {resolve();}
  });

  mutate();

  const afterDisk = uris.map(uri => fileState(uri.fsPath));

  // Complete: resolve deferred + capture after snapshots
  resolveDeferred();
  uris.map((uri, i) => {
    const after = captureSnapshot(uri, 'after', beforeSnapshots.length + i);
    after.undoStopId = 'test-undo-stop';
    snapshots.push(after);
  });

  return { snapshots, beforeDisk, afterDisk };
}

function fileState(filePath: string): { exists: boolean; content: string | undefined } {
  return {
    exists: fs.existsSync(filePath),
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined,
  };
}

function snapshotSummary(snapshots: readonly FileSnapshotRecord[]): Array<{ phase: 'before' | 'after' | undefined; content: string; missing: boolean | undefined }> {
  return snapshots.map(snapshot => ({
    phase: snapshot.phase,
    content: snapshot.content,
    missing: snapshot.missing,
  }));
}
