import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { DshBackend } from '../backends/dsh/adapter';
import { spawnAcpAgent } from '../backends/acp/transport';
import * as bridgeProtocol from '../backends/dsh/bridge-protocol';

vi.mock('../backends/acp/transport', () => ({ spawnAcpAgent: vi.fn(), connectAcpRemote: vi.fn() }));

const savedLine = 'ACPILOT_DSH_DESKTOP_SAVED_SELECTION\t' + JSON.stringify({
  protocol: 1, nonce: 'desktop-nonce', provider: 'desktop-route', model: 'desktop-model', reasoningEffort: 'max',
});
const route = '["desktop-route","desktop-model"]';
const backends: DshBackend[] = [];

function configOptions(currentEffort = '', currentModel = route, efforts = ['', 'low', 'max']): SessionConfigOption[] {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel,
      options: [{ value: currentModel, name: 'Selected model' }] },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: currentEffort,
      options: efforts.map(value => ({ value, name: value || 'Provider default' })) },
  ];
}

function harness(options: {
  currentEffort?: string; currentModel?: string; efforts?: string[]; marker?: string;
  onSet?: (value: string) => Promise<void>; backend?: DshBackend;
} = {}) {
  const outbound = new TransformStream<Uint8Array>();
  const inbound = new TransformStream<Uint8Array>();
  const calls: Array<{ sessionId: string; configId: string; value: string }> = [];
  const state = new Map<string, string>();
  let count = 0;
  let emitStderr: ((line: string) => void) | undefined;
  const app = agent({ name: 'desktop-selection-fixture' })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } }))
    .onRequest(methods.agent.session.new, () => {
      const sessionId = 'created-' + ++count;
      state.set(sessionId, options.currentEffort ?? '');
      return { sessionId, configOptions: configOptions(options.currentEffort, options.currentModel, options.efforts) };
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      state.set(params.sessionId, '');
      return { configOptions: configOptions() };
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      if (typeof params.value !== 'string') {throw new Error('Fixture supports select values only');}
      calls.push(params);
      await options.onSet?.(params.value);
      state.set(params.sessionId, params.value);
      return { configOptions: configOptions(params.value, options.currentModel, options.efforts) };
    })
    .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))
    .onRequest(methods.agent.session.close, () => ({}));
  const connection = app.connect(ndJsonStream(inbound.writable, outbound.readable));
  vi.mocked(spawnAcpAgent).mockImplementationOnce(local => {
    emitStderr = local.onStderrLine;
    emitStderr?.(options.marker ?? savedLine);
    return {
      stream: ndJsonStream(outbound.writable, inbound.readable),
      process: { kill: () => { connection.close(); return true; } } as never,
      dispose: () => connection.close(),
    };
  });
  const backend = options.backend ?? new DshBackend({ local: { command: 'in-process-desktop', env: { ACPILOT_DSH_BRIDGE_NONCE: 'desktop-nonce' } } });
  if (!backends.includes(backend)) {backends.push(backend);}
  return { backend, calls, state, emitStderr: (line: string) => emitStderr?.(line) };
}

afterEach(async () => {
  for (const backend of backends.splice(0)) {await backend.stop();}
  vi.mocked(spawnAcpAgent).mockReset();
});

