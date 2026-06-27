#!/usr/bin/env node
/**
 * One-time on-disk migration: convert legacy session.jsonl line formats to
 * the SSP-only persistence model.
 *
 * Background
 * ----------
 * Older ACPilot versions persisted a mix of line types in session.jsonl /
 * turns.jsonl:
 *   - {"v":2,"t":"event","d":<AcpEvent>}        — raw normalised events (legacy)
 *   - {"v":2,"t":"stream-part","d":{"kind":"rawAcpEvent","payload":{"event":<AcpEvent>}}}
 *                                                — AcpEvent wrapped in an SSP record
 *
 * After Phase 4 the persistence layer only understands standard SSP
 * stream-part records (assistantText, toolInvocation, externalEdit, ...).
 * The AcpEvent intermediate type is deleted, so any file still containing
 * the old shapes would be unreadable. This script rewrites them in place.
 *
 * Conversion map (AcpEvent.type → SSP stream-part kind):
 *   part.updated   part.type=text     → assistantText
 *   part.updated   part.type=reasoning→ reasoning
 *   part.updated   part.type=tool     → toolInvocation
 *   part.updated   part.type=step-*   → sessionLifecycle (turn boundary)
 *   part.delta     field=reasoning    → reasoningDelta  else assistantTextDelta
 *   session.diff                       → sessionDiff
 *   session.created/updated/deleted/error/status → sessionLifecycle
 *   session.idle                       → sessionLifecycle (turn boundary marker)
 *   permission.asked                   → externalEdit (best-effort)
 *   question.asked                     → question
 *   permission.replied / question.replied / question.rejected / server.connected / server.heartbeat
 *     → dropped (no SSP equivalent / noisy)
 *
 * Safety
 * ------
 * - Backs up the original file to <name>.bak-v2migrate before rewriting.
 * - Idempotent: writes a `migrated-v2` marker into the file header so a
 *   re-run is a no-op.
 * - Files with no legacy lines are left untouched.
 *
 * Usage
 * -----
 *   node scripts/migrate-session-jsonl.cjs <workspaceRoot>   # all backends
 *   node scripts/migrate-session-jsonl.cjs <path-to-dir>     # one session dir
 *
 * @module
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ACP_DIR = '.acpilot';
const FILE_NAMES = ['session.jsonl', 'turns.jsonl'];
const MIGRATED_VERSION = 2;
const MIGRATION_MARKER = 'v2-migrated';

// ---------------------------------------------------------------------------
// AcpEvent → SSP record conversion
// ---------------------------------------------------------------------------

let sequenceCounter = 0;

function freshMeta(event) {
  sequenceCounter += 1;
  return {
    turnIndex: 0,
    requestId: 'migrated',
    sequence: sequenceCounter,
    createdAt: new Date().toISOString(),
    source: 'acp-event',
    sourceType: typeof event === 'object' && event ? event.type : undefined,
    sessionId: typeof event === 'object' && event ? event.sessionId : undefined,
  };
}

function record(kind, payload, meta) {
  return {
    kind,
    version: 1,
    // Stable-ish id so re-runs (if marker missing) are deterministic.
    id: `migrated-${sequenceCounter}-${kind}`,
    payload,
    meta,
  };
}

/** Map a single legacy AcpEvent to zero or more SSP records. */
function convertEvent(event) {
  if (!event || typeof event !== 'object' || !event.type) {
    return [];
  }
  const meta = freshMeta(event);

  switch (event.type) {
    case 'part.updated': {
      const part = event.part;
      if (!part || typeof part !== 'object' || !part.type) {
        return [];
      }
      const sessionId = event.sessionId ?? part.sessionId;
      if (part.type === 'text') {
        return [record('assistantText', {
          partId: String(part.id ?? ''),
          text: String(part.text ?? ''),
          messageId: part.messageId,
          sessionId,
        }, meta)];
      }
      if (part.type === 'reasoning') {
        return [record('reasoning', {
          partId: String(part.id ?? ''),
          text: String(part.text ?? ''),
          messageId: part.messageId,
          sessionId,
        }, meta)];
      }
      if (part.type === 'tool') {
        const state = part.state || {};
        return [record('toolInvocation', {
          partId: String(part.id ?? ''),
          toolName: String(part.toolName ?? ''),
          callId: part.callId,
          state: {
            status: typeof state.status === 'string' ? state.status : 'completed',
            input: state.input && typeof state.input === 'object' ? state.input : {},
            output: typeof state.output === 'string' ? state.output : undefined,
            title: typeof state.title === 'string' ? state.title : undefined,
            startTime: typeof state.startTime === 'number' ? state.startTime : undefined,
            endTime: typeof state.endTime === 'number' ? state.endTime : undefined,
          },
          messageId: part.messageId,
          sessionId,
        }, meta)];
      }
      if (part.type === 'step-start' || part.type === 'step-finish') {
        // Step parts were turn-boundary markers; encode as a lifecycle event.
        return [record('sessionLifecycle', {
          eventType: 'session.idle',
          sessionId,
        }, meta)];
      }
      return [];
    }

    case 'part.delta': {
      const field = event.field;
      if (field === 'reasoning') {
        return [record('reasoningDelta', {
          partId: String(event.partId ?? ''),
          delta: String(event.delta ?? ''),
          field,
          sessionId: event.sessionId,
        }, meta)];
      }
      return [record('assistantTextDelta', {
        partId: String(event.partId ?? ''),
        delta: String(event.delta ?? ''),
        field,
        sessionId: event.sessionId,
      }, meta)];
    }

    case 'session.diff':
      return [record('sessionDiff', {
        sessionId: String(event.sessionId ?? ''),
        diffs: Array.isArray(event.diffs) ? event.diffs : [],
      }, meta)];

    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
    case 'session.error':
    case 'session.idle':
    case 'session.status':
      return [record('sessionLifecycle', {
        eventType: event.type,
        sessionId: event.sessionId,
        parentId: event.parentId,
        title: event.title,
        error: event.error,
        status: event.status,
      }, meta)];

    case 'permission.asked': {
      // Best-effort: externalEdit requires a filepath. Legacy permission
      // events carried it under metadata.filepath (OpenCode convention).
      const filepath = event.metadata && typeof event.metadata === 'object'
        ? event.metadata.filepath
        : undefined;
      const callId = event.tool ? event.tool.callId : undefined;
      // Only emit externalEdit when we have a path to snapshot; otherwise the
      // permission had no file-edit semantics and is best dropped.
      if (!filepath || !callId) {
        return [];
      }
      return [record('externalEdit', {
        toolCallId: String(callId),
        uri: filepath,
        status: 'completed',
      }, meta)];
    }

    case 'question.asked':
      return [record('question', {
        questionId: String(event.questionId ?? ''),
        questions: Array.isArray(event.questions) ? event.questions : [],
        status: 'asked',
      }, meta)];

    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected':
    case 'server.connected':
    case 'server.heartbeat':
      // No SSP equivalent or too noisy to reconstruct — drop.
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Line-level conversion
// ---------------------------------------------------------------------------

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {return null;}
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && typeof obj.t === 'string') {
      return obj;
    }
  } catch {
    // not JSON — skip
  }
  return null;
}

