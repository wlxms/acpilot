import { describe, expect, it, vi } from 'vitest';
import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';
import { ToolInvocationSSP } from '../ssp/impl/tool-invocation';
import { SerializableSessionStream } from '../backend/streaming/session-stream';
import { ChatSubagentToolInvocationData } from '../types/vscode-proposed-additions';

vi.mock('vscode', async importOriginal => ({
  ...await importOriginal<typeof import('vscode')>(),
  ChatSubagentToolInvocationData: (await import('../types/vscode-proposed-additions')).ChatSubagentToolInvocationData,
}));

interface StreamTree { value: BackendPipelineStream; parts: Map<string, ToolInvocationSSP>; children: Map<string, StreamTree>; }
function streamTree(): StreamTree {
  const parts = new Map<string, ToolInvocationSSP>();
  const children = new Map<string, StreamTree>();
  const value = {
    push(part: ToolInvocationSSP) { parts.set(part.id, part); },
    update(id: string, data: Record<string, unknown>) { parts.get(id)?.update(data); },
    has(id: string) { return parts.has(id); },
    subsession(id: string) { if (!children.has(id)) {children.set(id, streamTree());} return children.get(id)!.value; },
    writeMeta: vi.fn(), updateTitle: vi.fn(),
  } as unknown as BackendPipelineStream;
  return { value, parts, children };
}
function acp(update: Record<string, unknown>): ActiveSessionMessage {
  return { kind: 'session_update', notification: { sessionId: 'root', update }, update } as never;
}
const terminal = { kind: 'stop', response: { stopReason: 'end_turn' }, stopReason: 'end_turn' } as ActiveSessionMessage;
function start() {
  return { type: 'tool_call', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker',
    rawInput: { description: 'Inspect source', prompt: 'Review the code', agent_preset: 'reviewer' },
    presentation: { card: 'subagent', title: 'Inspect source', childSessionId: 'child', runId: 'run-1', status: 'running', agentName: 'reviewer' } } as const;
}

