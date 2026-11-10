import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import type { SerializableToolState, SspStream } from '../../ssp/types';

function renderTool(toolName: string, state: Partial<SerializableToolState>, subAgentInvocationId?: string, source: 'dsh' | 'generic' = 'dsh') {
  const parts: any[] = [];
  const updates: any[] = [];
  const stream: SspStream = {
    push: part => { parts.push(part); }, markdown() {}, progress() {},
    beginToolInvocation() {}, updateToolInvocation: (_id, update) => { updates.push(update); },
  };
  const ssp = new ToolInvocationSSP({
    partId: 'team-call', callId: 'team-call', toolName, subAgentInvocationId,
    state: { status: 'completed', input: {}, ...(source === 'dsh' ? { metadata: { dshToolName: toolName } } : {}), ...state },
  });
  ssp.render(stream);
  return { ssp, stream, parts, updates, part: parts[0] };
}

const taskResult = {
  id: 'task-7', revision: 2, subject: 'Review network roles', description: 'Check server and client behavior.',
  status: 'in_progress', ownerName: 'network-reviewer', blockedBy: ['task-2'],
  writeScopes: ['src/network'], ready: false, writeScopeWarnings: ['Overlaps task-9'],
};

// These assertions protect the native presentation and its state semantics,
// rather than pinning the exact wording of the whole card.
describe('DSH team tool presentation', () => {
  it('shows a created shared task with its returned identity and board state', () => {
    const { part } = renderTool('team_task_create', {
      input: { subject: 'Review network roles', description: 'Check server and client behavior.' },
      output: JSON.stringify({ ...taskResult, status: 'pending', ownerName: undefined, revision: 1 }),
    });
    expect(part.pastTenseMessage).toMatch(/Created team task.*Review network roles/);
    expect(part.toolSpecificData.input).toContain('Title: Review network roles');
    expect(part.toolSpecificData.output).toContain('Task: task-7');
    expect(part.toolSpecificData.output).toContain('Status: Pending');
    expect(part.toolSpecificData.output).toContain('Owner: Unassigned');
    expect(part.toolSpecificData.output).toContain('Revision: 1');
    expect(part.toolSpecificData.output).toContain('Blocked by: task-2');
    expect(part.toolSpecificData.todoList).toBeUndefined();
  });

  it('shows task claim as a board action with returned owner and status', () => {
    const { part } = renderTool('team_task_update', {
      input: { task_id: 'task-7', expected_revision: 1, action: 'claim' }, output: JSON.stringify(taskResult),
    });
    expect(part.pastTenseMessage).toMatch(/Claimed team task.*Review network roles/);
    expect(part.toolSpecificData.input).toContain('Action: Claim');
    expect(part.toolSpecificData.output).toContain('Status: In progress');
    expect(part.toolSpecificData.output).toContain('Owner: network-reviewer');
    expect(part.toolSpecificData.todoList).toBeUndefined();
    expect(part.toolSpecificData.agentName).toBeUndefined();
  });

  it('renders requested completion as running until the task result confirms its status', () => {
    const { ssp, stream, parts, part } = renderTool('team_task_update', {
      status: 'running', input: { task_id: 'task-7', expected_revision: 2, action: 'complete' },
    });
    expect(part.isComplete).toBe(false);
    expect(part.invocationMessage).toMatch(/Completing team task.*task-7/);
    expect(part.toolSpecificData.output).not.toMatch(/Status: Completed/);
    ssp.update({ state: { status: 'completed', output: JSON.stringify({ ...taskResult, status: 'completed', revision: 3 }) } });
    ssp.render(stream);
    expect(parts[1].toolSpecificData.output).toContain('Status: Completed');
    expect(parts[1].toolSpecificData.todoList).toBeUndefined();
  });

  it.each([
    [{ timedOut: false }, /Team change observed/, /team.*change/i],
    [{ timedOut: true }, /Wait timed out/, /timed out/i],
    [{ timedOut: false, noProgress: { reason: 'no-active-peer', message: 'No other Team member is running or provisioning.' } }, /No active teammate/, /No other Team member/],
  ])('distinguishes a wait result without claiming a teammate completed: %j', (output, title, detail) => {
    const { part } = renderTool('wait_agent', { input: { timeout_ms: 60000 }, output: JSON.stringify(output) });
    expect(part.pastTenseMessage).toMatch(title);
    expect(part.pastTenseMessage).not.toMatch(/Completed.*agent/i);
    expect(part.toolSpecificData.input).toContain('Timeout: 60s');
    expect(part.toolSpecificData.input).toContain('Targets: Team activity');
    expect(part.toolSpecificData.output).toMatch(detail);
  });

  it('shows an active wait and an explicitly supplied target without claiming target completion', () => {
    const { part } = renderTool('wait_agent', { status: 'running', input: { targets: ['worker-a'], timeout_ms: 30000 } });
    expect(part.isComplete).toBe(false);
    expect(part.invocationMessage).toMatch(/Waiting for.*team/i);
    expect(part.toolSpecificData.input).toContain('Targets: worker-a');
    expect(part.toolSpecificData.output).not.toMatch(/Completed|finished/i);
  });

  it.each(['accepted', 'queued'])('shows message recipient, complete text, and its %s receipt', (status) => {
    const message = 'Review the RPC restrictions.\nReport the two blocking findings.';
    const { part } = renderTool('send_message', { input: { target: 'network-reviewer', message }, output: JSON.stringify({ status, messageId: 'mail-8' }) });
    expect(part.pastTenseMessage).toContain(status);
    expect(part.pastTenseMessage).toContain('network-reviewer');
    expect(part.toolSpecificData.input).toContain('Recipient: network-reviewer');
    expect(part.toolSpecificData.input).toContain(message);
    expect(part.toolSpecificData.output).toContain('Message: mail-8');
    expect(part.toolSpecificData.output.toLowerCase()).toContain(status);
    expect(part.toolSpecificData.output).not.toMatch(/reply.*received/i);
  });

  it('handles the continuable child message presenter receipt', () => {
    const { part } = renderTool('send_message', { input: { agent_id: 'child-11', message: 'Continue the review.' }, output: 'message delivered to agent child-11' });
    expect(part.pastTenseMessage).toMatch(/Message delivered.*child-11/);
    expect(part.toolSpecificData.input).toContain('Recipient: child-11');
    expect(part.toolSpecificData.output).toMatch(/delivered/i);
  });

  it.each(['team_task_create', 'team_task_update', 'wait_agent', 'send_message'])('shows %s failures with the supplied error rather than a successful title', toolName => {
    const { parts } = renderTool(toolName, { status: 'error', input: { subject: 'Review network roles', task_id: 'task-7', action: 'complete', target: 'worker' }, error: 'Revision conflict; reload task.' });
    expect(parts[0].isError).toBe(true);
    expect(parts[0].pastTenseMessage).toMatch(/failed/i);
    expect(parts[0].pastTenseMessage).not.toMatch(/Completed|Created|delivered/);
    expect(parts[0].toolSpecificData.output).toContain('Revision conflict; reload task.');
  });

  it('keeps malformed result details readable without inventing delivery or task state', () => {
    const { part } = renderTool('send_message', { input: { target: 'worker', message: 'Proceed.' }, output: '{broken json' });
    expect(part.pastTenseMessage).not.toMatch(/accepted|queued|delivered/i);
    expect(part.toolSpecificData.output).toContain('{broken json');
  });

  it('uses preserved DSH identity when history restores an older presenter title', () => {
    const original = renderTool('Create a shared task', {
      originalToolName: 'team_task_create', metadata: { dshToolName: 'team_task_create' },
      input: { subject: 'Review network roles' }, output: JSON.stringify(taskResult),
    }, 'outer-agent');
    const record = JSON.parse(JSON.stringify(original.ssp.toJSON()));
    const restored = new ToolInvocationSSP(record.payload, record.meta, record.id);
    const parts: any[] = [];
    restored.render({ push: part => { parts.push(part); }, markdown() {}, progress() {} });
    expect(parts[0].pastTenseMessage).toMatch(/Created team task.*Review network roles/);
    expect(parts[0].subAgentInvocationId).toBe('outer-agent');
    expect(parts[0].toolSpecificData.todoList).toBeUndefined();
    expect(record.payload.toolName).toBe('Create a shared task');
  });


  it('uses the returned task status when a result does not confirm the requested completion', () => {
    const { part } = renderTool('team_task_update', {
      input: { task_id: 'task-7', expected_revision: 1, action: 'complete' }, output: JSON.stringify(taskResult),
    });
    expect(part.pastTenseMessage).not.toMatch(/Completed team task/);
    expect(part.toolSpecificData.output).toContain('Status: In progress');
  });

  it('preserves an incomplete task result without inventing its owner or status', () => {
    const output = JSON.stringify({ id: 'task-7', unexpected: 'result changed' });
    const { part } = renderTool('team_task_update', { input: { task_id: 'task-7', action: 'complete' }, output });
    expect(part.pastTenseMessage).not.toMatch(/Completed team task/);
    expect(part.toolSpecificData.output).toBe(output);
    expect(part.toolSpecificData.output).not.toContain('Owner: Unassigned');
  });

  it('does not treat an unknown receipt status as delivered', () => {
    const output = JSON.stringify({ status: 'unknown', messageId: 'mail-8' });
    const { part } = renderTool('send_message', { input: { target: 'worker', message: 'Continue.' }, output });
    expect(part.pastTenseMessage).not.toMatch(/accepted|queued|delivered/i);
    expect(part.toolSpecificData.output).toBe(output);
  });

  it('preserves the full message beyond the generic input truncation limit', () => {
    const message = 'Check each network role. '.repeat(20) + 'Final acceptance criterion.';
    const { part } = renderTool('send_message', { input: { agent_id: 'reviewer', message }, output: JSON.stringify({ messageId: 'mail-9' }) });
    expect(part.toolSpecificData.input).toContain(message);
    expect(part.pastTenseMessage).toMatch(/delivered.*reviewer/);
  });

  it.each([
    { metadata: { dshToolName: 'wait_agent' } },
    { originalToolName: 'wait_agent', metadata: { dshToolName: 'wait_agent' } },
  ])('recognizes preserved DSH metadata independently from the displayed title: %j', identity => {
    const { part } = renderTool('Wait for changes', { ...identity, input: {}, output: JSON.stringify({ timedOut: true }) });
    expect(part.pastTenseMessage).toMatch(/Wait timed out/);
    expect(part.toolSpecificData.input).toContain('Timeout: 30s (default)');
  });


  it.each(['team_task_create', 'team_task_update', 'wait_agent', 'send_message'])('keeps a non-DSH same-name %s tool in the generic branch', toolName => {
    const output = JSON.stringify({ timedOut: false, messageId: 'receipt-1' });
    const { part } = renderTool(toolName, { originalToolName: toolName, input: {}, output }, undefined, 'generic');
    expect(part.pastTenseMessage).toBe('Completed ' + toolName);
    expect(part.toolSpecificData).toEqual({ input: '', output });
    expect(part.toolSpecificData.output).not.toMatch(/Delivery:|team.*change/i);
  });


  it.each([{ messageId: 'mail-8' }, { status: 'accepted' }])('keeps an incomplete DSH team receipt unconfirmed: %j', receipt => {
    const output = JSON.stringify(receipt);
    const { part } = renderTool('send_message', { input: { target: 'worker', message: 'Proceed.' }, output });
    expect(part.pastTenseMessage).not.toMatch(/accepted|queued|delivered/i);
    expect(part.toolSpecificData.output).toBe(output);
  });

  it('does not assume a generic message id confirms delivery', () => {
    const output = JSON.stringify({ messageId: 'receipt-1' });
    const { part } = renderTool('send_message', { input: { target: 'other-service', message: 'Proceed.' }, output }, undefined, 'generic');
    expect(part.pastTenseMessage).toBe('Completed send_message');
    expect(part.toolSpecificData.output).toBe(output);
  });

  it.each([{}, { originalToolName: 'wait_agent' }, { metadata: { dshToolName: 1 } }, { metadata: { dshToolName: 'other' } }])('does not infer DSH ownership from an alias or invalid identity: %j', identity => {
    const output = JSON.stringify({ timedOut: true });
    const { part } = renderTool('Wait for changes', { ...identity, input: {}, output }, undefined, 'generic');
    expect(part.pastTenseMessage).toBe('Completed Wait for changes');
    expect(part.toolSpecificData.output).toBe(output);
  });

  it('keeps unrelated tools in their existing presentation branch', () => {
    const { part } = renderTool('custom_tool', { input: { target: 'worker' }, output: 'custom output' });
    expect(part.pastTenseMessage).toBe('Completed custom_tool');
    expect(part.toolSpecificData).toEqual({ input: 'target: worker', output: 'custom output' });
  });

  it('uses meaningful fallback titles when the native part constructor is unavailable', () => {
    const constructor = vi.spyOn(vscode as any, 'ChatToolInvocationPart', 'get').mockReturnValue(undefined);
    try {
      const { updates } = renderTool('wait_agent', { input: { timeout_ms: 10000 }, output: JSON.stringify({ timedOut: true }) });
      expect(updates[0].pastTenseMessage).toMatch(/Wait timed out/);
    } finally {
      constructor.mockRestore();
    }
  });
});
