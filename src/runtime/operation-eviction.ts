/** Evicts old terminal runtime operations while retaining active work. */

export interface EvictableOperation {
  readonly status: string;
  /** A cancelled operation may still have in-flight underlying work. */
  readonly active?: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export const DEFAULT_OPERATION_CAPACITY = 128;

const ACTIVE_STATUSES = new Set(['starting', 'running']);

export function evictTerminalOperations<T extends EvictableOperation>(
  operations: Map<string, T>,
  capacity = DEFAULT_OPERATION_CAPACITY,
): void {
  if (capacity < 0 || operations.size <= capacity) {return;}

  const terminal = [...operations.entries()]
    .filter(([, operation]) => !ACTIVE_STATUSES.has(operation.status) && operation.active !== true)
    .sort(([, left], [, right]) => operationTimestamp(left) - operationTimestamp(right));
  const removeCount = operations.size - capacity;
  for (const [id] of terminal.slice(0, removeCount)) {
    operations.delete(id);
  }
}

function operationTimestamp(operation: EvictableOperation): number {
  const timestamp = operation.finishedAt ?? operation.startedAt;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}