describe('DSH managed subagent lifecycle', () => {
  it('promotes the rendered generic ACP call to a native subagent card while it is still running', async () => {
    const rendered: Array<{ toolName: string; toolCallId: string; isComplete?: boolean; subAgentInvocationId?: string; toolSpecificData?: unknown }> = [];
    const stream = new SerializableSessionStream({
      push(part: typeof rendered[number]) { rendered.push(part); },
      markdown: vi.fn(), progress: vi.fn(), updateToolInvocation: vi.fn(),
    } as never, { workspaceRoot: 'D:/workspace', backendName: 'dsh', sessionId: 'root', turnIndex: 0, requestId: 'request', schedulingMode: 'immediate' });
    const pipeline = new DshPipeline({ sessionId: 'root', stream });
    let generic: typeof rendered[number] | undefined;
    let promoted: typeof rendered[number] | undefined;
    let runningPushes = 0;
    await pipeline.run((async function* () {
      // The committed ACP call and pre-execute bridge presentation precede
      // materialization's authoritative subagent/start event.
      pipeline.handleBridgeMessage({ ...start(), presentation: { card: 'generic', title: 'spawn_worker' } });
      yield acp({ sessionUpdate: 'tool_call', toolCallId: 'delegate', title: 'spawn_worker', status: 'in_progress', rawInput: start().rawInput });
      generic = rendered.at(-1);
      pipeline.handleBridgeMessage(start());
      promoted = rendered.at(-1);
      pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
        output: [{ type: 'text', text: 'started subagent child' }], presentation: start().presentation });
      runningPushes = rendered.length;
      pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
        output: 'Review done', presentation: { ...start().presentation, status: 'completed', stopReason: 'completed' } });
      yield terminal;
    })(), { isCancellationRequested: false });
    await stream.flush();
    expect(generic).toMatchObject({ toolName: 'spawn_worker', toolCallId: 'delegate', isComplete: false });
    expect(generic?.toolSpecificData).not.toBeInstanceOf(ChatSubagentToolInvocationData);
    expect(promoted).toMatchObject({ toolName: 'subagent', toolCallId: 'delegate', isComplete: false });
    expect(promoted?.subAgentInvocationId).toBeUndefined();
    expect(promoted?.toolSpecificData).toBeInstanceOf(ChatSubagentToolInvocationData);
    expect(promoted?.toolSpecificData).toMatchObject({ description: 'Inspect source', agentName: 'reviewer', prompt: 'Review the code' });
    expect(runningPushes).toBe(2);
  });

  it('does not request a host continuation after DSH consumes the child result and finishes its response', async () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.value });
    const result = await pipeline.run((async function* () {
      pipeline.handleBridgeMessage(start());
      yield acp({ sessionUpdate: 'tool_call', toolCallId: 'delegate', title: 'spawn_worker', status: 'in_progress' });
      pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
        output: [{ type: 'text', text: 'Review done' }], presentation: { ...start().presentation, status: 'completed', stopReason: 'completed' } });
      // DSH delivers the child result to its parent and waits for that parent's
      // resulting response before resolving the ACP prompt's stop boundary.
      yield acp({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The review is complete.' } });
      yield terminal;
    })(), { isCancellationRequested: false });
    expect(tree.parts.get('delegate')?.payload.state).toMatchObject({ status: 'completed', output: 'Review done' });
    // The request handler schedules another empty prompt for true; DSH has
    // already performed this continuation within the single ACP prompt.
    expect(result).toMatchObject({ completed: true, hadSubagentTasks: false });
  });

  it('keeps an activation running until subagent/end and groups child tools in its native card', async () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', directory: 'D:/workspace', stream: tree.value });
    pipeline.handleBridgeMessage(start());
    const snapshots: Array<() => void> = [];
    await pipeline.run((async function* () {
      yield acp({ sessionUpdate: 'tool_call', toolCallId: 'delegate', title: 'spawn_worker', status: 'in_progress', rawInput: start().rawInput });
      pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
        output: [{ type: 'text', text: 'started subagent child' }], presentation: start().presentation });
      yield acp({ sessionUpdate: 'tool_call_update', toolCallId: 'delegate', status: 'completed', rawOutput: 'started subagent child' });
      const activationStatus = tree.parts.get('delegate')?.payload.state.status;
      snapshots.push(() => expect(activationStatus).toBe('running'));
      const nativeParts: Array<{ toolSpecificData?: { description?: string; agentName?: string; prompt?: string } }> = [];
      tree.parts.get('delegate')!.render({ push(part: unknown) { nativeParts.push(part as typeof nativeParts[number]); }, markdown() {}, progress() {} });
      snapshots.push(() => expect(nativeParts[0]?.toolSpecificData).toMatchObject({ description: 'Inspect source', agentName: 'reviewer', prompt: 'Review the code' }));
      pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', agentSessionId: 'child', subAgentInvocationId: 'delegate',
        toolCallId: 'child-read', rootToolCallId: 'child-read', toolName: 'read', rawInput: { filePath: 'src/a.ts' }, presentation: { card: 'read', path: 'src/a.ts', offset: 1 } } as never);
      pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', agentSessionId: 'child', subAgentInvocationId: 'delegate',
        toolCallId: 'child-read', rootToolCallId: 'child-read', toolName: 'read', isError: false, output: 'code' } as never);
      const childStatus = tree.children.get('delegate')?.parts.get('child-read')?.payload.state.status;
      snapshots.push(() => expect(childStatus).toBe('completed'));
      pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
        output: 'Review done', presentation: { ...start().presentation, status: 'completed', stopReason: 'completed' } });
      yield terminal;
    })(), { isCancellationRequested: false });
    snapshots.forEach(assert => assert());
    expect(tree.parts.get('delegate')!.payload.state).toMatchObject({ status: 'completed', output: 'Review done' });
  });

  it('terminates running subagent cards and child tools when Stop closes the event stream', async () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.value });
    const token = { isCancellationRequested: false };
    await pipeline.run((async function* () {
      pipeline.handleBridgeMessage(start());
      yield acp({ sessionUpdate: 'tool_call', toolCallId: 'delegate', title: 'spawn_worker', status: 'in_progress' });
      pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', agentSessionId: 'child', subAgentInvocationId: 'delegate',
        toolCallId: 'child-bash', rootToolCallId: 'child-bash', toolName: 'bash', rawInput: { command: 'long command' }, presentation: { card: 'terminal' } } as never);
      token.isCancellationRequested = true;
    })(), token);
    expect(tree.parts.get('delegate')?.payload.state.status).toBe('error');
    expect(tree.children.get('delegate')?.parts.get('child-bash')?.payload.state.status).toBe('error');
    pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
      output: 'late result', presentation: { ...start().presentation, status: 'completed' } });
    expect(tree.parts.get('delegate')?.payload.state.status).toBe('error');
  });

  it("ignores a previous turn's child events in a replacement pipeline", async () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.value });
    pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
      output: 'old result', presentation: { ...start().presentation, status: 'completed' } });
    pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', agentSessionId: 'child', subAgentInvocationId: 'delegate',
      toolCallId: 'old-child-read', rootToolCallId: 'old-child-read', toolName: 'read', presentation: { card: 'read', path: 'a.ts' } });
    await pipeline.run((async function* () { yield terminal; })(), { isCancellationRequested: false });
    expect(tree.parts.size).toBe(0);
    expect(tree.children.size).toBe(0);
  });

  it('leaves a still-active subagent running at a natural root stop', async () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.value });
    pipeline.handleBridgeMessage(start());
    await pipeline.run((async function* () { yield terminal; })(), { isCancellationRequested: false });
    expect(tree.parts.get('delegate')?.payload.state.status).toBe('running');
    pipeline.handleBridgeMessage({ type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'delegate', rootToolCallId: 'delegate', toolName: 'spawn_worker', isError: false,
      output: 'Finished later', presentation: { ...start().presentation, status: 'completed' } });
    expect(tree.parts.get('delegate')?.payload.state).toMatchObject({ status: 'completed', output: 'Finished later' });
  });

  it('terminates a nested subagent and its tools when the transport closes without a stop', async () => {
    const tree = streamTree();
    const pipeline = new DshPipeline({ sessionId: 'root', stream: tree.value });
    await pipeline.run((async function* () {
      pipeline.handleBridgeMessage(start());
      pipeline.handleBridgeMessage({ ...start(), toolCallId: 'nested', rootToolCallId: 'nested', agentSessionId: 'child', subAgentInvocationId: 'delegate',
        presentation: { ...start().presentation, childSessionId: 'grandchild', runId: 'run-nested' } });
      pipeline.handleBridgeMessage({ type: 'tool_call', protocol: 1, sessionId: 'root', agentSessionId: 'grandchild', subAgentInvocationId: 'nested', parentSubAgentInvocationId: 'delegate',
        toolCallId: 'nested-read', rootToolCallId: 'nested-read', toolName: 'read', rawInput: { filePath: 'a.ts' }, presentation: { card: 'read', path: 'a.ts' } });
      yield acp({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Waiting for children' } });
    })(), { isCancellationRequested: false });
    expect(tree.children.get('delegate')?.parts.get('nested')?.payload.state.status).toBe('error');
    expect(tree.children.get('delegate')?.children.get('nested')?.parts.get('nested-read')?.payload.state.status).toBe('error');
  });
});
