import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';
import type { DshBridgePresentation } from '../backends/dsh/bridge-protocol';
import { ToolInvocationSSP } from '../ssp/impl/tool-invocation';

function targetStream() {
  const parts = new Map<string, ToolInvocationSSP>();
  const emitted: Array<{ toolSpecificData?: { values?: Array<{ fsPath?: string; uri?: { fsPath: string; path: string }; range?: { start: { line: number } } }> } }> = [];
  const firstPayloads: Record<string, unknown>[] = [];
  const render = (part: ToolInvocationSSP) => part.render({ push: value => emitted.push(value as never), markdown() {}, progress() {} });
  const stream = {
    push(part: ToolInvocationSSP) { parts.set(part.id, part); firstPayloads.push(part.toJSON().payload as never); render(part); },
    update(id: string, data: Record<string, unknown>) { const part = parts.get(id); part?.update(data); if (part) {render(part);} },
    has(id: string) { return parts.has(id); }, writeMeta() {}, updateTitle() {},
  } as unknown as BackendPipelineStream;
  return { stream, parts, emitted, firstPayloads };
}

function update(value: Record<string, unknown>): ActiveSessionMessage {
  return { kind: 'session_update', notification: { sessionId: 'session-1', update: value }, update: value } as never;
}
function stop(): ActiveSessionMessage { return { kind: 'stop', response: { stopReason: 'end_turn' }, stopReason: 'end_turn' } as never; }
function referencePaths(target: ReturnType<typeof targetStream>): string[] {
  return target.emitted.flatMap(part => part.toolSpecificData?.values ?? []).map(value => value.uri?.fsPath ?? value.fsPath ?? '');
}

async function runSearch(presentation: DshBridgePresentation, options: { resultOnly?: boolean; name?: string } = {}) {
  const target = targetStream();
  const pipeline = new DshPipeline({ sessionId: 'session-1', directory: 'D:/work/original', stream: target.stream });
  const name = options.name ?? (presentation.shape === 'paths' ? 'Glob' : 'grep');
  const rawInput = { pattern: '*.cs', path: 'src' };
  const call = { type: 'tool_call' as const, protocol: 1 as const, sessionId: 'session-1', toolCallId: 'search-1', rootToolCallId: 'search-1', toolName: name, rawInput, presentation };
  if (!options.resultOnly) {pipeline.handleBridgeMessage(call);}
  else {pipeline.handleBridgeMessage({ ...call, type: 'tool_result', isError: false, output: 'Found files' });}
  await pipeline.run((async function* () {
    yield update({ sessionUpdate: 'tool_call', toolCallId: 'search-1', title: name, kind: 'search', status: 'in_progress', rawInput });
    if (!options.resultOnly) {pipeline.handleBridgeMessage({ ...call, type: 'tool_result', isError: false, output: 'Found files' });}
    yield update({ sessionUpdate: 'tool_call_update', toolCallId: 'search-1', status: 'completed' });
    yield stop();
  })(), { isCancellationRequested: false });
  return { target, rawInput };
}

