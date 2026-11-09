export type BackendLogListener = (backendId: string, lines: readonly string[]) => void;

/**
 * Small in-memory log buffer used by the settings panel. Each backend has an
 * independent bounded history so a noisy process cannot grow extension-host
 * memory without limit.
 */
export class BackendLogStore {
  private readonly entries = new Map<string, string[]>();
  private readonly listeners = new Set<BackendLogListener>();
  private readonly maxLines: number;

  constructor(maxLines = 200) {
    if (!Number.isInteger(maxLines) || maxLines < 1) {
      throw new Error('Backend log maxLines must be a positive integer');
    }
    this.maxLines = maxLines;
  }

  append(backendId: string, message: string, emit = true): void {
    const id = backendId.trim();
    if (!id) {
      return;
    }
    const incoming = message
      .split(/\r\n|\r|\n/)
      .map(line => line.trimEnd())
      .filter(Boolean);
    if (incoming.length === 0) {
      return;
    }
    const lines = this.entries.get(id) ?? [];
    lines.push(...incoming);
    if (lines.length > this.maxLines) {
      lines.splice(0, lines.length - this.maxLines);
    }
    this.entries.set(id, lines);
    if (emit) {
      for (const listener of this.listeners) {
        listener(id, lines);
      }
    }
  }

  snapshot(backendId?: string): Record<string, string[]> {
    const entries = backendId === undefined
      ? this.entries.entries()
      : [[backendId.trim(), this.entries.get(backendId.trim()) ?? []] as const];
    return Object.fromEntries(
      [...entries]
        .filter(([id]) => Boolean(id))
        .map(([id, lines]) => [id, [...lines]]),
    );
  }

  clear(backendId?: string): void {
    if (backendId === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(backendId);
    }
  }

  onChange(listener: BackendLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}