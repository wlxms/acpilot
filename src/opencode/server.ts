import { createOpencode } from '@opencode-ai/sdk/v2';
import { existsSync, writeFileSync } from 'fs';
import { delimiter, resolve } from 'path';
import type { OpenCodeClient, OpenCodeServerController } from '../backends/opencode/sdk-types';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

/**
 * A server connection attempt must not hold shutdown (or a replacement
 * runtime) open forever. The SDK has its own request timeout, but callers may
 * provide a transport that never settles, so keep an adapter-level bound too.
 */
const START_DRAIN_TIMEOUT_MS = 2_000;

class StartCancelledError extends Error {
  constructor() {
    super('OpenCode server start cancelled');
    this.name = 'StartCancelledError';
  }
}

/** Default opencode.json config that enables permission.edit="ask" for externalEdit tracking */
const DEFAULT_OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'ask',
    bash: 'allow',
    read: 'allow',
  },
};

/**
 * Ensure an opencode.json exists in the given directory.
 * If the file already exists, it is NOT overwritten (user's config takes precedence).
 * If it doesn't exist, a default config with permission.edit="ask" is created.
 *
 * @returns true if a new file was created, false if one already existed
 */
function ensureOpencodeConfig(dir: string): boolean {
  const configPath = resolve(dir, 'opencode.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_OPENCODE_CONFIG, null, 2), 'utf-8');
    return true;
  }
  return false;
}

