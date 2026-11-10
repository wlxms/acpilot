import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const spec = {
  title: 'Status', items: [{ type: 'row', justify: 'space-between', children: [
    { type: 'badge', content: 'task-1 completed' },
    { type: 'badge', content: 'pwsh 不可用' },
  ] }],
};
const canonicalSpec = {
  title: 'Status', items: [{ type: 'row', justify: 'between', items: [
    { type: 'badge', label: 'task-1 completed' },
    { type: 'badge', label: 'pwsh 不可用' },
  ] }],
};

function probe(options: { isError?: boolean; metadata?: unknown; input?: unknown; unrelated?: boolean; agentUnrelated?: boolean } = {}) {
  const bridgeUrl = JSON.stringify(pathToFileURL(path.resolve('dsh-bridge/index.mjs')).href);
  const script = `
    const bridge = await import(${bridgeUrl});
    const options = ${JSON.stringify(options)};
    const writes = [];
    process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
    const handlers = {};
    let executed;
    let metaCalls = 0;
    const genui = {
      name: 'render_ui', description: 'Render an interactive UI card by passing a GenUI spec, using the dsh-ui fence vocabulary.',
      parameters: { type: 'object', properties: { spec: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } } } }, required: ['spec'] },
      output: { schema: { type: 'string' }, presentationMeta: args => { metaCalls++; return { ...args.spec, 'dsh-go/view': { kind: 'native', title: 'Status' } }; } },
      presentCall: () => ({ card: 'generic', title: 'Render UI', kind: 'other' }),
      presentResult: () => ({ card: 'generic', title: 'Rendered UI' }),
    };
    const unrelated = { name: 'render_ui', description: 'A custom unrelated renderer', presentCall: () => ({ card: 'generic', title: 'Other UI' }), output: { presentationMeta: args => args.spec } };
    const agent = { session: { id: 'root-session' }, ctx: { tools: { get: () => options.agentUnrelated ? unrelated : options.unrelated ? unrelated : genui } } };
    bridge.apply({ llm: { listProviders: () => [] }, tools: { get: () => genui }, on: (name, handler) => { handlers[name] = handler; }, provide() {} });
    const exec = { agent, signal: new AbortController().signal, callId: 'render-1', name: 'render_ui', arguments: options.input ?? { spec: ${JSON.stringify(spec)} } };
    await handlers['tools/pre-execute'](exec, async () => { executed = exec.arguments; return { kind: 'allow' }; });
    const beforeResultCalls = metaCalls;
    handlers['tools/result'](exec, { isError: options.isError === true, content: [{ type: 'text', text: options.isError ? 'invalid spec' : '[genui-render]\\nstatus=rendered' }], value: 'Rendered', ...(Object.hasOwn(options, 'metadata') ? { meta: options.metadata } : {}) });
    const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
    const messages = writes.filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    process.stdout.write(JSON.stringify({ messages, executed, metaCalls: metaCalls - beforeResultCalls }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  })) as { messages: Array<{ type: string; rawInput?: unknown; richView?: { protocol: number; renderer: unknown; viewId: string; data: unknown } }>; executed: unknown; metaCalls: number };
}

describe('DSH rich view bridge', () => {
  it('normalizes the screenshot aliases before the GenUI tool executes', () => {
    const result = probe();
    expect(result.executed).toEqual({ spec: canonicalSpec });
    expect(result.messages[0].rawInput).toEqual(result.executed);
  });

  it('preserves the complete successful authoritative presentation metadata', () => {
    const metadata = { ...canonicalSpec, 'dsh-go/view': { kind: 'native', title: 'Status' }, futureExtension: { arbitrary: [1, 2] } };
    const result = probe({ metadata });
    expect(result.messages[1].richView).toEqual({ protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'render-1', data: metadata });
    expect(result.metaCalls).toBe(0);
  });

  it('uses output.presentationMeta when the runtime does not project result metadata', () => {
    const result = probe();
    expect(result.messages[1].richView?.data).toEqual({ ...canonicalSpec, 'dsh-go/view': { kind: 'native', title: 'Status' } });
    expect(result.metaCalls).toBe(1);
  });

  it('does not generate a successful view or recompute metadata after an error', () => {
    const result = probe({ isError: true, metadata: canonicalSpec });
    expect(result.messages[1].richView).toBeUndefined();
    expect(result.metaCalls).toBe(0);
  });

  it('treats an authoritative null metadata projection as no view', () => {
    const result = probe({ metadata: null });
    expect(result.messages[1].richView).toBeUndefined();
    expect(result.metaCalls).toBe(0);
  });

  it.each([false, true])('does not modify or render an unrelated same-name effective tool (agent override=%s)', agentUnrelated => {
    const result = probe({ unrelated: true, agentUnrelated });
    expect(result.executed).toEqual({ spec });
    expect(result.messages[1].richView).toBeUndefined();
  });

  it('preserves canonical fields and arbitrary payload objects while normalizing component fields', () => {
    const input = { spec: { items: [{ type: 'row', justify: 'flex-start', items: [
      { type: 'badge', label: 'Canonical', content: 'Ignored alias' },
      { type: 'button', label: 'Send', action: 'send', payload: { type: 'badge', content: 'payload bytes' } },
    ], children: [{ type: 'badge', content: 'Ignored children' }] }] } };
    const result = probe({ input });
    expect(result.executed).toEqual({ spec: { items: [{ ...input.spec.items[0], justify: 'start' }] } });
  });

  it('leaves malformed component values for the GenUI validator without throwing in pre-execute', () => {
    const input = { spec: { items: [{ type: 'row', justify: { toString: null, valueOf: null }, items: [] }] } };
    expect(probe({ input }).executed).toEqual(input);
  });
});
