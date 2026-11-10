import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { DshRenderHost, registerDshRenderHost } from '../chat-rendering/host';
import { wrapDshRenderStream } from '../chat-rendering/stream';
import { RichViewSSP } from '../ssp/impl/rich-view';
import { createSSPFromRecord } from '../backend/streaming/deserialize';
import type { DshRichView } from '../chat-rendering/protocol';
const registration = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('vscode', async importOriginal => {
  const original = await importOriginal<typeof import('vscode')>();
  return { ...original, Uri: Object.assign(original.Uri, {
    joinPath(base: vscode.Uri, ...parts: string[]) { return base.with({ path: (base.path.endsWith('/') ? base.path.slice(0,-1) : base.path) + '/' + parts.join('/') }); }
  }), chat: { ...original.chat, registerChatOutputRenderer: registration.register } };
});
const view: DshRichView = { protocol:1, renderer:{id:'dsh.genui',version:1}, viewId:'view-a', data:{title:'Status',items:[{type:'badge',label:'Ready'}],extra:{preserve:true}} };
const token = { isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}}) };
function output() { const chunks:string[]=[]; return {chunks,raw:{markdown(value:string|{value:string}){chunks.push(typeof value==='string'?value:value.value);},progress:vi.fn(),push:vi.fn()}}; }
function envelope(text:string):DshRichView&{routeToken:string} { const start=text.indexOf('dsh-ui\n')+'dsh-ui\n'.length; return JSON.parse(text.slice(start,text.indexOf('\n',start))); }
function channel() {
  let receive:((message:unknown)=>unknown)|undefined; let dispose:(()=>unknown)|undefined;
  const webview={html:'',cspSource:'https://trusted-webview.invalid',options:{},asWebviewUri(uri:vscode.Uri){return{toString:()=> 'https://trusted-webview.invalid'+uri.path};},
    onDidReceiveMessage(listener:(message:unknown)=>unknown){receive=listener;return{dispose(){receive=undefined;}};},postMessage:vi.fn(async(_message:unknown)=>true)};
  return {webview,outputWebview:{webview,onDidDispose(listener:()=>unknown){dispose=listener;return{dispose(){}};}},send:async(message:unknown)=>{await receive?.(message);},dispose:()=>dispose?.()};
}
function render(host:DshRenderHost,c:ReturnType<typeof channel>,data:unknown) { return host.render({value:new TextEncoder().encode(JSON.stringify(data))},c.outputWebview as never,vscode.Uri.file('D:/acpilot'),token as never); }
describe('DSH render stream and replay',()=>{
  it('rewrites split fences with an originating route and complete data',async()=>{
    const {raw,chunks}=output();const host=new DshRenderHost(true);const route={sessionKey:'a',submit:vi.fn(async()=>{})};const stream=wrapDshRenderStream(raw as never,route,host);const json=JSON.stringify(view);
    stream.markdown('Before\n\x60\x60');stream.markdown('\x60dsh-ui\n'+json.slice(0,30));stream.markdown(json.slice(30)+'\n\x60\x60');stream.markdown('\x60\nAfter');stream.flushDshRender();
    const full=chunks.join(''),actual=envelope(full);expect(full).toContain('Before\n');expect(full).toContain('\nAfter');expect(actual).toMatchObject(view);expect(typeof actual.routeToken).toBe('string');await host.submit(actual.routeToken,view,'confirm',{item:1});expect(route.submit).toHaveBeenCalledWith('confirm',{item:1});
  });
  it('replaces a source supplied route token',async()=>{
    const host=new DshRenderHost(true),{raw,chunks}=output();const a={sessionKey:'a',submit:vi.fn(async()=>{})},b={sessionKey:'b',submit:vi.fn(async()=>{})};wrapDshRenderStream(raw as never,a,host).richView(view);const stolen=envelope(chunks.pop()!).routeToken;
    wrapDshRenderStream(raw as never,b,host).markdown('\x60\x60\x60dsh-ui\n'+JSON.stringify({...view,routeToken:stolen})+'\n\x60\x60\x60\n');const actual=envelope(chunks.pop()!);expect(actual.routeToken).not.toBe(stolen);await host.submit(actual.routeToken,view,'confirm',{});expect(b.submit).toHaveBeenCalledOnce();expect(a.submit).not.toHaveBeenCalled();
  });
  it('normalizes GenUI specs and preserves invalid, unfinished and nested examples',()=>{
    const {raw,chunks}=output(),stream=wrapDshRenderStream(raw as never,undefined,new DshRenderHost(true));stream.markdown('\x60\x60\x60dsh-ui\n'+JSON.stringify(view.data)+'\n\x60\x60\x60\n');expect(envelope(chunks.pop()!).data).toEqual(view.data);
    const source='\x60\x60\x60\x60text\n\x60\x60\x60dsh-ui\n{}\n\x60\x60\x60\n\x60\x60\x60\x60\n\x60\x60\x60dsh-ui\ninvalid\n\x60\x60\x60\n\x60\x60\x60dsh-ui\nunfinished';stream.markdown(source);stream.flushDshRender();expect(chunks.join('')).toBe(source);
  });
  it('replays rich SSP data without persisting a route token',()=>{
    const original=new RichViewSSP({partId:'tool-view',view},{sessionId:'a',toolCallId:'tool-a'}),record=original.toJSON(),{raw,chunks}=output();createSSPFromRecord(record).render(raw as never);expect(record.kind).toBe('richView');expect(record.payload).toEqual(view);expect(envelope(chunks.join(''))).toEqual(view);expect(record.meta).toMatchObject({sessionId:'a',toolCallId:'tool-a'});
  });
  it('provides readable fallback when the proposed API is unavailable',()=>{
    const{raw,chunks}=output();wrapDshRenderStream(raw as never,undefined,new DshRenderHost(false)).richView(view);expect(chunks.join('')).toContain('DSH view (dsh.genui v1)');expect(chunks.join('')).toContain('\x60\x60\x60json');expect(chunks.join('')).not.toContain('routeToken');
  });
});
describe('DSH renderer host',()=>{
  beforeEach(()=>vi.clearAllMocks());
  it('waits for ready and uses only bundled resources',async()=>{
    const host=new DshRenderHost(true),c=channel(),route={sessionKey:'a',submit:vi.fn(async()=>{})};let initialized=false;const pending=render(host,c,host.bind(view,route)).then(()=>{initialized=true;});await Promise.resolve();expect(initialized).toBe(false);
    expect(c.webview.html).toContain('id="dsh-root"');expect(c.webview.html).toContain('renderer.js');expect(c.webview.html).toContain('renderer.css');expect(c.webview.html).toContain("default-src 'none'");expect(c.webview.postMessage).not.toHaveBeenCalled();await c.send({type:'ready',protocol:1});await pending;expect(c.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'render',protocol:1,view,actionEnabled:true,assetBase:expect.stringContaining('/resources/dsh-renderer/assets/')}));host.dispose();
  });
  it('uses the bound route and returns the actual session error',async()=>{
    const host=new DshRenderHost(true),c=channel(),route={sessionKey:'a',submit:vi.fn(async()=>{throw new Error('busy');})};const pending=render(host,c,host.bind(view,route));await c.send({type:'ready',protocol:1});await pending;await c.send({type:'action',protocol:1,requestId:'a',action:'confirm',payload:{item:1},sessionKey:'b'});expect(route.submit).toHaveBeenCalledWith('confirm',{item:1});expect(c.webview.postMessage).toHaveBeenLastCalledWith({type:'action-result',protocol:1,requestId:'a',ok:false,error:'busy'});host.dispose();
  });
  it('keeps the first action guard when a later action is rejected as busy',async()=>{
    const host=new DshRenderHost(true),c=channel();let finish!:()=>void;const route={sessionKey:'a',submit:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}))};const pending=render(host,c,host.bind(view,route));await c.send({type:'ready',protocol:1});await pending;
    const first=c.send({type:'action',protocol:1,requestId:'first',action:'confirm',payload:{}});await c.send({type:'action',protocol:1,requestId:'second',action:'confirm',payload:{}});const third=c.send({type:'action',protocol:1,requestId:'third',action:'confirm',payload:{}});expect(route.submit).toHaveBeenCalledOnce();finish();await Promise.all([first,third]);host.dispose();
  });
  it('disables unbound actions and stops after disposal',async()=>{
    const host=new DshRenderHost(true),c=channel(),pending=render(host,c,view);await c.send({type:'ready',protocol:1});await pending;expect(c.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({actionEnabled:false}));c.dispose();const before=c.webview.postMessage.mock.calls.length;await c.send({type:'action',protocol:1,requestId:'a',action:'confirm',payload:{}});expect(c.webview.postMessage).toHaveBeenCalledTimes(before);host.dispose();
  });
  it('shows unsupported and invalid view data as escaped readable content',async()=>{
    const host=new DshRenderHost(true);for(const data of [{...view,renderer:{id:'custom',version:1},data:'<script>attack</script>'},{protocol:2,data:'<script>attack</script>'}]){const c=channel();await render(host,c,data);expect(c.webview.html).not.toContain('<script>attack</script>');expect(c.webview.html).not.toContain('renderer.js');expect(c.webview.html).toContain('&lt;script&gt;');}host.dispose();
  });
  it('registers the contributed view type and tolerates a disabled API',()=>{
    registration.register.mockReturnValue({dispose(){}});const context={extensionUri:vscode.Uri.file('D:/acpilot'),subscriptions:[]};registerDshRenderHost(context as never);expect(registration.register).toHaveBeenCalledWith('acpilot.dshView',expect.objectContaining({renderChatOutput:expect.any(Function)}));registration.register.mockImplementation(()=>{throw new Error('proposal disabled');});expect(()=>registerDshRenderHost(context as never)).not.toThrow();
  });
});
