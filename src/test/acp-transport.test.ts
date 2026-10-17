import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectAcpRemote } from '../backends/acp/transport';

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
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
