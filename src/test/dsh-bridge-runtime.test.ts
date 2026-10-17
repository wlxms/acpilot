import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BridgeRuntimeProbeResult {
  scopeCalls: boolean[];
  callTitle?: string;
  resultTitle?: string;
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
});