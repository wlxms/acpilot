const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'resources/dsh-renderer');
const sample = {
  title: 'ACPilot 图形能力样例',
  items: [
    { type: 'row', justify: 'between', items: [
      { type: 'badge', label: '已连接', tone: 'success' },
      { type: 'badge', label: '本地渲染', tone: 'accent' },
    ] },
    { type: 'tabs', tabs: [
      { label: '图表', items: [{ type: 'chart', kind: 'bars', data: [{ label: '请求', value: 12 }, { label: '完成', value: 9 }] }] },
      { label: '交互', items: [{ type: 'text', content: '按钮将发送结构化动作' }, { type: 'button', label: '刷新图表', action: 'refresh-chart' }] },
    ] },
  ],
};

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await pause();
  }
  assert.ok(predicate(), 'renderer did not reach the expected DOM state');
}
function harness(saved = {}) {
  const entry = path.join(output, 'renderer.js');
  assert.ok(fs.existsSync(entry), 'complete standalone renderer bundle is missing');
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body class="vscode-light"><main id="dsh-root"></main></body></html>', {
    url: 'https://renderer.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console,
  });
  const messages = [];
  let state = structuredClone(saved);
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  dom.window.acquireVsCodeApi = () => ({
    postMessage: message => messages.push(JSON.parse(JSON.stringify(message))),
    getState: () => state,
    setState: value => { state = JSON.parse(JSON.stringify(value)); return value; },
  });
  dom.window.eval(fs.readFileSync(entry, 'utf8'));
  const post = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const render = (data = sample, options = {}) => post({
    type: 'render', protocol: 1,
    view: { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'view-one', data },
    assetBase: 'https://renderer.test/assets/', actionEnabled: true,
    ...options,
  });
  return { dom, document: dom.window.document, messages, errors, post, render, state: () => structuredClone(state), close: () => dom.window.close() };
}
function button(document, text) { return [...document.querySelectorAll('button')].find(node => node.textContent === text); }
async function ready(h) { await until(() => h.messages.some(message => message.type === 'ready')); }

test('starts with a protocol handshake before rendering a view', async t => {
  const h = harness(); t.after(h.close); await ready(h);
  assert.deepEqual(h.messages, [{ type: 'ready', protocol: 1 }]);
  assert.equal(h.document.querySelector('[data-genui]'), null);
});

test('renders real GenUI row, badges and native bars', async t => {
  const h = harness(); t.after(h.close); h.render();
  await until(() => h.document.querySelector('[data-genui]'));
  assert.match(h.document.body.textContent, /已连接/);
  assert.match(h.document.body.textContent, /本地渲染/);
  const chart = h.document.querySelector('[data-genui-chart="bars"]');
  assert.ok(chart, 'native bar chart must be mounted');
  const fills = [...chart.querySelectorAll('div[style]')].filter(node => node.style.height.endsWith('%'));
  assert.equal(fills.length, 2);
  assert.ok(fills.every(node => parseFloat(node.style.height) > 0), 'both native bars must have positive painted height');
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.deepEqual(h.errors, []);
});

test('switches tabs locally and preserves selection on the same view rerender', async t => {
  const h = harness(); t.after(h.close); h.render();
  await until(() => h.document.querySelector('[role="tab"]'));
  button(h.document, '交互').click();
  await until(() => h.document.querySelector('[role="tabpanel"]').textContent.includes('按钮将发送'));
  assert.equal(h.messages.filter(message => message.type === 'action').length, 0);
  h.render(JSON.parse(JSON.stringify(sample)));
  await pause(); await pause();
  assert.equal(button(h.document, '交互').getAttribute('aria-selected'), 'true');
});

test('sends a real GenUI button action and displays matching host success', async t => {
  const h = harness(); t.after(h.close); h.render();
  await until(() => h.document.querySelector('[role="tab"]'));
  button(h.document, '交互').click(); await until(() => button(h.document, '刷新图表'));
  button(h.document, '刷新图表').click();
  await until(() => h.messages.some(message => message.type === 'action'));
  const action = h.messages.find(message => message.type === 'action');
  assert.equal(action.protocol, 1);
  assert.equal(action.action, 'refresh-chart');
  assert.deepEqual(action.payload, { type: 'button', label: '刷新图表' });
  assert.equal(typeof action.requestId, 'string');
  assert.equal('sessionId' in action, false);
  h.post({ type: 'action-result', protocol: 1, requestId: action.requestId, ok: true });
  await until(() => h.document.querySelector('[data-dsh-action-status]')?.textContent.includes('已发送'));
});

