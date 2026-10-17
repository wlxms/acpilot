import * as fs from 'node:fs';
import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as vm from 'node:vm';

const MAX_BODY_BYTES = 64 * 1024;
// Runtime API wait operations are capped at 30 seconds. Leave enough headroom
// for backend startup and result serialization around one bounded wait.
const SCRIPT_TIMEOUT_MS = 45_000;
const SYNC_SCRIPT_TIMEOUT_MS = 1_000;

class RequestBodyTooLargeError extends Error {}

export interface RuntimeTestApi {
  snapshot(): Promise<unknown>;
  inspectBackend(backendId: string): Promise<unknown>;
  inspectSession(backendId: string, sessionId: string): Promise<unknown>;
  listModels(backendId: string): Promise<unknown>;
  listAcpTargets(): Promise<unknown>;
  selectAcpTarget(targetId: string): Promise<unknown>;
  startBackend(backendId: string): Promise<unknown>;
  stopBackend(backendId: string): Promise<unknown>;
  createSession(backendId: string): Promise<unknown>;
  listSessions(backendId: string): Promise<unknown>;
  startPrompt(
    backendId: string,
    sessionId: string,
    text: string,
    options?: unknown,
  ): Promise<unknown>;
  getPrompt(operationId: string): Promise<unknown>;
  waitPrompt(operationId: string, timeoutMs?: number): Promise<unknown>;
  cancelPrompt(operationId: string): Promise<unknown>;
  startTurn(
    backendId: string,
    sessionId: string | undefined,
    text: string,
    options?: unknown,
  ): Promise<unknown>;
  getTurn(operationId: string): Promise<unknown>;
  waitTurn(operationId: string, timeoutMs?: number): Promise<unknown>;
  cancelTurn(operationId: string): Promise<unknown>;
  listLanguageModels(backendId: string, role?: 'agent' | 'copilot'): Promise<unknown>;
  generateTitle(backendId: string, prompt: string): Promise<unknown>;
  startModelRequest(
    backendId: string,
    modelId: string,
    text: string,
    options?: unknown,
  ): Promise<unknown>;
  getModelRequest(operationId: string): Promise<unknown>;
  waitModelRequest(operationId: string, timeoutMs?: number): Promise<unknown>;
  cancelModelRequest(operationId: string): Promise<unknown>;
  refreshModels(): Promise<unknown>;
  shutdownHost(): Promise<unknown>;
}

export interface RuntimeTestControlOptions {
  token: string;
  port?: number;
  descriptorPath?: string;
  logger?: { appendLine(message: string): void };
}

export interface RuntimeTestControlServer {
  readonly port: number;
  dispose(): void;
}

export async function startRuntimeTestControlServer(
  api: RuntimeTestApi,
  options: RuntimeTestControlOptions,
): Promise<RuntimeTestControlServer> {
  if (options.token.length < 16) {
    throw new Error('ACPILOT_TEST_CONTROL_TOKEN must contain at least 16 characters');
  }

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, api, options.token, options.logger);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Runtime test control server did not expose a TCP port');
  }
  const port = address.port;
  if (options.descriptorPath) {
    fs.writeFileSync(options.descriptorPath, JSON.stringify({ host: '127.0.0.1', port }), 'utf8');
  }
  options.logger?.appendLine(`[test-control] Listening on http://127.0.0.1:${port}`);

  return {
    port,
    dispose: () => {
      server.close();
      if (options.descriptorPath) {
        try {
          fs.unlinkSync(options.descriptorPath);
        } catch {
          // The runner may already have removed its descriptor.
        }
      }
    },
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  api: RuntimeTestApi,
  token: string,
  logger?: { appendLine(message: string): void },
): Promise<void> {
  if (!isAuthorized(request.headers.authorization, token)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/execute') {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const raw = await readBody(request);
    let body: { code?: unknown };
    try {
      body = JSON.parse(raw) as { code?: unknown };
    } catch {
      sendJson(response, 400, { error: 'Request body must be valid JSON' });
      return;
    }
    if (typeof body.code !== 'string' || !body.code.trim()) {
      sendJson(response, 400, { error: 'A non-empty code string is required' });
      return;
    }
    const result = await executeRuntimeTestScript(api, body.code);
    sendJson(response, 200, { ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.appendLine(`[test-control] Script failed: ${message}`);
    sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 500, {
      ok: false,
      error: message,
    });
  }
}

export async function executeRuntimeTestScript(api: RuntimeTestApi, code: string): Promise<unknown> {
  const exposedApi = Object.freeze({ ...api });
  const context = vm.createContext(
    { api: exposedApi },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: 'acpilot-runtime-test.js',
  });
  const execution = Promise.resolve(script.runInContext(context, {
    timeout: SYNC_SCRIPT_TIMEOUT_MS,
  }) as unknown);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Runtime test exceeded ${SCRIPT_TIMEOUT_MS}ms`)),
          SCRIPT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) {clearTimeout(timer);}
  }
}

function isAuthorized(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) {return false;}
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) {return;}
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new RequestBodyTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!tooLarge) {resolve(Buffer.concat(chunks).toString('utf8'));}
    });
    request.on('error', reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
