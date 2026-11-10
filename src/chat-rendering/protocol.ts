export interface DshRichView {
  protocol: 1;
  renderer: { id: string; version: number };
  viewId: string;
  data: unknown;
}

export const DSH_VIEW_MAX_BYTES = 2 * 1024 * 1024;
export const DSH_RENDER_VIEW_TYPE = 'acpilot.dshView';
export const DSH_RENDER_MIME = 'application/vnd.acpilot.dsh-view+json';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function printable(value: string): boolean {
  return [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
}

/** Only renderer data crosses this boundary; routing is assigned by the host. */
export function parseDshRichView(value: unknown): DshRichView | undefined {
  if (!isRecord(value) || value.protocol !== 1 || !isRecord(value.renderer)
    || typeof value.renderer.id !== 'string' || !value.renderer.id.trim() || value.renderer.id.length > 128 || !printable(value.renderer.id)
    || !Number.isSafeInteger(value.renderer.version) || Number(value.renderer.version) < 1
    || typeof value.viewId !== 'string' || !value.viewId.trim() || value.viewId.length > 1024 || !printable(value.viewId)
    || !Object.hasOwn(value, 'data') || value.data === undefined) { return undefined; }
  const result: DshRichView = { protocol: 1, renderer: { id: value.renderer.id, version: Number(value.renderer.version) }, viewId: value.viewId, data: value.data };
  try { if (Buffer.byteLength(JSON.stringify(result), 'utf8') >= DSH_VIEW_MAX_BYTES) { return undefined; } }
  catch { return undefined; }
  return result;
}

export function dshViewFence(view: DshRichView & { routeToken?: string }, language = 'dsh-ui'): string {
  const json = JSON.stringify(view);
  const runs = json.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
  return `${fence}${language}\n${json}\n${fence}\n`;
}
