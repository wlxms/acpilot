import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OpenCodePipeline } from '../backends/opencode/pipeline';
import { SerializableSessionStream } from '../backend/streaming/session-stream';
import { UserPromptSSP } from '../ssp/impl/user-prompt';
import {
  readAllSnapshots,
  readAllStreamParts,
  readMetaIndex,
  readSubsessionRecords,
} from '../backend/streaming/deserialize';
import type { OpenCodeStreamEvent } from '../backends/opencode/sdk-events';
import type { SessionStreamSchedulingMode } from '../backend/streaming/session-stream-node';
import type { BackendPipelineResult } from '../backend/backend';

// ---------------------------------------------------------------------------
// Mock backend for pipeline construction
// ---------------------------------------------------------------------------

function mockBackend(overrides?: {
  permissions?: { reply: ReturnType<typeof vi.fn> };
  questions?: { reply: ReturnType<typeof vi.fn>; reject?: ReturnType<typeof vi.fn> };
}) {
  return {
    name: 'test',
    permissions: overrides?.permissions ?? { reply: vi.fn().mockResolvedValue(undefined) },
    questions: overrides?.questions
      ? { reject: vi.fn().mockResolvedValue(undefined), ...overrides.questions }
      : { reply: vi.fn().mockResolvedValue(undefined), reject: vi.fn().mockResolvedValue(undefined) },
    sessions: {},
    config: {},
    events: {},
    auth: {},
  } as any;
}

// ---------------------------------------------------------------------------
// Test-only event shorthand
//
// The pipeline now consumes RAW OpenCode SSE events directly (no projection
// layer — see pipeline.ts). Tests below are written in a compact
// "shorthand" shape (flat IDs, flat tool state) for readability; this module
// maps that shorthand to the real raw SSE shapes the pipeline expects. This is
// a TEST FIXTURE ONLY — the production pipeline contains no such mapping.
// ---------------------------------------------------------------------------

/** Compact test shorthand converted to raw OpenCode SDK events by this fixture. */
type ShorthandEvent =
  | { type: 'part.updated'; sessionId?: string; part: ShorthandPart; delta?: string }
  | { type: 'part.delta'; partId: string; delta: string; field?: string; sessionId?: string }
  | { type: 'session.idle'; sessionId?: string }
  | { type: 'session.created'; sessionId?: string; parentId?: string; title?: string }
  | { type: 'session.updated'; sessionId?: string; title?: string }
  | { type: 'session.deleted'; sessionId?: string }
  | { type: 'session.error'; sessionId?: string; error?: unknown }
  | { type: 'session.diff'; sessionId: string; diffs: unknown[] }
  | { type: 'session.status'; sessionId: string; status: unknown }
  | {
      type: 'permission.asked';
      permissionId: string;
      sessionId: string;
      permission: string;
      patterns: string[];
      metadata: Record<string, unknown>;
      always: string[];
      tool?: { messageId: string; callId: string };
    }
  | { type: 'question.asked'; questionId: string; sessionId: string; questions: unknown[] }
  | { type: 'permission.replied'; sessionId: string; permissionId: string; response: string };

type ShorthandPart =
  | { type: 'text'; id: string; messageId?: string; sessionId?: string; text: string; synthetic?: boolean; ignored?: boolean }
  | { type: 'reasoning'; id: string; messageId?: string; sessionId?: string; text: string }
  | { type: 'tool'; id: string; messageId?: string; sessionId?: string; toolName: string; callId?: string; state: ShorthandToolState }
  | { type: 'step-start'; id: string; messageId?: string; sessionId?: string }
  | { type: 'step-finish'; id: string; messageId?: string; sessionId?: string };

type ShorthandToolState =
  | { status: 'pending'; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown> }
  | { status: 'running'; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; startTime?: number }
  | { status: 'completed'; input: Record<string, unknown>; output?: string; title?: string; metadata?: Record<string, unknown>; startTime?: number; endTime?: number }
  | { status: 'error'; input: Record<string, unknown>; error?: string; title?: string; metadata?: Record<string, unknown>; startTime?: number; endTime?: number };

/** Map a tool-state shorthand (flat time) to the raw nested-`time` shape. */
function rawToolState(s: ShorthandToolState): Record<string, unknown> {
  const time: Record<string, unknown> = {};
  if (s.status !== 'pending') {
    if ((s as { startTime?: number }).startTime != null) {time.start = (s as { startTime?: number }).startTime;}
    if ((s as { endTime?: number }).endTime != null) {time.end = (s as { endTime?: number }).endTime;}
  }
  const out: Record<string, unknown> = { status: s.status, input: s.input };
  // `title`/`metadata` only exist on running/completed in the raw schema; for
  // the `pending`/`error` shorthand they are accepted but dropped to match the
  // raw discriminated union.
  if (s.status === 'running' || s.status === 'completed') {
    if (s.title !== undefined) {out.title = s.title;}
    if (s.metadata) {out.metadata = s.metadata;}
  }
  if (s.status === 'completed' && s.output !== undefined) {out.output = s.output;}
  if (s.status === 'error' && s.error !== undefined) {out.error = s.error;}
  if (Object.keys(time).length > 0) {out.time = time;}
  return out;
}

/** Map a part shorthand (camelCase IDs, toolName) to the raw StreamPart shape (UPPER-case IDs, tool). */
function rawPart(part: ShorthandPart): Record<string, unknown> {
  const base: Record<string, unknown> = { id: part.id };
  if (part.messageId !== undefined) {base.messageID = part.messageId;}
  if (part.sessionId !== undefined) {base.sessionID = part.sessionId;}
  switch (part.type) {
    case 'text':
      return { ...base, type: 'text', text: part.text, ...(part.synthetic ? { synthetic: true } : {}), ...(part.ignored ? { ignored: true } : {}) };
    case 'reasoning':
      return { ...base, type: 'reasoning', text: part.text };
    case 'tool': {
      const out: Record<string, unknown> = { ...base, type: 'tool', tool: part.toolName, state: rawToolState(part.state) };
      if (part.callId !== undefined) {out.callID = part.callId;}
      return out;
    }
    case 'step-start':
      return { ...base, type: 'step-start' };
    case 'step-finish':
      return { ...base, type: 'step-finish' };
  }
}

/**
 * Convert a single shorthand event into the raw OpenCode SSE event the bridge
 * consumes. Returns the unwrapped OpenCodeEvent shape (no `{directory,payload}`
 * envelope — `run()` handles both).
 */
function toRawEvent(e: ShorthandEvent): OpenCodeStreamEvent {
  switch (e.type) {
    case 'part.updated': {
      // The real SDK always puts the session id inside `part.sessionID`. The
      // shorthand sometimes sets it at the event level instead — fold it onto
      // the part so the raw event carries it where the bridge expects it.
      const part = { ...e.part } as ShorthandPart & { sessionId?: string };
      if (e.sessionId && part.sessionId === undefined) {
        part.sessionId = e.sessionId;
      }
      return {
        type: 'message.part.updated',
        properties: { part: rawPart(part) as never, ...(e.delta !== undefined ? { delta: e.delta } : {}) },
      } as never;
    }
    case 'part.delta': {
      const props: Record<string, unknown> = { partID: e.partId, delta: e.delta };
      if (e.field !== undefined) {props.field = e.field;}
      if (e.sessionId !== undefined) {props.sessionID = e.sessionId;}
      return { type: 'message.part.delta', properties: props } as never;
    }
    case 'session.idle':
      return {
        type: 'session.idle',
        properties: e.sessionId !== undefined ? { sessionID: e.sessionId } : {},
      } as never;
    case 'session.created':
      return {
        type: 'session.created',
        properties: { info: { id: e.sessionId ?? '', ...(e.parentId ? { parentID: e.parentId } : {}), ...(e.title ? { title: e.title } : {}) } },
      } as never;
    case 'session.updated':
      return {
        type: 'session.updated',
        properties: { info: { id: e.sessionId ?? '', ...(e.title ? { title: e.title } : {}) } },
      } as never;
    case 'session.deleted':
      return { type: 'session.deleted', properties: { info: { id: e.sessionId ?? '' } } } as never;
    case 'session.error':
      return {
        type: 'session.error',
        properties: {
          ...(e.sessionId !== undefined ? { sessionID: e.sessionId } : {}),
          ...(e.error !== undefined ? { error: e.error } : {}),
        },
      } as never;
    case 'session.diff':
      return { type: 'session.diff', properties: { sessionID: e.sessionId, diff: e.diffs } } as never;
    case 'session.status':
      return { type: 'session.status', properties: { sessionID: e.sessionId, status: e.status } } as never;
    case 'permission.asked':
      return {
        type: 'permission.asked',
        properties: {
          id: e.permissionId,
          sessionID: e.sessionId,
          permission: e.permission,
          patterns: e.patterns,
          metadata: e.metadata,
          always: e.always,
          ...(e.tool ? { tool: { messageID: e.tool.messageId, callID: e.tool.callId } } : {}),
        },
      } as never;
    case 'question.asked':
      return {
        type: 'question.asked',
        properties: {
          id: e.questionId,
          sessionID: e.sessionId,
          questions: e.questions,
        },
      } as never;
    case 'permission.replied':
      return {
        type: 'permission.replied',
        properties: {
          sessionID: e.sessionId,
          requestID: e.permissionId,
          reply: e.response,
        },
      } as never;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockStream = Omit<vscode.ChatResponseStream, 'markdown' | 'progress' | 'push'> & {
  markdown: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  externalEdit: ReturnType<typeof vi.fn>;
  thinkingProgress: ReturnType<typeof vi.fn>;
  beginToolInvocation: ReturnType<typeof vi.fn>;
  updateToolInvocation: ReturnType<typeof vi.fn>;
};

function mockStream(opts?: { withProposed?: boolean }): MockStream {
  const stream: Partial<MockStream> = {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
    externalEdit: vi.fn(async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
      await callback();
      return 'undo-stop';
    }),
  };
  if (opts?.withProposed !== false) {
    stream.thinkingProgress = vi.fn();
    stream.beginToolInvocation = vi.fn();
    stream.updateToolInvocation = vi.fn();
  }
  return stream as MockStream;
}

function answerPermission(stream: MockStream, response: 'once' | 'always' | 'reject'): void {
  (stream as MockStream & {
    questionCarousel: ReturnType<typeof vi.fn>;
  }).questionCarousel = vi.fn(async () => ({ q_0: { selectedValue: response } }));
}

function mockToken(isCancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: isCancelled,
    onCancellationRequested: vi.fn(),
  };
}

/**
 * Wrap a shorthand event stream, mapping each event to its raw SSE shape before
 * the bridge consumes it. This is the single place where the test shorthand is
 * translated — the bridge itself receives only raw events.
 */
function rawStream(events: AsyncIterable<ShorthandEvent>): AsyncIterable<OpenCodeStreamEvent> {
  async function* gen(): AsyncIterable<OpenCodeStreamEvent> {
    for await (const e of events) {
      yield toRawEvent(e);
    }
  }
  return gen();
}

function eventStream(events: ShorthandEvent[]): { stream: AsyncIterable<ShorthandEvent> } {
  async function* gen(): AsyncIterable<ShorthandEvent> {
    for (const e of events) {yield e;}
  }
  return { stream: gen() };
}

function getTestSessionDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.acpilot', 'test', 'test-session');
}

/** Creates an SSS with a mock stream and runs raw backend events through the bridge. */
async function runBridge(
  bridgeFactory: (sss: SerializableSessionStream) => OpenCodePipeline,
  events: { stream: AsyncIterable<ShorthandEvent> },
  stream: MockStream,
  token: vscode.CancellationToken,
  options?: { schedulingMode?: SessionStreamSchedulingMode },
): Promise<BackendPipelineResult> {
  const sss = new SerializableSessionStream(stream as any, {
    workspaceRoot: '',
    backendName: 'test',
    sessionId: 'test-session',
    turnIndex: 0,
    requestId: 'test',
    schedulingMode: options?.schedulingMode,
  });
  const result = await bridgeFactory(sss).run(rawStream(events.stream), token);
  await sss.flush();
  return result;
}

function deltaEvent(delta: string, partId = 'prt_ai1'): ShorthandEvent {
  return {
    type: 'part.delta',
    partId,
    delta,
    field: 'text',
  };
}

function idleEvent(): ShorthandEvent {
  return {
    type: 'session.idle',
  };
}

function idleEventFor(sessionId: string): ShorthandEvent {
  return {
    type: 'session.idle',
    sessionId,
  };
}

