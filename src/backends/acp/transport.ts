/**
 * Transport layer for the ACP backend: builds an ACP `Stream` (WHATWG web
 * streams of JSON-RPC messages) from either a local spawned agent process or
 * a remote WebSocket endpoint.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import {
  createWebSocketStream,
  type WebSocketConstructor,
  type WebSocketLike,
} from '@agentclientprotocol/sdk/experimental/ws-client';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { WebSocket as NodeWebSocket } from 'ws';

export interface LocalReadinessOptions {
  /** Maximum time to wait for a readiness line after spawning the process. */
  timeoutMs?: number;
  /** Return a value for the first accepted stderr line, or undefined to keep waiting. */
  parse(line: string): unknown;
}

export interface LocalSpawnOptions {
  /** Command to run (e.g. 'npx', or an absolute path to an agent binary). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Optional environment overrides. */
  env?: NodeJS.ProcessEnv;
  /** Use the platform shell when the configured command is a script launcher. */
  shell?: boolean | string;
  /** Pipe stderr when the caller needs a readiness handshake or line logging. */
  stderr?: 'inherit' | 'pipe';
  /** Optional stderr readiness contract. Its promise must settle before ACP connect. */
  readiness?: LocalReadinessOptions;
  /** Receives non-protocol stderr lines when stderr is piped. */
  onStderrLine?: (line: string) => void;
}

export interface RemoteConnectOptions {
  /** WebSocket URL of the remote ACP agent (e.g. 'ws://host:4096'). */
  url: string;
  /** Optional bearer token sent via a custom WS constructor (headers). */
  authToken?: string;
}

export interface SpawnedAcpAgent {
  stream: Stream;
  process: ChildProcess;
  /** Resolves after the optional local readiness contract has accepted a line. */
  ready?: Promise<unknown>;
  /** Closes stderr line handling and terminates the child process. */
  dispose?: () => void;
}

/**
 * Spawn a local ACP agent and wrap its stdio in an ACP Stream (ndJson).
 * If readiness is configured, stderr is line-read until the parser accepts a
 * line. The reader intentionally remains alive after readiness so optional
 * side-channel protocols can continue to use stderr for the lifetime of ACP.
 */
export function spawnAcpAgent(opts: LocalSpawnOptions): SpawnedAcpAgent {
  const needsStderrPipe = opts.stderr === 'pipe' || opts.readiness !== undefined || opts.onStderrLine !== undefined;
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: opts.shell,
    stdio: ['pipe', 'pipe', needsStderrPipe ? 'pipe' : 'inherit'],
  });

  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  let stderrReader: Interface | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readinessSettled = false;
  let resolveReady!: (value: unknown) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<unknown>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const settleReady = (callback: () => void): void => {
    if (readinessSettled) {return;}
    readinessSettled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    callback();
  };

  const forwardStderrLine = (line: string): void => {
    opts.onStderrLine?.(line);
  };

  if (!opts.readiness) {
    readinessSettled = true;
    resolveReady(undefined);
    if (child.stderr && opts.onStderrLine) {
      stderrReader = createInterface({ input: child.stderr });
      stderrReader.on('line', forwardStderrLine);
    }
  } else if (!child.stderr) {
    readinessSettled = true;
    rejectReady(new Error('ACP local process did not provide stderr for readiness handshake'));
  } else {
    stderrReader = createInterface({ input: child.stderr });
    stderrReader.on('line', line => {
      if (readinessSettled) {
        forwardStderrLine(line);
        return;
      }

      let parsed: unknown;
      try {
        parsed = opts.readiness?.parse(line);
      } catch (error) {
        settleReady(() => rejectReady(error));
        return;
      }
      if (parsed === undefined) {
        forwardStderrLine(line);
        return;
      }
      // Keep the readline interface alive. The accepted marker is a startup
      // handshake; later lines may carry a structured DSH bridge message.
      settleReady(() => resolveReady(parsed));
    });
    const timeoutMs = opts.readiness.timeoutMs ?? 15_000;
    timer = setTimeout(() => {
      settleReady(() => rejectReady(new Error(`ACP local process readiness timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
  }

  const failBeforeReady = (error: Error): void => {
    if (!readinessSettled) {
      settleReady(() => rejectReady(error));
    }
  };
  child.once('error', error => failBeforeReady(error));
  child.once('exit', (code, signal) => {
    if (!readinessSettled) {
      failBeforeReady(new Error(
        `ACP local process exited before readiness (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
      ));
    }
  });

  return {
    stream,
    process: child,
    ready,
    dispose: () => {
      stderrReader?.close();
      if (timer) {clearTimeout(timer);}
      if (!child.killed && child.exitCode === null) {child.kill();}
    },
  };
}

/**
 * Connect to a remote ACP agent over WebSocket. When an authToken is provided
 * we pass a `ws`-based WebSocket constructor so headers can be set.
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