function findPackagedOpenCodeBin(): string | undefined {
  const candidates = [
    resolve(__dirname, '..', 'node_modules', '.bin'),
    resolve(__dirname, '..', '..', 'node_modules', '.bin'),
    resolve(process.cwd(), 'node_modules', '.bin'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function prependPackagedOpenCodeToPath(): string | undefined {
  const previousPath = process.env.PATH;
  const extensionBin = findPackagedOpenCodeBin();
  if (!extensionBin) {
    return previousPath;
  }

  const entries = (previousPath ?? '').split(delimiter).filter(Boolean);
  const hasExtensionBin = entries.some((entry) => resolve(entry).toLowerCase() === extensionBin.toLowerCase());
  process.env.PATH = hasExtensionBin
    ? previousPath
    : [extensionBin, ...entries].join(delimiter);
  return previousPath;
}

/**
 * Manages the lifecycle of the OpenCode server via the official SDK.
 *
 * Usage:
 *   const manager = new OpenCodeServerManager();
 *   const url = await manager.start();
 *   const client = manager.getClient();
 *   // ...
 *   await manager.stop();
 */
export class OpenCodeServerManager implements OpenCodeServerController {
  private instance: {
    server: { url: string; close: () => void };
    client: OpenCodeClient;
  } | null = null;
  private status: ServerStatus = 'stopped';
  private serverUrl: string | null = null;
  private startPromise: Promise<string> | null = null;
  /** Incremented whenever a start is invalidated by stop(). */
  private startGeneration = 0;

  /**
   * Start the OpenCode server.
   * @param cwd - Working directory for the opencode server (project root).
   *              The server needs to spawn in the project context for proper
   *              initialization (auth, config, etc.).
   *              Additionally, query.directory is passed on each API call.
   */
  async start(cwd?: string): Promise<string> {
    if (this.status === 'running' && this.serverUrl) {
      return this.serverUrl;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    const generation = ++this.startGeneration;
    const pending = this.doStart(cwd, generation);
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) {
        this.startPromise = null;
      }
    }
  }

  private async doStart(cwd: string | undefined, generation: number): Promise<string> {
    this.status = 'starting';
    this.serverUrl = null;

    const originalCwd = process.cwd();
    let createdInstance: Awaited<ReturnType<typeof createOpencode>> | undefined;
    try {
      // Ensure opencode.json exists in the project directory.
      // This is required for permission.edit="ask" to work, which enables
      // the per-edit externalEdit checkpoint mechanism.
      if (cwd) {
        ensureOpencodeConfig(cwd);
        process.chdir(cwd);
      }

      // DO NOT set OPENCODE_SERVER_PASSWORD — it causes 401 Unauthorized
      delete process.env.OPENCODE_SERVER_PASSWORD;

      const previousPath = prependPackagedOpenCodeToPath();
      try {
        createdInstance = await createOpencode({
          port: 0,
          timeout: 15_000,
        });
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
      // stop() may have invalidated this start while the SDK was connecting.
      // Close the just-created server instead of publishing a late running
      // instance after the caller has requested shutdown.
      if (generation !== this.startGeneration) {
        const staleInstance = createdInstance;
        createdInstance = undefined;
        try {
          staleInstance.server.close();
        } catch {
          // The stale transport may already have closed while stop() raced
          // startup. Preserve the cancellation result either way.
        }
        throw new StartCancelledError();
      }

      // Cast at the architectural boundary: SDK v2 OpencodeClient → our typed contract.
      // The shapes are compatible at runtime; the type mismatch is due to SDK's complex
      // ServerSentEventsResult / RequestResult generics vs our simpler SdkResponse wrapper.
      this.instance = {
        server: createdInstance.server,
        client: createdInstance.client as unknown as OpenCodeClient,
      };
      this.serverUrl = createdInstance.server.url;
      this.status = 'running';
      return this.serverUrl;
    } catch (err) {
      // If the SDK resolved and then the generation was invalidated before
      // publication, make sure no unowned server survives the failed start.
      if (createdInstance) {
        const lateInstance = createdInstance;
        try {
          lateInstance.server.close();
        } catch {
          // Best effort; preserve the original startup error.
        }
      }
      if (generation !== this.startGeneration || err instanceof StartCancelledError) {
        // A stale start can finish after a replacement has already published
        // its own instance. Only mutate shared state when this start still
        // owns the current generation.
        if (generation === this.startGeneration) {
          this.instance = null;
          this.serverUrl = null;
          this.status = 'stopped';
        }
        throw err instanceof StartCancelledError ? err : new StartCancelledError();
      }
      this.status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        throw new Error(
          'OpenCode CLI not found. Install with: npm i -g opencode-ai',
          { cause: err },
        );
      }
      throw new Error(`Failed to start OpenCode server: ${msg}`, { cause: err });
    } finally {
      // Always restore original CWD
      if (cwd) {
        process.chdir(originalCwd);
      }
    }
  }

  async stop(): Promise<void> {
    // Invalidate a start before awaiting it. The completion path checks the
    // generation and closes any server created after shutdown was requested.
    const stopGeneration = ++this.startGeneration;
    const pending = this.startPromise;
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        // Convert rejection into a normal result so the stop path never
        // replaces the original startup error seen by its caller.
        pending.then(() => true, () => true),
        new Promise<boolean>(resolveTimeout => {
          timer = setTimeout(() => resolveTimeout(false), START_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (!drained && this.startPromise === pending) {
        // Let a replacement start create its own promise. The stale doStart
        // path retains the generation guard and will dispose a late server
        // when the SDK eventually resolves.
        this.startPromise = null;
      }
    }

    // A new start may have been requested after the old start settled but
    // before this stop continuation resumed. In that case this stop no longer
    // owns the manager state and must leave the replacement runtime intact.
    if (this.startGeneration !== stopGeneration) {
      return;
    }

    const instance = this.instance;
    this.instance = null;
    this.serverUrl = null;
    this.status = 'stopped';
    if (instance) {
      try {
        instance.server.close();
      } catch {
        // Server close is best effort during extension shutdown.
      }
    }
  }

  /** Get the SDK OpencodeClient instance, or null if not running */
  getClient(): OpenCodeClient | null {
    return this.instance?.client ?? null;
  }

  getStatus(): ServerStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  getUrl(): string | null {
    return this.serverUrl;
  }
}
