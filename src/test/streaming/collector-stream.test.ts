import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { CollectorStream } from '../../backend/streaming/collector-stream';

describe('CollectorStream', () => {
  let stream: CollectorStream;

  beforeEach(() => {
    stream = new CollectorStream();
  });

  // ── markdown ───────────────────────────────────────────────────────────

  it('should capture markdown string as ChatResponseMarkdownPart', () => {
    stream.markdown('Hello');

    expect(stream.parts).toHaveLength(1);
    expect(stream.parts[0]).toBeInstanceOf(vscode.ChatResponseMarkdownPart);

    const part = stream.parts[0] as vscode.ChatResponseMarkdownPart;
    expect(part.value).toBeInstanceOf(vscode.MarkdownString);
    expect((part.value as vscode.MarkdownString).value).toBe('Hello');
  });

  it('should capture MarkdownString as ChatResponseMarkdownPart', () => {
    const md = new vscode.MarkdownString('**bold**');
    stream.markdown(md);

    expect(stream.parts).toHaveLength(1);
    expect(stream.parts[0]).toBeInstanceOf(vscode.ChatResponseMarkdownPart);
  });

  // ── push ───────────────────────────────────────────────────────────────

  it('should capture pushed arbitrary parts', () => {
    const part = { custom: 'data' };
    stream.push(part);

    expect(stream.parts).toHaveLength(1);
    expect(stream.parts[0]).toBe(part);
  });

  // ── progress ───────────────────────────────────────────────────────────

  it('should convert progress to italic markdown', () => {
    stream.progress('working on it…');

    expect(stream.parts).toHaveLength(1);
    expect(stream.parts[0]).toBeInstanceOf(vscode.ChatResponseMarkdownPart);

    const part = stream.parts[0] as vscode.ChatResponseMarkdownPart;
    expect((part.value as vscode.MarkdownString).value).toBe(
      '_working on it…_',
    );
  });

  // ── thinkingProgress ───────────────────────────────────────────────────

  it('should capture thinking as ChatResponseThinkingProgressPart when available', () => {
    stream.thinkingProgress({ text: 'deep thoughts…' });

    expect(stream.parts).toHaveLength(1);
    // When the proposed API class is available at runtime, expect that type
    if (typeof (vscode as any).ChatResponseThinkingProgressPart !== 'undefined') {
      expect(stream.parts[0]).toBeInstanceOf(
        (vscode as any).ChatResponseThinkingProgressPart,
      );
    } else {
      // Without the proposed API, fallback to markdown
      expect(stream.parts[0]).toBeInstanceOf(vscode.ChatResponseMarkdownPart);
    }
  });

  it('should fallback to markdown for thinking when native class unavailable', async () => {
    // Simulate an environment without the proposed API — set the
    // class to undefined so runtime detection triggers the fallback.
    const patchedVscode = {
      ...((await vi.importActual('vscode')) as any),
      ChatResponseThinkingProgressPart: undefined,
    };

    vi.resetModules();
    vi.doMock('vscode', () => patchedVscode);

    const { CollectorStream: FallbackStream } = await import(
      '../../backend/streaming/collector-stream'
    );
    const s = new FallbackStream();
    s.thinkingProgress({ text: 'thinking now' });

    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toBeInstanceOf(
      patchedVscode.ChatResponseMarkdownPart,
    );
    const part = s.parts[0] as any;
    expect(part.value.value).toBe('💭 Thinking: thinking now');
  });

  // ── buildTurn ──────────────────────────────────────────────────────────

  it('buildTurn should construct a response turn with captured parts and metadata', () => {
    stream.markdown('Hello');
    stream.push({ custom: true });

    const turn = stream.buildTurn({ toolIdEditMap: { tool: 'undo' } });

    // `responses` is the mock property name; the real VS Code API uses `response`
    expect((turn as any).responses).toHaveLength(2);
    expect((turn as any).result?.metadata).toEqual({ toolIdEditMap: { tool: 'undo' } });
  });

  // ── reset ──────────────────────────────────────────────────────────────

  it('reset should clear all captured parts', () => {
    stream.markdown('one');
    stream.markdown('two');
    expect(stream.parts).toHaveLength(2);

    stream.reset();

    expect(stream.parts).toHaveLength(0);
  });

  // ── order ──────────────────────────────────────────────────────────────

  it('should preserve the order of multiple operations', () => {
    stream.markdown('first');
    stream.push({ second: true });
    stream.progress('third');

    expect(stream.parts).toHaveLength(3);

    const part0 = stream.parts[0] as vscode.ChatResponseMarkdownPart;
    expect((part0.value as vscode.MarkdownString).value).toBe('first');

    expect(stream.parts[1]).toEqual({ second: true });

    const part2 = stream.parts[2] as vscode.ChatResponseMarkdownPart;
    expect((part2.value as vscode.MarkdownString).value).toBe('_third_');
  });
});
