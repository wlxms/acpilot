import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { parseDshBridgeReadyLine, serializeDshBridgeReady } from '../backends/dsh/bridge-protocol';
import { spawnAcpAgent, connectAcpRemote } from '../backends/acp/transport';

const servers: WebSocketServer[] = [];
const children: Array<ReturnType<typeof spawnAcpAgent>> = [];

afterEach(async () => {
  for (const spawned of children.splice(0)) {
    spawned.dispose?.();
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function nodeScript(body: string): string[] {
  return ['-e', body];
}

describe('ACP local transport lifecycle', () => {
  it('waits for a valid DSH bridge marker before exposing the stream', async () => {
    const nonce = 'transport-test-nonce';
    const marker = serializeDshBridgeReady(nonce);
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript(`process.stderr.write(${JSON.stringify(marker + '\n')}); process.stdin.resume();`),
      stderr: 'pipe',
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 1_000 },
    });
    children.push(spawned);
    await expect(spawned.ready).resolves.toEqual({
      plugin: '@wlxms/acpilot-dsh-bridge',
      protocol: 1,
      nonce,
    });
  });

  it('rejects a process that never publishes the bridge marker', async () => {
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript('process.stderr.write("ordinary dsh log\n"); process.stdin.resume();'),
      stderr: 'pipe',
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 25 },
    });
    children.push(spawned);
    await expect(spawned.ready).rejects.toThrow('readiness timed out');
  });
});

describe('ACP remote transport lifecycle', () => {
  it('closes the underlying WebSocket when disposed', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {throw new Error('Expected TCP WebSocket server');}

    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => {resolveClosed = resolve;});
    const connected = new Promise<void>(resolve => server.once('connection', socket => {
      socket.once('close', () => resolveClosed?.());
      resolve();
    }));
    const connection = await connectAcpRemote({ url: `ws://127.0.0.1:${address.port}` });
    await connected;
    connection.dispose();
    await expect(closed).resolves.toBeUndefined();
  });
});
