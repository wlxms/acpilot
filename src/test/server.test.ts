import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { delimiter, resolve } from 'path';

// ---------------------------------------------------------------------------
// Mock the SDK before importing
// ---------------------------------------------------------------------------

const mockServer = {
  url: 'http://127.0.0.1:51777',
  close: vi.fn(),
};

const mockClient = {
  session: {
    create: vi.fn(),
    prompt: vi.fn(),
  },
  event: {
    subscribe: vi.fn(),
  },
  config: {
    providers: vi.fn(),
  },
};

const mockInstance = {
  server: mockServer,
  client: mockClient,
};

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: vi.fn(),
}));

import { createOpencode } from '@opencode-ai/sdk/v2';
import { OpenCodeServerManager } from '../opencode/server';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenCodeServerManager', () => {
  let manager: OpenCodeServerManager;
  let originalPath: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    originalPath = process.env.PATH;
    manager = new OpenCodeServerManager();
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it('should be in stopped state initially', () => {
    expect(manager.getStatus()).toBe('stopped');
    expect(manager.isRunning()).toBe(false);
    expect(manager.getUrl()).toBeNull();
    expect(manager.getClient()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Start – success
  // -----------------------------------------------------------------------

  it('should call createOpencode with port 0 and return URL', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    const url = await manager.start();

    expect(createOpencode).toHaveBeenCalledWith({ port: 0, timeout: 15_000 });
    expect(url).toBe('http://127.0.0.1:51777');
    expect(manager.getStatus()).toBe('running');
    expect(manager.isRunning()).toBe(true);
    expect(manager.getUrl()).toBe(url);
  });

  it('should start using the packaged OpenCode CLI path and restore PATH afterward', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const firstPathEntry = (process.env.PATH ?? '').split(delimiter)[0];
      expect(resolve(firstPathEntry)).toBe(resolve(process.cwd(), 'node_modules', '.bin'));
      return mockInstance;
    });

    await manager.start();

    expect(process.env.PATH).toBe(originalPath);
  });

  it('should delete OPENCODE_SERVER_PASSWORD env var before starting', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'should-be-deleted';
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();

    expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it('should return cached URL if already running', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();
    const url2 = await manager.start();

    expect(url2).toBe('http://127.0.0.1:51777');
    expect(createOpencode).toHaveBeenCalledTimes(1);
  });

  it('should reuse an in-flight start call', async () => {
    let resolveStart: ((value: typeof mockInstance) => void) | undefined;
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );

    const first = manager.start('D:\\Temp');
    const second = manager.start('D:\\Temp');
    expect(manager.getStatus()).toBe('starting');
    expect(createOpencode).toHaveBeenCalledTimes(1);

    resolveStart!(mockInstance);
    await expect(first).resolves.toBe('http://127.0.0.1:51777');
    await expect(second).resolves.toBe('http://127.0.0.1:51777');
    expect(manager.getStatus()).toBe('running');
  });

  // -----------------------------------------------------------------------
  // getClient
  // -----------------------------------------------------------------------

  it('should return the SDK client from getClient', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();
    const client = manager.getClient();

    expect(client).toBe(mockClient);
  });

  it('should return null from getClient when not running', () => {
    expect(manager.getClient()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  it('should call server.close on stop', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();
    await manager.stop();

    expect(mockServer.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toBe('stopped');
    expect(manager.isRunning()).toBe(false);
    expect(manager.getUrl()).toBeNull();
    expect(manager.getClient()).toBeNull();
  });

  it('should be safe to call stop when not running', async () => {
    await manager.stop();
    expect(manager.getStatus()).toBe('stopped');
  });

  it('should cancel an in-flight start and close a late-created server', async () => {
    let resolveStart: ((value: typeof mockInstance) => void) | undefined;
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveStart = resolve; }),
    );

    const start = manager.start('D:\\Temp');
    const stop = manager.stop();
    resolveStart!(mockInstance);

    await stop;
    await expect(start).rejects.toThrow('start cancelled');
    expect(mockServer.close).toHaveBeenCalledOnce();
    expect(manager.getStatus()).toBe('stopped');
    expect(manager.getClient()).toBeNull();
  });

  it('bounds stop while startup is deferred, then cleans a late-created server', async () => {
    vi.useFakeTimers();
    try {
      let resolveStart: ((value: typeof mockInstance) => void) | undefined;
      (createOpencode as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise((resolve) => { resolveStart = resolve; }),
      );

      const start = manager.start();
      await Promise.resolve();
      const stop = manager.stop();
      await Promise.resolve();

      let stopSettled = false;
      void stop.then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await stop;
      expect(stopSettled).toBe(true);
      expect(manager.getStatus()).toBe('stopped');

      resolveStart!(mockInstance);
      await expect(start).rejects.toThrow('start cancelled');
      expect(mockServer.close).toHaveBeenCalledOnce();
      expect(manager.getClient()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a late cancelled start clear a replacement instance', async () => {
    vi.useFakeTimers();
    const replacementServer = {
      url: 'http://127.0.0.1:52334',
      close: vi.fn(),
    };
    const replacementClient = { ...mockClient };
    try {
      let resolveFirstStart: ((value: typeof mockInstance) => void) | undefined;
      (createOpencode as unknown as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(new Promise(resolve => { resolveFirstStart = resolve; }))
        .mockResolvedValueOnce({ server: replacementServer, client: replacementClient });

      const firstStart = manager.start();
      await Promise.resolve();
      const stop = manager.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await stop;

      await expect(manager.start()).resolves.toBe(replacementServer.url);

      resolveFirstStart!(mockInstance);
      await expect(firstStart).rejects.toThrow('start cancelled');
      expect(manager.getStatus()).toBe('running');
      expect(manager.getClient()).toBe(replacementClient);
      expect(replacementServer.close).not.toHaveBeenCalled();

      await manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // Start – error handling
  // -----------------------------------------------------------------------

  it('should throw OpenCode CLI not found on ENOENT error', async () => {
    const err = new Error('spawn ENOENT');
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      err,
    );

    await expect(manager.start()).rejects.toThrow('OpenCode CLI not found');
    expect(manager.getStatus()).toBe('error');
  });

  it('should throw OpenCode CLI not found on "not found" error', async () => {
    const err = new Error('command not found: opencode');
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      err,
    );

    await expect(manager.start()).rejects.toThrow('OpenCode CLI not found');
    expect(manager.getStatus()).toBe('error');
  });

  it('should throw generic error for other failures', async () => {
    const err = new Error('Port already in use');
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      err,
    );

    await expect(manager.start()).rejects.toThrow(
      'Failed to start OpenCode server: Port already in use',
    );
    expect(manager.getStatus()).toBe('error');
  });

  it('should handle non-Error rejection values', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      'string error',
    );

    await expect(manager.start()).rejects.toThrow(
      'Failed to start OpenCode server: string error',
    );
    expect(manager.getStatus()).toBe('error');
  });
});
