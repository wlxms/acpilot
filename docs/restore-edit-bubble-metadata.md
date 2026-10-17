# Restore Edit Bubble Metadata

## Problem

Restored edit sessions could show the correct lower diff panel while the chat
edit bubble still displayed `+0 -0`.

The lower diff panel and the bubble are not driven by the same data:

- The lower diff panel can be reconstructed from checkpoint snapshots.
- The bubble is tied to VS Code's restored editing session metadata.

This means a restored transcript can look mostly right while the bubble loses
its line counts.

## Copilot CLI Restore Shape

Copilot CLI restores edit UI with an intentionally empty edit payload:

1. `CodeblockUriPart(uri, true, editId)`
2. `TextEditPart(uri, [])`
3. `TextEditPart(uri, true)`

The empty `TextEditPart(uri, [])` is not a bug. It prevents VS Code from
applying the text edits again during history restore. Replacing it with the
real `TextEdit[]` can double-edit the file.

The durable signal is the metadata that lets VS Code reconnect a tool call to
the original edit session:

- real VS Code `request.id`
- turn index
- `toolIdEditMap`
- edit or undo stop id from the live external edit

## Failure Mode

The bad restore logs had this shape:

```text
fetchSessionHistory: ... editRecords=0 ...
Restored request id ... requestId=turn-0 source=turn-index
restored text edit diff: ... added=... removed=... textEditPayload=empty+done
```

Those logs proved that checkpoint replay was available, but the session metadata
needed by the bubble was missing. A generated `turn-0` id is not the real request
id that VS Code uses to associate the edit bubble with the editing session, so
the restore path no longer creates synthetic request ids.

The root cause was metadata overwrite:

1. The live external edit produced a valid undo stop id.
2. `SerializableSessionStream.onExternalEdit()` could persist request details.
3. Later title updates called the full meta write path.
4. That full write replaced the session metadata snapshot and dropped `requestDetails`.
5. Restore then had no edit records, so it fell back to `turn-N`.

## Fixed Contract

The restore contract is now:

- Capture the real VS Code request id from `request.id`.
- Pass it into `SerializableSessionStream`.
- Persist request details as `{ turnIndex, vscodeRequestId, toolIdEditMap }`.
- Merge new request details through append-only `meta.jsonl` session patches.
- Update titles through the metadata merge path instead of overwriting the whole
  meta file.
- Restore `ChatRequestTurn` with the persisted request id when available.
- Keep the Copilot CLI empty edit payload during history reconstruction.

Expected healthy logs:

```text
[SerializableSessionStream] externalEdit recorded ... requestId=<real-request-id> toolCallId=<tool-call-id> undoStopId=<edit-id>
[session-provider] fetchSessionHistory: ... editRecords=1 ...
[session-provider] Restored request id ... requestId=<real-request-id> source=request-details
[checkpoint-replay] restored text edit diff: ... textEditPayload=empty+done
```

`textEditPayload=empty+done` should remain present. The important difference is
`editRecords=1` and `source=request-details`.

## Implementation Points

- `src/participant/handler.ts` passes `request.id` into the serializable stream.
- `src/backend/streaming/session-stream.ts` persists and merges request details.
- `src/backends/opencode/pipeline.ts` reports external edit undo stop ids
  through `onExternalEdit`.
- `src/participant/session-title.ts` uses `sessionStore.updateMeta()` so title
  changes preserve `requestDetails`.
- `src/surfaces/vscode/experimental-session.ts` rebuilds request turns with the
  persisted request id and logs whether it came from request details or fallback.
- `src/backend/checkpoint/replay.ts` still emits the empty edit group plus done
  marker, matching Copilot CLI restore behavior.

## Verification

Focused verification:

```powershell
npx vitest run src/test/session-title.test.ts src/test/handler.test.ts src/test/streaming.test.ts src/test/streaming/session-stream.test.ts src/test/experimental-session.test.ts src/test/checkpoint/replay.test.ts
npm run compile
```

Manual verification:

1. Create a session that edits a file.
2. Confirm live logs include `externalEdit recorded` with a real request id and
   undo stop id.
3. Reload or restore the session.
4. Confirm restore logs show `editRecords=1` and `source=request-details`.
5. Confirm the chat edit bubble line counts match the diff instead of showing
   `+0 -0`.
