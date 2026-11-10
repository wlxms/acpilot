import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { DshRenderSessionRoute } from './session-route';
import { dshViewFence, DSH_RENDER_VIEW_TYPE, DSH_VIEW_MAX_BYTES, isRecord, parseDshRichView, type DshRichView } from './protocol';

interface BoundView { view: DshRichView; route: DshRenderSessionRoute; }
interface OutputWebview { webview: vscode.Webview; onDidDispose(listener: () => void): vscode.Disposable; }
interface RenderApi { registerChatOutputRenderer(type: string, renderer: { renderChatOutput(data: { value: Uint8Array }, output: OutputWebview, context: unknown, token: vscode.CancellationToken): Promise<void> }): vscode.Disposable; }

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function readableFallback(value: string, reason = 'Invalid data or unsupported renderer.'): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body><p>Unable to render this DSH view: ${escapeHtml(reason)}</p><pre>${escapeHtml(value)}</pre></body></html>`;
}

export class DshRenderHost {
  private readonly bindings = new Map<string, BoundView>();
  private readonly cleanups = new Set<() => void>();
  private disposed = false;
  constructor(readonly available: boolean) {}

  bind(view: DshRichView, route?: DshRenderSessionRoute): DshRichView & { routeToken?: string } {
    if (!route || !this.available || this.disposed || view.renderer.id !== 'dsh.genui' || view.renderer.version !== 1) { return view; }
    const routeToken = randomUUID();
    this.bindings.set(routeToken, { view, route });
    // Long-lived history can be rebound on replay; keep extension memory bounded.
    if (this.bindings.size > 2048) { this.bindings.delete(this.bindings.keys().next().value!); }
    return { ...view, routeToken };
  }

  async submit(token: string, view: DshRichView, action: string, payload: Record<string, unknown>): Promise<void> {
    const binding = this.bindings.get(token);
    if (this.disposed || !binding || binding.view.viewId !== view.viewId
      || JSON.stringify(binding.view) !== JSON.stringify(view)) { throw new Error('This DSH view is no longer bound to its conversation. Reopen it.'); }
    if (typeof action !== 'string' || !action.trim() || action.length > 256 || /[\r\n\0]/.test(action) || !isRecord(payload)) { throw new Error('Invalid DSH action'); }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 64 * 1024) { throw new Error('DSH action payload is too large'); }
    await binding.route.submit(action, payload);
  }

  markdown(view: DshRichView, route?: DshRenderSessionRoute): string {
    if (!this.available || view.renderer.id !== 'dsh.genui' || view.renderer.version !== 1) {
      return `DSH view (${view.renderer.id} v${view.renderer.version})\n\n${dshViewFence(view, 'json')}`;
    }
    return dshViewFence(this.bind(view, route));
  }

  async render(data: { value: Uint8Array }, output: OutputWebview, extensionUri: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
    if (this.disposed || token.isCancellationRequested) { return; }
    const webview = output.webview;
    let input: unknown;
    let source = 'The DSH view exceeds the supported size limit.';
    try {
      // The bounded route token is assigned after the renderer envelope was validated.
      if (data.value.byteLength < DSH_VIEW_MAX_BYTES + 128) {
        source = Buffer.from(data.value).toString('utf8');
        input = JSON.parse(source);
      }
    } catch { /* diagnostic below */ }
    const view = parseDshRichView(input);
    if (!view || view.renderer.id !== 'dsh.genui' || view.renderer.version !== 1) {
      webview.html = readableFallback(source);
      return;
    }
    const routeToken = isRecord(input) && typeof input.routeToken === 'string' ? input.routeToken : undefined;
    const assetRoot = vscode.Uri.joinPath(extensionUri, 'resources', 'dsh-renderer');
    const assetBase = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'assets')).toString() + '/';
    webview.options = { enableScripts: true, localResourceRoots: [assetRoot] };
    let closed = false;
    let busy = false;
    let ready = false;
    let resolveInitialized!: () => void;
    const initialized = new Promise<void>(resolve => { resolveInitialized = resolve; });
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    const finishInitialization = () => {
      if (readyTimeout !== undefined) { clearTimeout(readyTimeout); readyTimeout = undefined; }
      resolveInitialized();
    };
    const requestIds = new Set<string>();
    const disposables: vscode.Disposable[] = [];
    const close = () => {
      if (closed) { return; }
      closed = true;
      finishInitialization();
      for (const item of disposables) { item.dispose(); }
      this.cleanups.delete(close);
    };
    this.cleanups.add(close);
    disposables.push(output.onDidDispose(close), token.onCancellationRequested(close));
    disposables.push(webview.onDidReceiveMessage(async (message: unknown) => {
      if (closed || this.disposed || !isRecord(message) || message.protocol !== 1) { return; }
      if (message.type === 'ready') {
        ready = true;
        try {
          await webview.postMessage({ type: 'render', protocol: 1, view, assetBase, actionEnabled: !!routeToken && this.bindings.has(routeToken) });
        } catch {
          webview.html = readableFallback(JSON.stringify(view), 'The bundled renderer could not be initialized.');
          close();
        } finally { finishInitialization(); }
        return;
      }
      if (!ready || message.type !== 'action' || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128) { return; }
      const requestId = message.requestId;
      let ok = false;
      let error: string | undefined;
      let ownsBusy = false;
      try {
        if (busy || requestIds.has(requestId)) { throw new Error('This DSH action is already pending.'); }
        if (!routeToken) { throw new Error('This view is read only.'); }
        if (typeof message.action !== 'string' || !isRecord(message.payload)) { throw new Error('Invalid DSH action'); }
        busy = true;
        ownsBusy = true;
        requestIds.add(requestId);
        if (requestIds.size > 256) { requestIds.delete(requestIds.values().next().value!); }
        await this.submit(routeToken, view, message.action, message.payload);
        ok = true;
      } catch (failure) { error = failure instanceof Error ? failure.message.slice(0, 600) : 'DSH action failed'; }
      finally { if (ownsBusy) { busy = false; } }
      if (!closed && !this.disposed) {
        try { await webview.postMessage({ type: 'action-result', protocol: 1, requestId, ok, ...(error ? { error } : {}) }); }
        catch { close(); }
      }
    }));
    const nonce = randomUUID().replace(/-/g, '');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'renderer.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'renderer.css'));
    webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: http: data: blob:; media-src ${webview.cspSource} https: http: blob:; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource}; worker-src blob:;"><link rel="stylesheet" href="${style}"></head><body><div id="dsh-root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    readyTimeout = setTimeout(() => {
      if (!closed && !ready) {
        webview.html = readableFallback(JSON.stringify(view), 'The bundled renderer did not become ready.');
        close();
      }
    }, 10_000);
    await initialized;
  }

  dispose(): void {
    this.disposed = true;
    this.bindings.clear();
    for (const close of [...this.cleanups]) { close(); }
  }
}

let defaultHost = new DshRenderHost(false);
export function getDshRenderHost(): DshRenderHost { return defaultHost; }
export function registerDshRenderHost(context: vscode.ExtensionContext): void {
  defaultHost.dispose();
  const api = vscode.chat as unknown as Partial<RenderApi>;
  const host = new DshRenderHost(typeof api?.registerChatOutputRenderer === 'function');
  defaultHost = host;
  context.subscriptions.push({ dispose: () => host.dispose() });
  if (!host.available) { return; }
  try {
    context.subscriptions.push(api.registerChatOutputRenderer!(DSH_RENDER_VIEW_TYPE, {
      renderChatOutput: (data, output, _ctx, token) => host.render(data, output, context.extensionUri, token),
    }));
  } catch {
    host.dispose();
    defaultHost = new DshRenderHost(false);
  }
}
