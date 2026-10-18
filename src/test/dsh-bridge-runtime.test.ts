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

describe('DeepSeek Harness bridge runtime', () => {
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

});
