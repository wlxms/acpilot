/**
 * Best-effort resolution of a file path from an ACP tool call's input args.
 *
 * ACP's `session/request_permission` carries a `ToolCallUpdate` with a generic
 * `input` object whose shape varies per agent. There is no standard field name
 * for the target path, so we probe a list of common candidates. This lets the
 * ACP backend reuse the OpenCode-origin ExternalEditSSP snapshot mechanism
 * (which needs a path to capture before/after checkpoints) without depending
 * on any agent-specific field convention.
 *
 * @module
 */

/** Candidate input-arg keys that commonly hold a file path. */
const PATH_CANDIDATES = [
  'filePath',
  'file_path',
  'filepath',
  'path',
  'file',
  'filename',
  'uri',
  'url',
] as const;

/**
 * Extract a string file path from a tool call's input arguments.
 * Returns `undefined` if no candidate field holds a string.
 */
export function resolveToolCallPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {return undefined;}
  const args = input as Record<string, unknown>;
  for (const key of PATH_CANDIDATES) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) {return v;}
  }
  // Nested under common sub-objects (e.g. { command: { path } }).
  for (const nestedKey of ['command', 'args', 'options', 'params']) {
    const nested = args[nestedKey];
    if (nested && typeof nested === 'object') {
      const resolved = resolveToolCallPath(nested);
      if (resolved) {return resolved;}
    }
  }
  return undefined;
}
