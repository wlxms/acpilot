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
 *     → callback: onSnapshot(before), onBaselineCaptured(), block on deferred
 *
 *   update (status='completed') → resolve deferred
 *     → VS Code returns undoStopId via onDidComplete
 *     → onSnapshot(after, undoStopId)
 *     → store undoStopId → emitStateChange → SSS writes meta.jsonl
 *
 * Implements:
 *   IMutableStreamPart — update() merges status changes
 *   IMetadataProvider — exposes undoStopId for meta.jsonl
 *
 * Guards:
 *   editStarted: prevents re-launching stream.externalEdit() on repeated render()
 */

import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { SerializableStreamPart, IMutableStreamPart, IAsyncMetadataProvider } from '../types';
import type { SspStream } from '../types';
import type { ExternalEditStreamPartPayload, SerializableStreamPartMeta } from '../types';
import type { FileSnapshotRecord } from '../../backend/serializable/types';

// ---------------------------------------------------------------------------
// Callbacks (injected by Bridge — backend-specific logic lives here)
// ---------------------------------------------------------------------------

export interface ExternalEditSSPCallbacks {
  /** Called when VS Code has captured the file baseline — Bridge auto-replies permission */
  onBaselineCaptured: () => void;
  /** Called with file snapshots (before/after) — Bridge serializes via SSS.serializeSnapshot */
  onSnapshot: (snapshot: FileSnapshotRecord) => void;
}

// ---------------------------------------------------------------------------
// ExternalEditSSP
// ---------------------------------------------------------------------------

export class ExternalEditSSP extends SerializableStreamPart<
  'externalEdit',
  ExternalEditStreamPartPayload
> implements IMutableStreamPart<ExternalEditStreamPartPayload>, IAsyncMetadataProvider {

  readonly kind = 'externalEdit' as const;

  private editStarted = false;
  private baselineCaptured = false;
  private deferred: { resolve: () => void; promise: Promise<void> } | null = null;
  private onDidComplete: Thenable<string> | null = null;
  private metadataSettled: Promise<void> | null = null;
  private _undoStopId: string | null = null;

  constructor(
    payload: ExternalEditStreamPartPayload,
    private readonly callbacks?: ExternalEditSSPCallbacks,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
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
    if (!this._undoStopId) return undefined;
    return { undoStopId: this._undoStopId };
  }

  async whenMetadataSettled(): Promise<void> {
    await this.metadataSettled;
  }

  // ── Render: start externalEdit lifecycle ───────────────────────────────

  render(stream: SspStream): void {
    if (this.editStarted || this.payload.status !== 'pending') return;
    if (!stream.externalEdit) return;
    this.editStarted = true;

    const uris = (this.payload.uris ?? []) as vscode.Uri[];
    if (uris.length === 0 && this.payload.uri) {
      uris.push(buildFileUri(this.payload.uri));
    }
    if (uris.length === 0) return;

    const toolCallId = this.payload.toolCallId;
    const beforeSnapshots = uris.map((uri, i) =>
      captureSnapshot(uri, toolCallId, 'before', i, this.meta.turnIndex),
    );

    const callback = async () => {
      if (!this.baselineCaptured) {
        this.baselineCaptured = true;
        for (const s of beforeSnapshots) this.callbacks?.onSnapshot(s);
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

    if (data.status === 'completed' && this.deferred) {
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
              uris.push(buildFileUri(this.payload.uri));
            }
            for (let i = 0; i < uris.length; i++) {
              const after = captureSnapshot(uris[i], this.payload.toolCallId, 'after', i, this.meta.turnIndex);
              after.undoStopId = undoStopId || undefined;
              this.callbacks?.onSnapshot(after);
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

function buildFileUri(filePath: string): vscode.Uri {
  const rawUri = vscode.Uri.file(filePath);
  const normalizedPath = /^\/[a-zA-Z]:(?=\/)/.test(rawUri.path)
    ? rawUri.path.toLowerCase()
    : rawUri.path;
  return rawUri.path !== normalizedPath
    ? rawUri.with({ path: normalizedPath })
    : rawUri;
}
