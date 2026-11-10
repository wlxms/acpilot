import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function probe() {
  const bridgeUrl = JSON.stringify(pathToFileURL(path.resolve('dsh-bridge/index.mjs')).href);
  const script = `
    process.env.ACPILOT_DSH_BRIDGE_NONCE = 'subagent-test';
    const bridge = await import(${bridgeUrl});
    const handlers = new Map();
    const writes = [];
    process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
    const agents = new Map();
    const cancellations = [];
    const interruptions = [];
    const deliveries = [];
    const originals = new Map();
    const cleanup = [];
    const notice = id => ({ source: { kind: 'subagent-settled', form: 'notice', senderSessionId: id }, content: [{ type: 'text', text: 'Child stopped' }] });
    const agent = (id, parentSession) => {
      const value = { id, pending: [], session: { id, header: { id, parentSession, origin: parentSession ? 'subagent' : 'acp' } },
        cancel(cause, options = {}) { cancellations.push({ id, kind: cause.kind }); if (!options.keepInbox) this.pending.length = 0; },
        followup(message) { deliveries.push({ id, method: 'followup', source: message.source }); this.pending.push(message); },
        steer(message) { deliveries.push({ id, method: 'steer', source: message.source }); this.pending.push(message); },
        inject(message) { deliveries.push({ id, method: 'inject', source: message.source }); this.pending.push(message); } };
      agents.set(id, value);
      originals.set(value, { cancel: value.cancel, followup: value.followup, steer: value.steer });
      return value;
    };
    const root = agent('root'); const unrelated = agent('unrelated');
    const child = agent('child', 'root'); const grandchild = agent('grandchild', 'child'); const otherChild = agent('other-child', 'unrelated');
    const subagents = { interrupt(id, authority) {
      if (id === 'refused-child') throw new Error('interrupt authority refused');
      interruptions.push({ id, root: authority.agent.id, kind: authority.kind });
      agents.get(id)?.cancel({ kind: 'parent' }, { keepInbox: true });
      // Cancellation can synchronously settle another descendant before the
      // outer root's interrupt loop reaches that descendant.
      if (id === 'child') child.followup(notice('grandchild'));
    } };
    const ctx = {
      llm: { listProviders: () => [] }, tools: { get: () => undefined },
      get(name) { return name === 'agents' ? { get: id => agents.get(id), list: () => [...agents.values()] } : name === 'subagents' ? subagents : undefined; },
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); }, provide() {},
      effect(factory) { cleanup.push(factory()); },
    };
    bridge.apply(ctx);
    const emit = async (name, ...args) => { for (const h of handlers.get(name) ?? []) await h(...args); };
    await emit('agent/created', { agent: root }); await emit('agent/created', { agent: unrelated });
    await emit('agent/created', { agent: child }); await emit('agent/created', { agent: grandchild }); await emit('agent/created', { agent: otherChild });
    async function delegate(parent, id, callId, runId = 'run-' + id) {
      const exec = { agent: parent, callId, rootCallId: callId, name: 'spawn_worker', arguments: { description: 'Inspect source', prompt: 'Review code', agent_preset: 'reviewer' } };
      await emit('tools/pre-execute', exec, () => ({ kind: 'allow' }));
      const execute = handlers.get('tools/execute')?.[0];
      const body = async () => { await Promise.resolve(); await emit('subagent/start', { runId, id, provider: 'spawn', local: true }); return { kind: 'activation', subagentId: id }; };
      const value = execute ? await execute(exec, body) : await body();
      await emit('tools/result', exec, { isError: false, value, content: [{ type: 'text', text: 'started subagent ' + id }] });
    }
    await Promise.all([delegate(root, 'child', 'delegate'), delegate(unrelated, 'other-child', 'other-delegate')]);
    await delegate(child, 'grandchild', 'nested-delegate');
    child.pending.push(notice('queued-work'));
    grandchild.pending.push(notice('queued-work'));
    otherChild.pending.push(notice('queued-work'));
    await emit('tools/pre-execute', { agent: child, callId: 'read-1', rootCallId: 'read-1', name: 'read', arguments: { filePath: 'a.ts' } }, () => ({ kind: 'allow' }));
    root.cancel({ kind: 'user' });
    const stopped = [...interruptions];
    // Desktop delivers settlement notices synchronously BEFORE subagent/end.
    // A new user prompt remains waking, but the old stopped task's notice must
    // not wake the root again or interfere with its cancellation boundary.
    root.followup({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New request' }] });
    root.followup(notice('child'));
    child.steer(notice('grandchild'));
    unrelated.followup(notice('other-child'));
    unrelated.steer(notice('child'));
    const stoppedDeliveries = [...deliveries];
    const stoppedPending = { child: child.pending.length, grandchild: grandchild.pending.length, unrelatedChild: otherChild.pending.length, root: root.pending.length };
    await emit('subagent/end', { runId: 'run-child', id: 'child', stopReason: 'aborted', lastAssistantMessage: 'partial answer' });
    root.cancel({ kind: 'user' });
    const afterParentEnd = { count: interruptions.length, last: interruptions.at(-1) };
    await emit('subagent/end', { runId: 'run-grandchild', id: 'grandchild', stopReason: 'aborted' });
    // Reusing a durable child id starts a new residency epoch. A stale old end
    // must not mark the new epoch ended or carry cancellation into its notice.
    await delegate(root, 'child', 'reused-delegate', 'run-reused');
    await emit('subagent/end', { runId: 'run-child', id: 'child', stopReason: 'aborted' });
    root.steer(notice('child'));
    await emit('subagent/end', { runId: 'run-reused', id: 'child', stopReason: 'completed' });
    const later = agent('later', 'root'); await emit('agent/created', { agent: later }); await delegate(root, 'later', 'later-delegate');
    root.followup(notice('later'));
    root.cancel({ kind: 'user' });
    const lateRoot = agent('late-root'); const lateChild = agent('late-admission', 'late-root');
    await emit('agent/created', { agent: lateRoot }); await emit('agent/created', { agent: lateChild });
    const lateExec = { agent: lateRoot, callId: 'late-call', rootCallId: 'late-call', name: 'spawn_worker', arguments: { description: 'Late admission', prompt: 'Work' } };
    const lateBody = async () => { lateRoot.cancel({ kind: 'user' }); await Promise.resolve(); await emit('subagent/start', { id: 'late-admission', runId: 'late-run', provider: 'spawn', local: true }); };
    const execute = handlers.get('tools/execute')?.[0];
    if (execute) await execute(lateExec, lateBody); else await lateBody();
    lateRoot.steer(notice('late-admission'));
    const lateInterrupted = interruptions.filter(item => item.id === 'late-admission');
    const refusedRoot = agent('refused-root'); const refusedChild = agent('refused-child', 'refused-root');
    await emit('agent/created', { agent: refusedRoot }); await emit('agent/created', { agent: refusedChild });
    await delegate(refusedRoot, 'refused-child', 'refused-call');
    refusedChild.pending.push(notice('queued-work'));
    refusedRoot.cancel({ kind: 'user' });
    const refused = { pending: refusedChild.pending.length, cancellations: cancellations.filter(item => item.id === 'refused-child') };
    await emit('agent/disposed', { agent: child });
    const disposedRestored = Object.entries(originals.get(child)).every(([method, original]) => child[method] === original);
    const replacementSteer = () => {};
    root.steer = replacementSteer;
    for (const dispose of cleanup) dispose();
    const pluginRestored = root.cancel === originals.get(root).cancel && root.followup === originals.get(root).followup;
    const replacementPreserved = root.steer === replacementSteer;
    const messages = writes.filter(line => line.startsWith('ACPILOT_DSH_BRIDGE_TOOL\t')).map(line => JSON.parse(line.slice('ACPILOT_DSH_BRIDGE_TOOL\t'.length)));
    process.stdout.write(JSON.stringify({ stopped, afterParentEnd, interruptions, cancellations, lateInterrupted, stoppedDeliveries, stoppedPending, deliveries, messages, refused,
      restoration: { disposedRestored, pluginRestored, replacementPreserved } }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

describe('DSH bridge managed subagents', () => {
  it('does not clear a child inbox when the runtime refuses interruption', () => {
    expect(probe().refused).toEqual({ pending: 1, cancellations: [] });
  });
  it('restores original Agent methods on disposal and preserves later replacements', () => {
    expect(probe().restoration).toEqual({ disposedRestored: true, pluginRestored: true, replacementPreserved: true });
  });
  it('clears stopped managed children inboxes so suppressed nested notices cannot strand their settlement', () => {
    expect(probe().stoppedPending).toEqual({ child: 0, grandchild: 0, unrelatedChild: 1, root: 2 });
  });
  it('retains stopped root notices without waking it or queuing work on cancelled managed parents', () => {
    const { stoppedDeliveries } = probe();
    expect(stoppedDeliveries).toContainEqual({ id: 'root', method: 'inject', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' } });
    expect(stoppedDeliveries.filter((delivery: { id: string }) => delivery.id === 'child')).toEqual([]);
    expect(stoppedDeliveries.filter((delivery: { id: string; method: string; source: { kind: string } }) =>
      (delivery.id === 'root' || delivery.id === 'child') && delivery.source.kind === 'subagent-settled' && delivery.method !== 'inject')).toEqual([]);
    expect(stoppedDeliveries).toContainEqual({ id: 'root', method: 'followup', source: { kind: 'user' } });
    expect(stoppedDeliveries).toContainEqual({ id: 'unrelated', method: 'followup', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'other-child' } });
    expect(stoppedDeliveries).toContainEqual({ id: 'unrelated', method: 'steer', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' } });
  });
  it('suppresses a stopped late admission but lets fresh and reused child epochs wake their parent', () => {
    const { deliveries, messages } = probe();
    expect(deliveries).toContainEqual({ id: 'late-root', method: 'inject', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'late-admission' } });
    expect(deliveries).toContainEqual({ id: 'root', method: 'steer', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' } });
    expect(deliveries).toContainEqual({ id: 'root', method: 'followup', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'later' } });
    expect(messages.filter((message: { type: string; toolCallId: string }) => message.type === 'tool_result' && message.toolCallId === 'reused-delegate')).toEqual([
      expect.objectContaining({ presentation: expect.objectContaining({ status: 'running', runId: 'run-reused' }) }),
      expect.objectContaining({ presentation: expect.objectContaining({ status: 'completed', runId: 'run-reused' }) }),
    ]);
  });
  it('interrupts only the stopped roots descendants and supports later delegation', () => {
    const result = probe();
    expect(result.stopped).toEqual([
      { id: 'child', root: 'root', kind: 'ancestor' },
      { id: 'grandchild', root: 'root', kind: 'ancestor' },
    ]);
    expect(result.cancellations).toContainEqual({ id: 'child', kind: 'parent' });
    expect(result.cancellations).toContainEqual({ id: 'grandchild', kind: 'parent' });
    expect(result.cancellations).not.toContainEqual({ id: 'other-child', kind: 'parent' });
    expect(result.interruptions).toContainEqual({ id: 'later', root: 'root', kind: 'ancestor' });
  });
  it('interrupts an admission that starts after its owning execution was cancelled', () => {
    expect(probe().lateInterrupted).toEqual([{ id: 'late-admission', root: 'late-root', kind: 'ancestor' }]);
  });
  it('still interrupts a grandchild after its direct parent ended', () => {
    expect(probe().afterParentEnd).toEqual({ count: 3, last: { id: 'grandchild', root: 'root', kind: 'ancestor' } });
  });
  it('projects concurrent delegation identity, nested tools, and the actual end reason', () => {
    const result = probe();
    expect(result.messages).toContainEqual(expect.objectContaining({ type: 'tool_call', sessionId: 'root', toolCallId: 'delegate', presentation: expect.objectContaining({ card: 'subagent', childSessionId: 'child', status: 'running' }) }));
    expect(result.messages).toContainEqual(expect.objectContaining({ type: 'tool_call', sessionId: 'unrelated', toolCallId: 'other-delegate', presentation: expect.objectContaining({ card: 'subagent', childSessionId: 'other-child' }) }));
    expect(result.messages).toContainEqual(expect.objectContaining({ type: 'tool_call', sessionId: 'root', agentSessionId: 'child', toolCallId: 'read-1', subAgentInvocationId: 'delegate' }));
    expect(result.messages).toContainEqual(expect.objectContaining({ type: 'tool_result', sessionId: 'root', toolCallId: 'delegate', isError: true, output: 'partial answer', presentation: expect.objectContaining({ card: 'subagent', status: 'error', stopReason: 'aborted' }) }));
  });
});
