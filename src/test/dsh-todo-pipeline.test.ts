import { describe, expect, it } from 'vitest';
import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';
import { ToolInvocationSSP } from '../ssp/impl/tool-invocation';

function sessionUpdate(update: Record<string, unknown>): ActiveSessionMessage {
  return {
    kind: 'session_update',
    notification: { sessionId: 'session-1', update },
    update,
  } as never;
}

describe('DSH todo presentation', () => {
  it.each([
    ['early', 'todo_write'], ['late', 'todo_write'], ['none', 'todo_write'],
    ['early', 'Update todo list'], ['late', 'Update todo list'], ['none', 'Update todo list'],
  ] as const)('renders a canonical todo row and commits its native list on completion (bridge=%s, ACP title=%s)', async (bridgeTiming, acpTitle) => {
    const parts = new Map<string, ToolInvocationSSP>();
    const rendered: Array<{ toolName: string; isComplete: boolean; invocationMessage?: unknown; toolSpecificData?: unknown }> = [];
    const render = (part: ToolInvocationSSP) => part.render({
      push(nativePart) {
        rendered.push(nativePart as { toolName: string; isComplete: boolean; invocationMessage?: unknown; toolSpecificData?: unknown });
      },
      markdown() {}, progress() {},
    });
    const stream = {
      push(part: ToolInvocationSSP) { parts.set(part.id, part); render(part); },
      update(id: string, data: Parameters<ToolInvocationSSP['update']>[0]) {
        const part = parts.get(id);
        if (part) { part.update(data); render(part); }
      },
      has(id: string) { return parts.has(id); },
      writeMeta() {}, updateTitle() {},
    } as unknown as BackendPipelineStream;
    const pipeline = new DshPipeline({ sessionId: 'session-1', directory: 'D:/workspace', stream });
    const rawInput = { todos: [
      { content: 'Confirm the session', status: 'completed' },
      { content: 'Inspect the source', status: 'in_progress' },
      { content: 'Verify the fix', status: 'pending' },
    ] };
    // Installed DSH carries its registered name on ACP and an array in its
    // generic presenter; the bridge's top-level rawInput retains { todos }.
    const bridgeCall = {
      type: 'tool_call' as const, protocol: 1 as const, sessionId: 'session-1',
      toolCallId: 'todo-call', rootToolCallId: 'todo-call', toolName: 'todo_write', rawInput,
      presentation: { card: 'generic', title: 'Update todo list', kind: 'other', rawInput: rawInput.todos },
    };
    if (bridgeTiming === 'early') {pipeline.handleBridgeMessage(bridgeCall);}
    await pipeline.run((async function* () {
      yield sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'todo-call', title: acpTitle, kind: 'other', status: 'in_progress', rawInput });
      if (bridgeTiming === 'late') {pipeline.handleBridgeMessage(bridgeCall);}
      yield sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'todo-call', status: 'completed', rawOutput: 'Updated todo list: 1 pending, 1 in progress, 1 completed.' });
      yield { kind: 'stop', response: { stopReason: 'end_turn' }, stopReason: 'end_turn' } as ActiveSessionMessage;
    })(), { isCancellationRequested: false });

    const running = rendered.filter(part => !part.isComplete);
    const completed = rendered.filter(part => part.isComplete);
    expect(running.length).toBeGreaterThan(0);
    expect(completed.length).toBeGreaterThan(0);
    for (const part of running) {
      expect(part.toolName).toBe('todo');
      expect(part.invocationMessage).toBe('Todos');
      expect(part.toolSpecificData).toBeUndefined();
    }
    for (const part of completed) {
      expect(part.toolSpecificData).toEqual({ todoList: [
        { id: 0, title: 'Confirm the session', status: 3 },
        { id: 1, title: 'Inspect the source', status: 2 },
        { id: 2, title: 'Verify the fix', status: 1 },
      ] });
      expect(part.toolName).toBe('todo');
    }
    expect(parts.get('todo-call')?.toJSON().payload.toolName).toBe(bridgeTiming === 'none' ? acpTitle : 'todo_write');
  });
});
