import { useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  analyzeGenuiPortability, ErrorBoundary, GenuiActionContext, GenuiBlock,
  isRenderableProcess, processGenuiSpec, setGenuiAssetBase,
  type BlockInteractionState,
} from '@changfenhuang/dsh-genui/embed';
import 'genui-standalone-theme';
import 'katex/dist/katex.min.css';
import './renderer.css';

interface View {
  protocol: 1;
  renderer: { id: 'dsh.genui'; version: 1 };
  viewId: string;
  data: unknown;
}
interface RenderMessage {
  type: 'render';
  protocol: 1;
  view: View;
  assetBase: string;
  actionEnabled: boolean;
}
interface SavedState {
  protocol: 1;
  views: Array<{ viewId: string; interaction: BlockInteractionState }>;
}
interface WebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: SavedState): void;
}
declare const acquireVsCodeApi: () => WebviewApi;

const api = acquireVsCodeApi();
const mount = document.getElementById('dsh-root');
if (mount === null) throw new Error('DSH renderer mount is missing');
const root = createRoot(mount);
let current: RenderMessage | undefined;
let diagnostic: string | undefined;
let feedback: { error: boolean; message: string } | undefined;
const pending = new Map<string, { viewId: string }>();
let sequence = 0;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readState(): SavedState {
  const state = api.getState();
  if (!record(state) || state.protocol !== 1 || !Array.isArray(state.views)) return { protocol: 1, views: [] };
  return {
    protocol: 1,
    views: state.views.filter((entry): entry is SavedState['views'][number] =>
      record(entry) && typeof entry.viewId === 'string' && record(entry.interaction)).slice(0, 20),
  };
}

function saveInteraction(viewId: string, interaction: BlockInteractionState): void {
  const saved = readState();
  api.setState({ protocol: 1, views: [{ viewId, interaction }, ...saved.views.filter(entry => entry.viewId !== viewId)].slice(0, 20) });
}

function clearPending(): void {
  pending.clear();
}

function sendAction(action: string, payload: Record<string, unknown>): void {
  if (current?.actionEnabled !== true || diagnostic !== undefined) return;
  const viewId = current.view.viewId;
  // This id correlates feedback only. The extension's render closure owns the session route.
  const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'action-' + Date.now() + '-' + ++sequence;
  // The host awaits the entire model turn; completion has no fixed frontend deadline.
  pending.set(requestId, { viewId });
  feedback = { error: false, message: '动作已提交，正在等待会话响应…' };
  renderCurrent();
  api.postMessage({ type: 'action', protocol: 1, requestId, action, payload });
}