test('displays matching action failure and ignores unrelated results', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'button', label: '发送', action: 'send' }] });
  await until(() => button(h.document, '发送'));
  button(h.document, '发送').click();
  await until(() => h.messages.some(message => message.type === 'action'));
  const action = h.messages.find(message => message.type === 'action');
  h.post({ type: 'action-result', protocol: 1, requestId: 'unrelated', ok: false, error: '外部错误' });
  await pause(); assert.doesNotMatch(h.document.body.textContent, /外部错误/);
  h.post({ type: 'action-result', protocol: 1, requestId: action.requestId, ok: false, error: '会话已关闭' });
  await until(() => h.document.querySelector('[data-dsh-action-status]')?.textContent.includes('会话已关闭'));
});

test('keeps action buttons disabled without a host capability', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'button', label: '发送', action: 'send' }] }, { actionEnabled: false });
  await until(() => button(h.document, '发送'));
  assert.equal(button(h.document, '发送').disabled, true);
  button(h.document, '发送').click(); await pause();
  assert.equal(h.messages.filter(message => message.type === 'action').length, 0);
});

test('shows validation errors instead of silently dropping invalid native nodes', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'badge', content: 'broken' }] });
  await until(() => h.document.querySelector('[role="alert"]'));
  assert.match(h.document.querySelector('[role="alert"]').textContent, /label|badge/);
  assert.equal(h.document.querySelector('[data-genui]'), null);
});

test('diagnoses unsupported custom components and renderer versions', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'uninstalled-custom-widget', payload: 'opaque' }] });
  await until(() => h.document.querySelector('[role="alert"]'));
  assert.match(h.document.querySelector('[role="alert"]').textContent, /uninstalled-custom-widget/);
  h.render(sample, { view: { protocol: 1, renderer: { id: 'dsh.unknown', version: 2 }, viewId: 'view-two', data: sample } });
  await until(() => h.document.querySelector('[role="alert"]')?.textContent.includes('dsh.unknown'));
});

test('draws the complete native line and donut components', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: ['line', 'donut'].map(kind => ({ type: 'chart', kind, data: [{ label: 'A', value: 4 }, { label: 'B', value: 7 }] })) });
  await until(() => h.document.querySelector('[data-genui]'));
  assert.equal(h.document.querySelectorAll('svg').length, 2);
  assert.ok(h.document.querySelector('svg path, svg polyline'));
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('restores form drafts after the webview is recreated and isolates a new view', async t => {
  const form = { items: [{ type: 'input', id: 'draft', label: '草稿', value: '初始内容' }] };
  const h = harness(); t.after(h.close); h.render(form);
  await until(() => h.document.querySelector('input'));
  const input = h.document.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '已编辑');
  input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  await until(() => JSON.stringify(h.state()).includes('已编辑'));
  const restored = harness(h.state()); t.after(restored.close);
  restored.render(form); await until(() => restored.document.querySelector('input'));
  assert.equal(restored.document.querySelector('input').value, '已编辑');
  restored.render(form, { view: { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'other-view', data: form } });
  await until(() => restored.document.querySelector('input').value === '初始内容');
});

test('does not persist password drafts', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'input', id: 'secret', inputType: 'password', label: '密码' }] });
  await until(() => h.document.querySelector('input'));
  Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(h.document.querySelector('input'), 'super-secret');
  h.document.querySelector('input').dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  await pause(); await pause();
  assert.doesNotMatch(JSON.stringify(h.state()), /super-secret/);
});

test('loads lazy engine scripts only from the trusted host asset base', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'mermaid', code: 'graph TD; A-->B' }], assetBase: 'https://model.invalid/' });
  await until(() => h.document.querySelector('script[src]'));
  assert.equal(h.document.querySelector('script[src]').src, 'https://renderer.test/assets/mermaid.js');
});

