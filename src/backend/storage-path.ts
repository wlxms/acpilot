import * as path from 'node:path';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_WINDOWS_SEGMENT = /[<>:"/\\|?*]/;

/** Validate an untrusted identifier before using it as one filesystem segment. */
export function assertSafeStorageSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..') {
    throw new Error(`${label} must be a non-empty filesystem segment`);
  }
  const hasControlCharacter = [...value].some(character => character.charCodeAt(0) < 32);
  if (hasControlCharacter || INVALID_WINDOWS_SEGMENT.test(value) || value.endsWith('.') || value.endsWith(' ')) {
    throw new Error(`${label} contains characters that are not allowed in a filesystem segment`);
  }
  if (WINDOWS_RESERVED_NAME.test(value)) {
    throw new Error(`${label} uses a reserved Windows device name`);
  }
  return value;
}

/** Resolve a child directory and prove that it remains inside its parent. */
export function resolveStorageChild(baseDir: string, segment: string, label: string): string {
  const safeSegment = assertSafeStorageSegment(segment, label);
  const resolvedBase = path.resolve(baseDir);
  const resolvedChild = path.resolve(resolvedBase, safeSegment);
  if (!resolvedChild.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`${label} resolves outside its storage namespace`);
  }
  return resolvedChild;
}
