import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';
import type { DshBridgeToolResultMessage } from '../backends/dsh/bridge-protocol';
import type { ISerializableStreamPart } from '../ssp/types';

interface StreamTree {
  stream: BackendPipelineStream;
  parts: Map<string, ISerializableStreamPart>;
  records: ReturnType<ISerializableStreamPart['toJSON']>[];
  children: Map<string, StreamTree>;
}

function streamTree(): StreamTree {
  const parts = new Map<string, ISerializableStreamPart>();
  const records: ReturnType<ISerializableStreamPart['toJSON']>[] = [];
  const children = new Map<string, StreamTree>();
  const stream = {
    push(part: ISerializableStreamPart) { parts.set(part.id, part); records.push(JSON.parse(JSON.stringify(part.toJSON()))); },
    update(id: string, data: Record<string, unknown>) { (parts.get(id) as ISerializableStreamPart & { update?: (value: unknown) => void })?.update?.(data); },
    has(id: string) { return parts.has(id); }, writeMeta() {}, updateTitle() {},
    subsession(id: string) { if (!children.has(id)) {children.set(id, streamTree());} return children.get(id)!.stream; },
  } as unknown as BackendPipelineStream;
  return { stream, parts, records, children };
}
function update(value: Record<string, unknown>): ActiveSessionMessage {
  return { kind: 'session_update', notification: { sessionId: 'root', update: value }, update: value } as never;
}
const stop = { kind: 'stop', response: { stopReason: 'end_turn' }, stopReason: 'end_turn' } as ActiveSessionMessage;
const data = { title: 'Status', items: [{ type: 'badge', label: 'Done' }], 'dsh-go/view': { kind: 'native' } };
const view = { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'render-1', data };
const result = { type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'render-1', rootToolCallId: 'render-1', toolName: 'render_ui', isError: false,
  output: '[genui-render]\nstatus=rendered', presentation: { card: 'generic', title: 'Rendered Status' }, richView: view } as DshBridgeToolResultMessage;

describe('DSH rich view pipeline', () => {
  it.each(['initial-terminal', 'cached-result', 'missing-initial'] as const)('emits one view alongside the native card for %s ACP delivery', async variant => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.stream });
    if (variant === 'cached-result' || variant === 'missing-initial') {pipeline.handleBridgeMessage(result);}
    else {pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', toolCallId: 'render-1', rootToolCallId: 'render-1', toolName: 'render_ui', rawInput: { spec: data }, presentation: { card: 'generic', title: 'Render Status' } });}
    await pipeline.run((async function* () {
      yield update({ sessionUpdate: variant === 'missing-initial' ? 'tool_call_update' : 'tool_call', toolCallId: 'render-1', title: 'render_ui', kind: 'other', status: 'completed', rawInput: { spec: data }, rawOutput: '[genui-render]\nstatus=rendered' });
      pipeline.handleBridgeMessage(result);
      pipeline.handleBridgeMessage(result);
      yield update({ sessionUpdate: 'tool_call_update', toolCallId: 'render-1', status: 'completed' });
      yield stop;
    })(), { isCancellationRequested: false });
    const views = tree.records.filter(part => part.kind === 'richView');
    expect(views).toHaveLength(1);
    expect(views[0].payload).toEqual(view);
    expect(views[0].meta).toMatchObject({ sessionId: 'root', toolCallId: 'render-1' });
    const native = tree.records.filter(part => part.kind === 'toolInvocation');
    expect(native).toHaveLength(1);
    expect((native[0].payload as { state: { status: string } }).state.status).toBe('completed');
    expect(tree.parts.get('render-1')?.toJSON().payload).toMatchObject({ state: { status: 'completed', output: result.output } });
  });

  it.each([false, true])('keeps a child view and its result in the managed source scope (result-only=%s)', resultOnly => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.stream });
    pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', presentation: { card: 'subagent', status: 'running', childSessionId: 'child' } });
    const scope = { agentSessionId: 'child', subAgentInvocationId: 'delegate' };
    if (!resultOnly) {pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', ...scope, toolCallId: 'render-1', rootToolCallId: 'render-1', toolName: 'render_ui', rawInput: { spec: data }, presentation: { card: 'generic', title: 'Render' } });}
    pipeline.handleBridgeMessage({ ...result, ...scope });
    pipeline.handleBridgeMessage({ ...result, ...scope });
    const child = tree.children.get('delegate');
    const views = child?.records.filter(part => part.kind === 'richView') ?? [];
    expect(views).toHaveLength(1);
    expect(views[0].payload).toEqual(view);
    expect(views[0].meta).toMatchObject({ sessionId: 'child', parentSessionId: 'root', subAgentInvocationId: 'delegate', toolCallId: 'render-1' });
    expect(child?.parts.get('render-1')?.toJSON().payload).toMatchObject({ state: { status: 'completed', output: result.output } });
    expect(tree.records.filter(part => part.kind === 'richView')).toHaveLength(0);
  });

  it('ignores error, other-session, stale-child and disposed rich results', () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.stream });
    pipeline.handleBridgeMessage({ ...result, isError: true });
    pipeline.handleBridgeMessage({ ...result, sessionId: 'other' });
    pipeline.handleBridgeMessage({ ...result, agentSessionId: 'old-child', subAgentInvocationId: 'old-delegate' });
    pipeline.dispose();
    pipeline.handleBridgeMessage(result);
    expect(tree.records.filter(part => part.kind === 'richView')).toHaveLength(0);
    expect(tree.children.size).toBe(0);
  });
});
