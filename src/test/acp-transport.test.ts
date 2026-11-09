import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { parseDshBridgeReadyLine, serializeDshBridgeReady } from '../backends/dsh/bridge-protocol';
import { spawnAcpAgent, connectAcpRemote } from '../backends/acp/transport';

const servers: WebSocketServer[] = [];
const children: Array<ReturnType<typeof spawnAcpAgent>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const spawned of children.splice(0)) {
    spawned.dispose?.();
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function nodeScript(body: string): string[] {
  return ['-e', body];
}

describe('ACP local transport lifecycle', () => {
  it.runIf(process.platform === 'win32').each([
    { extension: 'cmd', shell: true },
    { extension: 'cmd', shell: 'C:\\Windows\\System32\\cmd.exe' },
    { extension: 'bat', shell: true },
  ])('starts a .$extension launcher in a path containing spaces through $shell', async ({ extension, shell }) => {
    const directory = await mkdtemp(join(tmpdir(), 'acpilot Code - Insiders '));
    temporaryDirectories.push(directory);
    const command = join(directory, `launcher.${extension}`);
    const patchPath = join(directory, 'bridge patch.yml');
    await writeFile(command, '@echo off\r\n(echo %~1) > "%~dp0launched.txt"\r\n');
    const spawned = spawnAcpAgent({ command, args: [`"${patchPath}"`], shell, stderr: 'pipe' });
    children.push(spawned);
    const exit = new Promise(resolve => spawned.process.once('exit', (code, signal) => resolve({ code, signal })));

    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect((await readFile(join(directory, 'launched.txt'), 'utf8')).trim()).toBe(patchPath);
  });

  it('lets an opted-in agent finish its EOF cleanup before termination', async () => {
    const marker = serializeDshBridgeReady('graceful-stop');
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript(`process.stdin.on('end', () => { process.exitCode = 0; }); process.stdin.resume(); process.stderr.write(${JSON.stringify(marker + '\n')});`),
      shutdownGracePeriodMs: 300,
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 1_000 },
    });
    children.push(spawned);
    await spawned.ready;
    const exit = new Promise(resolve => spawned.process.once('exit', (code, signal) => resolve({ code, signal })));
    spawned.dispose?.();
    spawned.dispose?.();
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect(spawned.process.killed).toBe(false);
  });

  it('terminates an opted-in agent that ignores EOF after a bounded grace period', async () => {
    const marker = serializeDshBridgeReady('bounded-stop');
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript(`setInterval(() => {}, 1_000); process.stdin.resume(); process.stderr.write(${JSON.stringify(marker + '\n')});`),
      shutdownGracePeriodMs: 30,
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 1_000 },
    });
    children.push(spawned);
    await spawned.ready;
    const exit = new Promise(resolve => spawned.process.once('exit', () => resolve(undefined)));
    spawned.dispose?.();
    expect(spawned.process.killed).toBe(false);
    await exit;
    expect(spawned.process.killed).toBe(true);
  });

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

  it('keeps forwarding stderr lines after readiness resolves', async () => {
    const nonce = 'transport-after-ready';
    const marker = serializeDshBridgeReady(nonce);
    const lines: string[] = [];
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript(`process.stderr.write(${JSON.stringify(marker + '\n')}); setTimeout(() => process.stderr.write('bridge-after-ready\\n'), 20); process.stdin.resume();`),
      stderr: 'pipe',
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 1_000 },
      onStderrLine: line => lines.push(line),
    });
    children.push(spawned);
    await expect(spawned.ready).resolves.toMatchObject({ nonce });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(lines).toContain('bridge-after-ready');
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

  it('includes recent stderr when a local agent exits before readiness', async () => {
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript("process.stderr.write('native module mismatch\\n'); process.exit(7);"),
      stderr: 'pipe',
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 1_000 },
    });
    children.push(spawned);

    await expect(spawned.ready).rejects.toThrow(
      /code=7, signal=none[\s\S]*native module mismatch/,
    );
  });

  it('reports unexpected exit status and recent stderr after readiness', async () => {
    const nonce = 'transport-exit-context';
    const marker = serializeDshBridgeReady(nonce);
    const exits: string[] = [];
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: nodeScript(`process.stderr.write(${JSON.stringify(marker + '\n')}); setTimeout(() => { process.stderr.write('profile boot failed\\n'); process.exit(3); }, 10);`),
      stderr: 'pipe',
      readiness: { parse: parseDshBridgeReadyLine, timeoutMs: 1_000 },
      onExit: message => exits.push(message),
    });
    children.push(spawned);

    await expect(spawned.ready).resolves.toMatchObject({ nonce });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toContain('code=3, signal=none');
    expect(exits[0]).toContain('profile boot failed');
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