function toolEvents(opts: {
  toolName: string;
  callId: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  timeStart?: number;
  timeEnd?: number;
}): ShorthandEvent[] {
  const partId = 'prt_tool001';
  return [
    {
      type: 'part.updated',
      part: { type: 'tool', toolName: opts.toolName, id: partId, callId: opts.callId, state: { status: 'pending', input: {} } },
    },
    {
      type: 'part.updated',
      part: { type: 'tool', toolName: opts.toolName, id: partId, callId: opts.callId, state: { status: 'running', input: opts.input ?? {}, title: opts.title, startTime: opts.timeStart } },
    },
    {
      type: 'part.updated',
      part: { type: 'tool', toolName: opts.toolName, id: partId, callId: opts.callId, state: { status: 'completed', input: opts.input ?? {}, output: opts.output ?? '', title: opts.title, startTime: opts.timeStart ?? 0, endTime: opts.timeEnd ?? 100 } },
    },
  ];
}

function fullTurnEvents(opts: { tools?: ShorthandEvent[]; aiDeltas?: string[] }): ShorthandEvent[] {
  const tools = opts.tools ?? toolEvents({ toolName: 'read', callId: 'call_001', input: { filePath: '/f.txt' }, output: 'hello' });
  const aiDeltas = opts.aiDeltas ?? ['OK'];

  return [
    { type: 'part.updated', part: { type: 'text', text: 'do it', messageId: 'msg_u1', id: 'prt_u1' } },
    { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
    ...tools,
    { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
    ...aiDeltas.map((d: string) => deltaEvent(d)),
    idleEvent(),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenCodePipeline', () => {
  let bridge: (sss: SerializableSessionStream) => OpenCodePipeline;

  beforeEach(() => {
    bridge = (sss) => new OpenCodePipeline(mockBackend(), {
      sessionId: 'test-session',
      stream: sss,
    });
  });

  it('persists the backend title without invoking VS Code LM', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-title-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-title',
    });
    try {
      await sss.initialize();
      sss.recordFirstPrompt('how to implement oauth middleware');
      const result = await bridge(sss).run(rawStream((async function* (): AsyncIterable<ShorthandEvent> {
        yield {
          type: 'session.updated',
          sessionId: 'test-session',
          title: 'how to implement oauth middleware',
        };
        yield { type: 'session.idle', sessionId: 'test-session' };
      })()), mockToken());
      await sss.flush();

      const metaIndex = await readMetaIndex(path.join(getTestSessionDir(tmpDir), 'meta.jsonl'));
      const sessionMeta = metaIndex.get('session');
      expect(result.sessionTitle).toBe('how to implement oauth middleware');
      expect(result.sessionTitleSource).toBe('backend');
      expect(sessionMeta?.title).toBe('how to implement oauth middleware');
      expect(sessionMeta?.titleSource).toBe('backend');
      expect(sessionMeta?.provisionalTitle).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists a truncated backend title as-is without invoking VS Code LM', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-title-truncated-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-title',
    });
    try {
      await sss.initialize();
      sss.recordFirstPrompt('refactor bridge title flow to keep raw events inside the bridge boundary');
      const result = await bridge(sss).run(rawStream((async function* (): AsyncIterable<ShorthandEvent> {
        yield {
          type: 'session.updated',
          sessionId: 'test-session',
          title: 'refactor bridge title flow...',
        };
        yield { type: 'session.idle', sessionId: 'test-session' };
      })()), mockToken());
      await sss.flush();

      const metaIndex = await readMetaIndex(path.join(getTestSessionDir(tmpDir), 'meta.jsonl'));
      const sessionMeta = metaIndex.get('session');
      expect(result.sessionTitle).toBe('refactor bridge title flow...');
      expect(result.sessionTitleSource).toBe('backend');
      expect(sessionMeta?.title).toBe('refactor bridge title flow...');
      expect(sessionMeta?.titleSource).toBe('backend');
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists a non-echo backend session title without invoking VS Code LM', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-title-backend-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-title',
    });
    const selectChatModelsSpy = vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([]);
    selectChatModelsSpy.mockClear();

    try {
      await sss.initialize();
      sss.recordFirstPrompt('how to implement oauth middleware');
      const result = await bridge(sss).run(rawStream((async function* (): AsyncIterable<ShorthandEvent> {
        yield {
          type: 'session.updated',
          sessionId: 'test-session',
          title: 'OAuth Middleware',
        };
        yield { type: 'session.idle', sessionId: 'test-session' };
      })()), mockToken());
      await sss.flush();

      const metaIndex = await readMetaIndex(path.join(getTestSessionDir(tmpDir), 'meta.jsonl'));
      const sessionMeta = metaIndex.get('session');
      expect(selectChatModelsSpy).not.toHaveBeenCalled();
      expect(result.sessionTitle).toBe('OAuth Middleware');
      expect(result.sessionTitleSource).toBe('backend');
      expect(sessionMeta?.title).toBe('OAuth Middleware');
      expect(sessionMeta?.titleSource).toBe('backend');
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should complete a full turn with tool + AI text', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({}));
    const result = await runBridge(bridge,events, stream, mockToken());
    expect(result.completed).toBe(true);
    expect(stream.markdown).toHaveBeenCalledWith('OK');
  });

  it('does not recursively generate a title for a title-generation pipeline', async () => {
    const selectChatModels = vi.spyOn(vscode.lm, 'selectChatModels')
      .mockRejectedValue(new Error('title generation must not recurse'));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-title-recursion-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-title-recursion',
    });
    try {
      await sss.initialize();
      sss.recordFirstPrompt('Generate a short title');
      const result = await new OpenCodePipeline(mockBackend(), {
        sessionId: 'test-session',
        stream: sss,
        suppressTitleGeneration: true,
      }).run(rawStream((async function* (): AsyncIterable<ShorthandEvent> {
        yield {
          type: 'session.updated',
          sessionId: 'test-session',
          title: 'Generate a short title',
        };
        yield { type: 'session.idle', sessionId: 'test-session' };
      })()), mockToken());
      await sss.flush();

      expect(result.sessionTitle).toBeNull();
      expect(selectChatModels).not.toHaveBeenCalled();
    } finally {
      selectChatModels.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('ends incomplete on session.error without waiting for session.idle or stream closure', async () => {
    const stream = mockStream();
    let releaseStream!: () => void;
    const streamHeldOpen = new Promise<void>(resolve => {
      releaseStream = resolve;
    });
    async function* events(): AsyncIterable<ShorthandEvent> {
      yield {
        type: 'session.error',
        sessionId: 'test-session',
        error: { name: 'ApiError', data: { message: 'model request failed' } },
      };
      await streamHeldOpen;
    }

    try {
      const result = await runBridge(bridge, { stream: events() }, stream, mockToken());

      expect(result.completed).toBe(false);
      expect(result.error).toBe('model request failed');
      expect(stream.progress).toHaveBeenCalledWith(expect.stringContaining('model request failed'));
    } finally {
      releaseStream();
    }
  });

  it('completes a deferred parent turn when child session.error ends the child scope', async () => {
    const stream = mockStream();
    const taskCallId = 'call_child_error_terminal';
    const childSessionId = 'ses_child_error_terminal';
    let releaseStream!: () => void;
    const streamHeldOpen = new Promise<void>(resolve => {
      releaseStream = resolve;
    });
    async function* events(): AsyncIterable<ShorthandEvent> {
      yield {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_error_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child failure' },
            metadata: { sessionId: childSessionId },
          },
        },
      };
      // Parent idle enters deferred-idle because the child is still active.
      yield idleEvent();
      yield {
        type: 'session.error',
        sessionId: childSessionId,
        error: { name: 'ApiError', data: { message: 'child model failed' } },
      };
      await streamHeldOpen;
    }

    try {
      const result = await runBridge(bridge, { stream: events() }, stream, mockToken());

      expect(result.completed).toBe(true);
      expect(stream.progress).toHaveBeenCalledWith(expect.stringContaining('child model failed'));
      const failedTask = stream.push.mock.calls
        .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean })
        .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);
      expect(failedTask).toBeDefined();
    } finally {
      releaseStream();
    }
  });

  it('continues the parent pipeline after a child session.error', async () => {
    const stream = mockStream();
    const taskCallId = 'call_child_error_parent_continues';
    const childSessionId = 'ses_child_error_parent_continues';
    const events = eventStream([
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_error_parent_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'recoverable child failure' },
            metadata: { sessionId: childSessionId },
          },
        },
      },
      {
        type: 'session.error',
        sessionId: childSessionId,
        error: { name: 'ApiError', data: { message: 'child failed but parent continues' } },
      },
      {
        type: 'part.updated',
        part: { type: 'text', text: '', messageId: 'msg_parent_after_error', id: 'prt_parent_after_error' },
      },
      { type: 'part.delta', partId: 'prt_parent_after_error', delta: 'parent recovered', field: 'text' },
      idleEvent(),
    ]);

    const result = await runBridge(bridge, events, stream, mockToken());

    expect(result.completed).toBe(true);
    expect(stream.markdown).toHaveBeenCalledWith('parent recovered');
    expect(stream.progress).toHaveBeenCalledWith(expect.stringContaining('child failed but parent continues'));
    const failedTask = stream.push.mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean })
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);
    expect(failedTask).toBeDefined();
  });

  it('persists a child session.error that arrives before scope binding', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-child-error-before-bind-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'child-error-before-bind',
    });
    const firstCallId = 'call_child_error_before_bind';
    const secondCallId = 'call_other_scope';
    const childSessionId = 'ses_child_error_before_bind';
    const secondChildSessionId = 'ses_other_scope';

    try {
      await sss.initialize();
      const events = rawStream(eventStream([
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_child_error_before_bind',
            callId: firstCallId,
            state: { status: 'running', input: { description: 'first child' } },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_other_scope',
            callId: secondCallId,
            state: { status: 'running', input: { description: 'second child' } },
          },
        },
        // Two unbound scopes make this event intentionally ambiguous, so it is
        // buffered until the matching task carries its child session id.
        {
          type: 'session.error',
          sessionId: childSessionId,
          error: { name: 'ApiError', data: { message: 'buffered child failure' } },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_child_error_before_bind',
            callId: firstCallId,
            state: {
              status: 'running',
              input: { description: 'first child' },
              metadata: { sessionId: childSessionId },
            },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_other_scope',
            callId: secondCallId,
            state: {
              status: 'completed',
              input: { description: 'second child' },
              output: 'second complete',
              metadata: { sessionId: secondChildSessionId },
            },
          },
        },
        idleEventFor(secondChildSessionId),
        idleEvent(),
      ]).stream);

      const result = await new OpenCodePipeline(mockBackend(), {
        sessionId: 'test-session',
        stream: sss,
      }).run(events, mockToken());
      await sss.flush();

      expect(result.completed).toBe(true);
      const sessionDir = getTestSessionDir(tmpDir);
      const subsessions = await readSubsessionRecords(sessionDir);
      const failedSubsession = subsessions.find(sub => sub.subAgentInvocationId === firstCallId);
      expect(failedSubsession).toBeDefined();
      expect(failedSubsession?.metaIndex.get('session')?.status).toBe('failed');
      expect(failedSubsession?.metaIndex.get('session')?.error).toBe('buffered child failure');
      expect(failedSubsession?.records.some(record =>
        record.kind === 'sessionLifecycle'
        && (record.payload as { eventType?: string }).eventType === 'session.error',
      )).toBe(true);

      const rootRecords = await readAllStreamParts(path.join(sessionDir, 'session.jsonl'));
      expect(rootRecords.some(record =>
        record.kind === 'toolInvocation'
        && (record.payload as { callId?: string }).callId === firstCallId
        && (record.payload as { state?: { status?: string } }).state?.status === 'error',
      )).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(['sessionID', 'sessionId'] as const)(
    'uses top-level %s on message.part.updated to keep child output out of the root stream',
    async (sessionField) => {
      const stream = mockStream();
      const sss = new SerializableSessionStream(stream as any, {
        workspaceRoot: '',
        backendName: 'test',
        sessionId: 'test-session',
        turnIndex: 0,
        requestId: 'test-request-top-level-session',
      });
      await sss.initialize();
      async function* rawEvents(): AsyncIterable<OpenCodeStreamEvent> {
        yield {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'prt_root_user_top_level',
              messageID: 'msg_root_user_top_level',
              text: 'root prompt',
            },
            [sessionField]: 'test-session',
          },
        } as never;
        yield {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'prt_child_answer_top_level',
              messageID: 'msg_child_answer_top_level',
              text: 'child answer',
            },
            [sessionField]: 'child-session-top-level',
          },
        } as never;
        yield { type: 'session.idle', properties: { sessionID: 'test-session' } } as never;
      }

      await bridge(sss).run(rawEvents(), mockToken());
      await sss.flush();

      expect(stream.markdown).not.toHaveBeenCalledWith('child answer');
    },
  );

  it('should stream AI text even when user echo is missing', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'text', text: 'Hello', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent(' world', 'prt_ai1'),
      idleEvent(),
    ]);

    const result = await runBridge(bridge,events, stream, mockToken());

    expect(result.completed).toBe(true);
    expect(stream.markdown).toHaveBeenCalledWith(' world');
    expect(result.userMessageId).toBeNull();
  });

  // --- Tool: read → SimpleToolResultData ---

  it('does not render deltas for a skipped user echo part', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'user echo', messageId: 'msg_u1', id: 'prt_u1' } },
      deltaEvent(' ignored user delta', 'prt_u1'),
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('assistant text', 'prt_ai1'),
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).not.toHaveBeenCalledWith(' ignored user delta');
    expect(stream.markdown).toHaveBeenCalledWith('assistant text');
  });

  it('renders closed OpenCode system reminders as standalone tool cards', async () => {
    const stream = mockStream();
    const noticeText = '<system-reminder>\n\n[ALL BACKGROUND TASKS COMPLETE]\n\nCompleted:\n\nbg_123: repo scan\n</system-reminder>\n\n<!-- OMO_INTERNAL_INITIATOR -->';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'user echo', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('root answer', 'prt_ai1'),
      {
        type: 'part.updated',
        part: {
          type: 'text',
          id: 'prt_notice',
          messageId: 'msg_user_notice',
          text: noticeText,
          ignored: true,
        },
      },
      deltaEvent('\nshould not render', 'prt_notice'),
      deltaEvent(' still root', 'prt_ai1'),
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).toHaveBeenCalledWith('root answer');
    expect(stream.markdown).toHaveBeenCalledWith(' still root');
    expect(stream.markdown).not.toHaveBeenCalledWith(expect.stringContaining('BACKGROUND TASKS COMPLETE'));
    expect(stream.markdown).not.toHaveBeenCalledWith('\nshould not render');
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        toolCallId?: string;
        isComplete?: boolean;
        pastTenseMessage?: string;
        toolSpecificData?: { input?: string; output?: string };
      });
    const systemPart = pushed.find(part => part.toolName === 'ALL BACKGROUND TASKS COMPLETE' && part.toolCallId === 'system-prt_notice');
    expect(systemPart).toBeDefined();
    expect(systemPart?.isComplete).toBe(true);
    expect(systemPart?.pastTenseMessage).toBe('ALL BACKGROUND TASKS COMPLETE');
    expect(systemPart?.toolSpecificData).toEqual({
      input: 'ALL BACKGROUND TASKS COMPLETE',
      output: noticeText,
    });
  });

  it('does not treat incomplete system-reminder text as a system tool card', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'user echo', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('root answer', 'prt_ai1'),
      {
        type: 'part.updated',
        part: {
          type: 'text',
          id: 'prt_notice',
          messageId: 'msg_user_notice',
          text: '<system-reminder>\n\n[ALL BACKGROUND TASKS COMPLETE]',
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).toHaveBeenCalledWith('root answer');
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string });
    expect(pushed.some(part => part.toolName === 'ALL BACKGROUND TASKS COMPLETE')).toBe(false);
  });

  it('renders any closed system-reminder title from the first bracketed heading', async () => {
    const stream = mockStream();
    const noticeText = '<system-reminder>\n\n[NEEDS USER REVIEW]\n\nCheck the background result.\n</system-reminder>';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'user echo', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'text',
          id: 'prt_notice_review',
          messageId: 'msg_user_notice',
          text: noticeText,
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).not.toHaveBeenCalledWith(expect.stringContaining('NEEDS USER REVIEW'));
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        pastTenseMessage?: string;
        toolSpecificData?: { input?: string; output?: string };
      });
    const systemPart = pushed.find(part => part.toolName === 'NEEDS USER REVIEW');
    expect(systemPart?.pastTenseMessage).toBe('NEEDS USER REVIEW');
    expect(systemPart?.toolSpecificData).toEqual({
      input: 'NEEDS USER REVIEW',
      output: noticeText,
    });
  });

  it('should push read tool as ChatSimpleToolResultData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callId: 'call_rd', input: { filePath: '/src/main.ts' }, output: 'line1\nline2', title: 'main.ts', timeStart: 1000, timeEnd: 1500 }),
    }));
    await runBridge(bridge,events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(
      'call_rd',
      'read',
      expect.objectContaining({ isAttachedToThinking: true }),
    );
    expect(stream.push).toHaveBeenCalled();
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const readPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; isComplete?: boolean };
      return p?.toolName === 'read' && p?.isComplete === true;
    });
    expect(readPart).toBeDefined();
    const part = readPart![0] as {
      pastTenseMessage?: string | { toString(): string };
      invocationMessage?: string | { toString(): string };
      presentation?: string;
      enablePartialUpdate?: boolean;
      toolSpecificData?: unknown;
      isAttachedToThinking?: boolean;
    };
    expect(part.isAttachedToThinking).toBe(true);
    expect(String(part.invocationMessage)).toMatch(/Read.*main\.ts/);
    expect(part.pastTenseMessage).toBeUndefined();
    expect(part.presentation).toBe('hiddenAfterComplete');
    expect(part.enablePartialUpdate).toBe(true);
    expect(part.toolSpecificData).toBeUndefined();
  });

  // --- Tool: bash → TerminalToolData ---

  it('should push bash tool as ChatTerminalToolInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'bash', callId: 'call_sh', input: { command: 'ls -la' }, output: 'total 42', title: 'bash', timeStart: 1000, timeEnd: 3200 }),
    }));
    await runBridge(bridge,events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(
      'call_sh',
      'bash',
      expect.objectContaining({ isAttachedToThinking: true }),
    );
  });

  // --- Tool: write → ToolResourcesInvocationData ---

  it('should push write tool as a transient hidden-after-complete card', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'write', callId: 'call_wr', input: { filePath: '/src/new.ts' }, output: 'written', title: 'new.ts' }),
    }));
    await runBridge(bridge,events, stream, mockToken());
    // Write tools without permission are deferred at pending/running;
    // ToolInvocationSSP is created at completed state directly.
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const writePart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; isComplete?: boolean };
      return p?.toolName === 'write' && p?.isComplete === true;
    });
    expect(writePart).toBeDefined();
    const part = writePart![0] as {
      presentation?: string;
      enablePartialUpdate?: boolean;
      toolSpecificData?: unknown;
      isAttachedToThinking?: boolean;
    };
    expect(part.isAttachedToThinking).toBe(true);
    expect(part.presentation).toBe('hiddenAfterComplete');
    expect(part.enablePartialUpdate).toBe(true);
    expect(part.toolSpecificData).toBeUndefined();
  });

  // --- Tool: task → SubagentToolInvocationData ---

  it('should push task tool as ChatSubagentToolInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'task', callId: 'call_tsk', input: { description: 'subtask', prompt: 'do X', subagent_type: 'librarian' }, output: 'done', title: 'Subtask' }),
    }));
    await runBridge(bridge,events, stream, mockToken());
    const subagentPart = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; invocationMessage?: string; toolSpecificData?: Record<string, unknown> })
      .find(part => part.toolName === 'task' && part.toolCallId === 'call_tsk');

    expect(subagentPart).toBeDefined();
    expect(subagentPart?.invocationMessage).toBe('subtask');
    expect(subagentPart?.toolSpecificData).toEqual(expect.objectContaining({
      description: 'subtask',
      agentName: 'librarian',
      prompt: 'do X',
    }));
  });

  // --- Subagent event filtering ---

  it('should filter subagent-internal tool events and aggregate progress', async () => {
    const stream = mockStream();
    const taskId = 'prt_task001';
    const taskCallId = 'call_sub1';
    const childSessionId = 'ses_child001';
    // Subagent internal tool part (different partId — will be filtered)
    const subPartId = 'prt_sub_read001';
    const subDeltaPartId = 'prt_sub_text001';

    const events = eventStream([
      // User message
      { type: 'part.updated', part: { type: 'text', text: 'do it', messageId: 'msg_u1', id: 'prt_u1' } },
      // Parent step-start
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      // Task tool: pending
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'pending', input: {} } } },
      // Task tool: running → opens subagent scope
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'running', input: { description: 'fix bug' }, title: 'fix-bug' } } },
      // Subagent internal: read tool (different partId — should be filtered)
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: subPartId, callId: 'call_sub_read', state: { status: 'completed', input: { filePath: '/src/main.ts' }, output: 'line1', title: 'main.ts' } } },
      // Subagent internal: text delta (different partId — should be filtered)
      { type: 'part.delta', partId: subDeltaPartId, delta: 'subagent thinking...' },
      // Another subagent tool: bash (different partId — should be filtered)
      { type: 'part.updated', part: { type: 'tool', toolName: 'bash', id: 'prt_sub_bash001', callId: 'call_sub_bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'all pass' } } },
      // Task tool: completed → subagent created, childSessionId set, scope kept open
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'completed', input: { description: 'fix bug' }, output: 'bug fixed', title: 'fix-bug', metadata: { sessionId: childSessionId }, startTime: 1000, endTime: 3000 } } },
      // AI response
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      ...['Done'].map((d: string) => deltaEvent(d)),
      // Child session goes idle → triggers final subagent card push
      idleEventFor(childSessionId),
      // Parent session idle → bridge stops
      idleEvent(),
    ]);
    await runBridge(bridge,events, stream, mockToken());

    // The final card should be pushed when child session goes idle
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const runningTaskPart = pushed
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; subAgentInvocationId?: string; isAttachedToThinking?: boolean })
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId);
    expect(runningTaskPart?.subAgentInvocationId).toBeUndefined();
    expect(runningTaskPart?.isAttachedToThinking).toBe(true);

    // Should have the task's final completed part pushed (from child session.idle)
    const taskPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean };
      return p?.toolName === 'task' && p?.toolCallId === taskCallId && p?.isComplete === true;
    });
    expect(taskPart).toBeDefined();
    expect((taskPart![0] as { isAttachedToThinking?: boolean }).isAttachedToThinking).toBe(true);

    // Verify subagent internal tools were pushed as child tool cards
    // (with subAgentInvocationId for VSCode scope grouping), not as
    // independent top-level cards.
    const readPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; subAgentInvocationId?: string };
      return p?.toolName === 'read';
    });
    expect(readPart).toBeDefined();
    // Child tools should carry the subAgentInvocationId for grouping
    const readObj = readPart![0];
    expect(readObj.subAgentInvocationId).toBe(taskCallId);
    expect(readObj.isAttachedToThinking).toBe(true);

    const bashPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; subAgentInvocationId?: string };
      return p?.toolName === 'bash';
    });
    expect(bashPart).toBeDefined();
    const bashObj = bashPart![0];
    expect(bashObj.subAgentInvocationId).toBe(taskCallId);
    expect(bashObj.isAttachedToThinking).toBe(true);

    // AI text should still be rendered
    expect(stream.markdown).toHaveBeenCalledWith('Done');
  });

  it('updates parent subagent progress through updateToolInvocation between root tool completions', async () => {
    const stream = mockStream();
    const taskCallId = 'call_parent_task';
    const childSessionId = 'ses_child_task';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'do it', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_task',
          callId: taskCallId,
          state: { status: 'pending', input: { description: 'background task' } },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: { description: 'background task' },
            output: 'launched',
            title: 'background task',
            metadata: { sessionId: childSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'webfetch',
          id: 'prt_root_fetch_a',
          callId: 'call_root_fetch_a',
          state: { status: 'pending', input: { url: 'https://example.test/a' } },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'webfetch',
          id: 'prt_root_fetch_b',
          callId: 'call_root_fetch_b',
          state: { status: 'pending', input: { url: 'https://example.test/b' } },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'webfetch',
          id: 'prt_root_fetch_a',
          callId: 'call_root_fetch_a',
          state: {
            status: 'completed',
            input: { url: 'https://example.test/a' },
            title: 'a',
            output: 'a',
          },
        },
      },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: {
          type: 'tool',
          toolName: 'bash',
          id: 'prt_child_bash',
          callId: 'call_child_bash',
          sessionId: childSessionId,
          state: {
            status: 'completed',
            input: { command: 'npm test' },
            title: 'npm test',
            output: 'ok',
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'webfetch',
          id: 'prt_root_fetch_b',
          callId: 'call_root_fetch_b',
          state: {
            status: 'completed',
            input: { url: 'https://example.test/b' },
            title: 'b',
            output: 'b',
          },
        },
      },
      idleEventFor(childSessionId),
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken(), { schedulingMode: 'continuous' });

    const pushedTaskParts = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string })
      .filter(part => part.toolName === 'task' && part.toolCallId === taskCallId);
    expect(pushedTaskParts).toHaveLength(2);
    expect(stream.updateToolInvocation).toHaveBeenCalledWith(taskCallId, {
      invocationMessage: 'bash',
      isAttachedToThinking: true,
    });
  });

  it('routes nested subagent session events to the nested subsession scope', async () => {
    const stream = mockStream();
    const parentCallId = 'call_parent_sub';
    const parentSessionId = 'ses_parent_sub';
    const nestedCallId = 'call_nested_sub';
    const nestedSessionId = 'ses_nested_sub';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'do nested work', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parent_task',
          callId: parentCallId,
          state: { status: 'pending', input: {} },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parent_task',
          callId: parentCallId,
          state: {
            status: 'running',
            input: { description: 'parent task' },
            title: 'parent',
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_nested_task',
          callId: nestedCallId,
          sessionId: parentSessionId,
          state: {
            status: 'completed',
            input: { description: 'nested task' },
            output: 'nested done',
            title: 'nested',
            metadata: { sessionId: nestedSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_nested_read',
          callId: 'call_nested_read',
          sessionId: nestedSessionId,
          state: {
            status: 'completed',
            input: { filePath: '/nested.ts' },
            output: 'nested content',
            title: 'nested.ts',
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parent_task',
          callId: parentCallId,
          state: {
            status: 'completed',
            input: { description: 'parent task' },
            output: 'parent done',
            title: 'parent',
            metadata: { sessionId: parentSessionId },
          },
        },
      },
      idleEventFor(nestedSessionId),
      idleEventFor(parentSessionId),
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; subAgentInvocationId?: string });
    const parentTaskPart = pushed
      .find(part => part.toolName === 'task' && part.toolCallId === parentCallId);
    const nestedTaskPart = pushed
      .find(part => part.toolName === 'task' && part.toolCallId === nestedCallId);
    const nestedReadPart = pushed
      .find(part => part.toolName === 'read' && part.toolCallId === 'call_nested_read');

    expect(parentTaskPart?.subAgentInvocationId).toBeUndefined();
    expect(nestedTaskPart?.subAgentInvocationId).toBe(parentCallId);
    expect(nestedReadPart?.subAgentInvocationId).toBe(nestedCallId);
  });

  it('routes child session text and reasoning through the child subsession flow', async () => {
    const stream = mockStream();
    const taskCallId = 'call_child_text_task';
    const childSessionId = 'ses_child_text';
    const childReasoningId = 'prt_child_reasoning';
    const childTextId = 'prt_child_text';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_text_task',
          callId: taskCallId,
          state: { status: 'pending', input: {} },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_text_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: { description: 'child text' },
            output: 'child done',
            title: 'child',
            metadata: { sessionId: childSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: { type: 'text', text: 'child user echo', messageId: 'child_user', id: 'prt_child_user', sessionId: childSessionId },
      },
      {
        type: 'part.updated',
        part: { type: 'step-start', messageId: 'child_assistant', id: 'prt_child_step', sessionId: childSessionId },
      },
      {
        type: 'part.updated',
        part: { type: 'reasoning', text: '', messageId: 'child_assistant', id: childReasoningId, sessionId: childSessionId },
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childReasoningId, delta: 'child thought', field: 'text' },
      {
        type: 'part.updated',
        part: { type: 'text', text: '', messageId: 'child_assistant', id: childTextId, sessionId: childSessionId },
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childTextId, delta: 'child answer', field: 'text' },
      idleEventFor(childSessionId),
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken(), { schedulingMode: 'continuous' });

    expect(stream.markdown).not.toHaveBeenCalledWith('child user echo');
    expect(stream.thinkingProgress).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'child thought' }));
    expect(stream.markdown).not.toHaveBeenCalledWith('child answer');

    const subagentPart = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        toolCallId?: string;
        isComplete?: boolean;
        toolSpecificData?: { result?: string };
      })
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);
    expect(subagentPart?.toolSpecificData?.result).toBe('child answer');
  });

  it('keeps child reasoning inside the subagent card instead of root thinkingProgress', async () => {
    const stream = mockStream();
    const taskCallId = 'call_child_reasoning_scope';
    const childSessionId = 'ses_child_reasoning_scope';
    const rootReasoningId = 'prt_root_reasoning_scope';
    const childReasoningId = 'prt_child_reasoning_scope';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: rootReasoningId } },
      { type: 'part.delta', partId: rootReasoningId, delta: 'root thought', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_reasoning_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child reasoning', prompt: 'think', subagent_type: 'explore' },
            title: 'child reasoning',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      { type: 'session.created', sessionId: childSessionId, parentId: 'test-session', title: 'child reasoning' },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: { type: 'reasoning', text: '', messageId: 'child_assistant', id: childReasoningId },
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childReasoningId, delta: 'child thought', field: 'text' },
      idleEventFor(childSessionId),
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_reasoning_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: { description: 'child reasoning', prompt: 'think', subagent_type: 'explore' },
            output: 'done',
            title: 'child reasoning',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken(), { schedulingMode: 'continuous' });

    const thinkingCalls = stream.thinkingProgress.mock.calls
      .map((call: unknown[]) => call[0] as {
        text?: string;
        id?: string;
        metadata?: {
          sessionId?: string;
          parentSessionId?: string;
          subAgentInvocationId?: string;
          subAgentPath?: string[];
        };
      })
      .filter(call => call.text);
    const rootThought = thinkingCalls.find(call => call.text === 'root thought');
    const childThought = thinkingCalls.find(call => call.text === 'child thought');

    expect(rootThought?.id).toBeDefined();
    expect(childThought).toBeUndefined();
    expect(rootThought?.metadata?.subAgentInvocationId).toBeUndefined();

    const parentCardUpdates = stream.updateToolInvocation.mock.calls
      .filter((call: unknown[]) => call[0] === taskCallId)
      .map((call: unknown[]) => call[1] as {
        invocationMessage?: string;
        pastTenseMessage?: string;
      });
    expect(parentCardUpdates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ invocationMessage: expect.stringContaining('child thought') }),
    ]));
    expect(parentCardUpdates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ pastTenseMessage: expect.stringContaining('child thought') }),
    ]));

    const subagentPart = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        toolCallId?: string;
        isComplete?: boolean;
        toolSpecificData?: { result?: string };
      })
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);
    expect(subagentPart?.toolSpecificData?.result).toBe('done');
  });

  it('keeps consecutive root reasoning together and inserts subagent tools at the next main-flow boundary', async () => {
    const stream = mockStream();
    const taskCallId = 'call_hybrid_reasoning_boundary_task';
    const reasoningId = 'prt_hybrid_reasoning_boundary';
    const mainCallId = 'call_hybrid_reasoning_boundary_main';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: reasoningId } },
      { type: 'part.delta', partId: reasoningId, delta: 'root r1', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_hybrid_reasoning_boundary_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child work', prompt: 'read', subagent_type: 'explore' },
            title: 'child work',
          },
        },
      },
      { type: 'part.delta', partId: reasoningId, delta: 'root r2', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_hybrid_reasoning_boundary_main',
          callId: mainCallId,
          state: {
            status: 'running',
            input: { filePath: '/tmp/main.ts' },
            title: 'main.ts',
          },
        },
      },
    ] satisfies ShorthandEvent[]);

    await runBridge(bridge, events, stream, mockToken(), { schedulingMode: 'continuous' });

    const r2Index = stream.thinkingProgress.mock.calls
      .findIndex((call: unknown[]) => (call[0] as { text?: string }).text === 'root r2');
    const taskPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'task' && part.toolCallId === taskCallId;
      });
    const mainPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'read' && part.toolCallId === mainCallId;
      });

    expect(r2Index).toBeGreaterThanOrEqual(0);
    expect(taskPushIndex).toBeGreaterThanOrEqual(0);
    expect(mainPushIndex).toBeGreaterThanOrEqual(0);
    expect(stream.thinkingProgress.mock.invocationCallOrder[r2Index])
      .toBeLessThan(stream.push.mock.invocationCallOrder[taskPushIndex]);
    expect(stream.push.mock.invocationCallOrder[taskPushIndex])
      .toBeLessThan(stream.push.mock.invocationCallOrder[mainPushIndex]);
  });

  it('keeps consecutive markdown together and inserts subagent tools before the next main-flow kind', async () => {
    const stream = mockStream();
    const taskCallId = 'call_hybrid_markdown_boundary_task';
    const textId = 'prt_hybrid_markdown_boundary';
    const mainCallId = 'call_hybrid_markdown_boundary_main';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: textId } },
      { type: 'part.delta', partId: textId, delta: 'Preparing search', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_hybrid_markdown_boundary_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child work', prompt: 'read', subagent_type: 'explore' },
            title: 'child work',
          },
        },
      },
      { type: 'part.delta', partId: textId, delta: '\n\n:', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_hybrid_markdown_boundary_main',
          callId: mainCallId,
          state: {
            status: 'running',
            input: { filePath: '/tmp/main.ts' },
            title: 'main.ts',
          },
        },
      },
    ] satisfies ShorthandEvent[]);

    await runBridge(bridge, events, stream, mockToken(), { schedulingMode: 'continuous' });

    const colonIndex = stream.markdown.mock.calls
      .findIndex((call: unknown[]) => call[0] === '\n\n:');
    const taskPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'task' && part.toolCallId === taskCallId;
      });
    const mainPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'read' && part.toolCallId === mainCallId;
      });

    expect(colonIndex).toBeGreaterThanOrEqual(0);
    expect(taskPushIndex).toBeGreaterThanOrEqual(0);
    expect(mainPushIndex).toBeGreaterThanOrEqual(0);
    expect(stream.markdown.mock.invocationCallOrder[colonIndex])
      .toBeLessThan(stream.push.mock.invocationCallOrder[taskPushIndex]);
    expect(stream.push.mock.invocationCallOrder[taskPushIndex])
      .toBeLessThan(stream.push.mock.invocationCallOrder[mainPushIndex]);
  });

  it('tool-first scheduling renders root tools immediately and delays reasoning while a subagent is active', async () => {
    const stream = mockStream();
    const taskCallId = 'call_tool_first_task';
    const reasoningId = 'prt_tool_first_reasoning';
    const readCallId = 'call_tool_first_read';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'inspect', messageId: 'msg_u1', id: 'prt_u1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_tool_first_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child work', prompt: 'inspect', subagent_type: 'explore' },
            title: 'child work',
          },
        },
      },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: reasoningId } },
      { type: 'part.delta', partId: reasoningId, delta: 'root thought', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_tool_first_read',
          callId: readCallId,
          state: {
            status: 'running',
            input: { filePath: '/tmp/main.ts' },
            title: 'main.ts',
          },
        },
      },
      { type: 'part.updated', part: { type: 'reasoning', text: 'root thought', messageId: 'msg_a1', id: reasoningId } },
    ] satisfies ShorthandEvent[]);

    await runBridge(bridge, events, stream, mockToken(), { schedulingMode: 'tool-first' });

    const readPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'read' && part.toolCallId === readCallId;
      });
    const reasoningIndex = stream.thinkingProgress.mock.calls
      .findIndex((call: unknown[]) => (call[0] as { text?: string }).text === 'root thought');

    expect(readPushIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(stream.push.mock.invocationCallOrder[readPushIndex])
      .toBeLessThan(stream.thinkingProgress.mock.invocationCallOrder[reasoningIndex]);
  });

  it('default tool-first scheduling streams reasoning immediately until a subagent is active', async () => {
    const stream = mockStream();
    const reasoningId = 'prt_default_tool_first_reasoning';
    const readCallId = 'call_default_tool_first_read';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'inspect', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: reasoningId } },
      { type: 'part.delta', partId: reasoningId, delta: 'root thought', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_default_tool_first_read',
          callId: readCallId,
          state: {
            status: 'running',
            input: { filePath: '/tmp/main.ts' },
            title: 'main.ts',
          },
        },
      },
      { type: 'part.updated', part: { type: 'reasoning', text: 'root thought', messageId: 'msg_a1', id: reasoningId } },
    ] satisfies ShorthandEvent[]);

    await runBridge(bridge, events, stream, mockToken());

    const readPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'read' && part.toolCallId === readCallId;
      });
    const reasoningIndex = stream.thinkingProgress.mock.calls
      .findIndex((call: unknown[]) => (call[0] as { text?: string }).text === 'root thought');

    expect(readPushIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(stream.thinkingProgress.mock.invocationCallOrder[reasoningIndex])
      .toBeLessThan(stream.push.mock.invocationCallOrder[readPushIndex]);
  });

  it('flushes queued subagent tools before main session idle handling', async () => {
    const stream = mockStream();
    const taskCallId = 'call_hybrid_idle_task';
    const textId = 'prt_hybrid_idle_text';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: textId } },
      { type: 'part.delta', partId: textId, delta: 'Working', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_hybrid_idle_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child work', prompt: 'read', subagent_type: 'explore' },
            title: 'child work',
          },
        },
      },
      idleEvent(),
    ] satisfies ShorthandEvent[]);

    await runBridge(bridge, events, stream, mockToken());

    const taskPushIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string };
        return part.toolName === 'task' && part.toolCallId === taskCallId;
      });
    expect(taskPushIndex).toBeGreaterThanOrEqual(0);
  });

  it('flushes every queued subagent tool when deferred main idle resolves', async () => {
    const stream = mockStream();
    const taskCallId = 'call_hybrid_deferred_idle_task';
    const childSessionId = 'ses_hybrid_deferred_idle_child';
    const childReadCallId = 'call_hybrid_deferred_idle_child_read';
    const textId = 'prt_hybrid_deferred_idle_text';
    let releaseStream!: () => void;
    let childIdleHandled!: () => void;
    const waitForRelease = new Promise<void>((resolve) => { releaseStream = resolve; });
    const afterChildIdleHandled = new Promise<void>((resolve) => { childIdleHandled = resolve; });

    const eventsBeforeChildIdle = [
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: textId } },
      { type: 'part.delta', partId: textId, delta: 'Working', field: 'text' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_hybrid_deferred_idle_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child work', prompt: 'read', subagent_type: 'explore' },
            title: 'child work',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      idleEvent(),
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_hybrid_deferred_idle_child_read',
          callId: childReadCallId,
          state: {
            status: 'pending',
            input: { filePath: '/tmp/child.ts' },
            title: 'child.ts',
          },
        },
      },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_hybrid_deferred_idle_child_read',
          callId: childReadCallId,
          state: {
            status: 'running',
            input: { filePath: '/tmp/child.ts' },
            title: 'child.ts',
          },
        },
      },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_hybrid_deferred_idle_child_read',
          callId: childReadCallId,
          state: {
            status: 'completed',
            input: { filePath: '/tmp/child.ts' },
            output: 'child file',
            title: 'child.ts',
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_hybrid_deferred_idle_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: { description: 'child work', prompt: 'read', subagent_type: 'explore' },
            output: 'child done',
            title: 'child work',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
    ] satisfies ShorthandEvent[];

    async function* controlledStream(): AsyncIterable<ShorthandEvent> {
      for (const event of eventsBeforeChildIdle) {
        yield event;
      }
      yield idleEventFor(childSessionId);
      childIdleHandled();
      await waitForRelease;
    }

    const runPromise = runBridge(bridge, { stream: controlledStream() }, stream, mockToken());
    await afterChildIdleHandled;

    const childBeginIndex = stream.beginToolInvocation.mock.calls
      .findIndex((call: unknown[]) => call[0] === childReadCallId && call[1] === 'read');
    const childReadPushes = stream.push.mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean })
      .filter(part => part.toolName === 'read' && part.toolCallId === childReadCallId);
    const finalTaskIndex = stream.push.mock.calls
      .findIndex((call: unknown[]) => {
        const part = call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean };
        return part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true;
      });

    expect(childBeginIndex).toBeGreaterThanOrEqual(0);
    expect(childReadPushes.length).toBeGreaterThanOrEqual(2);
    expect(finalTaskIndex).toBeGreaterThanOrEqual(0);

    releaseStream();
    const result = await runPromise;
    expect(result.completed).toBe(true);
  });

  it('returns an incomplete result when deferred idle times out', async () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const taskCallId = 'call_deferred_idle_timeout_task';
    const childSessionId = 'ses_deferred_idle_timeout_child';
    const pipelineType = OpenCodePipeline as unknown as {
      DEFERRED_IDLE_TIMEOUT_MS: number;
    };
    const previousTimeout = pipelineType.DEFERRED_IDLE_TIMEOUT_MS;
    pipelineType.DEFERRED_IDLE_TIMEOUT_MS = 25;

    let releasePendingRead!: () => void;
    const pendingRead = new Promise<void>(resolve => { releasePendingRead = resolve; });
    async function* controlledStream(): AsyncIterable<ShorthandEvent> {
      yield { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_timeout_u1' } };
      yield {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_timeout_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'never finishes' },
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      };
      yield idleEvent();
      await pendingRead;
    }

    try {
      const runPromise = runBridge(
        bridge,
        { stream: controlledStream() },
        stream,
        mockToken(),
      );
      await vi.advanceTimersByTimeAsync(25);
      const result = await runPromise;
      expect(result.completed).toBe(false);
      releasePendingRead();
    } finally {
      releasePendingRead();
      pipelineType.DEFERRED_IDLE_TIMEOUT_MS = previousTimeout;
      vi.useRealTimers();
    }
  });

  it('uses the last child assistant markdown text as the subagent result', async () => {
    const stream = mockStream();
    const taskCallId = 'call_child_text_result_scope';
    const childSessionId = 'ses_child_text_result_scope';
    const childTextId = 'prt_child_text_result_scope';
    const childReasoningId = 'prt_child_late_reasoning_scope';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_text_result_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'child text result', prompt: 'answer', subagent_type: 'explore' },
            title: 'child text result',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      { type: 'session.created', sessionId: childSessionId, parentId: 'test-session', title: 'child text result' },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: { type: 'text', text: '', messageId: 'child_assistant', id: childTextId },
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childTextId, delta: 'final markdown answer', field: 'text' },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: { type: 'reasoning', text: '', messageId: 'child_assistant', id: childReasoningId },
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childReasoningId, delta: 'late private reasoning', field: 'text' },
      idleEventFor(childSessionId),
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_text_result_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: { description: 'child text result', prompt: 'answer', subagent_type: 'explore' },
            output: 'fallback task output',
            title: 'child text result',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).not.toHaveBeenCalledWith('final markdown answer');
    expect(stream.thinkingProgress).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'late private reasoning' }));

    const subagentPart = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        toolCallId?: string;
        isComplete?: boolean;
        toolSpecificData?: { result?: string };
      })
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);
    expect(subagentPart?.toolSpecificData?.result).toBe('final markdown answer');
  });

  it('buffers child session deltas until their child text part is routed to SubSSS', async () => {
    const stream = mockStream();
    const taskCallId = 'call_child_delta_task';
    const childSessionId = 'ses_child_delta';
    const childTextId = 'prt_child_delta_text';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_delta_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: {
              description: 'Inspect SSP types',
              prompt: 'Read src/ssp/types.ts',
              subagent_type: 'explore',
            },
            title: 'Inspect SSP types',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      {
        type: 'session.created',
        sessionId: childSessionId,
        parentId: 'test-session',
        title: 'Inspect SSP types (@explore subagent)',
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childTextId, delta: 'child ', field: 'text' },
      { type: 'part.delta', sessionId: childSessionId, partId: childTextId, delta: 'answer', field: 'text' },
      {
        type: 'part.updated',
        part: { type: 'text', text: 'child answer', messageId: 'child_assistant', id: childTextId, sessionId: childSessionId },
      },
      idleEventFor(childSessionId),
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_child_delta_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: {
              description: 'Inspect SSP types',
              prompt: 'Read src/ssp/types.ts',
              subagent_type: 'explore',
            },
            output: '<task_result>child answer</task_result>',
            title: 'Inspect SSP types',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).not.toHaveBeenCalledWith('child ');
    expect(stream.markdown).not.toHaveBeenCalledWith('answer');
    expect(stream.markdown).not.toHaveBeenCalledWith('child answer');

    const subagentPart = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        toolCallId?: string;
        isComplete?: boolean;
        toolSpecificData?: { agentName?: string; description?: string; prompt?: string; result?: string };
      })
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);

    expect(subagentPart?.toolSpecificData).toEqual(expect.objectContaining({
      agentName: 'explore',
      description: 'Inspect SSP types',
      prompt: 'Read src/ssp/types.ts',
      result: 'child answer',
    }));
  });

  it('routes child part.updated events by event-level sessionId when the part lacks sessionId', async () => {
    const stream = mockStream();
    const taskCallId = 'call_event_session_task';
    const childSessionId = 'ses_event_session_child';
    const childTextId = 'prt_event_session_text';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_event_session_task',
          callId: taskCallId,
          state: {
            status: 'running',
            input: { description: 'event session', prompt: 'answer in child', subagent_type: 'explore' },
            title: 'event session',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      { type: 'session.created', sessionId: childSessionId, parentId: 'test-session', title: 'event session child' },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: { type: 'text', text: '', messageId: 'child_assistant', id: childTextId },
      },
      { type: 'part.delta', sessionId: childSessionId, partId: childTextId, delta: 'child only', field: 'text' },
      {
        type: 'part.updated',
        sessionId: childSessionId,
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_event_session_read',
          callId: 'call_event_session_read',
          state: {
            status: 'completed',
            input: { filePath: '/child.ts' },
            output: 'content',
            title: 'child.ts',
          },
        },
      },
      idleEventFor(childSessionId),
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_event_session_task',
          callId: taskCallId,
          state: {
            status: 'completed',
            input: { description: 'event session', prompt: 'answer in child', subagent_type: 'explore' },
            output: '<task_result>child only</task_result>',
            title: 'event session',
            metadata: { parentSessionId: 'test-session', sessionId: childSessionId },
          },
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    expect(stream.markdown).not.toHaveBeenCalledWith('child only');
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as {
        toolName?: string;
        toolCallId?: string;
        subAgentInvocationId?: string;
        isComplete?: boolean;
        toolSpecificData?: { result?: string };
      });
    const childReadPart = pushed
      .find(part => part.toolName === 'read' && part.toolCallId === 'call_event_session_read');
    const subagentPart = pushed
      .find(part => part.toolName === 'task' && part.toolCallId === taskCallId && part.isComplete === true);

    expect(childReadPart?.subAgentInvocationId).toBe(taskCallId);
    expect(subagentPart?.toolSpecificData?.result).toBe('child only');
  });

  it('mock vscode full chain persists child session flow through bridge, SSS, SubSSS, and SSP', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-full-chain-'));
    const childFilePath = path.join(tmpDir, 'child.txt');
    await fs.writeFile(childFilePath, 'before\n', 'utf-8');

    try {
      const permissions = { reply: vi.fn(async () => ({ data: true, error: undefined })) };
      const stream = mockStream();
      answerPermission(stream, 'once');
      stream.externalEdit = vi.fn(async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
        await callback();
        await fs.writeFile(childFilePath, 'after\n', 'utf-8');
        return 'undo-child-full-chain';
      });

      const sss = new SerializableSessionStream(stream as any, {
        workspaceRoot: tmpDir,
        backendName: 'test',
        sessionId: 'test-session',
        turnIndex: 0,
        requestId: 'req-full-chain',
      });
      await sss.initialize();
      sss.push(new UserPromptSSP({
        text: 'spawn child and edit file',
        partId: 'user-full-chain',
      }));

      const fullBridge = new OpenCodePipeline(
        mockBackend({ permissions }),
        { sessionId: 'ses_root_full_chain', directory: tmpDir, stream: sss },
      );

      const childSessionId = 'ses_child_full_chain';
      const taskCallId = 'call_task_full_chain';
      const writeCallId = 'call_child_write_full_chain';
      const childReasoningId = 'prt_child_reasoning_full_chain';
      const childTextId = 'prt_child_text_full_chain';

      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: 'spawn child', messageId: 'msg_u1', id: 'prt_u1' } },
        { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_child_full_chain_task',
            callId: taskCallId,
            state: { status: 'pending', input: { description: 'child full chain' } },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_child_full_chain_task',
            callId: taskCallId,
            state: {
              status: 'completed',
              input: { description: 'child full chain' },
              output: 'child spawned',
              title: 'child full chain',
              metadata: { sessionId: childSessionId },
            },
          },
        },
        { type: 'session.updated', sessionId: childSessionId, title: 'Child Full Chain' },
        {
          type: 'session.diff',
          sessionId: childSessionId,
          diffs: [{
            file: childFilePath,
            patch: '@@ -1 +1 @@\n-before\n+after\n',
            additions: 1,
            deletions: 1,
            status: 'modified' as const,
          }],
        },
        { type: 'session.status', sessionId: childSessionId, status: { type: 'busy' } },
        {
          type: 'part.updated',
          part: { type: 'text', text: 'child user echo', messageId: 'child_user', id: 'prt_child_user', sessionId: childSessionId },
        },
        {
          type: 'part.updated',
          part: { type: 'step-start', messageId: 'child_assistant', id: 'prt_child_step', sessionId: childSessionId },
        },
        {
          type: 'part.updated',
          part: { type: 'reasoning', text: '', messageId: 'child_assistant', id: childReasoningId, sessionId: childSessionId },
        },
        { type: 'part.delta', sessionId: childSessionId, partId: childReasoningId, delta: 'child thought', field: 'text' },
        {
          type: 'part.updated',
          part: { type: 'text', text: '', messageId: 'child_assistant', id: childTextId, sessionId: childSessionId },
        },
        { type: 'part.delta', sessionId: childSessionId, partId: childTextId, delta: 'child answer', field: 'text' },
        permissionAskedEvent({
          sessionId: childSessionId,
          permissionId: 'perm_child_full_chain_write',
          metadata: { filepath: 'child.txt' },
          tool: { messageId: 'msg_child_tool', callId: writeCallId },
        }),
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_child_write_full_chain',
            callId: writeCallId,
            sessionId: childSessionId,
            state: { status: 'pending', input: { filePath: 'child.txt' } },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_child_write_full_chain',
            callId: writeCallId,
            sessionId: childSessionId,
            state: {
              status: 'completed',
              input: { filePath: 'child.txt' },
              output: 'ok',
              title: 'child.txt',
            },
          },
        },
        idleEventFor(childSessionId),
        idleEvent(),
      ] satisfies ShorthandEvent[]);

      await fullBridge.run(rawStream(events.stream), mockToken());
      await sss.flush();
      await sss.drain();
      sss.close();
      await sss.flush();

      expect(stream.markdown).not.toHaveBeenCalledWith('child user echo');
      expect(stream.thinkingProgress).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'child thought' }));
      expect(stream.markdown).not.toHaveBeenCalledWith('child answer');
      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect(permissions.reply).toHaveBeenCalledWith(childSessionId, 'perm_child_full_chain_write', 'once', tmpDir);

      const sessionDir = getTestSessionDir(tmpDir);
      const rootRecords = await readAllStreamParts(path.join(sessionDir, 'session.jsonl'));
      expect(rootRecords.some(record => record.kind === 'userPrompt')).toBe(true);
      expect(rootRecords.some(record =>
        record.kind === 'toolInvocation' &&
        (record.payload as { callId?: string }).callId === taskCallId,
      )).toBe(true);

      const subsessions = await readSubsessionRecords(sessionDir);
      expect(subsessions).toHaveLength(1);
      const sub = subsessions[0];
      const rawSubRecords = await readAllStreamParts(sub.filePath);

      expect(rawSubRecords.map(record => record.kind)).toEqual(expect.arrayContaining([
        'reasoning',
        'assistantText',
        'externalEdit',
      ]));
      expect(rawSubRecords.some(record =>
        record.kind === 'reasoning' &&
        (record.payload as { text?: string }).text === 'child thought',
      )).toBe(true);
      expect(rawSubRecords.some(record =>
        record.kind === 'assistantText' &&
        (record.payload as { text?: string }).text === 'child answer',
      )).toBe(true);
      expect(rawSubRecords.every(record => record.meta.subAgentInvocationId === sub.subAgentInvocationId)).toBe(true);
      expect(rawSubRecords[0]?.meta.sequence).toBe(0);
      expect(rootRecords[0]?.meta.sequence).toBe(0);
      expect(sub.records.some(record =>
        record.kind === 'toolInvocation' &&
        (record.payload as { callId?: string }).callId === writeCallId,
      )).toBe(false);

      const childSessionMeta = sub.metaIndex.get('session');
      expect(childSessionMeta?.title).toBe('Child Full Chain');
      expect(childSessionMeta?.changeSummary).toEqual({ files: 1 });
      expect(childSessionMeta?.status).toEqual({ type: 'busy' });
      expect(sub.metaIndex.get(writeCallId)?.undoStopId).toBe('undo-child-full-chain');

      const rootMeta = await readMetaIndex(path.join(sessionDir, 'meta.jsonl'));
      expect(rootMeta.get('session')?.title).not.toBe('Child Full Chain');
      expect(rootMeta.get(writeCallId)).toBeUndefined();

      const rootSnapshots = await readAllSnapshots(path.join(sessionDir, 'session.jsonl'));
      expect(rootSnapshots).toEqual([]);

      const snapshots = await readAllSnapshots(sub.filePath);
      expect(snapshots).toEqual(expect.arrayContaining([
        expect.objectContaining({
          toolCallId: writeCallId,
          phase: 'before',
          content: 'before\n',
          missing: false,
        }),
        expect.objectContaining({
          toolCallId: writeCallId,
          phase: 'after',
          content: 'after\n',
          undoStopId: 'undo-child-full-chain',
          missing: false,
        }),
      ]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('routes parallel subagent session events by explicit sessionId', async () => {
    const stream = mockStream();
    const firstCallId = 'call_parallel_a';
    const secondCallId = 'call_parallel_b';
    const firstSessionId = 'ses_parallel_a';
    const secondSessionId = 'ses_parallel_b';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'parallel', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parallel_a',
          callId: firstCallId,
          state: { status: 'pending', input: {} },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parallel_b',
          callId: secondCallId,
          state: { status: 'pending', input: {} },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parallel_a',
          callId: firstCallId,
          state: {
            status: 'completed',
            input: { description: 'first' },
            output: 'first done',
            title: 'first',
            metadata: { sessionId: firstSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_parallel_b',
          callId: secondCallId,
          state: {
            status: 'completed',
            input: { description: 'second' },
            output: 'second done',
            title: 'second',
            metadata: { sessionId: secondSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_parallel_read_b',
          callId: 'call_parallel_read_b',
          sessionId: secondSessionId,
          state: {
            status: 'completed',
            input: { filePath: '/b.ts' },
            output: 'b',
            title: 'b.ts',
          },
        },
      },
      idleEventFor(firstSessionId),
      idleEventFor(secondSessionId),
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; subAgentInvocationId?: string });
    const firstScopeId = pushed
      .find(part => part.toolName === 'task' && part.toolCallId === firstCallId)
      ?.toolCallId;
    const secondScopeId = pushed
      .find(part => part.toolName === 'task' && part.toolCallId === secondCallId)
      ?.toolCallId;
    const secondReadPart = pushed
      .find(part => part.toolName === 'read' && part.toolCallId === 'call_parallel_read_b');

    expect(firstScopeId).toBeDefined();
    expect(secondScopeId).toBeDefined();
    expect(secondScopeId).not.toBe(firstScopeId);
    expect(secondReadPart?.subAgentInvocationId).toBe(secondScopeId);
  });

  it('buffers real child session events until parent task metadata binds the matching scope', async () => {
    const stream = mockStream();
    const firstCallId = 'call_real_parallel_a';
    const secondCallId = 'call_real_parallel_b';
    const firstSessionId = 'ses_real_parallel_a';
    const secondSessionId = 'ses_real_parallel_b';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'parallel real flow', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_real_parallel_a',
          callId: firstCallId,
          state: {
            status: 'running',
            input: { description: 'first', prompt: 'read a', subagent_type: 'explore' },
            title: 'first',
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_real_parallel_b',
          callId: secondCallId,
          state: {
            status: 'running',
            input: { description: 'second', prompt: 'read b', subagent_type: 'explore' },
            title: 'second',
          },
        },
      },
      { type: 'session.created', sessionId: secondSessionId, parentId: 'test-session', title: 'second child' },
      { type: 'session.created', sessionId: firstSessionId, parentId: 'test-session', title: 'first child' },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_real_parallel_read_b',
          callId: 'call_real_parallel_read_b',
          sessionId: secondSessionId,
          state: {
            status: 'completed',
            input: { filePath: '/b.ts' },
            output: 'b',
            title: 'b.ts',
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_real_parallel_b',
          callId: secondCallId,
          state: {
            status: 'running',
            input: { description: 'second', prompt: 'read b', subagent_type: 'explore' },
            title: 'second',
            metadata: { parentSessionId: 'test-session', sessionId: secondSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_real_parallel_a',
          callId: firstCallId,
          state: {
            status: 'running',
            input: { description: 'first', prompt: 'read a', subagent_type: 'explore' },
            title: 'first',
            metadata: { parentSessionId: 'test-session', sessionId: firstSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'read',
          id: 'prt_real_parallel_read_a',
          callId: 'call_real_parallel_read_a',
          sessionId: firstSessionId,
          state: {
            status: 'completed',
            input: { filePath: '/a.ts' },
            output: 'a',
            title: 'a.ts',
          },
        },
      },
      idleEventFor(firstSessionId),
      idleEventFor(secondSessionId),
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_real_parallel_a',
          callId: firstCallId,
          state: {
            status: 'completed',
            input: { description: 'first', prompt: 'read a', subagent_type: 'explore' },
            output: 'first done',
            title: 'first',
            metadata: { parentSessionId: 'test-session', sessionId: firstSessionId },
          },
        },
      },
      {
        type: 'part.updated',
        part: {
          type: 'tool',
          toolName: 'task',
          id: 'prt_real_parallel_b',
          callId: secondCallId,
          state: {
            status: 'completed',
            input: { description: 'second', prompt: 'read b', subagent_type: 'explore' },
            output: 'second done',
            title: 'second',
            metadata: { parentSessionId: 'test-session', sessionId: secondSessionId },
          },
        },
      },
      idleEvent(),
    ]);

    await runBridge(bridge, events, stream, mockToken());

    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; subAgentInvocationId?: string });
    const firstTaskPart = pushed.find(part => part.toolName === 'task' && part.toolCallId === firstCallId);
    const secondTaskPart = pushed.find(part => part.toolName === 'task' && part.toolCallId === secondCallId);
    const firstReadPart = pushed.find(part => part.toolName === 'read' && part.toolCallId === 'call_real_parallel_read_a');
    const secondReadPart = pushed.find(part => part.toolName === 'read' && part.toolCallId === 'call_real_parallel_read_b');

    expect(firstTaskPart?.subAgentInvocationId).toBeUndefined();
    expect(secondTaskPart?.subAgentInvocationId).toBeUndefined();
    expect(firstReadPart?.subAgentInvocationId).toBe(firstCallId);
    expect(secondReadPart?.subAgentInvocationId).toBe(secondCallId);
  });

  it('should not filter events when no subagent is active', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callId: 'call_rd', input: { filePath: '/f.txt' }, output: 'hello', title: 'f.txt' }),
    }));
    await runBridge(bridge,events, stream, mockToken());

    // Read tool should be pushed normally
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const readPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string };
      return p?.toolName === 'read';
    });
    expect(readPart).toBeDefined();
  });

  it('should clean up subagent scope on task error', async () => {
    const stream = mockStream();
    const taskId = 'prt_task_err';
    const taskCallId = 'call_err';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'go', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'pending', input: {} } } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'running', input: { description: 'fail task' } } } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'error', input: { description: 'fail task' }, error: 'timeout' } } },
      idleEvent(),
    ]);
    await runBridge(bridge,events, stream, mockToken());

    // After error, scope should be cleaned — subsequent tools should not be filtered
    // Just verify no crash and error part was pushed
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const errorPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; isComplete?: boolean };
      return p?.toolName === 'task' && p?.isComplete === true;
    });
    expect(errorPart).toBeDefined();
  });

  it('should NOT stop on session.idle while subagent is active', async () => {
    const stream = mockStream();
    const taskId = 'prt_task_idle';
    const taskCallId = 'call_idle_test';
    const childSessionId = 'ses_child_idle';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'go', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      // Task: pending
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'pending', input: {} } } },
      // Task: running → opens subagent scope
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'running', input: { description: 'slow task' } } } },
      // session.idle arrives WHILE subagent is active → should NOT stop
      idleEvent(),
      // Subagent still produces events after idle
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: 'prt_sub_r1', callId: 'call_sub_r1', state: { status: 'completed', input: { filePath: '/a.ts' }, output: 'content' } } },
      // Task: completed → scope kept open, childSessionId set
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'completed', input: { description: 'slow task' }, output: 'done', title: 'slow-task', metadata: { sessionId: childSessionId } } } },
      // Child session idle → triggers final subagent card push
      idleEventFor(childSessionId),
      // Final idle (no active subagents) → should stop
      idleEvent(),
    ]);
    const result = await runBridge(bridge,events, stream, mockToken());

    // Bridge should complete successfully (not cancel)
    expect(result.completed).toBe(true);

    // Task completed part should have been pushed (via child session.idle)
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const taskPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean };
      return p?.toolName === 'task' && p?.isComplete === true;
    });
    expect(taskPart).toBeDefined();
  });

  // --- Tool: other → SimpleToolResultData fallback ---

  it('should push unknown tool as ChatSimpleToolResultData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'custom', callId: 'call_cu', input: { x: 1 }, output: 'ok' }),
    }));
    await runBridge(bridge,events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(
      'call_cu',
      'custom',
      expect.objectContaining({ isAttachedToThinking: true }),
    );
  });

  // --- Reasoning ---

  it('should stream reasoning via thinkingProgress', async () => {
    const stream = mockStream();
    const pid = 'prt_reason2';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: pid } },
      { type: 'part.delta', partId: pid, delta: 'hmm...', field: 'text' },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('Yes'),
      idleEvent(),
    ]);
    await runBridge(bridge,events, stream, mockToken());
    expect(stream.thinkingProgress).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hmm...' }),
    );
    expect(stream.markdown).toHaveBeenCalledWith('Yes');
  });

  it('should reuse thinking id for consecutive reasoning parts', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: 'prt_r1' } },
      { type: 'part.delta', partId: 'prt_r1', delta: 'first', field: 'text' },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: 'prt_r2' } },
      { type: 'part.delta', partId: 'prt_r2', delta: ' second', field: 'text' },
      idleEvent(),
    ]);

    await runBridge(bridge,events, stream, mockToken());

    const thinkingCalls = stream.thinkingProgress.mock.calls
      .map((call: unknown[]) => call[0] as { text: string; id?: string })
      .filter(call => call.text);
    const first = thinkingCalls.find(call => call.text === 'first');
    const second = thinkingCalls.find(call => call.text === ' second');
    expect(first?.id).toBeDefined();
    expect(second?.id).toBe(first?.id);
    expect(first?.id).not.toBe('prt_r1');
  });

  it('should start a new thinking id after assistant text activates', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: 'prt_r1' } },
      { type: 'part.delta', partId: 'prt_r1', delta: 'first', field: 'text' },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_t1' } },
      { type: 'part.delta', partId: 'prt_t1', delta: 'answer', field: 'text' },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a2', id: 'prt_r2' } },
      { type: 'part.delta', partId: 'prt_r2', delta: 'second', field: 'text' },
      idleEvent(),
    ]);

    await runBridge(bridge,events, stream, mockToken());

    const thinkingCalls = stream.thinkingProgress.mock.calls
      .map((call: unknown[]) => call[0] as { text: string; id?: string })
      .filter(call => call.text);
    const first = thinkingCalls.find(call => call.text === 'first');
    const second = thinkingCalls.find(call => call.text === 'second');
    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
    expect(stream.markdown).toHaveBeenCalledWith('answer');
  });

  it('should skip thinkingProgress if fallback (no proposed API)', async () => {
    const stream = mockStream({ withProposed: false });
    const pid = 'prt_reason3';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: pid } },
      { type: 'part.delta', partId: pid, delta: 'hmm fallback', field: 'text' },
      idleEvent(),
    ]);
    await runBridge(bridge,events, stream, mockToken());
    // Fallback stream doesn't have thinkingProgress
    expect((stream as any).thinkingProgress).toBeUndefined();
  });

  // --- Session idle with scope ---

  it('should stop on session.idle matching target session', async () => {
    const stream = mockStream();
    const scopedBridge = (sss: SerializableSessionStream) => new OpenCodePipeline(
      mockBackend(), { sessionId: 'ses_a', stream: sss },
    );
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('Yes'),
      idleEventFor('ses_a'),
      deltaEvent('IGNORED', 'prt_ai1'),
    ]);
    await runBridge(scopedBridge,events, stream, mockToken());
    expect(stream.markdown).toHaveBeenCalledWith('Yes');
    expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
  });

  it('should ignore session.idle from a different session when target session is set', async () => {
    const stream = mockStream();
    const scopedBridge = (sss: SerializableSessionStream) => new OpenCodePipeline(
      mockBackend(), { sessionId: 'ses_target', stream: sss },
    );
    const events = eventStream([
      {
        type: 'part.updated',
        part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1', sessionId: 'ses_target' },
      },
      deltaEvent('Hello', 'prt_ai1'),
      idleEventFor('ses_other'),
      deltaEvent(' world', 'prt_ai1'),
      idleEventFor('ses_target'),
      deltaEvent('IGNORED', 'prt_ai1'),
    ]);

    await runBridge(scopedBridge,events, stream, mockToken());

    expect(stream.markdown).toHaveBeenCalledWith('Hello');
    expect(stream.markdown).toHaveBeenCalledWith(' world');
    expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
  });

  // --- Cancellation ---

  it('should return false when cancelled', async () => {
    const stream = mockStream();
    const r = await runBridge(bridge,eventStream(fullTurnEvents({})), stream, mockToken(true));
    expect(r.completed).toBe(false);
  });

  it('should return true when completed normally', async () => {
    const stream = mockStream();
    const r = await runBridge(bridge,eventStream(fullTurnEvents({})), stream, mockToken());
    expect(r.completed).toBe(true);
  });

  // --- Reset ---

  it('should reset state between bridge calls', async () => {
    const s1 = mockStream();
    await runBridge(bridge,eventStream(fullTurnEvents({ tools: toolEvents({ toolName: 'read', callId: 'call_a', output: 'a' }) })), s1, mockToken());
    const s2 = mockStream();
    await runBridge(bridge,eventStream(fullTurnEvents({ tools: toolEvents({ toolName: 'read', callId: 'call_b', output: 'b' }) })), s2, mockToken());
    // read tool uses hiddenAfterComplete and returns undefined for toolSpecificData
    const s2Pushed = (s2.push as ReturnType<typeof vi.fn>).mock.calls;
    const readPart = s2Pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean };
      return p?.toolName === 'read' && p?.toolCallId === 'call_b' && p?.isComplete === true;
    });
    expect(readPart).toBeDefined();
    expect(String((readPart![0] as { invocationMessage?: string | { toString(): string } }).invocationMessage)).toMatch(/Running read/);
  });

  // --- Edge cases ---

  it('should handle empty delta', async () => {
    const stream = mockStream();
    await runBridge(bridge,eventStream([deltaEvent('', 'x'), idleEvent()]), stream, mockToken());
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('should handle unknown partId delta', async () => {
    const stream = mockStream();
    await runBridge(bridge,eventStream([deltaEvent('x', 'prt_unknown'), idleEvent()]), stream, mockToken());
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('should handle tool without callId (uses part.id)', async () => {
    const stream = mockStream();
    const pid = 'prt_tool001';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: pid, state: { status: 'pending', input: {} } } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: pid, state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'ok' } } },
      idleEvent(),
    ]);
    await runBridge(bridge,events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(
      pid,
      'read',
      expect.objectContaining({ isAttachedToThinking: true }),
    );
  });

  // -----------------------------------------------------------------------
  // Permission.asked lifecycle — external edit tracking + auto-reply
  // -----------------------------------------------------------------------
  type ShorthandPermissionAsked = Extract<ShorthandEvent, { type: 'permission.asked' }>;

  function permissionAskedEvent(
    overrides?: Partial<ShorthandPermissionAsked>,
  ): ShorthandPermissionAsked {
    return {
      type: 'permission.asked',
      permissionId: 'perm_42',
      sessionId: 'ses_target',
      permission: 'edit',
      patterns: ['src/**/*.ts'],
      metadata: { filepath: '/workspace/src/app.ts' },
      always: [],
      tool: { messageId: 'msg_tool1', callId: 'call_edit_001' },
      ...overrides,
    };
  }

  describe('permission.asked lifecycle', () => {
    let mockPermissions: { reply: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockPermissions = { reply: vi.fn(async () => ({ data: true, error: undefined })) };
    });

    function permissionBridge(directory?: string, questions?: { reply: ReturnType<typeof vi.fn>; reject?: ReturnType<typeof vi.fn> }) {
      return (sss: SerializableSessionStream) => new OpenCodePipeline(
        mockBackend({ permissions: mockPermissions, questions }),
        { sessionId: 'ses_target', directory, stream: sss },
      );
    }

    function firstExternalEditTarget(stream: MockStream): vscode.Uri[] {
      return (stream.externalEdit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as vscode.Uri[];
    }

    it('starts ExternalEditSSP with callId and filepath when both are present', async () => {
      const stream = mockStream();
      answerPermission(stream, 'once');
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect(firstExternalEditTarget(stream)[0].toString()).toBe('file:///workspace/src/app.ts');
      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
    });

    it('normalizes Windows file URI paths to lowercase without dropping the slash after the drive', async () => {
      const stream = mockStream();
      const events = eventStream([
        permissionAskedEvent({ metadata: { filepath: 'D:\\Temp\\sisyphus-greeting.txt' } }),
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      const uris = firstExternalEditTarget(stream);
      expect(uris[0].path).toBe('/d:/temp/sisyphus-greeting.txt');
      expect(uris[0].toString()).toBe('file:///d:/temp/sisyphus-greeting.txt');
    });

    it('resolves relative edit paths against the workspace before starting externalEdit', async () => {
      const stream = mockStream();
      const events = eventStream([
        permissionAskedEvent({ metadata: { filepath: 'Hello-Sisyphus.txt' } }),
        idleEvent(),
      ]);

      await runBridge(permissionBridge('D:\\Temp'), events, stream, mockToken());

      const uris = firstExternalEditTarget(stream);
      expect(uris[0].path).toBe('/d:/temp/hello-sisyphus.txt');
      expect(uris[0].toString()).toBe('file:///d:/temp/hello-sisyphus.txt');
    });

    it('does not start externalEdit when callId is missing', async () => {
      const stream = mockStream();
      answerPermission(stream, 'once');
      const events = eventStream([
        permissionAskedEvent({ tool: undefined }),
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.externalEdit).not.toHaveBeenCalled();
      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
    });

    it('does not start externalEdit when filepath is missing', async () => {
      const stream = mockStream();
      answerPermission(stream, 'once');
      const events = eventStream([
        permissionAskedEvent({ metadata: {} }),
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.externalEdit).not.toHaveBeenCalled();
      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
    });

    it('automatically allows permission requests in full-edit mode without rendering approval UI', async () => {
      const stream = mockStream();
      const sss = new SerializableSessionStream(stream as any, {
        workspaceRoot: '',
        backendName: 'test',
        sessionId: 'test-session',
        turnIndex: 0,
        requestId: 'test-request',
      });
      const pipeline = new OpenCodePipeline(
        mockBackend({ permissions: mockPermissions }),
        { sessionId: 'ses_target', stream: sss, permissionMode: 'full-edit' },
      );

      await pipeline.run(
        rawStream(eventStream([permissionAskedEvent(), idleEvent()]).stream),
        mockToken(),
      );
      await sss.flush();

      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect((stream as MockStream & { questionCarousel?: ReturnType<typeof vi.fn> }).questionCarousel).toBeUndefined();
    });

    it('automatically allows permissions for a non-interactive native LM turn', async () => {
      const stream = mockStream();
      const sss = new SerializableSessionStream(stream as any, {
        workspaceRoot: '',
        backendName: 'test',
        sessionId: 'test-session',
        turnIndex: 0,
        requestId: 'test-request',
      });
      const pipeline = new OpenCodePipeline(
        mockBackend({ permissions: mockPermissions }),
        {
          sessionId: 'ses_target',
          stream: sss,
          // Native LanguageModelChat has no permission carousel. The approval
          // setting must not leave the backend permission request unresolved.
          permissionMode: 'approval',
          allowUserInteraction: false,
        },
      );

      await pipeline.run(
        rawStream(eventStream([permissionAskedEvent({ tool: undefined }), idleEvent()]).stream),
        mockToken(),
      );
      await sss.flush();

      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
      expect((stream as MockStream & { questionCarousel?: ReturnType<typeof vi.fn> }).questionCarousel).toBeUndefined();
    });

    it('keeps the ExternalEdit baseline barrier for non-interactive file edits', async () => {
      const stream = mockStream();
      let captureBaseline: (() => PromiseLike<unknown>) | undefined;
      stream.externalEdit = vi.fn(async (_target, callback) => {
        captureBaseline = callback;
        return 'undo-stop';
      });
      const sss = new SerializableSessionStream(stream as any, {
        workspaceRoot: '',
        backendName: 'test',
        sessionId: 'test-session',
        turnIndex: 0,
        requestId: 'test-request',
      });
      const pipeline = new OpenCodePipeline(
        mockBackend({ permissions: mockPermissions }),
        {
          sessionId: 'ses_target',
          stream: sss,
          permissionMode: 'approval',
          allowUserInteraction: false,
        },
      );

      const runPromise = pipeline.run(
        rawStream(eventStream([permissionAskedEvent(), idleEvent()]).stream),
        mockToken(),
      );
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await sss.flush();
      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect(mockPermissions.reply).not.toHaveBeenCalled();

      expect(captureBaseline).toBeDefined();
      void captureBaseline!();
      await expect(runPromise).resolves.toMatchObject({ completed: true });
      await sss.flush();
      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
    });

    it('automatically allows non-mutating permission requests in read-only mode', async () => {
      const stream = mockStream();
      const sss = new SerializableSessionStream(stream as any, {
        workspaceRoot: '',
        backendName: 'test',
        sessionId: 'test-session',
        turnIndex: 0,
        requestId: 'test-request',
      });
      const pipeline = new OpenCodePipeline(
        mockBackend({ permissions: mockPermissions }),
        { sessionId: 'ses_target', stream: sss, permissionMode: 'read-only' },
      );

      await pipeline.run(
        rawStream(eventStream([permissionAskedEvent({ permission: 'read' }), idleEvent()]).stream),
        mockToken(),
      );
      await sss.flush();

      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'once', undefined);
      expect(stream.externalEdit).not.toHaveBeenCalled();
      expect((stream as MockStream & { questionCarousel?: ReturnType<typeof vi.fn> }).questionCarousel).toBeUndefined();
    });

    it('rejects permission when the user selects Reject', async () => {
      const stream = mockStream();
      answerPermission(stream, 'reject');

      await runBridge(
        permissionBridge(),
        eventStream([permissionAskedEvent({ tool: undefined }), idleEvent()]),
        stream,
        mockToken(),
      );

      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'reject', undefined);
    });

    it('rejects permission when the user skips the prompt', async () => {
      const stream = mockStream();
      (stream as MockStream & {
        questionCarousel: ReturnType<typeof vi.fn>;
      }).questionCarousel = vi.fn(async () => undefined);

      await runBridge(
        permissionBridge(),
        eventStream([permissionAskedEvent({ tool: undefined }), idleEvent()]),
        stream,
        mockToken(),
      );

      expect(mockPermissions.reply).toHaveBeenCalledWith('ses_target', 'perm_42', 'reject', undefined);
    });

    it('bridge loop continues processing subsequent events after permission.asked', async () => {
      const stream = mockStream();
      const events = eventStream([
        permissionAskedEvent(),
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        { type: 'part.delta', partId: 'prt_ai1', delta: 'Edit applied', field: 'text' },
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect(mockPermissions.reply).toHaveBeenCalledTimes(1);
      expect(stream.markdown).toHaveBeenCalledWith('Edit applied');
    });

    it('answers question.asked through QuestionSSP callbacks', async () => {
      const stream = {
        ...mockStream(),
        questionCarousel: vi.fn(async () => ({ q_0: 'Yes' })),
      } as any;
      const questions = { reply: vi.fn(async () => ({ data: true })), reject: vi.fn(async () => ({ data: true })) };
      const questionEvent = {
        type: 'question.asked',
        questionId: 'question-1',
        sessionId: 'ses_target',
        questions: [
          {
            question: 'Continue?',
            header: 'Continue',
            options: [],
          },
        ],
      } as ShorthandEvent;

      await runBridge(permissionBridge(undefined, questions), eventStream([questionEvent, idleEvent()]), stream, mockToken());

      expect(questions.reply).toHaveBeenCalledWith('ses_target', 'question-1', [['Yes']], undefined);
    });

    it('session.idle stops the bridge after permission.asked flow', async () => {
      const stream = mockStream();
      const events = eventStream([
        permissionAskedEvent(),
        { type: 'part.delta', partId: 'prt_ai1', delta: 'BEFORE', field: 'text' },
        idleEvent(),
        { type: 'part.delta', partId: 'prt_ai1', delta: 'AFTER_IDLE', field: 'text' },
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.markdown).not.toHaveBeenCalledWith('AFTER_IDLE');
    });

    it('tool completion completes ExternalEditSSP and hides the normal edit card', async () => {
      const stream = mockStream();
      const callId = 'call_edit_001';
      const partId = 'prt_edit_tool';
      const events = eventStream([
        permissionAskedEvent({ tool: { messageId: 'msg_t1', callId } }),
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'edit',
            id: partId,
            callId,
            state: { status: 'pending', input: {} },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'edit',
            id: partId,
            callId,
            state: { status: 'completed', input: { filePath: '/src/app.ts' }, output: 'ok' },
          },
        },
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect(stream.beginToolInvocation).not.toHaveBeenCalledWith(callId, 'edit');
      const editParts = (stream.push as ReturnType<typeof vi.fn>).mock.calls
        .map((call: unknown[]) => call[0] as { toolName?: string; toolCallId?: string; presentation?: string; isComplete?: boolean })
        .filter((p) => p?.toolName === 'edit' && p?.toolCallId === callId);
      expect(editParts.filter((p) => p.isComplete === true && p.presentation !== 'hidden')).toHaveLength(0);
    });

    it('defers write tool SSP until permission.asked, then uses ExternalEditSSP (no orphaned tool card)', async () => {
      const stream = mockStream();
      const callId = 'call_edit_late_permission';
      const partId = 'prt_edit_tool';
      const events = eventStream([
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: partId,
            callId,
            state: { status: 'pending', input: {} },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: partId,
            callId,
            state: { status: 'running', input: { filePath: '/workspace/src/app.ts' }, title: 'app.ts' },
          },
        },
        permissionAskedEvent({ tool: { messageId: 'msg_t1', callId } }),
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: partId,
            callId,
            state: { status: 'completed', input: { filePath: '/workspace/src/app.ts' }, output: 'ok' },
          },
        },
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      // No ToolInvocationSSP should be pushed for write tools with external edit
      const writeParts = (stream.push as ReturnType<typeof vi.fn>).mock.calls
        .map((call: unknown[]) => call[0] as {
          toolName?: string;
          toolCallId?: string;
        })
        .filter((p) => p?.toolName === 'write' && p?.toolCallId === callId);
      expect(writeParts).toHaveLength(0);
    });

    it('completes child-session ExternalEditSSP when a child write tool completes', async () => {
      const stream = mockStream();
      answerPermission(stream, 'once');
      const taskCallId = 'call_child_edit_task';
      const childSessionId = 'ses_child_edit';
      const writeCallId = 'call_child_write';
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: 'edit in child', messageId: 'msg_u1', id: 'prt_u1' } },
        { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_child_edit_task',
            callId: taskCallId,
            state: {
              status: 'completed',
              input: { description: 'child edit' },
              output: 'spawned',
              title: 'child',
              metadata: { sessionId: childSessionId },
            },
          },
        },
        permissionAskedEvent({
          sessionId: childSessionId,
          permissionId: 'perm_child_write',
          metadata: { filepath: '/workspace/src/child.ts' },
          tool: { messageId: 'msg_child_tool', callId: writeCallId },
        }),
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_child_write',
            callId: writeCallId,
            sessionId: childSessionId,
            state: { status: 'pending', input: { filePath: '/workspace/src/child.ts' } },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_child_write',
            callId: writeCallId,
            sessionId: childSessionId,
            state: { status: 'completed', input: { filePath: '/workspace/src/child.ts' }, output: 'ok' },
          },
        },
        idleEventFor(childSessionId),
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      expect(stream.externalEdit).toHaveBeenCalledTimes(1);
      expect(mockPermissions.reply).toHaveBeenCalledWith(childSessionId, 'perm_child_write', 'once', undefined);
      const writeParts = (stream.push as ReturnType<typeof vi.fn>).mock.calls
        .map((call: unknown[]) => call[0] as {
          toolName?: string;
          toolCallId?: string;
          isComplete?: boolean;
          presentation?: string;
        })
        .filter((p) => p?.toolName === 'write' && p?.toolCallId === writeCallId);
      expect(writeParts.filter((p) => p.isComplete === true && p.presentation !== 'hidden')).toHaveLength(0);
    });

    it('keeps child external edit state from hiding a root tool with the same callId', async () => {
      const stream = mockStream();
      const taskCallId = 'call_child_shared_task';
      const childSessionId = 'ses_child_shared_edit';
      const sharedWriteCallId = 'call_shared_write';
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: 'edit root and child', messageId: 'msg_u1', id: 'prt_u1' } },
        { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'task',
            id: 'prt_child_shared_task',
            callId: taskCallId,
            state: {
              status: 'completed',
              input: { description: 'child edit' },
              output: 'spawned',
              title: 'child',
              metadata: { sessionId: childSessionId },
            },
          },
        },
        permissionAskedEvent({
          sessionId: childSessionId,
          permissionId: 'perm_child_shared_write',
          metadata: { filepath: '/workspace/src/child.ts' },
          tool: { messageId: 'msg_child_tool', callId: sharedWriteCallId },
        }),
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_root_write',
            callId: sharedWriteCallId,
            state: { status: 'pending', input: { filePath: '/workspace/src/root.ts' } },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_root_write',
            callId: sharedWriteCallId,
            state: { status: 'completed', input: { filePath: '/workspace/src/root.ts' }, output: 'root ok' },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_child_write_shared',
            callId: sharedWriteCallId,
            sessionId: childSessionId,
            state: { status: 'pending', input: { filePath: '/workspace/src/child.ts' } },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'write',
            id: 'prt_child_write_shared',
            callId: sharedWriteCallId,
            sessionId: childSessionId,
            state: { status: 'completed', input: { filePath: '/workspace/src/child.ts' }, output: 'child ok' },
          },
        },
        idleEventFor(childSessionId),
        idleEvent(),
      ]);

      await runBridge(permissionBridge(), events, stream, mockToken());

      const writeParts = (stream.push as ReturnType<typeof vi.fn>).mock.calls
        .map((call: unknown[]) => call[0] as {
          toolName?: string;
          toolCallId?: string;
          subAgentInvocationId?: string;
          isComplete?: boolean;
          presentation?: string;
        })
        .filter((p) => p?.toolName === 'write' && p?.toolCallId === sharedWriteCallId && p?.isComplete === true);
      const rootWrite = writeParts.find(part => !part.subAgentInvocationId);
      const childWrite = writeParts.find(part => !!part.subAgentInvocationId);

      expect(rootWrite).toBeDefined();
      expect(rootWrite?.presentation).not.toBe('hidden');
      expect(childWrite?.presentation).not.toBe('hidden');
    });

    it('does not push session.diff as MultiDiffPart', async () => {
      const stream = mockStream();
      const permBridge = permissionBridge();
      const events = eventStream([
        {
          type: 'session.diff',
          sessionId: 'ses_target',
          diffs: [
            {
              file: '/workspace/src/app.ts',
              patch: '...',
              additions: 10,
              deletions: 0,
              status: 'modified' as const,
            },
          ],
        },
        idleEvent(),
      ]);

      await runBridge(permBridge,events, stream, mockToken());

      const diffParts = (stream.push as ReturnType<typeof vi.fn>).mock.calls
        .map((call: unknown[]) => call[0] as { title?: string; value?: unknown[] })
        .filter((p) => p?.title === 'File Changes');
      expect(diffParts).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Backend event coverage
  // -----------------------------------------------------------------------

  describe('backend event coverage', () => {
    // --- session.diff gracefully handled (no MultiDiffPart in test mock) ---

    it('should gracefully handle session.diff without MultiDiffPart', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        deltaEvent('Hello'),
        {
          type: 'session.diff',
          sessionId: 'ses_test',
          diffs: [
            {
              file: '/src/app.ts',
              patch: '...',
              additions: 5,
              deletions: 2,
              status: 'modified' as const,
            },
          ],
        },
        deltaEvent(' world'),
        idleEvent(),
      ]);
      await runBridge(bridge,events, stream, mockToken());
      // Both deltas rendered (session.diff in between is skipped gracefully)
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).toHaveBeenCalledWith(' world');
    });

    it('should process session.diff with deleted files (filtered out)', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        {
          type: 'session.diff',
          sessionId: 'ses_test',
          diffs: [
            {
              file: '/src/removed.ts',
              patch: '',
              additions: 0,
              deletions: 10,
              status: 'deleted' as const,
            },
          ],
        },
        deltaEvent('Hello'),
        idleEvent(),
      ]);
      await runBridge(bridge,events, stream, mockToken());
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
    });

    // --- permission.replied silently ignored ---

    it('should silently ignore permission.replied', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        deltaEvent('Hello'),
        {
          type: 'permission.replied',
          sessionId: 'ses_test',
          permissionId: 'perm_1',
          response: 'once',
        },
        deltaEvent(' world'),
        idleEvent(),
      ]);
      await runBridge(bridge,events, stream, mockToken());
      // permission.replied should be skipped without rendering or crash
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).toHaveBeenCalledWith(' world');
    });

    // --- Ordering: session.idle stops regardless of event order ---

    it('should stop on session.idle even when permission.asked precedes it', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        deltaEvent('Hello'),
        {
          type: 'permission.asked',
          permissionId: 'perm_1',
          sessionId: 'ses_test',
          permission: 'file:write',
          patterns: [],
          metadata: {},
          always: [],
        },
        idleEvent(),
        deltaEvent('IGNORED_AFTER_IDLE'),
      ]);
      await runBridge(bridge,events, stream, mockToken());
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED_AFTER_IDLE');
    });

    // --- ACP-derived full turn with combined event types ---

    it('should process an ACP-derived full turn with multiple event types', async () => {
      const stream = mockStream();
      const events = eventStream([
        // User text echo
        { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
        // AIMessage step
        { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
        // Reasoning part
        { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: 'prt_r1' } },
        // Reasoning delta
        { type: 'part.delta', partId: 'prt_r1', delta: 'thinking...', field: 'text' },
        // AI text part
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        // AI text delta
        { type: 'part.delta', partId: 'prt_ai1', delta: 'Hello world', field: 'text' },
        // Tool part (pending → completed)
        { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: 'prt_t1', callId: 'call_1', state: { status: 'pending', input: {} } } },
        { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: 'prt_t1', callId: 'call_1', state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'file content' } } },
        // Step finish
        { type: 'part.updated', part: { type: 'step-finish', messageId: 'msg_a1', id: 'prt_f1' } },
        // Session done
        idleEvent(),
        // This should be ignored
        { type: 'part.delta', partId: 'prt_ai1', delta: 'IGNORED', field: 'text' },
      ]);
      await runBridge(bridge,events, stream, mockToken());
      // Verify the full turn rendered correctly
      expect(stream.thinkingProgress).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'thinking...' }),
      );
      expect(stream.markdown).toHaveBeenCalledWith('Hello world');
      expect(stream.beginToolInvocation).toHaveBeenCalledWith(
        'call_1',
        'read',
        expect.objectContaining({ isAttachedToThinking: true }),
      );
      expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
    });
  });
});