function Renderer({ message, error, status }: {
  message: RenderMessage | undefined;
  error: string | undefined;
  status: typeof feedback;
}) {
  const processed = useMemo(() => {
    if (message === undefined || error !== undefined) return undefined;
    try { return processGenuiSpec(message.view.data); }
    catch (failure) { return { failure: failure instanceof Error ? failure.message : '无法读取 GenUI 数据' }; }
  }, [message?.view.data, error]);
  const viewId = message?.view.viewId;
  const onStateChange = useCallback((state: BlockInteractionState) => {
    if (viewId !== undefined) saveInteraction(viewId, state);
  }, [viewId]);
  // A changed spec remounts the error boundary; read the latest secret-free draft for that mount.
  const initialState = readState().views.find(entry => entry.viewId === viewId)?.interaction;
  let errors: string[] = error === undefined ? [] : [error];
  let spec;
  let warnings: string[] = [];
  if (processed !== undefined) {
    if ('failure' in processed) errors = [processed.failure];
    else {
      errors = processed.errors;
      warnings = processed.warnings.map(warning => warning.message);
      if (isRenderableProcess(processed) && processed.spec !== null) {
        const custom = analyzeGenuiPortability(processed.spec).customTypes;
        if (custom.length > 0) errors = ['未安装以下自定义组件的渲染器：' + custom.join(', ')];
        else {
          spec = processed.spec;
          // Intentional guard limits render with explicit diagnostics.
          warnings = [...warnings, ...errors];
          errors = [];
        }
      }
    }
  }
  if (errors.length > 0) return <div className="dsh-diagnostic" role="alert"><strong>无法渲染此 GenUI 界面</strong><ul>{errors.map((item, index) => <li key={index}>{item}</li>)}</ul></div>;
  if (spec === undefined || message === undefined) return <div className="dsh-waiting" role="status">正在准备 GenUI…</div>;
  return <>
    {warnings.length > 0 && <details className="dsh-diagnostic"><summary>界面数据提示</summary><ul>{warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    <GenuiActionContext.Provider value={message.actionEnabled ? sendAction : undefined}>
      <ErrorBoundary key={message.view.viewId + ':' + JSON.stringify(spec)} label="GenUI">
        <GenuiBlock spec={spec} stateKey={message.view.viewId} initialState={initialState} onStateChange={onStateChange} animateEntrance={false} />
      </ErrorBoundary>
    </GenuiActionContext.Provider>
    {status !== undefined && <div className="dsh-action-status" data-dsh-action-status role={status.error ? 'alert' : 'status'}>{status.message}</div>}
  </>;
}

function renderCurrent(): void {
  root.render(<Renderer message={current} error={diagnostic} status={feedback} />);
}

function validateRender(message: Record<string, unknown>): string | undefined {
  const view = message.view;
  if (message.protocol !== 1 || !record(view) || view.protocol !== 1 || !record(view.renderer)) return '不支持的界面协议。';
  if (view.renderer.id !== 'dsh.genui' || view.renderer.version !== 1) return '不支持的渲染器：' + String(view.renderer.id) + ' v' + String(view.renderer.version);
  if (typeof view.viewId !== 'string' || view.viewId.length === 0 || view.viewId.length > 1024 || !Object.hasOwn(view, 'data')) return '界面缺少有效 viewId 或 data。';
  if (typeof message.actionEnabled !== 'boolean' || typeof message.assetBase !== 'string') return '宿主缺少资源或动作配置。';
  try {
    const url = new URL(message.assetBase);
    if (!['https:', 'http:', 'vscode-resource:', 'vscode-webview-resource:'].includes(url.protocol) || url.username !== '' || url.password !== '') return '宿主资源地址无效。';
  } catch { return '宿主资源地址无效。'; }
  return undefined;
}

// Installed before ready: only the trusted host message supplies renderer assets and action capability.
window.addEventListener('message', event => {
  const message: unknown = event.data;
  if (!record(message)) return;
  if (message.type === 'render') {
    const error = validateRender(message);
    if (error !== undefined) {
      clearPending();
      current = undefined;
      diagnostic = error;
      feedback = undefined;
    } else {
      const next = message as unknown as RenderMessage;
      if (current?.view.viewId !== next.view.viewId) {
        clearPending();
        feedback = undefined;
      }
      setGenuiAssetBase(next.assetBase);
      current = next;
      diagnostic = undefined;
    }
    renderCurrent();
  } else if (message.type === 'action-result' && message.protocol === 1 && typeof message.requestId === 'string' && typeof message.ok === 'boolean') {
    const entry = pending.get(message.requestId);
    if (entry === undefined || entry.viewId !== current?.view.viewId) return;
    pending.delete(message.requestId);
    feedback = message.ok ? { error: false, message: '动作已发送。' }
      : { error: true, message: '动作发送失败：' + (typeof message.error === 'string' ? message.error.slice(0, 600) : '宿主未提供错误详情。') };
    renderCurrent();
  }
});
function syncTheme(): void {
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  document.body.toggleAttribute('data-ds-dark-theme', dark);
}
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
renderCurrent();
api.postMessage({ type: 'ready', protocol: 1 });