describe('DSH search reference pipeline', () => {
  it.each([false, true])('canonicalizes glob references before their first emission (resultOnly=%s)', async (resultOnly) => {
    const { target, rawInput } = await runSearch({ card: 'search', shape: 'paths', cwd: 'D:/work/current', paths: ['src/Actor.cs', 'C:\\External\\Drive.cs', '\\\\Server\\Share\\UNC.cs'], total: 3, truncated: false }, { resultOnly });
    expect(target.emitted[0].toolSpecificData?.values?.map(value => value.uri?.fsPath ?? value.fsPath)).toEqual([
      'D:\\work\\current\\src\\Actor.cs', 'C:\\External\\Drive.cs', '\\\\Server\\Share\\UNC.cs',
    ]);
    expect((target.firstPayloads[0].state as { metadata?: { dshPresentation?: { paths: string[] } } }).metadata?.dshPresentation?.paths).toEqual([
      'D:\\work\\current\\src\\Actor.cs', 'C:\\External\\Drive.cs', '\\\\Server\\Share\\UNC.cs',
    ]);
    expect(rawInput).toEqual({ pattern: '*.cs', path: 'src' });
  });

  it('preserves canonical grep paths and line locations through history serialization', async () => {
    const { target } = await runSearch({ card: 'search', shape: 'matches', cwd: '/srv/current', files: [{ path: 'src/Actor.cs', matches: [{ lineNumber: 7, line: 'class Actor' }] }], locations: [{ path: 'src/Actor.cs', line: 7 }], total: 1, truncated: false });
    const payload = JSON.parse(JSON.stringify(target.parts.get('search-1')!.toJSON().payload));
    expect(payload.state.metadata.dshPresentation.files).toEqual([{ path: '/srv/current/src/Actor.cs', matches: [{ lineNumber: 7, line: 'class Actor' }] }]);
    expect(payload.state.metadata.dshPresentation.locations).toEqual([{ path: '/srv/current/src/Actor.cs', line: 7 }]);
    const restored = new ToolInvocationSSP(payload);
    const history = targetStream();
    history.stream.push(restored);
    const values = history.emitted.flatMap(part => part.toolSpecificData?.values ?? []);
    expect(values.some(value => value.uri?.path === '/srv/current/src/Actor.cs' && value.range?.start.line === 6)).toBe(true);
  });

  it.each(['glob', 'grep'])('emits only result files when ACP completes before the search bridge result (%s)', async (name) => {
    const target = targetStream();
    const pipeline = new DshPipeline({ sessionId: 'session-1', directory: 'D:/work/original', stream: target.stream });
    const rawInput = { pattern: '*.cs', path: 'src' };
    const base = { protocol: 1 as const, sessionId: 'session-1', toolCallId: 'ordinary', rootToolCallId: 'ordinary', toolName: name };
    pipeline.handleBridgeMessage({ ...base, type: 'tool_call', rawInput, presentation: { card: 'generic', kind: 'search', title: name + ' *.cs in src' } });
    let referencesBeforeResult: string[] = [];
    await pipeline.run((async function* () {
      yield update({ sessionUpdate: 'tool_call', toolCallId: 'ordinary', title: name, kind: 'search', status: 'in_progress', rawInput });
      yield update({ sessionUpdate: 'tool_call_update', toolCallId: 'ordinary', status: 'completed', rawOutput: 'Found files' });
      referencesBeforeResult = referencePaths(target);
      pipeline.handleBridgeMessage({ ...base, type: 'tool_result', isError: false, output: 'Found files', presentation: {
        card: 'search', cwd: 'D:/work/current', shape: name === 'glob' ? 'paths' : 'matches', total: 1, truncated: false,
        ...(name === 'glob' ? { paths: ['src/Actor.cs'] } : { files: [{ path: 'src/Actor.cs', matches: [{ lineNumber: 7, line: 'class Actor' }] }] }),
      } });
      yield stop();
    })(), { isCancellationRequested: false });
    expect(referencesBeforeResult).toEqual([]);
    expect(referencePaths(target).length).toBeGreaterThan(0);
    expect(new Set(referencePaths(target))).toEqual(new Set(["D:\\work\\current\\src\\Actor.cs"]));
    expect(target.parts.get('ordinary')!.toJSON().payload.state?.input).toEqual(rawInput);
  });

  it.each(['glob', 'grep'])('does not emit the search root as a file when the bridge is missing (%s)', async (name) => {
    const target = targetStream();
    const pipeline = new DshPipeline({ sessionId: 'session-1', directory: 'D:/work/original', stream: target.stream });
    await pipeline.run((async function* () {
      yield update({ sessionUpdate: 'tool_call', toolCallId: 'fallback', title: name, kind: 'search', status: 'in_progress', rawInput: { pattern: '*.cs', path: 'src' } });
      yield update({ sessionUpdate: 'tool_call_update', toolCallId: 'fallback', status: 'completed', rawOutput: 'Found files' });
      yield stop();
    })(), { isCancellationRequested: false });
    expect(referencePaths(target)).toEqual([]);
    expect(target.parts.get('fallback')!.toJSON().payload.state?.status).toBe('completed');
  });
});
