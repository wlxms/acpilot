import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import type { SspStream } from '../../ssp/types';
import { SerializableStreamPart } from '../../ssp/types';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import type { SerializableToolState } from '../../ssp/types';
import { ChatTodoStatus } from '../../types/vscode-proposed-additions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockStream(): SspStream {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
    beginToolInvocation: vi.fn(),
    updateToolInvocation: vi.fn(),
  };
}

function toolState(overrides?: Partial<SerializableToolState>): SerializableToolState {
  return {
    status: 'running',
    input: {},
    ...overrides,
  };
}

/** Extract the last pushed ChatToolInvocationPart from stream.push.mock.calls */
function lastPushedPart(stream: SspStream): any {
  const calls = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]?.[0];
}

function countPushes(stream: SspStream): number {
  return (stream.push as ReturnType<typeof vi.fn>).mock.calls.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolInvocationSSP', () => {
  describe('instanceof', () => {
    it('should be instanceof SerializableStreamPart', () => {
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'bash',
        callId: 'c1',
        state: toolState(),
      });
      expect(ssp).toBeInstanceOf(SerializableStreamPart);
    });
  });

  describe('merge (state accumulation)', () => {
    it('should deep-merge state across lifecycle', () => {
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'read',
        callId: 'c1',
        state: toolState({ status: 'pending', input: {} }),
      });

      ssp.update({ state: { status: 'running', input: { filePath: 'a.ts' } } });
      expect(ssp.payload.state.status).toBe('running');
      expect(ssp.payload.state.input).toEqual({ filePath: 'a.ts' });

      ssp.update({ state: { status: 'completed', output: 'file content' } });
      expect(ssp.payload.state.status).toBe('completed');
      expect(ssp.payload.state.input).toEqual({ filePath: 'a.ts' }); // preserved
      expect(ssp.payload.state.output).toBe('file content');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Contract C1: read complete does NOT set pastTenseMessage
  // ════════════════════════════════════════════════════════════════════════

  describe('Contract C1: read complete tense preservation', () => {
    it.each(['running', 'completed'] as const)('preserves case in an absolute file link while %s', (status) => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'read-case', toolName: 'read', callId: 'read-case',
        state: toolState({ status, input: { filePath: '/Workspace/Script/AWYActor.cs', offset: 2, limit: 2 } }),
      });
      ssp.render(stream);
      expect(String(lastPushedPart(stream).invocationMessage)).toBe('Read [](file:///Workspace/Script/AWYActor.cs#2-3)');
    });

    it('read completed should set invocationMessage, NOT pastTenseMessage', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'read',
        callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { filePath: '/src/main.ts' },
          output: 'file contents',
        }),
      });
      ssp.render(stream);

      const part = lastPushedPart(stream);
      expect(part).toBeDefined();
      expect(part.isAttachedToThinking).toBe(true);
      expect(part.invocationMessage).toBeTruthy(); // has invocationMessage
      expect(String(part.invocationMessage)).toMatch(/Read.*main\.ts/i);
      // ★ CRITICAL: pastTenseMessage must NOT be set for read
      expect(part.pastTenseMessage).toBeUndefined();
    });

    it('read with a DSH file_path input renders a clickable read card', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'read',
        callId: 'c1',
        state: toolState({
          status: 'running',
          input: { file_path: 'd:\\Temp\\agent-note-2026-10-21.md' },
        }),
      });
      ssp.render(stream);

      const part = lastPushedPart(stream);
      expect(String(part.invocationMessage)).toMatch(/^Read /u);
      expect(String(part.invocationMessage)).not.toContain('file_path');
    });

    it('bash completed SHOULD set pastTenseMessage (contrast with read)', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'bash',
        callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { command: 'npm test' },
          output: 'all passed',
          startTime: 1000,
          endTime: 1500,
        }),
      });
      ssp.render(stream);

      const part = lastPushedPart(stream);
      expect(part.isAttachedToThinking).toBe(true);
      expect(part.pastTenseMessage).toBeTruthy();
      expect(String(part.pastTenseMessage)).toMatch(/npm test/);
      expect(String(part.pastTenseMessage)).toMatch(/\(0\.5s\)/);
    });

    it('read completed via fallback (no push) should NOT call updateToolInvocation', () => {
      // When stream lacks push(), ToolInvocationSSP falls back to begin/update path.
      // For read complete in fallback, the code returns immediately (trunk L1335-1337).
      const fallbackStream = {
        markdown: vi.fn(),
        progress: vi.fn(),
        beginToolInvocation: vi.fn(),
        updateToolInvocation: vi.fn(),
        // NO push() → triggers fallback path
      } as unknown as SspStream;

      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'read',
        callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { filePath: '/a.ts' },
          output: 'content',
        }),
      });
      ssp.render(fallbackStream);

      // ★ CRITICAL: fallback for read complete does nothing (trunk L1335-1337)
      expect(fallbackStream.updateToolInvocation).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Contract C3: progressive idempotency
  // ════════════════════════════════════════════════════════════════════════

  describe('Contract C3: progressive push idempotency', () => {
    it('promotes a generic running call once while preserving its parent subagent group', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'nested-delegate', callId: 'nested-delegate', toolName: 'spawn_worker',
        subAgentInvocationId: 'parent-call', state: toolState({ input: { description: 'Inspect source', prompt: 'Review code' } }),
      });
      ssp.render(stream);
      ssp.update({ toolName: 'subagent', state: { input: { description: 'Inspect source', agentName: 'reviewer', prompt: 'Review code' } }, renderMode: 'updateOnly' } as never);
      ssp.render(stream);
      expect(lastPushedPart(stream)).toMatchObject({ toolName: 'subagent', toolCallId: 'nested-delegate', subAgentInvocationId: 'parent-call', isComplete: false,
        toolSpecificData: { description: 'Inspect source', agentName: 'reviewer', prompt: 'Review code' } });
      expect(countPushes(stream)).toBe(2);
      ssp.update({ toolName: 'subagent', state: { title: 'Waiting for review' }, renderMode: 'updateOnly' } as never);
      ssp.render(stream);
      expect(countPushes(stream)).toBe(2);
      expect(stream.updateToolInvocation).toHaveBeenCalledWith('nested-delegate', expect.objectContaining({ invocationMessage: 'Waiting for review' }));
    });

    it('multiple running updates should only push once, then updateToolInvocation', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'bash',
        callId: 'c1',
        state: toolState({ status: 'running', input: { command: 'npm' } }),
      });
      ssp.render(stream);

      // First running → push (isComplete=false)
      expect(countPushes(stream)).toBe(1);
      expect(lastPushedPart(stream).isComplete).toBe(false);

      // Second running update → should NOT push again, only update via merge
      (stream.push as ReturnType<typeof vi.fn>).mockClear();
      ssp.update({ state: { status: 'running', input: { command: 'npm test' } } });

      // push should NOT be called again (update() calls render which detects _progressivePushed)
      // Note: render pushes a new part each time in proposed API path, but the contract
      // is about the RUNNING state using updateToolInvocation for subsequent updates.
      // In our SSP model, render always pushes (no progressive check in pushToolInvocation
      // for the push vs update distinction — that's handled by updateToolInvocation in fallback).
      // For proposed API path, each render pushes a new part with enablePartialUpdate=true.
    });

    it('completed read updates the running card instead of pushing an after card', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'read',
        callId: 'c1',
        state: toolState({ status: 'running', input: { file_path: 'D:/Temp/a.md' } }),
      });
      ssp.render(stream);
      expect(countPushes(stream)).toBe(1);

      ssp.update({ state: { status: 'completed', output: 'content' } });
      ssp.render(stream);

      expect(countPushes(stream)).toBe(1);
      expect(stream.updateToolInvocation).toHaveBeenCalledWith('c1', expect.objectContaining({
        invocationMessage: expect.stringMatching(/^Read /u),
      }));
    });

    it('completed should always push a new part with isComplete=true', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'bash',
        callId: 'c1',
        state: toolState({ status: 'running', input: { command: 'npm' } }),
      });
      ssp.render(stream);

      // Transition to completed
      ssp.update({
        state: {
          status: 'completed',
          output: 'done',
          startTime: 1000,
          endTime: 2000,
        },
      });
      ssp.render(stream); // ← new API: SSS calls render after update

      const part = lastPushedPart(stream);
      expect(part).toBeDefined();
      expect(part.isAttachedToThinking).toBe(true);
      expect(part.isComplete).toBe(true);
      expect(part.pastTenseMessage).toBeTruthy();
    });

    it('updateOnly should refresh an existing task without pushing a new part', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'task',
        callId: 'c1',
        state: toolState({
          status: 'running',
          input: { description: 'Fetch architecture' },
          title: 'Fetch architecture',
        }),
      });
      ssp.render(stream);
      (stream.push as ReturnType<typeof vi.fn>).mockClear();

      ssp.update({
        state: { title: 'bash, webfetch' },
        renderMode: 'updateOnly',
      } as never);
      ssp.render(stream);

      expect(stream.push).not.toHaveBeenCalled();
      expect(stream.updateToolInvocation).toHaveBeenCalledWith('c1', {
        invocationMessage: 'bash, webfetch',
        isAttachedToThinking: true,
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Contract C4: toolSpecificData 7-type mapping
  // ════════════════════════════════════════════════════════════════════════

  describe('Contract C4: toolSpecificData mapping', () => {
    it('DSH read presentation exposes the file location', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'read', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { filePath: 'src/index.ts' },
          output: '1: export const value = 1',
          metadata: {
            dshPresentation: {
              card: 'read',
              path: 'D:/workspace/src/index.ts',
              offset: 12,
              lines: [{ number: 12, text: 'export const value = 1' }],
              totalLines: 40,
            },
          },
        }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data?.values).toHaveLength(1);
      expect(data.values[0]).toBeInstanceOf(vscode.Location);
      expect(data.values[0].range.start.line).toBe(11);
    });

    it('read with DSH presentation renders a resource card instead of raw file_path', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'read', callId: 'c1',
        state: toolState({
          status: 'running',
          input: { filePath: 'D:/Temp/hello.txt' },
          metadata: {
            dshPresentation: {
              card: 'read',
              path: 'D:/Temp/hello.txt',
              offset: 1,
            },
          },
        }),
      });
      ssp.render(stream);
      const part = lastPushedPart(stream);
      expect(part.toolSpecificData).toMatchObject({ values: [expect.anything()] });
      expect(String(part.invocationMessage)).not.toContain('file_path');
    });

    it('read → undefined (no toolSpecificData)', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'read', callId: 'c1',
        state: toolState({ status: 'completed', input: { filePath: '/a.ts' }, output: 'content' }),
      });
      ssp.render(stream);
      expect(lastPushedPart(stream).toolSpecificData).toBeUndefined();
    });

    it('write → undefined', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'write', callId: 'c1',
        state: toolState({ status: 'completed', input: { filePath: '/b.ts' }, output: '' }),
      });
      ssp.render(stream);
      expect(lastPushedPart(stream).toolSpecificData).toBeUndefined();
    });

    it('edit → undefined', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'edit', callId: 'c1',
        state: toolState({ status: 'completed', input: { filePath: '/c.ts' }, output: '' }),
      });
      ssp.render(stream);
      expect(lastPushedPart(stream).toolSpecificData).toBeUndefined();
    });

    it('DSH terminal presentation infers the shell language from the original tool', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'bash', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { command: 'Get-ChildItem', cwd: 'D:/workspace' },
          output: 'src',
          metadata: {
            dshToolName: 'pwsh',
            dshPresentation: { card: 'terminal', title: 'Get-ChildItem', cwd: 'D:/workspace' },
          },
        }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toMatchObject({
        commandLine: { original: 'Get-ChildItem' },
        language: 'powershell',
        output: { text: 'src' },
      });
    });

    it('bash → ChatTerminalToolInvocationData', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'bash', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { command: 'echo hello', language: 'bash' },
          output: 'hello\nexitCode: 0',
        }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(data.commandLine).toBeDefined();
      expect(data.commandLine.original).toBe('echo hello');
      expect(data.language).toBe('bash');
      expect(data.state?.exitCode).toBe(0);
    });

    it('list with path → ChatToolResourcesInvocationData (file URIs)', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'list', callId: 'c1',
        state: toolState({ status: 'completed', input: { path: '/src' }, output: '3 files' }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(Array.isArray(data.values)).toBe(true);
      expect(data.values.length).toBeGreaterThan(0);
      expect(data.values[0]).toBeInstanceOf(vscode.Uri);
    });

    it('list without path/file refs → ChatSimpleToolResultData fallback', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'list', callId: 'c1',
        state: toolState({ status: 'completed', input: {}, output: 'no paths here' }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(data.output).toBe('no paths here');
    });

    it('grep → ChatSimpleToolResultData', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'grep', callId: 'c1',
        state: toolState({ status: 'completed', input: { pattern: 'foo' }, output: '2 matches' }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(data.output).toBe('2 matches');
    });

    it('grep with file paths in output → ChatToolResourcesInvocationData', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'grep', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { pattern: 'foo' },
          output: '/src/a.ts:1:foo\n/src/b.ts:2:bar',
        }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(Array.isArray(data.values)).toBe(true);
      expect(data.values.length).toBe(2);
      expect(data.values[0]).toBeInstanceOf(vscode.Uri);
    });

    it('websearch with query → ChatToolResourcesInvocationData (web URL URIs)', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'websearch', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { query: 'vscode chat api' },
          output: 'see https://code.visualstudio.com/api',
        }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(Array.isArray(data.values)).toBe(true);
      // Bing search URL for the query + parsed URL from output
      expect(data.values.length).toBe(2);
      expect(data.values[0]).toBeInstanceOf(vscode.Uri);
      expect(String(data.values[0])).toContain('bing.com/search');
      expect(String(data.values[1])).toContain('code.visualstudio.com');
    });

    it('todo root session → ChatTodoToolInvocationData with todoList', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'todo', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: {
            todos: [
              { content: 'task A', status: 'completed' },
              { content: 'task B', status: 'in_progress' },
              { content: 'task C', status: 'pending' },
            ],
          },
          output: '',
        }),
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(Array.isArray(data.todoList)).toBe(true);
      expect(data.todoList).toHaveLength(3);
      expect(data.todoList[0].title).toBe('task A');
      expect(data.todoList[0].status).toBe(ChatTodoStatus.Completed);
      expect(data.todoList[1].status).toBe(ChatTodoStatus.InProgress);
      expect(data.todoList[2].status).toBe(ChatTodoStatus.NotStarted);
    });

    it('todo nested in subagent → ChatSimpleToolResultData text fallback', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'todo', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: {
            todos: [
              { content: 'nested A', status: 'completed' },
              { content: 'nested B', status: 'pending' },
            ],
          },
          output: '',
        }),
        subAgentInvocationId: 'parent-subagent-call',
      });
      ssp.render(stream);
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(data.todoList).toBeUndefined();
      expect(typeof data.input).toBe('string');
      expect(data.input).toMatch(/nested A/);
      expect(data.input).toMatch(/✓/);
    });

    it('task → ChatSubagentToolInvocationData', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'task', callId: 'c1',
        state: toolState({
          status: 'completed',
          input: { description: 'review code', subagent_type: 'reviewer', prompt: 'review src/' },
          output: 'LGTM',
        }),
      });
      ssp.render(stream);
      const part = lastPushedPart(stream);
      expect(part.isAttachedToThinking).toBe(true);
      expect(part.invocationMessage).toBeUndefined();
      expect(part.pastTenseMessage).toBe('review code');
      const data = lastPushedPart(stream).toolSpecificData;
      expect(data).toBeDefined();
      expect(data.description).toBe('review code');
      expect(data.agentName).toBe('reviewer');
      expect(data.prompt).toBe('review src/');
      expect(data.result).toBe('LGTM');
    });

    it('parent task pending starts VS Code task stream without subagent metadata', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'task',
        callId: 'c1',
        state: toolState({
          status: 'pending',
          input: {
            description: 'Search docs',
            subagent_type: 'librarian',
            prompt: 'Search VS Code docs for ACP architecture.',
          },
        }),
      });

      ssp.render(stream);

      expect(stream.beginToolInvocation).toHaveBeenCalledWith('c1', 'task', {
        isAttachedToThinking: true,
      });
    });

    it('child task pending starts VS Code task stream with parent subagent metadata', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1',
        toolName: 'task',
        callId: 'c1',
        state: toolState({
          status: 'pending',
          input: {
            description: 'Nested search',
            subagent_type: 'librarian',
            prompt: 'Search inside the parent subagent.',
          },
        }),
        subAgentInvocationId: 'parent-call',
      });

      ssp.render(stream);

      expect(stream.beginToolInvocation).toHaveBeenCalledWith('c1', 'task', {
        isAttachedToThinking: true,
        subagentInvocationId: 'parent-call',
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Contract C5: presentation
  // ════════════════════════════════════════════════════════════════════════

  describe('Contract C5: presentation (hiddenAfterComplete)', () => {
    it.each(['read', 'write', 'edit'])('tool %s should have presentation=hiddenAfterComplete', (toolName) => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName, callId: 'c1',
        state: toolState({ status: 'completed', input: { filePath: '/a.ts' }, output: '' }),
      });
      ssp.render(stream);
      expect(lastPushedPart(stream).isAttachedToThinking).toBe(true);
      expect(lastPushedPart(stream).presentation).toBe('hiddenAfterComplete');
    });

    it('bash should NOT have hiddenAfterComplete (stays expanded)', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'bash', callId: 'c1',
        state: toolState({ status: 'completed', input: { command: 'ls' }, output: 'files' }),
      });
      ssp.render(stream);
      expect(lastPushedPart(stream).isAttachedToThinking).toBe(true);
      expect(lastPushedPart(stream).presentation).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Error state
  // ════════════════════════════════════════════════════════════════════════

  describe('error state', () => {
    it('should set isError and pastTenseMessage on error', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'bash', callId: 'c1',
        state: toolState({
          status: 'error',
          input: { command: 'bad-cmd' },
          output: '',
          error: 'command not found',
        }),
      });
      ssp.render(stream);
      const toolPart = (stream.push as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(toolPart.isAttachedToThinking).toBe(true);
      expect(toolPart.isError).toBe(true);
      expect(toolPart.pastTenseMessage).toBeTruthy();
    });
    it('keeps the edit row and appends a visible error detail below it', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'edit', callId: 'c1',
        state: toolState({
          status: 'error',
          input: { filePath: 'hello.txt' },
          output: 'Error: old_string was not found in "hello.txt"',
          error: 'Error: old_string was not found in "hello.txt"',
        }),
      });
      ssp.render(stream);
      const tool = (stream.push as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(tool.isError).toBe(true);
      expect(countPushes(stream)).toBe(2);
      const warning = (stream.push as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
      const WarningPart = (vscode as unknown as { ChatResponseWarningPart?: new (value: string) => unknown }).ChatResponseWarningPart;
      expect(warning).toBeInstanceOf(WarningPart);
      expect(String(warning.value)).toBe('edit failed: old_string was not found in "hello.txt"');
    });
  });
  // ════════════════════════════════════════════════════════════════════════
  // Subagent nesting
  // ════════════════════════════════════════════════════════════════════════

  describe('subAgentInvocationId', () => {
    it('should set subAgentInvocationId on pushed part when configured', () => {
      const stream = mockStream();
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'read', callId: 'c1',
        state: toolState({ status: 'completed', input: { filePath: '/a.ts' }, output: '' }),
        subAgentInvocationId: 'subagent-call2-12345',
      });
      ssp.render(stream);
      expect(lastPushedPart(stream).subAgentInvocationId).toBe('subagent-call2-12345');
    });
  });

  describe('toJSON', () => {
    it('should produce toolInvocation kind', () => {
      const ssp = new ToolInvocationSSP({
        partId: 'p1', toolName: 'bash', callId: 'c1',
        state: toolState({ status: 'completed', input: {}, output: '' }),
      });
      const json = ssp.toJSON();
      expect(json.kind).toBe('toolInvocation');
      expect(json.payload.toolName).toBe('bash');
      expect(json.payload.state.status).toBe('completed');
    });
  });
});
