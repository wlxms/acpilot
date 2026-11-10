import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { BackendPipelineStream } from '../backend/backend';
import type { DshBridgePresentation } from '../backends/dsh/bridge-protocol';
import { DshPipeline } from '../backends/dsh/pipeline';
import { ToolInvocationSSP } from '../ssp/impl/tool-invocation';

function sessionUpdate(update: Record<string, unknown>): ActiveSessionMessage {
  return { kind: 'session_update', notification: { sessionId: 'terminal-session', update }, update } as never;
}

const variants: Array<{ name: string; kind: string; input: Record<string, unknown>; presentation?: DshBridgePresentation; fromContent?: boolean }> = [
  { name: 'wait_agent', kind: 'other', input: { timeout_ms: 30_000 } },
  { name: 'glob', kind: 'search', input: { pattern: '*.cs', path: 'src' }, presentation: { card: 'generic', kind: 'search', title: 'Find C# files' }, fromContent: true },
  { name: 'glob', kind: 'search', input: { pattern: '*.cs', path: 'src' }, presentation: { card: 'search', shape: 'paths', title: 'Find C# files', cwd: 'D:/work/current', paths: ['src/Actor.cs'], total: 1, truncated: false } },
];
const cases = variants.flatMap(variant => (['completed', 'failed'] as const).map(status => ({ ...variant, status })));

describe('DSH first terminal tool calls', () => {
  it.each(cases)('preserves first $status ACP state for $name ($presentation.card)', async ({ name, kind, input, presentation, status, fromContent }) => {
    const snapshots: ReturnType<ToolInvocationSSP['toJSON']>[] = [];
    const parts = new Map<string, ToolInvocationSSP>();
    const emitted: Array<{ isComplete?: boolean; isError?: boolean; toolSpecificData?: { values?: Array<{ fsPath?: string; uri?: { fsPath: string } }> } }> = [];
    const render = (part: ToolInvocationSSP) => part.render({ push: value => emitted.push(value as never), markdown() {}, progress() {} });
    const stream = {
      push(part: ToolInvocationSSP) { snapshots.push(JSON.parse(JSON.stringify(part.toJSON()))); parts.set(part.id, part); render(part); },
      update(id: string, data: Record<string, unknown>) { const part = parts.get(id); part?.update(data); if (part) {render(part);} },
      has(id: string) { return parts.has(id); }, writeMeta() {}, updateTitle() {},
    } as unknown as BackendPipelineStream;
    const pipeline = new DshPipeline({ sessionId: 'terminal-session', directory: 'D:/work/original', stream });
    if (presentation) {
      pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'terminal-session', toolCallId: 'terminal-1', rootToolCallId: 'terminal-1', toolName: name, rawInput: input, presentation });
    }
    const output = status === 'failed' ? 'Search rejected' : name === 'wait_agent' ? { timedOut: true } : 'Found files';
    const expectedOutput = status === 'failed' ? 'Search rejected' : name === 'wait_agent' ? '{"timedOut":true}' : 'Found files';
    await pipeline.run((async function* () {
      yield sessionUpdate({
        sessionUpdate: 'tool_call', toolCallId: 'terminal-1', title: name, kind, status, rawInput: input,
        ...(fromContent ? { content: [{ type: 'content', content: { type: 'text', text: expectedOutput } }] } : { rawOutput: output }),
      });
      yield { kind: 'stop', stopReason: 'end_turn', response: { stopReason: 'end_turn' } } as never;
    })(), { isCancellationRequested: false });
    const first = snapshots[0].payload.state;
    expect(first?.status).toBe(status === 'failed' ? 'error' : 'completed');
    expect(first?.output).toBe(expectedOutput);
    expect(first?.error).toBe(status === 'failed' ? expectedOutput : undefined);
    expect(first?.input).toEqual(input);
    expect(first?.title).toBe(presentation?.title ?? name);
    expect(first?.metadata?.dshToolName).toBe(name);
    expect(emitted[0].isComplete).toBe(true);
    expect(emitted[0].isError ?? false).toBe(status === 'failed');
    expect(parts.get('terminal-1')!.toJSON().payload.state?.status).toBe(first?.status);
    if (presentation?.card === 'search') {
      expect((first?.metadata?.dshPresentation as DshBridgePresentation).paths).toEqual(['D:\\work\\current\\src\\Actor.cs']);
      const references = emitted.flatMap(part => part.toolSpecificData?.values ?? []).map(value => value.uri?.fsPath ?? value.fsPath);
      expect(references.every(value => value === 'D:\\work\\current\\src\\Actor.cs')).toBe(true);
      if (status === 'completed') {expect(references.length).toBeGreaterThan(0);}
    }
  });
  it.each(['completed', undefined] as const)('seeds a cached search result before the first implicit ACP update (status=%s)', async (status) => {
    const parts = new Map<string, ToolInvocationSSP>();
    const emitted: Array<{ isComplete?: boolean; toolSpecificData?: { values?: Array<{ fsPath?: string; uri?: { fsPath: string } }> } }> = [];
    const snapshots: ReturnType<ToolInvocationSSP['toJSON']>[] = [];
    const render = (part: ToolInvocationSSP) => part.render({ push: value => emitted.push(value as never), markdown() {}, progress() {} });
    const stream = {
      push(part: ToolInvocationSSP) { snapshots.push(JSON.parse(JSON.stringify(part.toJSON()))); parts.set(part.id, part); render(part); },
      update(id: string, data: Record<string, unknown>) { const part = parts.get(id); part?.update(data); if (part) {render(part);} },
      has(id: string) { return parts.has(id); }, writeMeta() {}, updateTitle() {},
    } as unknown as BackendPipelineStream;
    const pipeline = new DshPipeline({ sessionId: 'terminal-session', directory: 'D:/work/original', stream });
    pipeline.handleBridgeMessage({
      type: 'tool_result', protocol: 1, sessionId: 'terminal-session', toolCallId: 'implicit-search', rootToolCallId: 'implicit-search',
      toolName: 'glob', isError: false, output: 'Found files',
      presentation: { card: 'search', shape: 'paths', cwd: 'D:/work/current', paths: ['src/Actor.cs'], total: 1, truncated: false },
    });
    const rawInput = { pattern: '*.cs', path: 'src' };
    await pipeline.run((async function* () {
      yield sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'implicit-search', title: 'glob', kind: 'search', ...(status ? { status, rawOutput: 'Found files' } : {}), rawInput });
      yield { kind: 'stop', stopReason: 'end_turn', response: { stopReason: 'end_turn' } } as never;
    })(), { isCancellationRequested: false });
    expect(emitted[0].toolSpecificData?.values?.map(value => value.uri?.fsPath ?? value.fsPath)).toEqual(['D:\\work\\current\\src\\Actor.cs']);
    expect(emitted[0].isComplete).toBe(true);
    expect(snapshots[0].payload.state?.metadata?.dshToolName).toBe('glob');
    expect(snapshots[0].payload.state?.status).toBe('completed');
    expect(snapshots[0].payload.state?.input).toEqual(rawInput);
    expect(snapshots[0].payload.state?.output).toBe('Found files');
  });

});
