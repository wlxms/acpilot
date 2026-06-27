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
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import type { Stream } from '@agentclientprotocol/sdk';

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
  // Lazy-import to keep the transport module side-effect free.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ndJsonStream } = require('@agentclientprotocol/sdk') as typeof import('@agentclientprotocol/sdk');
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
export async function connectAcpRemote(opts: RemoteConnectOptions): Promise<Stream> {
  if (!opts.authToken) {
    return createWebSocketStream(opts.url);
  }

  // Authenticated path: load `ws` (host-provided) and pass its constructor.
  let WSImpl: typeof WebSocket | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wsModule = require('ws') as { WebSocket: typeof WebSocket };
    WSImpl = wsModule.WebSocket;
  } catch {
    throw new Error(
      'ACP remote transport with authToken requires the `ws` npm package. ' +
      'Install it (npm i ws) or omit authToken to use the global WebSocket.',
    );
  }

  // Build a WS subclass that injects the Authorization header.
  const token = opts.authToken;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WSBase = WSImpl as any;
  class AuthenticatedWebSocket extends WSBase {
    constructor(address: string, protocols?: string | string[] | undefined) {
      super(address, protocols, { headers: { Authorization: `Bearer ${token}` } });
    }
  }
  return createWebSocketStream(opts.url, { WebSocket: AuthenticatedWebSocket as unknown as typeof WebSocket });
}
