import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function probeSearch(options: { shape: 'paths' | 'matches'; serviceScope?: 'agent' | 'bridge' | 'missing'; metadataOnly?: boolean; uppercase?: boolean; ignorePromise?: boolean }) {
  const bridgeUrl = JSON.stringify(pathToFileURL(path.resolve('dsh-bridge/index.mjs')).href);
  const script = `
    const bridge = await import(${bridgeUrl});
    const options = ${JSON.stringify(options)};
    const writes = [];
    process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
    const handlers = {};
    const signal = new AbortController().signal;
    const header = { cwd: 'D:/work/current' };
    const agent = { session: { id: 'search-session', header }, ctx: {} };
    const paths = ['src/actor.cs', '/srv/shared/POSIX.ts', 'C:\\\\External\\\\Drive.cs', '\\\\\\\\Server\\\\Share\\\\UNC.cs'];
    const meta = options.shape === 'paths'
      ? { shape: 'paths', paths, total: 4, truncated: false }
      : { shape: 'matches', files: [{ path: paths[0], matches: [{ lineNumber: 7, line: 'class Actor' }] }], locations: [{ path: paths[0], line: 7 }], total: 1, truncated: false };
    const resolverInputs = [];
    const services = {
      workingDirectory: { ensure: async () => { throw new Error('search does not execute in read cwd'); } },
      fs: {
        resolve: async (input, opts) => {
          if (opts.signal !== signal || opts.cwd !== 'D:/work/current') throw new Error('wrong search execution cwd');
          resolverInputs.push(input);
          return { canonical: 'D:\\\\work\\\\current\\\\Source\\\\Actor.cs' };
        },
        processPath: target => target.canonical,
      },
    };
    if (options.serviceScope === 'agent') agent.ctx.get = name => services[name];
    const definition = {
      presentCall: args => ({ card: 'generic', kind: 'search', title: 'Search', rawInput: args.pattern }),
      ...(!options.metadataOnly ? { presentResult: () => ({ card: 'search', ...meta }) } : {}),
    };
    bridge.apply({
      llm: { listProviders: () => [] }, tools: { get: () => definition },
      ...(options.serviceScope === 'bridge' ? { get: name => services[name] } : {}),
      on: (name, handler) => { handlers[name] = handler; }, provide() {},
    });
    const args = Object.freeze({ pattern: '*.cs', path: 'src' });
    const exec = { agent, signal, callId: 'search-1', name: options.uppercase ? 'Glob' : options.shape === 'paths' ? 'glob' : 'grep', arguments: args };
    await handlers['tools/pre-execute'](exec, async () => ({ kind: 'allow' }));
    header.cwd = 'D:/work/resumed';
    const returned = handlers['tools/result'](exec, { isError: false, content: [{ type: 'text', text: 'Found files' }], meta });
    const emittedBeforeAwait = writes.some(line => line.includes('tool_result'));
    if (!options.ignorePromise) await returned;
    const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
    const messages = writes.filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    process.stdout.write(JSON.stringify({ messages, args, resolverInputs, emittedBeforeAwait }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  })) as { messages: Array<{ type: string; rawInput?: unknown; presentation: Record<string, unknown> }>; args: unknown; resolverInputs: string[]; emittedBeforeAwait: boolean };
}

describe('DSH search reference bridge', () => {
  it('emits the result synchronously when the DSH observer ignores returned promises', () => {
    const result = probeSearch({ shape: 'paths', serviceScope: 'missing', ignorePromise: true });
    expect(result.emittedBeforeAwait).toBe(true);
  });
  it.each(['agent', 'bridge'] as const)('uses the captured search cwd with unrelated %s filesystem services', (serviceScope) => {
    const result = probeSearch({ shape: 'paths', serviceScope, uppercase: true });
    expect(result.messages[1].presentation.paths).toEqual([
      'D:\\work\\current\\src\\actor.cs', '/srv/shared/POSIX.ts', 'C:\\External\\Drive.cs', '\\\\Server\\Share\\UNC.cs',
    ]);
    expect(result.messages[1].presentation.cwd).toBe('D:/work/current');
    expect(result.messages[0].rawInput).toEqual({ pattern: '*.cs', path: 'src' });
    expect(result.args).toEqual({ pattern: '*.cs', path: 'src' });
  });

  it('resolves grep grouped files and line locations before emitting the result', () => {
    const result = probeSearch({ shape: 'matches', serviceScope: 'agent' });
    expect(result.messages[1].presentation.files).toEqual([
      { path: 'D:\\work\\current\\src\\actor.cs', matches: [{ lineNumber: 7, line: 'class Actor' }] },
    ]);
    expect(result.messages[1].presentation.locations).toEqual([{ path: 'D:\\work\\current\\src\\actor.cs', line: 7 }]);
  });

  it('resolves the metadata-only search fallback in the captured execution cwd', () => {
    const result = probeSearch({ shape: 'paths', serviceScope: 'bridge', metadataOnly: true });
    expect(result.messages[1].presentation.paths).toEqual([
      'D:\\work\\current\\src\\actor.cs', '/srv/shared/POSIX.ts', 'C:\\External\\Drive.cs', '\\\\Server\\Share\\UNC.cs',
    ]);
  });

  it('uses the exact search workdir when optional filesystem services are missing', () => {
    const result = probeSearch({ shape: 'paths', serviceScope: 'missing' });
    expect(result.messages[1].presentation.paths).toEqual([
      'D:\\work\\current\\src\\actor.cs', '/srv/shared/POSIX.ts', 'C:\\External\\Drive.cs', '\\\\Server\\Share\\UNC.cs',
    ]);
  });
});
