import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { DshRenderHost } from '../chat-rendering/host';
import { dshViewFence, DSH_VIEW_MAX_BYTES, parseDshRichView } from '../chat-rendering/protocol';
import { wrapDshRenderStream } from '../chat-rendering/stream';
import { RichViewSSP } from '../ssp/impl/rich-view';
import { createSSPFromRecord } from '../backend/streaming/deserialize';
const view = { protocol: 1 as const, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'v1', data: { items: [{ type: 'text', content: 'Hello' }] } };
function setup() {
  const output: string[] = [];
  const raw = { markdown: (v: string) => { output.push(v); }, progress: vi.fn(), push: vi.fn() };
  const host = new DshRenderHost(true);
  const submit = vi.fn(async () => {});
  const route = { sessionKey: 'session-a', submit };
  return { output, raw, host, submit, route, stream: wrapDshRenderStream(raw as never, route, host) };
}
function envelope(output: string[]) { return JSON.parse(output.join('').split('\n').slice(1, -2).join('\n')); }
function channel() {
  let receive: ((message: unknown) => unknown) | undefined;
  let dispose: (() => void) | undefined;
  const webview = { html: '', cspSource: 'https://trusted.invalid', options: {},
    asWebviewUri(uri: vscode.Uri) { return { toString: () => 'https://trusted.invalid' + uri.path }; },
    onDidReceiveMessage(listener: (message: unknown) => unknown) { receive = listener; return { dispose() { receive = undefined; } }; },
    postMessage: vi.fn(async (_message: unknown) => true) };
  return { webview, output: { webview, onDidDispose(listener: () => void) { dispose = listener; return { dispose() {} }; } },
    send: async (message: unknown) => { await receive?.(message); }, dispose: () => dispose?.() };
}
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
describe('DSH generic render integration', () => {
  it('renders many separated backtick runs without overflowing the stack', () => {
    const rich = { ...view, data: { items: [{ type: 'text', content: '`a'.repeat(150000) }] } };
    expect(() => dshViewFence(rich)).not.toThrow();
    expect(dshViewFence(rich).startsWith('```dsh-ui\n')).toBe(true);
  });
  it('validates data without accepting model route tokens', () => {
    expect(parseDshRichView({ ...view, routeToken: 'untrusted' })).toEqual(view);
    expect(parseDshRichView({ ...view, data: 'x'.repeat(2 * 1024 * 1024) })).toBeUndefined();
    expect(parseDshRichView({ ...view, renderer: { id: 'custom', version: 2 } })?.renderer.id).toBe('custom');
  });
  it('persists and replays source metadata', () => {
    const part = new RichViewSSP({ partId: 'rich-v1', view, sessionId: 's', toolCallId: 't' });
    expect(part.toJSON().payload).toEqual(view);
    const restored = createSSPFromRecord(JSON.parse(JSON.stringify(part.toJSON())));
    const richView = vi.fn();
    restored.render({ markdown: vi.fn(), progress: vi.fn(), push: vi.fn(), richView } as never);
    expect(richView).toHaveBeenCalledWith(view, expect.objectContaining({ sessionId: 's', toolCallId: 't' }));
  });
  it('binds split complete fences to the source route', async () => {
    const s = setup();
    for (const chunk of ['```ds', 'h-ui\n', JSON.stringify({ ...view, routeToken: 'forged' }), '\n``', '`\n']) { s.stream.markdown(chunk); }
    s.stream.flushDshRender();
    const rendered = envelope(s.output);
    expect(rendered.routeToken).not.toBe('forged');
    expect(rendered.data).toEqual(view.data);
    await s.host.submit(rendered.routeToken, view, 'submit', { choice: 1 });
    expect(s.submit).toHaveBeenCalledWith('submit', { choice: 1 });
  });
  it('streams normal text and preserves nested foreign fences', () => {
    const s = setup(); s.stream.markdown('Hello'); expect(s.output.join('')).toBe('Hello');
    const text = '\n````markdown\n```dsh-ui\n{}\n```\n````\n';
    for (const ch of text) { s.stream.markdown(ch); }
    s.stream.flushDshRender(); expect(s.output.join('')).toBe('Hello' + text);
  });
  it('preserves unfinished and invalid fences', () => {
    const s = setup(); const text = '```dsh-ui\nnot json\n```\n```dsh-ui\n{';
    for (const ch of text) { s.stream.markdown(ch); }
    s.stream.flushDshRender(); expect(s.output.join('')).toBe(text);
  });
  it('does not bind child or unknown renderer actions to root', () => {
    const s = setup(); s.stream.richView(view, { subAgentInvocationId: 'delegate' } as never);
    expect(envelope(s.output).routeToken).toBeUndefined();
    s.stream.richView({ ...view, renderer: { id: 'custom', version: 1 } });
    expect(s.output.join('')).toContain('custom');
  });
  it('rejects cross-view, malformed and expired actions', async () => {
    const s = setup(); const bound = s.host.bind(view, s.route);
    await expect(s.host.submit(bound.routeToken!, { ...view, viewId: 'other' }, 'go', {})).rejects.toThrow();
    await expect(s.host.submit(bound.routeToken!, view, '', {})).rejects.toThrow();
    s.host.dispose(); await expect(s.host.submit(bound.routeToken!, view, 'go', {})).rejects.toThrow();
    expect(s.submit).not.toHaveBeenCalled();
  });
  it('falls back to readable JSON without renderer support', () => {
    const s = setup(); wrapDshRenderStream(s.raw as never, s.route, new DshRenderHost(false)).richView(view);
    expect(s.output.join('')).toContain('```json'); expect(s.output.join('')).toContain('Hello');
    expect(s.output.join('')).not.toContain('routeToken');
  });
  it('holds the action guard through concurrent rejected messages and closes safely', async () => {
    const s = setup(); let release!: () => void;
    s.route.submit = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const bound = s.host.bind(view, s.route); const c = channel();
    const rendering = s.host.render({ value: Buffer.from(JSON.stringify(bound)) }, c.output as never, vscode.Uri.file('D:/acpilot'), token as never);
    expect(c.webview.html).toContain('renderer.js'); expect(c.webview.postMessage).not.toHaveBeenCalled();
    await c.send({ type: 'ready', protocol: 1 });
    await rendering;
    expect(c.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ view, actionEnabled: true }));
    const message = { type: 'action', protocol: 1, action: 'go', payload: {} };
    const first = c.send({ ...message, requestId: '1' });
    await c.send({ ...message, requestId: '2' });
    await c.send({ ...message, requestId: '3' });
    expect(s.route.submit).toHaveBeenCalledTimes(1);
    c.dispose(); release(); await first;
    await c.send({ ...message, requestId: '4' }); expect(s.route.submit).toHaveBeenCalledTimes(1);
  });
  it('permits guarded image and media URLs while keeping executable assets local', async () => {
    const s = setup(); const c = channel();
    const rendering = s.host.render({ value: Buffer.from(JSON.stringify(view)) }, c.output as never, vscode.Uri.file('D:/acpilot'), token as never);
    const content = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(c.webview.html)![1];
    const directives = Object.fromEntries(content.split(';').filter(Boolean).map(item => { const [name, ...sources] = item.trim().split(/\s+/); return [name, sources]; }));
    expect(directives['img-src']).toEqual(expect.arrayContaining(['https:', 'http:']));
    expect(directives['media-src']).toEqual(expect.arrayContaining(['https:', 'http:']));
    expect(directives['script-src']).not.toContain('https:');
    await c.send({ type: 'ready', protocol: 1 }); await rendering;
  });
  it('renders a valid near-limit view after adding host routing metadata', async () => {
    const s = setup(); const c = channel();
    const empty = { ...view, data: '' };
    const rich = { ...empty, data: 'x'.repeat(DSH_VIEW_MAX_BYTES - Buffer.byteLength(JSON.stringify(empty)) - 1) };
    expect(parseDshRichView(rich)).toBeDefined();
    const bound = s.host.bind(rich, s.route);
    const rendering = s.host.render({ value: Buffer.from(JSON.stringify(bound)) }, c.output as never, vscode.Uri.file('D:/acpilot'), token as never);
    expect(c.webview.html.includes('renderer.js')).toBe(true);
    await c.send({ type: 'ready', protocol: 1 }); await rendering;
  });
  it('bounds an incomplete one-line payload before its closing newline', () => {
    const s = setup(); s.stream.markdown('```dsh-ui\n');
    const body = 'x'.repeat(2 * 1024 * 1024); s.stream.markdown(body);
    expect(s.output.join('')).toBe('```dsh-ui\n' + body);
  });
});
