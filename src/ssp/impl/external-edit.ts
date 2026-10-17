/**
 * ExternalEditSSP — manages VS Code externalEdit lifecycle for file writes.
 *
 * Kind: 'externalEdit'
 *
 * Merges the old ExternalEditTracker logic directly into the SSP.
 * No external tracker dependency — the SSP IS the lifecycle manager.
 *
 * Lifecycle:
 *   push (status='pending') → render() starts stream.externalEdit()
 *     → VS Code captures baseline
 *     → callback: emit before snapshot, onBaselineCaptured(), block on deferred
 *
 *   update (status='completed') → resolve deferred
 *     → VS Code returns undoStopId via onDidComplete
 *     → emit after snapshot with undoStopId
 *     → store undoStopId → emitStateChange → SSS writes meta.jsonl
 *
 * Implements:
 *   IMutableStreamPart — update() merges status changes
 *   IMetadataProvider — exposes undoStopId for meta.jsonl
 *   ISnapshotProvider — emits before/after snapshots for SSS persistence
 *
 * Guards:
 *   editStarted: prevents re-launching stream.externalEdit() on repeated render()
 */

import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SerializableStreamPart, type IMutableStreamPart, type IAsyncMetadataProvider, type ISnapshotProvider } from '../types';
import type { SspStream } from '../types';
import type { ExternalEditStreamPartPayload, FileSnapshotRecord, SerializableStreamPartMeta } from '../types';

// ---------------------------------------------------------------------------
// Backend callbacks
// ---------------------------------------------------------------------------

export interface ExternalEditSSPCallbacks {
  /** Called when VS Code has captured the file baseline. */
  onBaselineCaptured: () => void;
}

// ---------------------------------------------------------------------------
// ExternalEditSSP
// ---------------------------------------------------------------------------

export class ExternalEditSSP extends SerializableStreamPart<
  'externalEdit',
  ExternalEditStreamPartPayload
> implements IMutableStreamPart<ExternalEditStreamPartPayload>, IAsyncMetadataProvider, ISnapshotProvider {

  readonly kind = 'externalEdit' as const;

  private editStarted = false;
  private baselineCaptured = false;
  private deferred: { resolve: () => void; promise: Promise<void> } | null = null;
  private onDidComplete: Thenable<string> | null = null;
  private metadataSettled: Promise<void> | null = null;
  private _undoStopId: string | null = null;
  private snapshotListeners: Array<(snapshot: FileSnapshotRecord) => void> = [];

  constructor(
    payload: ExternalEditStreamPartPayload,
    private readonly callbacks?: ExternalEditSSPCallbacks,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
    private readonly directory?: string,
  ) {
    super(payload, {
      ...meta,
      subAgentId: meta?.subAgentId ?? payload.subAgentId,
      subAgentInvocationId: meta?.subAgentInvocationId ?? payload.subAgentInvocationId,
      toolCallId: meta?.toolCallId ?? payload.toolCallId,
      editId: meta?.editId ?? payload.editId,
      uri: meta?.uri ?? payload.uri,
    }, id ?? payload.toolCallId);
  }

  get undoStopId(): string | null { return this._undoStopId; }

  // ── IMetadataProvider ──────────────────────────────────────────────────

  get metaId(): string { return this.id; }

  getMetadata(): Record<string, unknown> | undefined {
    if (!this._undoStopId) {return undefined;}
    return { undoStopId: this._undoStopId };
  }

  async whenMetadataSettled(): Promise<void> {
    await this.metadataSettled;
  }

  // ── ISnapshotProvider ─────────────────────────────────────────────────

  onSnapshot(cb: (snapshot: FileSnapshotRecord) => void): () => void {
    this.snapshotListeners.push(cb);
    return () => {
      this.snapshotListeners = this.snapshotListeners.filter(listener => listener !== cb);
    };
  }

  // ── Render: start externalEdit lifecycle ───────────────────────────────

  render(stream: SspStream): void {
    if (this.editStarted || this.payload.status !== 'pending') {return;}
    if (!stream.externalEdit) {return;}
    this.editStarted = true;

    const uris = (this.payload.uris ?? []) as vscode.Uri[];
    if (uris.length === 0 && this.payload.uri) {
      uris.push(buildFileUri(this.payload.uri, this.directory));
    }
    if (uris.length === 0) {return;}

    const toolCallId = this.payload.toolCallId;
    const beforeSnapshots = uris.map((uri, i) =>
      captureSnapshot(uri, toolCallId, 'before', i, this.meta.turnIndex),
    );

    const callback = async () => {
      if (!this.baselineCaptured) {
        this.baselineCaptured = true;
        for (const s of beforeSnapshots) {this.emitSnapshot(s);}
        this.callbacks?.onBaselineCaptured();
      }

      // Block until update({status:'completed'}) resolves the deferred
      this.deferred ??= createDeferred();
      await this.deferred.promise;
    };

    this.onDidComplete = stream.externalEdit(uris, callback);
  }

  // ── IMutableStreamPart.update ──────────────────────────────────────────

  update(data: Partial<ExternalEditStreamPartPayload>): void {
    Object.assign(this.payload, data);

    if ((data.status === 'completed' || data.status === 'error') && this.deferred) {
      this.deferred.resolve();

      // Wait for VS Code to return undoStopId
      const completion = this.onDidComplete;
      if (completion) {
        this.metadataSettled = Promise.resolve(completion).then(
          (undoStopId: string) => {
            this._undoStopId = undoStopId || null;
            if (this._undoStopId) {
              this.payload.undoStopId = this._undoStopId;
              this.payload.editId = this._undoStopId;
              this.meta.editId = this._undoStopId;
            }
            // Capture after-snapshots
            const uris = (this.payload.uris ?? []) as vscode.Uri[];
            if (this.payload.uri && uris.length === 0) {
              uris.push(buildFileUri(this.payload.uri, this.directory));
            }
            for (let i = 0; i < uris.length; i++) {
              const after = captureSnapshot(uris[i], this.payload.toolCallId, 'after', i, this.meta.turnIndex);
              after.undoStopId = undoStopId || undefined;
              this.emitSnapshot(after);
            }
            this.emitStateChange();
          },
          () => {
            // onDidComplete rejected — still emit to mark completion
            this.emitStateChange();
          },
        );
      }
    }
  }

  private emitSnapshot(snapshot: FileSnapshotRecord): void {
    for (const cb of this.snapshotListeners) {cb(snapshot);}
  }
}

// ---------------------------------------------------------------------------
// Helpers (from ExternalEditTracker)
// ---------------------------------------------------------------------------

function createDeferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

function captureSnapshot(
  uri: vscode.Uri,
  toolCallId: string,
  phase: 'before' | 'after',
  editIndex: number,
  turnIndex?: number,
): FileSnapshotRecord {
  const missing = !existsSync(uri.fsPath);
  return {
    uri: uri.toString(),
    content: missing ? '' : readFileSync(uri.fsPath, 'utf-8'),
    phase,
    turnIndex,
    editIndex,
    toolCallId,
    timestamp: new Date().toISOString(),
    missing,
  };
}

function buildFileUri(filePath: string, directory?: string): vscode.Uri {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(directory ?? '', filePath);
  const rawUri = vscode.Uri.file(resolvedPath);
  const normalizedPath = /^\/[a-zA-Z]:(?=\/)/.test(rawUri.path)
    ? rawUri.path.toLowerCase()
    : rawUri.path;
  return rawUri.path !== normalizedPath
    ? rawUri.with({ path: normalizedPath })
    : rawUri;
}
