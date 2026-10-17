import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeRuntimeTestScript,
  startRuntimeTestControlServer,
  type RuntimeTestApi,
  type RuntimeTestControlServer,
} from '../test-control/server';

function createApi(): RuntimeTestApi {
  return {
    snapshot: vi.fn(async () => ({ value: 42 })),
    inspectBackend: vi.fn(async backendId => ({ backendId, status: 'running' })),
    inspectSession: vi.fn(async (backendId, sessionId) => ({ backendId, id: sessionId })),
    listModels: vi.fn(async backendId => [{ backendId, id: 'model-1' }]),
    listAcpTargets: vi.fn(async () => []),
    selectAcpTarget: vi.fn(async targetId => ({ targetId })),
    startBackend: vi.fn(async backendId => ({ backendId, status: 'running' })),
    stopBackend: vi.fn(async backendId => ({ backendId, status: 'stopped' })),
    createSession: vi.fn(async backendId => ({ backendId, id: 'session-1' })),
    listSessions: vi.fn(async () => []),
    startPrompt: vi.fn(async (backendId, sessionId, text) => ({
      id: 'prompt-1', backendId, sessionId, text, status: 'starting',
    })),
    getPrompt: vi.fn(async operationId => ({ id: operationId, status: 'completed' })),
    waitPrompt: vi.fn(async operationId => ({ id: operationId, status: 'completed' })),
    cancelPrompt: vi.fn(async operationId => ({ id: operationId, status: 'cancelled' })),
    startTurn: vi.fn(async (backendId, sessionId, text) => ({
      id: 'turn-1', backendId, sessionId, text, status: 'starting',
    })),
    getTurn: vi.fn(async operationId => ({ id: operationId, status: 'completed' })),
    waitTurn: vi.fn(async operationId => ({ id: operationId, status: 'completed' })),
    cancelTurn: vi.fn(async operationId => ({ id: operationId, status: 'cancelled' })),
    listLanguageModels: vi.fn(async () => []),
    generateTitle: vi.fn(async () => ({ title: undefined, copilotModels: [], allModels: [] })),
    startModelRequest: vi.fn(async (backendId, modelId, text) => ({
      id: 'model-request-1', backendId, modelId, text, status: 'starting',
    })),
    getModelRequest: vi.fn(async operationId => ({ id: operationId, status: 'completed', parts: [] })),
    waitModelRequest: vi.fn(async operationId => ({ id: operationId, status: 'completed', parts: [] })),
    cancelModelRequest: vi.fn(async operationId => ({ id: operationId, status: 'cancelled', parts: [] })),
    refreshModels: vi.fn(async () => []),
    shutdownHost: vi.fn(async () => ({ scheduled: true })),
  };
}

const servers: RuntimeTestControlServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {server.dispose();}
});

describe('runtime test control', () => {
  it('executes test code against the capability API', async () => {
    const result = await executeRuntimeTestScript(
      createApi(),
      'const state = await api.snapshot(); return state.value + 1;',
    );
    expect(result).toBe(43);
  });

  it('exposes structured backend and prompt capabilities to runtime scripts', async () => {
    const api = createApi();
    const result = await executeRuntimeTestScript(
      api,
      `const backend = await api.inspectBackend('opencode');
       const session = await api.inspectSession('opencode', 'session-1');
       const models = await api.listModels('opencode');
       const operation = await api.startPrompt('opencode', 'session-1', 'hello');
       const final = await api.waitPrompt(operation.id);
       return { backend, session, models, operation, final };`,
    );
    expect(result).toEqual(expect.objectContaining({
      backend: { backendId: 'opencode', status: 'running' },
      session: { backendId: 'opencode', id: 'session-1' },
      models: [{ backendId: 'opencode', id: 'model-1' }],
      operation: expect.objectContaining({ id: 'prompt-1' }),
      final: { id: 'prompt-1', status: 'completed' },
    }));
  });

  it('requires bearer authentication on the loopback server', async () => {
    const token = 'runtime-test-token-1234';
    const server = await startRuntimeTestControlServer(createApi(), { token });
    servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}`;

    const unauthorized = await fetch(`${endpoint}/health`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${endpoint}/execute`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: 'return await api.snapshot();' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, result: { value: 42 } });
  });

  it('returns diagnostic client errors for malformed and oversized bodies', async () => {
    const token = 'runtime-test-token-1234';
    const server = await startRuntimeTestControlServer(createApi(), { token });
    servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/execute`;
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };

    const malformed = await fetch(endpoint, { method: 'POST', headers, body: '{' });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Request body must be valid JSON' });

    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: 'x'.repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Request body exceeds'),
    });
  });

  it('exposes the real-turn capability separately from event-level prompts', async () => {
    const api = createApi();
    const result = await executeRuntimeTestScript(
      api,
      `const started = await api.startTurn('acp', undefined, 'hello');
       const current = await api.getTurn(started.id);
       const final = await api.waitTurn(started.id);
       return { started, current, final };`,
    );
    expect(result).toEqual(expect.objectContaining({
      started: expect.objectContaining({ id: 'turn-1' }),
      current: { id: 'turn-1', status: 'completed' },
      final: { id: 'turn-1', status: 'completed' },
    }));
  });

  it('exposes native language-model listing and request capabilities', async () => {
    const api = createApi();
    const result = await executeRuntimeTestScript(
      api,
      `const models = await api.listLanguageModels('opencode');
       const started = await api.startModelRequest('opencode', 'opencode/model-1', 'hello');
       const final = await api.waitModelRequest(started.id);
       return { models, started, final };`,
    );
    expect(result).toEqual(expect.objectContaining({
      models: [],
      started: expect.objectContaining({ id: 'model-request-1' }),
      final: { id: 'model-request-1', status: 'completed', parts: [] },
    }));
  });

  it('exposes explicit model-request cancellation', async () => {
    const api = createApi();
    const result = await executeRuntimeTestScript(
      api,
      `const started = await api.startModelRequest('opencode', 'opencode/model-1', 'hello');
       return await api.cancelModelRequest(started.id);`,
    );
    expect(result).toEqual({ id: 'model-request-1', status: 'cancelled', parts: [] });
    expect(api.cancelModelRequest).toHaveBeenCalledWith('model-request-1');
  });
});