describe('Desktop saved reasoning selection', () => {
  it('applies saved reasoning before publishing a newly created session', async () => {
    const fixture = harness();
    await fixture.backend.start('D:/workspace');
    const created = await fixture.backend.sessions.create({ directory: 'D:/workspace' });
    expect(created.error).toBeUndefined();
    expect(fixture.state.get(created.data!.id)).toBe('max');
    expect(fixture.calls).toEqual([{ sessionId: created.data!.id, configId: 'reasoning_effort', value: 'max' }]);
  });

  it.each([
    { label: 'an existing session choice', currentEffort: 'low' },
    { label: 'a different ACP model route', currentModel: '["explicit-route","other-model"]' },
    { label: 'an unsupported saved effort', efforts: ['', 'low'] },
    { label: 'a different launch nonce', marker: savedLine.replace('desktop-nonce', 'old-launch') },
  ])('preserves $label', async row => {
    const fixture = harness(row);
    await fixture.backend.start('D:/workspace');
    const created = await fixture.backend.sessions.create({ directory: 'D:/workspace' });
    expect(created.error).toBeUndefined();
    expect(fixture.calls).toEqual([]);
    expect(fixture.state.get(created.data!.id)).toBe(row.currentEffort ?? '');
  });

  it('allows an explicit provider default after inheriting the saved effort', async () => {
    const fixture = harness();
    await fixture.backend.start('D:/workspace');
    const created = await fixture.backend.sessions.create({ directory: 'D:/workspace' });
    const id = created.data!.id;
    const result = await fixture.backend.sessions.prompt(id, 'hello', 'D:/workspace', {
      model: { providerID: 'dsh', modelID: route }, modelOptions: { reasoningEffort: '' },
    });
    expect(result).toEqual({ data: true });
    expect(fixture.state.get(id)).toBe('');
    expect(fixture.calls.map(call => call.value)).toEqual(['max', '']);
    await fixture.backend.sessions.prompt(id, 'hello again', 'D:/workspace');
    expect(fixture.calls.map(call => call.value)).toEqual(['max', '']);
  });

  it('retains the setter option response so an explicit matching effort needs no second request', async () => {
    const fixture = harness();
    await fixture.backend.start('D:/workspace');
    const created = await fixture.backend.sessions.create({ directory: 'D:/workspace' });
    await fixture.backend.sessions.prompt(created.data!.id, 'hello', 'D:/workspace', {
      model: { providerID: 'dsh', modelID: route }, modelOptions: { reasoningEffort: 'max' },
    });
    expect(fixture.calls.map(call => call.value)).toEqual(['max']);
    expect(fixture.state.get(created.data!.id)).toBe('max');
  });

  it('leaves resumed sessions at their ACP selection', async () => {
    const fixture = harness();
    await fixture.backend.start('D:/workspace');
    await expect(fixture.backend.sessions.prompt('existing-session', 'hello', 'D:/workspace')).resolves.toEqual({ data: true });
    expect(fixture.calls).toEqual([]);
    expect(fixture.state.get('existing-session')).toBe('');
  });

  it('keeps session creation usable when a valid saved preference cannot be applied', async () => {
    const fixture = harness({ onSet: async () => { throw new Error('setter unavailable'); } });
    await fixture.backend.start('D:/workspace');
    const created = await fixture.backend.sessions.create({ directory: 'D:/workspace' });
    expect(created.error).toBeUndefined();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.state.get(created.data!.id)).toBe('');
  });

  it('does not publish a session when stop invalidates an in-flight default setter', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const fixture = harness({ onSet: async () => {
      entered?.();
      await new Promise<void>(resolve => { release = resolve; });
    } });
    await fixture.backend.start('D:/workspace');
    const creating = fixture.backend.sessions.create({ directory: 'D:/workspace' });
    await Promise.race([enteredPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('setter not entered')), 200))]);
    const stopping = fixture.backend.stop();
    release?.();
    const result = await creating;
    await stopping;
    expect(result.data).toBeUndefined();
    expect(result.error).toMatch(/stopped|changed/i);
    expect(fixture.backend.isRunning()).toBe(false);
  });

  it('rejects stale Desktop stderr after the launch has stopped', async () => {
    const fixture = harness({ marker: savedLine.replace('desktop-nonce', 'ignored') });
    await fixture.backend.start('D:/workspace');
    await fixture.backend.stop();
    fixture.emitStderr(savedLine);
    const next = harness({ backend: fixture.backend, marker: savedLine.replace('desktop-nonce', 'ignored') });
    await next.backend.start('D:/workspace');
    const created = await next.backend.sessions.create({ directory: 'D:/workspace' });
    expect(next.calls).toEqual([]);
    expect(next.state.get(created.data!.id)).toBe('');
  });

  it('parses only bounded selection metadata for the expected launch', () => {
    const parse = (bridgeProtocol as unknown as {
      parseDshDesktopSavedSelectionLine?: (line: string, nonce: string) => unknown;
    }).parseDshDesktopSavedSelectionLine;
    const line = 'ACPILOT_DSH_DESKTOP_SAVED_SELECTION\t' + JSON.stringify({
      protocol: 1, nonce: 'desktop-nonce', provider: 'desktop-route', model: 'desktop-model', reasoningEffort: 'max', secret: 'not-selection-data',
    });
    expect(parse?.(line, 'desktop-nonce')).toEqual({
      protocol: 1, nonce: 'desktop-nonce', provider: 'desktop-route', model: 'desktop-model', reasoningEffort: 'max',
    });
    expect(parse?.(line, 'other-nonce')).toBeUndefined();
    expect(parse?.(line.replace('"protocol":1', '"protocol":2'), 'desktop-nonce')).toBeUndefined();
    expect(parse?.(line.replace('desktop-model', 'm'.repeat(1025)), 'desktop-nonce')).toBeUndefined();
  });

  it('discards an invalid saved-selection marker without logging its raw payload', async () => {
    const fixture = harness({ marker: savedLine.replace('desktop-nonce', 'other-nonce').replace('}', ',"apiKey":"DO_NOT_LOG_SECRET"}') });
    const logs: string[] = [];
    fixture.backend.setLogger({ appendLine: line => logs.push(line) });
    await fixture.backend.start('D:/workspace');
    await fixture.backend.sessions.create({ directory: 'D:/workspace' });
    expect(logs.join('\n')).not.toContain('DO_NOT_LOG_SECRET');
    expect(fixture.calls).toEqual([]);
  });
});
