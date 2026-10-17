import { assertSafeStorageSegment } from './storage-path';

/** Build the stable identity of one backend runtime instance. */
export function createBackendInstanceKey(backendId: string, instanceId?: string): string {
  assertSafeStorageSegment(backendId, 'Backend ID');
  return instanceId !== undefined ? `${backendId}:${instanceId}` : backendId;
}

/** Convert an instance key into a filesystem-safe relative namespace. */
export function getBackendStorageNamespace(instanceKey: string): string {
  const separator = instanceKey.indexOf(':');
  if (separator < 0) {return assertSafeStorageSegment(instanceKey, 'Backend instance key');}
  const backendId = instanceKey.slice(0, separator);
  assertSafeStorageSegment(backendId, 'Backend ID');
  const instanceId = encodeURIComponent(instanceKey.slice(separator + 1));
  return `${backendId}/instance-${instanceId}`;
}

/** Enforce the canonical session URI shape for one backend instance. */
export function assertSessionResourcePath(
  resourcePath: string,
  backendId: string,
  instanceKey: string,
): void {
  const segments = resourcePath.split('/').filter(Boolean);
  if (instanceKey === backendId) {
    if (segments.length !== 1) {
      throw new Error(`Invalid unscoped session resource: ${resourcePath}`);
    }
    return;
  }
  if (segments.length !== 2) {
    throw new Error(`Session resource must include backend instance "${instanceKey}".`);
  }
  let resourceInstanceKey = segments[0];
  try {
    resourceInstanceKey = decodeURIComponent(resourceInstanceKey);
  } catch {
    // The raw value cannot match a canonical encoded instance key.
  }
  if (resourceInstanceKey !== instanceKey) {
    throw new Error(
      `Session belongs to backend instance "${resourceInstanceKey}", ` +
      `but the active instance is "${instanceKey}". Switch ACP target before opening it.`,
    );
  }
}