/**
 * Convert the contents of one session JSONL file.
 * Returns { changed, lines } where lines is the new file content.
 */
function convertFileLines(text) {
  sequenceCounter = 0;
  const rawLines = text.split(/\r?\n/);
  const out = [];
  let changed = false;
  let alreadyMigrated = false;

  for (const raw of rawLines) {
    if (raw.trim() === '') {
      continue;
    }

    // Migration marker header: skip and re-emit.
    const marker = parseLine(raw);
    if (marker && marker.t === 'migration') {
      if (marker.d === MIGRATION_MARKER) {
        alreadyMigrated = true;
      }
      continue;
    }

    // Pass-through lines that are already standard SSP stream-parts — but
    // rewrite rawAcpEvent parts into their concrete kind.
    const parsed = parseLine(raw);
    if (!parsed) {
      // Non-JSON line; keep as-is (e.g. trailing whitespace artefacts dropped).
      changed = true;
      continue;
    }

    // Legacy "event" line → convert.
    if (parsed.t === 'event' && parsed.d) {
      const records = convertEvent(parsed.d);
      for (const r of records) {
        out.push(JSON.stringify({ v: 2, t: 'stream-part', d: r }));
      }
      changed = true;
      continue;
    }

    // stream-part line: keep as-is unless it's a rawAcpEvent wrapper.
    if (parsed.t === 'stream-part' && parsed.d) {
      const d = parsed.d;
      if (d.kind === 'rawAcpEvent' && d.payload && d.payload.event) {
        // Unwrap the embedded AcpEvent and re-convert.
        const records = convertEvent(d.payload.event);
        for (const r of records) {
          out.push(JSON.stringify({ v: 2, t: 'stream-part', d: r }));
        }
        changed = true;
        continue;
      }
      // Standard SSP record — keep verbatim.
      out.push(JSON.stringify(parsed));
      continue;
    }

    // Other line types (version, meta, turn-start/end, snapshot) — keep.
    out.push(JSON.stringify(parsed));
  }

  if (alreadyMigrated && !changed) {
    return { changed: false, content: null };
  }

  // Prepend migration marker.
  const header = JSON.stringify({ v: 2, t: 'migration', d: MIGRATION_MARKER });
  const body = [header, ...out].join('\n') + '\n';
  return { changed: true, content: body };
}

