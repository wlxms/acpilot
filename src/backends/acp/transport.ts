/**
 * Transport layer for the ACP backend: builds an ACP `Stream` (WHATWG web
 * streams of JSON-RPC messages) from either a local spawned agent process or
 * a remote WebSocket endpoint.
 *
 * VS Code runs on Node 22+, which has stable global `ReadableStream`/
 * `WritableStream` and `Readable.toWeb`/`Writable.toWeb`. The SDK's
 * `ndJsonStream(output, input)` takes web `Uint8Array` streams.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  createWebSocketStream,
  type WebSocketConstructor,
  type WebSocketLike,
} from '@agentclientprotocol/sdk/experimental/ws-client';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { WebSocket as NodeWebSocket } from 'ws';

export interface LocalSpawnOptions {
  /** Command to run (e.g. 'npx', or an absolute path to an agent binary). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Optional environment overrides. */
  env?: NodeJS.ProcessEnv;
}

export interface RemoteConnectOptions {
  /** WebSocket URL of the remote ACP agent (e.g. 'ws://host:4096'). */
  url: string;
  /** Optional bearer token sent via a custom WS constructor (headers). */
  authToken?: string;
}

/**
 * Spawn a local ACP agent and wrap its stdio in an ACP Stream (ndJson).
 * Returns the stream and the underlying ChildProcess (caller should kill it
 * on stop).
 */
export function spawnAcpAgent(opts: LocalSpawnOptions): { stream: Stream; process: ChildProcess } {
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Node stdio → WHATWG web streams (input = agent's stdout, output = agent's stdin).
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;

  // ndJsonStream(output, input) — note arg order: output first.
  const stream = ndJsonStream(output, input);
  return { stream, process: child };
}

/**
 * Connect to a remote ACP agent over WebSocket. When an authToken is provided
 * we pass a `ws`-based WebSocket constructor so headers can be set (the global
 * WebSocket cannot send Authorization headers).
 *
 * `ws` is a peer dependency the host extension must provide (the SDK lists it
 * only as a devDependency). If no token is needed, the global WebSocket works.
 */
export interface RemoteAcpConnection {
  stream: Stream;
  dispose(): void;
}

export async function connectAcpRemote(opts: RemoteConnectOptions): Promise<RemoteAcpConnection> {
  let socket: WebSocketLike | undefined;
  const BaseWebSocket = NodeWebSocket as unknown as WebSocketConstructor;
  const CapturingWebSocket = function (
    this: unknown,
    address: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ): WebSocketLike {
    socket = new BaseWebSocket(address, protocols, options);
    return socket;
  } as unknown as WebSocketConstructor;
  const headers = opts.authToken
    ? { Authorization: `Bearer ${opts.authToken}` }
    : undefined;
  const stream = createWebSocketStream(opts.url, {
    WebSocket: CapturingWebSocket,
    headers,
  });
  return {
    stream,
    dispose: () => {
      socket?.close();
      socket = undefined;
    },
  };
}
