import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BridgeRuntimeProbeResult {
  scopeCalls: boolean[];
  callTitle?: string;
  resultTitle?: string;
}

interface BridgePermissionProbeResult {
  decision: { kind?: string; reason?: string };
  callTitle?: string;
  title?: string;
}

function probeReadCallPresentation(options: { serviceScope?: 'agent' | 'bridge'; failure?: string; toolName?: string } = {}) {
  const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
  const script = `
    const path = await import('node:path');
    const bridge = await import(${bridgePath});
    const options = ${JSON.stringify(options)};
    const writes = [];
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    const handlers = {};
    const signal = new AbortController().signal;
    let cwd = 'D:/workspace/current';
    let resolutions = 0;
    const session = { id: 'read-session', header: { cwd: 'D:/workspace/original' } };
    const agent = { session, ctx: {} };
    const services = options.failure === 'missing' ? {} : {
      workingDirectory: {
        ensure: async (owner, cancellation) => {
          if (owner !== agent || cancellation !== signal) throw new Error('wrong execution scope');
          if (options.failure === 'ensure') throw new Error('working directory unavailable');
          return cwd;
        },
      },
      fs: {
        resolve: async (input, resolveOptions) => {
          resolutions++;
          if (options.failure === 'resolve') throw new Error('filesystem unavailable');
          if (resolveOptions.cwd !== cwd || resolveOptions.signal !== signal) throw new Error('wrong resolution options');
          return { processPath: path.win32.resolve(resolveOptions.cwd, input), original: input };
        },
        processPath: (target) => {
          if (options.failure === 'processPath') throw new Error('process path unavailable');
          return target.processPath;
        },
      },
    };
    if (options.serviceScope === 'agent') Object.assign(agent.ctx, services);
    const tools = { get: () => ({ presentCall: args => ({
      card: 'generic', kind: 'read', title: 'Read ' + args.file_path,
      locations: [{ path: args.file_path, line: args.offset }],
    }) }) };
    bridge.apply({
      llm: { listProviders: () => [] }, tools,
      ...(options.serviceScope === 'agent' ? {} : services),
      on: (name, handler) => { handlers[name] = handler; }, provide: () => undefined,
    });
    const args = Object.freeze({ file_path: 'Source/Actor.cs', offset: 2, limit: 3 });
    for (const callId of ['read-first', 'read-second']) {
      const exec = { agent, signal, callId, rootCallId: callId, name: options.toolName ?? 'read', arguments: args };
      const decision = await handlers['tools/pre-execute'](exec, async () => ({ kind: 'allow' }));
      if (exec.arguments !== args || decision.kind !== 'allow') throw new Error('execution changed');
      cwd = 'D:/workspace/resumed';
    }
    const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
    const calls = writes.filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    process.stdout.write(JSON.stringify({ calls, args, resolutions }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })) as { calls: Array<{ rawInput: unknown; presentation: Record<string, unknown> }>; args: unknown; resolutions: number };
}

describe('DeepSeek Harness bridge runtime', () => {
  it.each(['agent', 'bridge'] as const)('resolves read call paths from the current runtime directory (%s services)', (serviceScope) => {
    const result = probeReadCallPresentation({ serviceScope });
    expect(result.calls.map(call => call.presentation)).toEqual([
      { card: 'read', kind: 'read', title: 'Read Source/Actor.cs', path: 'D:\\workspace\\current\\Source\\Actor.cs', offset: 2, limit: 3, locations: [{ path: 'D:\\workspace\\current\\Source\\Actor.cs', line: 2 }] },
      { card: 'read', kind: 'read', title: 'Read Source/Actor.cs', path: 'D:\\workspace\\resumed\\Source\\Actor.cs', offset: 2, limit: 3, locations: [{ path: 'D:\\workspace\\resumed\\Source\\Actor.cs', line: 2 }] },
    ]);
    expect(result.args).toEqual({ file_path: 'Source/Actor.cs', offset: 2, limit: 3 });
    expect(result.calls.map(call => call.rawInput)).toEqual([
      { file_path: 'Source/Actor.cs', offset: 2, limit: 3 },
      { file_path: 'Source/Actor.cs', offset: 2, limit: 3 },
    ]);
  });

  it.each(['missing', 'ensure', 'resolve', 'processPath'])('keeps the existing read presentation when runtime resolution fails (%s)', (failure) => {
    const result = probeReadCallPresentation({ failure });
    for (const call of result.calls) {
      expect(call.presentation).toEqual({ card: 'generic', kind: 'read', title: 'Read Source/Actor.cs', locations: [{ path: 'Source/Actor.cs', line: 2 }] });
      expect(call.rawInput).toEqual({ file_path: 'Source/Actor.cs', offset: 2, limit: 3 });
    }
  });

  it('does not resolve a non-read tool through the filesystem services', () => {
    const result = probeReadCallPresentation({ toolName: 'custom-tool' });
    expect(result.resolutions).toBe(0);
    expect(result.calls[0].presentation.card).toBe('generic');
    expect(result.calls[0].presentation.locations).toEqual([{ path: 'Source/Actor.cs', line: 2 }]);
  });

  it('resolves presenters from the executing Agent scope', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
            const bridge = await import(${bridgePath});
      const writes = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        writes.push(String(chunk));
        return true;
      };
      const agent = { session: { id: 'session-1' } };
      const scopeCalls = [];
      const scoped = {
        presentCall: (args) => ({ card: 'generic', title: 'agent-view', rawInput: args }),
        presentResult: () => ({ card: 'generic', title: 'agent-result' }),
      };
      const global = {
        presentCall: () => ({ card: 'generic', title: 'global-view' }),
        presentResult: () => ({ card: 'generic', title: 'global-result' }),
      };
      const tools = {
        get: (name, scope) => {
          scopeCalls.push(scope === agent);
          return scope === agent ? scoped : global;
        },
      };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools,
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const exec = {
        agent,
        callId: 'call-1',
        rootCallId: 'call-1',
        name: 'shadow-tool',
        arguments: { value: 1 },
      };
      await handlers['tools/pre-execute'](exec, () => undefined);
      handlers['tools/result'](exec, { content: [], isError: false });
      process.stderr.write = originalWrite;
      const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
      const messages = writes
        .filter((line) => line.startsWith(prefix))
        .map((line) => JSON.parse(line.slice(prefix.length)));
      process.stdout.write(JSON.stringify({
        scopeCalls,
        callTitle: messages[0]?.presentation?.title,
        resultTitle: messages[1]?.presentation?.title,
      }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as BridgeRuntimeProbeResult;
    expect(result.scopeCalls).toEqual([true, true]);
    expect(result.callTitle).toBe('agent-view');
    expect(result.resultTitle).toBe('agent-result');
  });

  it('uses the executing Agent scope for the real DSH write presentation', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
      process.env.ACPILOT_DSH_BRIDGE_NONCE = 'test-nonce';
            const bridge = await import(${bridgePath});
      const writes = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        writes.push(String(chunk));
        return true;
      };
      const agent = {
        id: 'agent-1',
        session: { id: 'session-1' },
        ctx: {
          tools: {
            get: (name) => name === 'write' ? {
              presentCall: (args) => ({
                card: 'diff',
                title: \`Write \${args.file_path}\`,
                diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
                locations: [{ path: args.file_path }],
              }),
              presentResult: (args) => ({
                card: 'diff',
                title: \`Write \${args.file_path}\`,
              }),
            } : undefined,
          },
        },
      };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: { get: () => undefined },
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const exec = {
        agent,
        callId: 'call-write',
        rootCallId: 'call-write',
        name: 'write',
        arguments: {
          file_path: 'D:\\\\Temp\\\\dsh-note.md',
          content: 'after',
        },
      };
      const decision = await handlers['tools/pre-execute'](exec, async () => ({ kind: 'allow' }));
      process.stderr.write = originalWrite;
      const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
      const call = writes
        .filter((line) => line.startsWith(prefix))
        .map((line) => JSON.parse(line.slice(prefix.length)))
        .find((message) => message.type === 'tool_call');
      process.stdout.write(JSON.stringify({
        decision,
        card: call?.presentation?.card,
        title: call?.presentation?.title,
        diffPath: call?.presentation?.diffs?.[0]?.path,
      }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as BridgePermissionProbeResult & {
      card?: string;
      diffPath?: string;
    };
    expect(result.decision).toEqual({ kind: 'ask', reason: 'Write D:\\Temp\\dsh-note.md' });
    expect(result.card).toBe('diff');
    expect(result.title).toBe('Write D:\\Temp\\dsh-note.md');
    expect(result.diffPath).toBe('D:\\Temp\\dsh-note.md');
  });
  it('turns an allowed diff presentation into an approval request', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
      process.env.ACPILOT_DSH_BRIDGE_NONCE = 'test-nonce';
            const bridge = await import(${bridgePath});
      const writes = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        writes.push(String(chunk));
        return true;
      };
      const agent = { session: { id: 'session-1' } };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: {
          get: () => ({
            presentCall: () => ({ card: 'diff', title: 'Write dsh-hello.md', locations: [{ path: 'dsh-hello.md', line: 1 }] }),
          }),
        },
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const decision = await handlers['tools/pre-execute']({
        agent,
        callId: 'call-1',
        rootCallId: 'call-1',
        name: 'write',
        arguments: { path: 'dsh-hello.md', content: 'after' },
      }, async () => ({ kind: 'allow' }));
      process.stderr.write = originalWrite;
      const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
      const call = writes
        .filter((line) => line.startsWith(prefix))
        .map((line) => JSON.parse(line.slice(prefix.length)))
        .find((message) => message.type === 'tool_call');
      process.stdout.write(JSON.stringify({ decision, callTitle: call?.presentation?.title }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as BridgePermissionProbeResult;
    expect(result.decision).toEqual({ kind: 'ask', reason: 'Write dsh-hello.md' });
    expect(result.callTitle).toBe('Write dsh-hello.md');
  });

  it('runs downstream policy listeners before converting an allowed diff call into ask', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
      process.env.ACPILOT_DSH_BRIDGE_NONCE = 'test-nonce';
            const bridge = await import(${bridgePath});
      const handlers = {};
      let nextCalled = false;
      const approval = { config: { policy: 'ask' }, overrideOf: () => 'ask' };
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: { get: () => ({ presentCall: () => ({ card: 'diff', title: 'Write dsh-hello.md' }) }) },
        get: (name) => name === 'approval' ? approval : undefined,
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const decision = await handlers['tools/pre-execute']({
        agent: { session: { id: 'session-1' } },
        callId: 'call-1', rootCallId: 'call-1', name: 'write',
        arguments: { file_path: 'dsh-hello.md', content: 'after' },
      }, async () => {
        nextCalled = true;
        return { kind: 'allow' };
      });
      process.stdout.write(JSON.stringify({ decision, nextCalled }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as {
      decision: { kind?: string; reason?: string };
      nextCalled: boolean;
    };
    expect(result.decision).toEqual({ kind: 'ask', reason: 'Write dsh-hello.md' });
    expect(result.nextCalled).toBe(true);
  });
  it('re-enables the approval channel for full-access write calls when ACPilot is attached', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
      process.env.ACPILOT_DSH_BRIDGE_NONCE = 'test-nonce';
            const bridge = await import(${bridgePath});
      const policyChanges = [];
      const session = { id: 'session-1' };
      const agent = { session };
      const approval = {
        config: { policy: 'never' },
        overrideOf: () => 'never',
        setPolicy: (target, policy) => { policyChanges.push({ target, policy }); },
      };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: {
          get: () => ({ presentCall: () => ({ card: 'diff', title: 'Write dsh-hello.md' }) }),
        },
        get: (name) => name === 'approval' ? approval : undefined,
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const decision = await handlers['tools/pre-execute']({
        agent,
        callId: 'call-1',
        rootCallId: 'call-1',
        name: 'write',
        arguments: { path: 'dsh-hello.md', content: 'after' },
      }, async () => ({ kind: 'allow' }));
      process.stdout.write(JSON.stringify({ decision, policyChanges }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as {
      decision: { kind?: string; reason?: string };
      policyChanges: Array<{ target: unknown; policy: string }>;
    };
    expect(result.decision).toEqual({ kind: 'ask', reason: 'Write dsh-hello.md' });
    expect(result.policyChanges).toHaveLength(1);
    expect(result.policyChanges[0]?.target).toEqual({ session: { id: 'session-1' } });
    expect(result.policyChanges[0]?.policy).toBe('ask');
  });
  it('switches approval before a downstream full-access denial', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
      process.env.ACPILOT_DSH_BRIDGE_NONCE = 'test-nonce';
            const bridge = await import(${bridgePath});
      let policy = 'never';
      const policyChanges = [];
      const session = { id: 'session-1' };
      const agent = { session };
      const approval = {
        config: { policy: 'never' },
        overrideOf: () => policy,
        setPolicy: (target, nextPolicy) => { policy = nextPolicy; policyChanges.push({ target, policy: nextPolicy }); },
      };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: { get: () => ({ presentCall: () => ({ card: 'diff', title: 'Write dsh-hello.md' }) }) },
        get: (name) => name === 'approval' ? approval : undefined,
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const decision = await handlers['tools/pre-execute']({
        agent, callId: 'call-1', rootCallId: 'call-1', name: 'write',
        arguments: { path: 'dsh-hello.md', content: 'after' },
      }, async () => policy === 'ask'
        ? { kind: 'allow' }
        : { kind: 'deny', reason: 'approval disabled' });
      process.stdout.write(JSON.stringify({ decision, policy, policyChanges }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as {
      decision: { kind?: string; reason?: string };
      policy: string;
      policyChanges: Array<{ target: unknown; policy: string }>;
    };
    expect(result.decision).toEqual({ kind: 'ask', reason: 'Write dsh-hello.md' });
    expect(result.policy).toBe('ask');
    expect(result.policyChanges).toHaveLength(1);
    expect(result.policyChanges[0]?.policy).toBe('ask');
  });

  it('projects DSH result metadata into read and edit cards when no presenter is installed', () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
            const bridge = await import(${bridgePath});
      const writes = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        writes.push(String(chunk));
        return true;
      };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: { get: () => ({}) },
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      const agent = { session: { id: 'session-1' } };
      handlers['tools/result'](
        { agent, callId: 'read-1', rootCallId: 'read-1', name: 'read', arguments: { file_path: 'src/a.ts' } },
        {
          isError: false,
          content: [{ type: 'text', text: '<path>src/a.ts</path>' }],
          meta: { path: 'src/a.ts', offset: 4, lines: [{ number: 4, text: 'const x = 1;' }], totalLines: 8, lang: 'ts' },
        },
      );
      handlers['tools/result'](
        { agent, callId: 'edit-1', rootCallId: 'edit-1', name: 'edit', arguments: { file_path: 'src/a.ts' } },
        {
          isError: false,
          content: [{ type: 'text', text: 'Edited' }],
          meta: { diffs: [{ path: 'src/a.ts', oldText: 'const x = 1;', newText: 'const x = 2;' }] },
        },
      );
      process.stderr.write = originalWrite;
      const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
      const messages = writes
        .filter((line) => line.startsWith(prefix))
        .map((line) => JSON.parse(line.slice(prefix.length)));
      process.stdout.write(JSON.stringify({ read: messages[0]?.presentation, edit: messages[1]?.presentation }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as {
      read?: Record<string, unknown>;
      edit?: Record<string, unknown>;
    };
    expect(result.read).toMatchObject({
      card: 'read',
      path: 'src/a.ts',
      offset: 4,
      totalLines: 8,
      lang: 'ts',
    });
    expect(result.edit).toMatchObject({
      card: 'diff',
      diffs: [{ path: 'src/a.ts', oldText: 'const x = 1;', newText: 'const x = 2;' }],
      locations: [{ path: 'src/a.ts' }],
    });
  });
  it('preflights impossible edits before the permission gate', async () => {
    const bridgePath = JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/index.mjs')).href);
    const script = `
      process.env.ACPILOT_DSH_BRIDGE_NONCE = 'test-nonce';
            const bridge = await import(${bridgePath});
      const writes = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
      const handlers = {};
      bridge.apply({
        llm: { listProviders: () => [] },
        tools: { get: () => ({ presentCall: () => ({ card: 'diff', title: 'Edit hello.md' }) }) },
        on: (name, handler) => { handlers[name] = handler; },
        provide: () => undefined,
      });
      let nextCalled = false;
      const decision = await handlers['tools/pre-execute']({
        agent: { session: { id: 'session-1', header: { cwd: process.cwd() } } },
        callId: 'call-1', rootCallId: 'call-1', name: 'edit',
        arguments: { file_path: path.join(process.cwd(), 'dsh-bridge', 'index.mjs'), old_string: 'does-not-exist', new_string: 'x' },
      }, async () => { nextCalled = true; return { kind: 'allow' }; });
      process.stderr.write = originalWrite;
      const prefix = 'ACPILOT_DSH_BRIDGE_TOOL\\t';
      const messages = writes.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));
      process.stdout.write(JSON.stringify({ decision, nextCalled, calls: messages.filter((message) => message.type === 'tool_call').length }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw) as {
      decision: { kind?: string; reason?: string };
      nextCalled: boolean;
      calls: number;
    };
    expect(result.nextCalled).toBe(false);
    expect(result.calls).toBe(1);
    expect(result.decision.kind).toBe('deny');
    expect(result.decision.reason).toContain('old_string was not found');
  });
});