test('ships all pinned engine bytes, CSS/fonts, version manifest and license notices', () => {
  const manifestPath = path.join(output, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'renderer version manifest is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.renderer.id, 'dsh.genui');
  assert.equal(manifest.renderer.version, 1);
  assert.equal(manifest.runtime.package, '@changfenhuang/dsh-genui');
  assert.equal(manifest.runtime.version, '0.15.0');
  assert.ok(manifest.sourceDependencies.some(dependency => dependency.package === 'react' && dependency.version === '18.3.1'), 'React dependency and license must be recorded even through a node_modules junction');
  const packageRoot = path.dirname(require.resolve('@changfenhuang/dsh-genui/package.json'));
  for (const file of ['mermaid.js', 'three.js', 'echarts-core.js', 'echarts-full.js', 'icons.js', 'maplibre.js']) {
    assert.deepEqual(fs.readFileSync(path.join(output, 'assets', file)), fs.readFileSync(path.join(packageRoot, 'lib/assets', file)), file);
    const entry = manifest.files.find(entry => entry.path === 'assets/' + file);
    assert.equal(entry.sha256, createHash('sha256').update(fs.readFileSync(path.join(output, 'assets', file))).digest('hex'));
  }
  assert.ok(fs.readFileSync(path.join(output, 'renderer.css'), 'utf8').includes('@font-face'));
  assert.ok(fs.readdirSync(path.join(output, 'fonts')).some(file => file.endsWith('.woff2')));
  assert.ok(fs.readFileSync(path.join(output, 'LICENSE'), 'utf8').includes('MIT License'));
  assert.ok(fs.readFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('MapLibre'));
  assert.ok(fs.readFileSync(path.join(output, 'BUNDLED_LICENSES.txt'), 'utf8').includes('Apache License'));
  const js = fs.readFileSync(path.join(output, 'renderer.js'), 'utf8');
  assert.doesNotMatch(js, /__ModuleLoader__/);
});


test('keeps an edited draft when the same view receives updated content', async t => {
  const h = harness(); t.after(h.close);
  const form = { items: [{ type: 'input', id: 'draft', label: '草稿', value: '初始内容' }] };
  h.render(form); await until(() => h.document.querySelector('input'));
  Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(h.document.querySelector('input'), '进行中的编辑');
  h.document.querySelector('input').dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  await until(() => JSON.stringify(h.state()).includes('进行中的编辑'));
  h.render({ title: '更新后的界面', items: [...form.items, { type: 'text', content: '新增说明' }] });
  await until(() => h.document.body.textContent.includes('新增说明'));
  assert.equal(h.document.querySelector('input').value, '进行中的编辑');
});

test('ignores pending action replies after replacing their view', async t => {
  const h = harness(); t.after(h.close);
  h.render({ items: [{ type: 'button', label: '发送', action: 'send' }] });
  await until(() => button(h.document, '发送'));
  button(h.document, '发送').click(); await until(() => h.messages.some(message => message.type === 'action'));
  const request = h.messages.find(message => message.type === 'action');
  h.render({ items: [{ type: 'text', content: '新的界面' }] }, { view: { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'new-view', data: { items: [{ type: 'text', content: '新的界面' }] } } });
  await until(() => h.document.body.textContent.includes('新的界面'));
  h.post({ type: 'action-result', protocol: 1, requestId: request.requestId, ok: false, error: '旧界面错误' });
  await pause();
  assert.doesNotMatch(h.document.body.textContent, /旧界面错误/);
  assert.equal(h.document.querySelector('[data-dsh-action-status]'), null);
});

test('updates host action capability without losing the local tab selection', async t => {
  const h = harness(); t.after(h.close); h.render();
  await until(() => h.document.querySelector('[role="tab"]'));
  button(h.document, '交互').click(); await until(() => button(h.document, '刷新图表'));
  h.render(sample, { actionEnabled: false });
  await until(() => button(h.document, '刷新图表').disabled);
  assert.equal(button(h.document, '交互').getAttribute('aria-selected'), 'true');
  h.render(sample, { actionEnabled: true });
  await until(() => !button(h.document, '刷新图表').disabled);
});


test('keeps an action pending throughout a long model turn', async t => {
  const h = harness(); t.after(h.close);
  const nativeSetTimeout = h.dom.window.setTimeout.bind(h.dom.window);
  let responseTimeout;
  h.dom.window.setTimeout = (callback, delay, ...args) => {
    if (delay >= 30_000) responseTimeout = callback;
    return nativeSetTimeout(callback, delay, ...args);
  };
  h.render({ items: [{ type: 'button', label: '继续推理', action: 'continue' }] });
  await until(() => button(h.document, '继续推理'));
  button(h.document, '继续推理').click(); await until(() => h.messages.some(message => message.type === 'action'));
  const request = h.messages.find(message => message.type === 'action');
  // Simulate the old fixed timeout without waiting for a real long model run.
  responseTimeout?.(); await pause();
  assert.doesNotMatch(h.document.querySelector('[data-dsh-action-status]').textContent, /超时/);
  h.post({ type: 'action-result', protocol: 1, requestId: request.requestId, ok: true });
  await until(() => h.document.querySelector('[data-dsh-action-status]')?.textContent.includes('已发送'));
});


test('matches the host view identity length limit', async t => {
  const h = harness(); t.after(h.close);
  const view = { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'v'.repeat(1024), data: { items: [{ type: 'text', content: '合法长标识' }] } };
  h.render(view.data, { view });
  await until(() => h.document.querySelector('[data-genui], [role="alert"]'));
  assert.ok(h.document.querySelector('[data-genui]'), 'a 1024-character host-approved view identity must render');
  h.render(view.data, { view: { ...view, viewId: 'v'.repeat(1025) } });
  await until(() => h.document.querySelector('[role="alert"]'));
  assert.match(h.document.querySelector('[role="alert"]').textContent, /viewId/);
});
