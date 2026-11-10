/* Optional Chromium smoke: real layout, local lazy engines and Webview CSP. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'resources/dsh-renderer');
const evidence = path.join(root, 'build/dsh-renderer-browser');
const chrome = process.env.ACPILOT_CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sample = {
  title: 'GenUI 完整运行时 · 本地资源验证',
  items: [
    { type: 'row', justify: 'between', items: [{ type: 'badge', label: '本地资源', tone: 'success' }, { type: 'icon', name: 'AddMember', label: '按需图标' }] },
    { type: 'text', content: 'KaTeX: $E = mc^2$' },
    { type: 'chart', kind: 'bars', data: [{ label: '请求', value: 12 }, { label: '完成', value: 9 }] },
    { type: 'mermaid', code: 'graph LR; Bridge-->Runtime; Runtime-->Session' },
    { type: 'echart', title: 'ECharts Core', preset: 'bar', data: [{ label: 'A', value: 3 }, { label: 'B', value: 7 }] },
    { type: 'echart', title: 'ECharts Full', option: { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: { type: 'value' }, series: [{ type: 'line', data: [2, 4] }] } },
    { type: 'scene3d', title: 'Three.js WebGL', meshes: [{ shape: 'box', color: '#679efe' }, { shape: 'sphere', position: [2, 0, 0], color: '#4ed17e' }] },
    { type: 'map', title: 'MapLibre 离线地图', locations: [{ id: 'one', label: '上海', coordinates: [121.47, 31.23] }, { id: 'two', label: '杭州', coordinates: [120.15, 30.27] }], center: [120.8, 30.8], zoom: 4, height: 240 },
    { type: 'image', src: '__SMOKE_ORIGIN__/smoke-image.svg', alt: '资源图片' },
    { type: 'button', label: '发送动作', action: 'smoke-action' },
  ],
};

async function main() {
  await fs.access(chrome);
  await fs.access(path.join(assets, 'manifest.json'));
  await fs.mkdir(evidence, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'acpilot-genui-chromium-'));
  const network = [];
  const failures = [];
  const diagnostics = [];
  let browser;
  let socket;
  let server;
  let outcome;
  try {
    server = http.createServer(async (request, response) => {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const url = new URL(request.url, origin);
      network.push(url.pathname);
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (url.pathname === '/smoke-image.svg') {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><rect width="320" height="100" rx="12" fill="#e4edfd"/><circle cx="80" cy="50" r="28" fill="#679efe"/><path d="M150 75L185 25L220 75Z" fill="#4ed17e"/></svg>');
        return;
      }
      if (url.pathname === '/') {
        const csp = `default-src 'none'; script-src 'nonce-smoke' ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data:; connect-src ${origin}; worker-src blob:;`;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/renderer.css"><style>body{padding:16px;box-sizing:border-box}#dsh-root{max-width:1148px;margin:auto}</style></head><body class="vscode-light"><main id="dsh-root"></main><script nonce="smoke">window.__messages=[];let state={};window.acquireVsCodeApi=()=>({getState:()=>state,setState:value=>state=value,postMessage:message=>{window.__messages.push(message);if(message.type==='action')window.postMessage({type:'action-result',protocol:1,requestId:message.requestId,ok:true},location.origin)}});window.__render=(data)=>window.postMessage({type:'render',protocol:1,view:{protocol:1,renderer:{id:'dsh.genui',version:1},viewId:'browser-smoke',data},assetBase:location.origin+'/assets/',actionEnabled:true},location.origin);</script><script nonce="smoke" src="/renderer.js"></script></body></html>`);
        return;
      }
      const filename = path.resolve(assets, '.' + url.pathname);
      if (!filename.startsWith(assets + path.sep)) { response.writeHead(403); response.end(); return; }
      try {
        const content = await fs.readFile(filename);
        response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        response.end(content);
      } catch { response.writeHead(404); response.end(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    browser.stdout.on('data', bytes => diagnostics.push(bytes.toString()));
    browser.stderr.on('data', bytes => diagnostics.push(bytes.toString()));
    let port;
    for (let attempts = 0; attempts < 150; attempts++) {
      try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; break; } catch { await pause(100); }
    }
    assert.ok(port, 'Chromium did not expose its isolated debug endpoint');
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await once(socket, 'open');
    const requests = new Map();
    let counter = 0;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.id !== undefined) {
        const pending = requests.get(message.id);
        requests.delete(message.id);
        if (pending) clearTimeout(pending.timer);
        if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
        else pending?.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') failures.push(message.params.exceptionDetails);
      else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') failures.push(message.params.entry);
      else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') failures.push({ source: 'console', arguments: message.params.args.map(argument => argument.value ?? argument.description) });
    });
    function command(method, params = {}, sessionId) {
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error('Chromium command timed out: ' + method)); }, 10_000);
        requests.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    const target = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await command('Runtime.enable', {}, sessionId);
    await command('Page.enable', {}, sessionId);
    await command('Log.enable', {}, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await command('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' }, sessionId);
    async function evaluate(expression) {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function until(expression, label) {
      for (let attempts = 0; attempts < 300; attempts++) {
        if (await evaluate(expression)) return;
        await pause(50);
      }
      throw new Error(label + ' did not become ready: ' + await evaluate('document.body.innerText'));
    }
    await until('window.__messages?.some(message=>message.type==="ready")', 'renderer handshake');
    await evaluate('window.__render(' + JSON.stringify(sample).replaceAll('__SMOKE_ORIGIN__', 'http://127.0.0.1:' + server.address().port) + ')');
    await until('document.querySelector("[data-genui-chart=bars]") && document.querySelector(".katex")', 'native chart and KaTeX');
    await until('document.querySelector("[data-genui-scene3d] canvas")', 'Three.js scene');
    await until('document.querySelector(".maplibregl-canvas")', 'MapLibre map');
    await until('window.__GenuiAssets__?.mermaid && document.querySelectorAll("canvas").length >= 4 && document.querySelector("svg[aria-roledescription]")', 'Mermaid and ECharts engines');
    await until('document.querySelector("img[alt=资源图片]")?.naturalWidth > 0', 'image resource');
    await evaluate('document.fonts.ready.then(()=>true)');
    await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="发送动作").click()');
    await until('window.__messages.some(message=>message.type==="action") && document.querySelector("[data-dsh-action-status]")?.textContent.includes("已发送")', 'action round trip');
    const rendered = await evaluate('({canvases:[...document.querySelectorAll("canvas")].map(canvas=>({width:canvas.width,height:canvas.height})),math:document.querySelectorAll(".katex").length,svgs:document.querySelectorAll("svg").length,imageWidth:document.querySelector("img[alt=资源图片]").naturalWidth,alerts:[...document.querySelectorAll("[role=alert]")].map(node=>node.textContent),engines:Object.keys(window.__GenuiAssets__??{}),messages:window.__messages,fonts:document.fonts.status})');
    for (const canvas of rendered.canvases) assert.ok(canvas.width > 0 && canvas.height > 0, 'each engine must paint a sized canvas');
    assert.deepEqual(rendered.alerts, []);
    for (const engine of ['mermaid', 'three', 'echartsCore', 'echartsFull', 'icons', 'maplibre']) assert.ok(rendered.engines.includes(engine), engine + ' engine must load locally');
    assert.deepEqual(failures, [], 'runtime and CSP errors must be absent');
    const metrics = await command('Page.getLayoutMetrics', {}, sessionId);
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 } }, sessionId);
    await fs.writeFile(path.join(evidence, 'runtime.png'), Buffer.from(screenshot.data, 'base64'));
    outcome = { ok: true, executable: chrome, browser: version.Browser, renderer: JSON.parse(await fs.readFile(path.join(assets, 'manifest.json'), 'utf8')).runtime, rendered, network, failures };
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([once(browser, 'exit'), pause(2500)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('acpilot-genui-chromium-'), 'cleanup must target only the unique browser profile');
    try { await fs.rm(resolved, { recursive: true, force: true }); } catch (error) { diagnostics.push('Retained isolated profile: ' + resolved + ' (' + error.message + ')'); }
    await fs.writeFile(path.join(evidence, 'chromium.log'), diagnostics.join(''));
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(outcome ?? { ok: false, network, failures }, null, 2) + '\n');
  }
  console.log('Headless Chromium passed: native charts, KaTeX, six local lazy engines and action round trip. Evidence: ' + evidence);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
