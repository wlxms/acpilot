import type { ActiveSessionMessage } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { BackendPipelineStream } from '../backend/backend';
import { DshPipeline } from '../backends/dsh/pipeline';
import { ToolInvocationSSP } from '../ssp/impl/tool-invocation';

function sessionUpdate(update: Record<string, unknown>): ActiveSessionMessage {
  return { kind: 'session_update', notification: { sessionId: 'team-session', update }, update } as never;
}

const cases = [
  { name: 'team_task_create', input: { subject: 'Review network roles' }, output: { id: 'task-7', subject: 'Review network roles', revision: 1, status: 'pending' }, running: /Creating team task/, completed: /Created team task/, detail: /Task: task-7/ },
  { name: 'team_task_update', input: { task_id: 'task-7', expected_revision: 1, action: 'claim' }, output: { id: 'task-7', subject: 'Review network roles', revision: 2, status: 'in_progress', ownerName: 'reviewer' }, running: /Claiming team task/, completed: /Claimed team task/, detail: /Owner: reviewer/ },
  { name: 'wait_agent', input: { timeout_ms: 30_000 }, output: { timedOut: true }, running: /Waiting for team changes/, completed: /Wait timed out/, detail: /timed out/ },
  { name: 'send_message', input: { target: 'reviewer', message: 'Check RPC restrictions.' }, output: { status: 'queued', messageId: 'mail-8' }, running: /Sending message to reviewer/, completed: /Message queued to reviewer/, detail: /Message: mail-8/ },
];

describe('DSH team tool fallback pipeline', () => {
  it.each(cases)('marks $name before its first fallback emission and preserves the result', async ({ name, input, output, running, completed, detail }) => {
    vi.useFakeTimers();
    try {
      const parts = new Map<string, ToolInvocationSSP>();
      const snapshots: ReturnType<ToolInvocationSSP['toJSON']>[] = [];
      const native: Array<{ invocationMessage?: unknown; pastTenseMessage?: unknown; isComplete?: boolean; toolSpecificData?: { input?: string; output?: string } }> = [];
      const render = (part: ToolInvocationSSP) => part.render({ push: value => native.push(value as never), markdown() {}, progress() {} });
      const stream = {
        push(part: ToolInvocationSSP) { parts.set(part.id, part); snapshots.push(JSON.parse(JSON.stringify(part.toJSON()))); render(part); },
        update(id: string, data: Record<string, unknown>) { const part = parts.get(id); part?.update(data); if (part) {render(part);} },
        has(id: string) { return parts.has(id); }, writeMeta() {}, updateTitle() {},
      } as unknown as BackendPipelineStream;
      const pipeline = new DshPipeline({ sessionId: 'team-session', directory: 'D:/work', stream });
      let runningCount = 0;
      await pipeline.run((async function* () {
        yield sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'team-1', title: name, kind: 'other', status: 'in_progress', rawInput: input });
        await vi.advanceTimersByTimeAsync(100);
        runningCount = native.length;
        yield sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'team-1', status: 'completed', rawOutput: JSON.stringify(output) });
        yield { kind: 'stop', stopReason: 'end_turn', response: { stopReason: 'end_turn' } } as never;
      })(), { isCancellationRequested: false });
      expect(snapshots[0]?.payload.state?.metadata?.dshToolName).toBe(name);
      expect(runningCount).toBeGreaterThan(0);
      expect(native[0].isComplete).toBe(false);
      expect(String(native[0].invocationMessage)).toMatch(running);
      expect(String(native.at(-1)?.pastTenseMessage)).toMatch(completed);
      expect(native.at(-1)?.toolSpecificData?.output).toMatch(detail);
      expect(parts.get('team-1')!.toJSON().payload.state?.input).toEqual(input);
      expect(parts.get('team-1')!.toJSON().payload.state?.status).toBe('completed');
    } finally {vi.useRealTimers();}
  });
});
