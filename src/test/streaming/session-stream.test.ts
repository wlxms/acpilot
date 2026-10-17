/**
 * Tests for SerializableSessionStream (v2: push/update API).
 *
 * Uses temporary directories to isolate each test case.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SerializableSessionStream } from '../../backend/streaming/session-stream';
import { materializeRecords, finalizeIncompleteStates } from '../../backend/streaming/deserialize';
import { readAllStreamParts, readMetaIndex, createSSPFromRecord } from '../../backend/streaming/deserialize';
import { readSubsessionRecords } from '../../backend/streaming/deserialize';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { UserPromptSSP } from '../../ssp/impl/user-prompt';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import type {
  IMetadataProvider,
  SerializableToolState,
  StreamPartRecord,
  SspStream,
} from '../../ssp/types';
import { SerializableStreamPart } from '../../ssp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockStream() {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
    thinkingProgress: vi.fn(),
    beginToolInvocation: vi.fn(),
    updateToolInvocation: vi.fn(),
  };
}

function makeSSS(tmpDir: string, overrides?: { turnIndex?: number }) {
  return new SerializableSessionStream(mockStream() as any, {
    workspaceRoot: tmpDir,
    backendName: 'test-backend',
    sessionId: 'test-session',
    turnIndex: overrides?.turnIndex ?? 0,
    requestId: 'req-0',
  });
}

function toolState(overrides?: Partial<SerializableToolState>): SerializableToolState {
  return { status: 'pending', input: {}, ...overrides };
}

function getSessionDir(tmpDir: string): string {
  return path.join(tmpDir, '.acpilot', 'test-backend', 'test-session');
}

class MetadataTestSSP
  extends SerializableStreamPart<'opaqueEvent', { event: unknown }>
  implements IMetadataProvider {
  readonly kind = 'opaqueEvent' as const;
  constructor(id: string, private readonly metadata: Record<string, unknown>) {
    super({ event: { test: true } }, undefined, id);
  }
  get metaId(): string { return this.id; }
  getMetadata(): Record<string, unknown> | undefined { return this.metadata; }
  render(_stream: SspStream): void {}
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim() !== '');
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// SerializableSessionStream
// ---------------------------------------------------------------------------

describe('SerializableSessionStream', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── initialize ─────────────────────────────────────────────────────────

  it('creates session directory on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-init-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    const stat = await fs.stat(getSessionDir(tmpDir));
    expect(stat.isDirectory()).toBe(true);
  });

  it('writes version + turn-start to session.jsonl on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-ver-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0]);
    expect(first.t).toBe('version');
    const second = JSON.parse(lines[1]);
    expect(second.t).toBe('turn-start');
  });

  it('writes initial session meta to meta.jsonl on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-meta-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'meta.jsonl'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(lines[0]);
    expect(meta.type).toBe('session');
    expect(meta.backendName).toBe('test-backend');
  });

  // ── push ───────────────────────────────────────────────────────────────

  it('push renders to stream and appends to session.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-push-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new ReasoningSSP({ partId: 'r1', delta: 'thinking...' }));
    await sss.flush();

    const parts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe('reasoning');
    expect((parts[0].payload as { text: string }).text).toBe('thinking...');
  });

  it('push user prompt', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-prompt-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new UserPromptSSP({ text: 'hello world', partId: 'u1' }));
    await sss.flush();

    const parts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(parts.some(p => p.kind === 'userPrompt')).toBe(true);
  });

  it('immediate scheduling renders every scheduled part as it arrives', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-schedule-immediate-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
      schedulingMode: 'immediate',
    });
    await sss.initialize();

    sss.push(new AssistantTextSSP({ partId: 'm1', delta: 'markdown' }));
    sss.push(new ToolInvocationSSP({
      partId: 'task-1', toolName: 'task', callId: 'task-1',
      state: toolState({ status: 'running', input: { description: 'child' } }),
      subAgentId: 'task-1',
    }));

    const markdownOrder = stream.markdown.mock.invocationCallOrder[0];
    const toolOrder = stream.push.mock.invocationCallOrder[0];
    expect(markdownOrder).toBeLessThan(toolOrder);
  });

  it('continuous scheduling keeps root markdown continuous before queued subagent tools', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-schedule-continuous-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
      schedulingMode: 'continuous',
    });
    await sss.initialize();

    sss.push(new AssistantTextSSP({ partId: 'm1', delta: 'one' }));
    sss.push(new ToolInvocationSSP({
      partId: 'task-1', toolName: 'task', callId: 'task-1',
      state: toolState({ status: 'running', input: { description: 'child' } }),
      subAgentId: 'task-1',
    }));
    sss.push(new AssistantTextSSP({ partId: 'm1', delta: ' two' }));
    sss.push(new ToolInvocationSSP({
      partId: 'read-1', toolName: 'read', callId: 'read-1',
      state: toolState({ status: 'running', input: { filePath: '/tmp/a.ts' } }),
    }));

    const secondMarkdownOrder = stream.markdown.mock.invocationCallOrder[1];
    const taskOrder = stream.push.mock.invocationCallOrder.find((_: number, index: number) => {
      const part = stream.push.mock.calls[index][0] as { toolCallId?: string };
      return part.toolCallId === 'task-1';
    });
    const readOrder = stream.push.mock.invocationCallOrder.find((_: number, index: number) => {
      const part = stream.push.mock.calls[index][0] as { toolCallId?: string };
      return part.toolCallId === 'read-1';
    });

    expect(secondMarkdownOrder).toBeLessThan(taskOrder!);
    expect(taskOrder).toBeLessThan(readOrder!);
  });

  it('tool-first scheduling renders append parts immediately while no subagent is active', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-schedule-tool-first-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
      schedulingMode: 'tool-first',
    });
    await sss.initialize();

    sss.push(new ReasoningSSP({ partId: 'r1', delta: 'thinking' }));
    sss.push(new ToolInvocationSSP({
      partId: 'read-1', toolName: 'read', callId: 'read-1',
      state: toolState({ status: 'completed', input: { filePath: '/tmp/a.ts' } }),
    }));

    expect(stream.push).toHaveBeenCalledTimes(1);
    expect(stream.thinkingProgress).toHaveBeenCalledWith(expect.objectContaining({ text: 'thinking' }));
    expect(stream.thinkingProgress.mock.invocationCallOrder[0])
      .toBeLessThan(stream.push.mock.invocationCallOrder[0]);
  });

  it('tool-first scheduling delays append parts only while a subagent is active', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-schedule-tool-first-active-subagent-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
      schedulingMode: 'tool-first',
    });
    await sss.initialize();

    sss.push(new ToolInvocationSSP({
      partId: 'task-1', toolName: 'task', callId: 'task-1',
      state: toolState({ status: 'running', input: { description: 'child' } }),
      subAgentId: 'task-1',
    }));
    sss.push(new ReasoningSSP({ partId: 'r1', delta: 'thinking' }));

    expect(stream.push).toHaveBeenCalledTimes(1);
    expect(stream.thinkingProgress).not.toHaveBeenCalled();

    sss.push(new ReasoningSSP({ partId: 'r1', delta: '', isComplete: true }));

    expect(stream.thinkingProgress).toHaveBeenCalledWith(expect.objectContaining({ text: 'thinking' }));
    expect(stream.push.mock.invocationCallOrder[0])
      .toBeLessThan(stream.thinkingProgress.mock.invocationCallOrder[0]);
  });

  it('tool-first scheduling returns to immediate after the active subagent completes', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-schedule-tool-first-subagent-complete-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
      schedulingMode: 'tool-first',
    });
    await sss.initialize();

    const task = new ToolInvocationSSP({
      partId: 'task-1', toolName: 'task', callId: 'task-1',
      state: toolState({ status: 'running', input: { description: 'child' } }),
      subAgentId: 'task-1',
    });
    sss.push(task);
    sss.update(task.id, { state: toolState({ status: 'completed', input: {}, output: 'done' }) });
    sss.push(new ReasoningSSP({ partId: 'r-after', delta: 'after' }));

    const completedTaskOrder = stream.push.mock.invocationCallOrder[1];
    const reasoningOrder = stream.thinkingProgress.mock.invocationCallOrder[0];
    expect(stream.thinkingProgress).toHaveBeenCalledWith(expect.objectContaining({ text: 'after' }));
    expect(completedTaskOrder).toBeLessThan(reasoningOrder);
  });

  it('defaults to tool-first scheduling without delaying append parts before subagents are active', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-schedule-default-tool-first-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
    });
    await sss.initialize();

    sss.push(new ReasoningSSP({ partId: 'r1', delta: 'thinking' }));
    sss.push(new ToolInvocationSSP({
      partId: 'read-1', toolName: 'read', callId: 'read-1',
      state: toolState({ status: 'running', input: { filePath: '/tmp/a.ts' } }),
    }));

    expect(stream.push).toHaveBeenCalledTimes(1);
    expect(stream.thinkingProgress).toHaveBeenCalledWith(expect.objectContaining({ text: 'thinking' }));
    expect(stream.thinkingProgress.mock.invocationCallOrder[0])
      .toBeLessThan(stream.push.mock.invocationCallOrder[0]);
  });

  // ── update ─────────────────────────────────────────────────────────────

  it('update merges mutable part and appends', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-update-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const toolSSP = new ToolInvocationSSP({
      partId: 't1', toolName: 'bash', callId: 'c1',
      state: toolState({ status: 'pending', input: {} }),
    });
    sss.push(toolSSP);
    sss.update(toolSSP.id, { state: toolState({ status: 'completed', output: 'done' }) });
    await sss.flush();

    const parts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(parts.length).toBe(2); // push + update = 2 lines
    expect((parts[0].payload as { state: { status: string } }).state.status).toBe('pending');
    expect((parts[1].payload as { state: { status: string } }).state.status).toBe('completed');
  });

  // ── writeMeta ──────────────────────────────────────────────────────────

  it('writeMeta appends to meta.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-wm-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.writeMeta({ title: 'New Title', status: 'completed' });
    await sss.flush();

    const metaIndex = await readMetaIndex(path.join(getSessionDir(tmpDir), 'meta.jsonl'));
    const session = metaIndex.get('session');
    expect(session?.title).toBe('New Title');
    expect(session?.status).toBe('completed');
  });

  it('records first prompt and persists title updates through SSS', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-title-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.recordFirstPrompt('  how to implement oauth middleware  ');
    sss.recordFirstPrompt('ignored second prompt');
    const persisted = sss.updateTitle('  OAuth Middleware  ', 'copilot-style');
    await sss.flush();

    expect(sss.getFirstPrompt()).toBe('how to implement oauth middleware');
    expect(persisted).toBe('OAuth Middleware');

    const metaIndex = await readMetaIndex(path.join(getSessionDir(tmpDir), 'meta.jsonl'));
    const session = metaIndex.get('session');
    expect(session?.title).toBe('OAuth Middleware');
    expect(session?.titleSource).toBe('copilot-style');
    expect(session?.provisionalTitle).toBe(false);
    expect(typeof session?.titleUpdatedAt).toBe('string');
  });

  it('notifies when title changes', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-title-cb-'));
    const onTitleChanged = vi.fn();
    const sss = new SerializableSessionStream(mockStream() as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
      onTitleChanged,
    });
    await sss.initialize();

    sss.updateTitle('OAuth Middleware', 'copilot-style');
    sss.updateTitle('OAuth Middleware', 'copilot-style');
    sss.updateTitle('Backend OAuth Middleware', 'backend');
    await sss.flush();

    expect(onTitleChanged).toHaveBeenCalledTimes(2);
    expect(onTitleChanged).toHaveBeenNthCalledWith(1, {
      sessionId: 'test-session',
      title: 'OAuth Middleware',
      source: 'copilot-style',
      provisional: false,
    });
    expect(onTitleChanged).toHaveBeenNthCalledWith(2, {
      sessionId: 'test-session',
      title: 'Backend OAuth Middleware',
      source: 'backend',
      provisional: false,
    });
  });

  // ── close ──────────────────────────────────────────────────────────────

  it('close writes turn-end to session.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-close-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    sss.close();
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.t).toBe('turn-end');
  });

  // ── subsession ─────────────────────────────────────────────────────────

  it('subsession creates SubsessionStream that writes to separate file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-sub-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const sub = sss.subsession('sub-invocation-1');
    sub.push(new ToolInvocationSSP({
      partId: 'child-1', toolName: 'read', callId: 'child-c1',
      state: toolState({ status: 'completed', input: {}, output: 'content' }),
      subAgentInvocationId: 'sub-invocation-1',
    }));
    await sub.flush();

    const subPath = path.join(getSessionDir(tmpDir), 'subsessions', 'sub-invocation-1', 'subsession.jsonl');
    const parts = await readAllStreamParts(subPath);
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe('toolInvocation');
  });

  it('subsession writes part metadata to its own meta.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-sub-meta-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const sub = sss.subsession('sub-with-meta');
    sub.push(new MetadataTestSSP('meta-part-1', { undoStopId: 'undo-sub-1' }));
    await sss.drain();

    const sessionDir = getSessionDir(tmpDir);
    const subMetaPath = path.join(sessionDir, 'subsessions', 'sub-with-meta', 'meta.jsonl');
    const metaIndex = await readMetaIndex(subMetaPath);
    expect(metaIndex.get('meta-part-1')?.undoStopId).toBe('undo-sub-1');

    const subsessions = await readSubsessionRecords(sessionDir);
    const restored = subsessions.find(subsession => subsession.subAgentInvocationId === 'sub-with-meta');
    expect(restored?.metaIndex.get('meta-part-1')?.undoStopId).toBe('undo-sub-1');
  });

  it('subsession persists reasoning and assistant text without rendering them into the root stream', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-sub-text-'));
    const stream = mockStream();
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
    });
    await sss.initialize();

    const sub = sss.subsession('sub-text');
    sub.push(new ReasoningSSP({ partId: 'child-reasoning', delta: 'child thought' }));
    sub.push(new AssistantTextSSP({ partId: 'child-text', delta: 'child answer' }));
    await sss.drain();

    expect(stream.thinkingProgress).not.toHaveBeenCalled();
    expect(stream.markdown).not.toHaveBeenCalled();

    const subPath = path.join(getSessionDir(tmpDir), 'subsessions', 'sub-text', 'subsession.jsonl');
    const parts = await readAllStreamParts(subPath);
    expect(parts.map(part => part.kind)).toEqual(['reasoning', 'assistantText']);
    expect(parts.map(part => (part.payload as { text?: string }).text)).toEqual(['child thought', 'child answer']);
    expect(parts.every(part => part.meta.subAgentInvocationId === 'sub-text')).toBe(true);
  });

  it('drain waits for async ExternalEditSSP metadata in subsessions', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-sub-async-meta-'));
    const stream = {
      ...mockStream(),
      externalEdit: vi.fn(async (_target: unknown, callback: () => PromiseLike<unknown>) => {
        await callback();
        return 'undo-sub-async';
      }),
    };
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
    });
    await sss.initialize();

    const sub = sss.subsession('sub-async-meta');
    const edit = new ExternalEditSSP({
      toolCallId: 'child-edit-call',
      editId: '',
      status: 'pending',
      uri: 'child.txt',
      uris: [{ fsPath: path.join(tmpDir, 'child.txt'), toString: () => 'file:///child.txt' }],
    } as never);

    sub.push(edit);
    sub.update(edit.id, { status: 'completed' });
    await sss.drain();

    const sessionDir = getSessionDir(tmpDir);
    const subMetaPath = path.join(sessionDir, 'subsessions', 'sub-async-meta', 'meta.jsonl');
    const metaIndex = await readMetaIndex(subMetaPath);
    expect(metaIndex.get(edit.id)?.undoStopId).toBe('undo-sub-async');
  });

  // ── snapshot persistence ───────────────────────────────────────────────

  it('persists ExternalEditSSP snapshots to session.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-snap-'));
    const filePath = path.join(tmpDir, 'test.ts');
    await fs.writeFile(filePath, 'file content', 'utf-8');
    const stream = {
      ...mockStream(),
      externalEdit: vi.fn(async (_target: unknown, callback: () => PromiseLike<unknown>) => {
        await callback();
        return 'undo-root-snapshot';
      }),
    };
    const sss = new SerializableSessionStream(stream as any, {
      workspaceRoot: tmpDir,
      backendName: 'test-backend',
      sessionId: 'test-session',
      turnIndex: 0,
      requestId: 'req-0',
    });
    await sss.initialize();

    const edit = new ExternalEditSSP({
      toolCallId: 'tc1',
      editId: '',
      status: 'pending',
      uri: filePath,
      uris: [{ fsPath: filePath, toString: () => 'file:///test.ts' }],
    } as never);
    sss.push(edit);
    sss.update(edit.id, { status: 'completed' });
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    const snapshots = lines
      .map(l => JSON.parse(l))
      .filter(l => l.t === 'snapshot')
      .map(l => l.d);
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: 'tc1', phase: 'before', content: 'file content' }),
      expect.objectContaining({ toolCallId: 'tc1', phase: 'after', undoStopId: 'undo-root-snapshot' }),
    ]));
  });

  // ── drain ──────────────────────────────────────────────────────────────

  it('drain flushes main session and all subsessions', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-drain-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new AssistantTextSSP({ partId: 't1', delta: 'text' }));
    const sub = sss.subsession('sub-1');
    sub.push(new ToolInvocationSSP({
      partId: 'c1', toolName: 'read', callId: 'cc1',
      state: toolState({ status: 'completed' }),
    }));

    await sss.drain();

    const mainParts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    const subParts = await readAllStreamParts(
      path.join(getSessionDir(tmpDir), 'subsessions', 'sub-1', 'subsession.jsonl'),
    );
    expect(mainParts.length).toBeGreaterThanOrEqual(1);
    expect(subParts.length).toBe(1);
  });

  it('nested subsessions persist ancestry metadata and are read recursively', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-nested-sub-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const nested = sss.subsession('sub-parent').subsession('sub-child');
    nested.push(new ToolInvocationSSP({
      partId: 'nested-1',
      toolName: 'read',
      callId: 'nested-c1',
      state: toolState({ status: 'completed', input: {}, output: 'content' }),
    }));

    await sss.drain();

    const sessionDir = getSessionDir(tmpDir);
    const nestedPath = path.join(
      sessionDir,
      'subsessions',
      'sub-parent',
      'subsessions',
      'sub-child',
      'subsession.jsonl',
    );
    const nestedParts = await readAllStreamParts(nestedPath);
    expect(nestedParts).toHaveLength(1);
    expect(nestedParts[0].meta.subAgentInvocationId).toBe('sub-child');
    expect(nestedParts[0].meta.parentSubAgentInvocationId).toBe('sub-parent');
    expect(nestedParts[0].meta.subAgentPath).toEqual(['sub-parent', 'sub-child']);

    const subsessions = await readSubsessionRecords(sessionDir);
    const restored = subsessions.find(sub => sub.subAgentInvocationId === 'sub-child');
    expect(restored?.subAgentPath).toEqual(['sub-parent', 'sub-child']);
    expect(restored?.records[0].meta.subAgentPath).toEqual(['sub-parent', 'sub-child']);
  });

  it('keeps sequence local to root and each subsession stream', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-local-seq-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new AssistantTextSSP({ partId: 'root-text', delta: 'root' }));
    const firstSub = sss.subsession('sub-a');
    firstSub.push(new ToolInvocationSSP({
      partId: 'sub-a-tool',
      toolName: 'read',
      callId: 'shared-call-id',
      state: toolState({ status: 'completed' }),
    }));
    const secondSub = sss.subsession('sub-b');
    secondSub.push(new ToolInvocationSSP({
      partId: 'sub-b-tool',
      toolName: 'read',
      callId: 'shared-call-id',
      state: toolState({ status: 'completed' }),
    }));

    await sss.drain();

    const sessionDir = getSessionDir(tmpDir);
    const rootParts = await readAllStreamParts(path.join(sessionDir, 'session.jsonl'));
    const subAParts = await readAllStreamParts(path.join(sessionDir, 'subsessions', 'sub-a', 'subsession.jsonl'));
    const subBParts = await readAllStreamParts(path.join(sessionDir, 'subsessions', 'sub-b', 'subsession.jsonl'));

    expect(rootParts[0].meta.sequence).toBe(0);
    expect(subAParts[0].meta.sequence).toBe(0);
    expect(subBParts[0].meta.sequence).toBe(0);
    expect(subAParts[0].meta.subAgentPath).toEqual(['sub-a']);
    expect(subBParts[0].meta.subAgentPath).toEqual(['sub-b']);
  });
});

// ---------------------------------------------------------------------------
// materializeRecords
// ---------------------------------------------------------------------------

describe('materializeRecords', () => {
  function rec(id: string, kind: string, payload: Record<string, unknown>): StreamPartRecord {
    return { kind, version: 1, id, payload, meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' } };
  }

  it('merges consecutive append-only records by concatenating text', () => {
    const records = [
      rec('r1', 'reasoning', { partId: 'r1', text: 'Hello' }),
      rec('r1', 'reasoning', { partId: 'r1', text: ' world' }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(1);
    expect((result[0].payload as { text: string }).text).toBe('Hello world');
  });

  it('does NOT merge append-only records interrupted by different id', () => {
    const records = [
      rec('r1', 'reasoning', { partId: 'r1', text: 'A' }),
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'completed' } }),
      rec('r1', 'reasoning', { partId: 'r1', text: 'B' }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(3); // r1, t1, r1 (separate)
  });

  it('globally aggregates mutable records by id even if non-consecutive', () => {
    const records = [
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'pending', input: {} } }),
      rec('r1', 'reasoning', { partId: 'r1', text: 'interrupting' }),
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'completed', output: 'done' } }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(2); // t1 (aggregated) + r1
    const toolRecord = result.find(r => r.kind === 'toolInvocation')!;
    expect((toolRecord.payload as { state: { status: string } }).state.status).toBe('completed');
  });

  it('preserves error as terminal state in tool merge', () => {
    const records = [
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'error', error: 'Failed', input: {} } }),
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'completed', output: 'done', input: {} } }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(1);
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// finalizeIncompleteStates
// ---------------------------------------------------------------------------

describe('finalizeIncompleteStates', () => {
  function rec(kind: string, payload: Record<string, unknown>): StreamPartRecord {
    return { kind, version: 1, id: 'test', payload, meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' } };
  }

  it('marks pending tools as error in completed sessions', () => {
    const records = [rec('toolInvocation', { state: { status: 'pending', input: {} } })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('error');
  });

  it('marks running tools as error in completed sessions', () => {
    const records = [rec('toolInvocation', { state: { status: 'running', input: {} } })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('error');
  });

  it('does NOT touch pending tools in inProgress sessions', () => {
    const records = [rec('toolInvocation', { state: { status: 'pending', input: {} } })];
    const result = finalizeIncompleteStates(records, 'inProgress');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('pending');
  });

  it('does NOT touch completed tools', () => {
    const records = [rec('toolInvocation', { state: { status: 'completed', input: {} } })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('completed');
  });

  it('marks asked questions as skipped in completed sessions', () => {
    const records = [rec('question', { questionId: 'q1', questions: [], status: 'asked' })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { status: string }).status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// createSSPFromRecord
// ---------------------------------------------------------------------------

describe('createSSPFromRecord', () => {
  it('creates AssistantTextSSP from assistantText record', () => {
    const record: StreamPartRecord = {
      kind: 'assistantText', version: 1, id: 'ssp-1',
      payload: { partId: 'a1', text: 'hello' },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const ssp = createSSPFromRecord(record);
    expect(ssp.kind).toBe('assistantText');
    expect((ssp.payload as { text: string }).text).toBe('hello');
  });

  it('restores ReasoningSSP with a persisted thinking id', () => {
    const record: StreamPartRecord = {
      kind: 'reasoning', version: 1, id: 'ssp-reasoning',
      payload: { partId: 'backend-reasoning-1', text: 'thinking', thinkingId: 'thinking-1' },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const stream = mockStream();

    const ssp = createSSPFromRecord(record);
    ssp.render(stream as never);

    expect(ssp.kind).toBe('reasoning');
    expect((ssp.payload as { thinkingId?: string }).thinkingId).toBe('thinking-1');
    expect(stream.thinkingProgress).toHaveBeenCalledWith({ text: 'thinking', id: 'thinking-1' });
  });

  it('restores ReasoningSSP with session and subagent metadata', () => {
    const record: StreamPartRecord = {
      kind: 'reasoning',
      version: 1,
      id: 'ssp-child-reasoning',
      payload: {
        partId: 'backend-child-reasoning',
        text: 'child thinking',
        thinkingId: 'thinking-2',
      },
      meta: {
        turnIndex: 0,
        requestId: '',
        sequence: 0,
        createdAt: '',
        source: 'restore',
        sessionId: 'ses-child',
        parentSessionId: 'ses-parent',
        subAgentInvocationId: 'call-child',
        parentSubAgentInvocationId: 'call-parent',
        subAgentPath: ['call-parent', 'call-child'],
      },
    };
    const stream = mockStream();

    const ssp = createSSPFromRecord(record);
    ssp.render(stream as never);

    expect(stream.thinkingProgress).toHaveBeenCalledWith({
      text: 'child thinking',
      id: 'thinking-2',
      metadata: {
        sessionId: 'ses-child',
        parentSessionId: 'ses-parent',
        subAgentInvocationId: 'call-child',
        parentSubAgentInvocationId: 'call-parent',
        subAgentPath: ['call-parent', 'call-child'],
      },
    });
  });

  it('creates ToolInvocationSSP from toolInvocation record', () => {
    const record: StreamPartRecord = {
      kind: 'toolInvocation', version: 1, id: 'ssp-2',
      payload: { partId: 't1', toolName: 'bash', callId: 'c1', state: { status: 'completed', input: {} } },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const ssp = createSSPFromRecord(record);
    expect(ssp.kind).toBe('toolInvocation');
    expect((ssp.payload as { toolName: string }).toolName).toBe('bash');
  });

  it('creates ExternalEditSSP with undoStopId from meta', () => {
    const record: StreamPartRecord = {
      kind: 'externalEdit', version: 1, id: 'ssp-3',
      payload: { toolCallId: 'c1', editId: '', status: 'completed' },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const metaIndex = new Map([['ssp-3', { undoStopId: 'undo-xxx' }]]);
    const ssp = createSSPFromRecord(record, metaIndex);
    expect(ssp.kind).toBe('externalEdit');
    expect((ssp.payload as { undoStopId?: string }).undoStopId).toBe('undo-xxx');
  });

  it('reads external edit metadata from the current stream node meta index only', () => {
    const rootRecord: StreamPartRecord = {
      kind: 'externalEdit', version: 1, id: 'shared-edit-id',
      payload: { toolCallId: 'root-call', editId: '', status: 'completed' },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const subRecord: StreamPartRecord = {
      kind: 'externalEdit', version: 1, id: 'shared-edit-id',
      payload: { toolCallId: 'sub-call', editId: '', status: 'completed' },
      meta: {
        turnIndex: 0,
        requestId: '',
        sequence: 0,
        createdAt: '',
        source: 'restore',
        subAgentInvocationId: 'sub-a',
        subAgentPath: ['sub-a'],
      },
    };
    const rootMetaIndex = new Map([['shared-edit-id', { undoStopId: 'undo-root' }]]);
    const subMetaIndex = new Map([['shared-edit-id', { undoStopId: 'undo-sub' }]]);

    const rootSsp = createSSPFromRecord(rootRecord, rootMetaIndex);
    const subSsp = createSSPFromRecord(subRecord, subMetaIndex);

    expect((rootSsp.payload as { undoStopId?: string }).undoStopId).toBe('undo-root');
    expect((subSsp.payload as { undoStopId?: string }).undoStopId).toBe('undo-sub');
  });
});