// ---------------------------------------------------------------------------
// File / directory traversal
// ---------------------------------------------------------------------------

async function migrateFile(filePath, logger) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    logger(`[migrate] read failed ${filePath}: ${err.message}`);
    return false;
  }

  const result = convertFileLines(text);
  if (!result.changed) {
    return false;
  }

  // Back up original.
  try {
    await fsp.copyFile(filePath, filePath + '.bak-v2migrate');
  } catch (err) {
    logger(`[migrate] backup failed ${filePath}: ${err.message}`);
    return false;
  }

  try {
    await fsp.writeFile(filePath, result.content, 'utf8');
    logger(`[migrate] migrated ${filePath}`);
    return true;
  } catch (err) {
    logger(`[migrate] write failed ${filePath}: ${err.message}`);
    return false;
  }
}

async function migrateSessionDir(dir, logger) {
  let migrated = 0;
  for (const name of FILE_NAMES) {
    const p = path.join(dir, name);
    try {
      await fsp.access(p);
    } catch {
      continue;
    }
    if (await migrateFile(p, logger)) {
      migrated += 1;
    }
  }
  return migrated;
}

/**
 * Walk a backend directory (e.g. <workspaceRoot>/.acpilot/opencode) and
 * migrate every session subdir's jsonl files.
 */
async function migrateBackendDir(backendDir, logger) {
  let entries;
  try {
    entries = await fsp.readdir(backendDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    count += await migrateSessionDir(path.join(backendDir, entry.name), logger);
  }
  return count;
}

/**
 * Migrate all backends under <workspaceRoot>/.acpilot/.
 * If target is a single session dir (contains session.jsonl/turns.jsonl),
 * migrate just that dir.
 */
async function migrate(target, logger) {
  const log = typeof logger === 'function' ? logger : () => {};

  // Single session dir?
  const stat = await fsp.stat(target).catch(() => null);
  if (stat && stat.isDirectory()) {
    const hasJsonl = await Promise.all(
      FILE_NAMES.map((n) => fsp.access(path.join(target, n)).then(() => true).catch(() => false)),
    );
    if (hasJsonl.some(Boolean)) {
      return migrateSessionDir(target, log);
    }
  }

  // Otherwise treat as workspace root.
  const acpRoot = path.join(target, ACP_DIR);
  let backends;
  try {
    backends = await fsp.readdir(acpRoot, { withFileTypes: true });
  } catch {
    log(`[migrate] no ${ACP_DIR} dir at ${target}`);
    return 0;
  }
  let total = 0;
  for (const entry of backends) {
    if (!entry.isDirectory()) {continue;}
    total += await migrateBackendDir(path.join(acpRoot, entry.name), log);
  }
  return total;
}

module.exports = {
  migrate,
  migrateFile,
  migrateSessionDir,
  migrateBackendDir,
  convertFileLines,
  convertEvent,
  MIGRATION_MARKER,
};

// CLI entry point when run directly.
if (require.main === module) {
  const target = process.argv[2] || process.cwd();
  migrate(target, (msg) => process.stderr.write(msg + '\n'))
    .then((n) => {
      process.stderr.write(`[migrate] done: ${n} file(s) migrated\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`[migrate] fatal: ${err.stack || err.message || err}\n`);
      process.exit(1);
    });
}
