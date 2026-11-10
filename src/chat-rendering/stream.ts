import type * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { SerializableStreamPartMeta } from '../ssp/types';
import { getDshRenderHost } from './host';
import type { DshRenderHost } from './host';
import { DSH_VIEW_MAX_BYTES, isRecord, parseDshRichView, type DshRichView } from './protocol';
import type { DshRenderSessionRoute } from './session-route';

export type DshRenderStream = vscode.ChatResponseStream & {
  richView(view: DshRichView, meta?: SerializableStreamPartMeta): void;
  flushDshRender(): void;
};

export function flushDshRenderStream(stream: vscode.ChatResponseStream): void {
  (stream as Partial<DshRenderStream>).flushDshRender?.();
}
interface Fence { char: string; length: number; }
function opening(line: string): (Fence & { language: string }) | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
  return match ? { char: match[1][0], length: match[1].length, language: match[2].trim() } : undefined;
}
function closing(line: string, fence: Fence): boolean {
  const match = /^ {0,3}([`~]+)[ \t]*\r?\n?$/.exec(line);
  return !!match && match[1][0] === fence.char && [...match[1]].every(c => c === fence.char) && match[1].length >= fence.length;
}
function possibleFencePrefix(text: string): boolean {
  return /^ {0,3}(?:`*|~*)$/.test(text) || /^ {0,3}(?:`{3,}|~{3,})[^\r\n]*$/.test(text);
}

/** Completed dsh-ui fences receive a host-owned route; ordinary text stays streaming. */
export function wrapDshRenderStream(raw: vscode.ChatResponseStream, route?: DshRenderSessionRoute, host: DshRenderHost = getDshRenderHost()): DshRenderStream {
  let pending = '';
  let lineStart = true;
  let foreign: Fence | undefined;
  let target: { fence: Fence; open: string; body: string } | undefined;
  const emit = (text: string) => { if (text) { raw.markdown(text); } };
  const finishTarget = (close: string): void => {
    const current = target!;
    target = undefined;
    let input: unknown;
    try { input = JSON.parse(current.body); } catch { /* preserve invalid text */ }
    let view = parseDshRichView(input);
    if (!view && isRecord(input) && input.protocol === undefined && Array.isArray(input.items)) {
      view = parseDshRichView({ protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: randomUUID(), data: input });
    }
    emit(view ? host.markdown(view, route) : current.open + current.body + close);
  };
  const processLine = (line: string) => {
    if (target) {
      if (closing(line, target.fence)) { finishTarget(line); }
      else {
        target.body += line;
        if (Buffer.byteLength(target.body, 'utf8') >= DSH_VIEW_MAX_BYTES) {
          foreign = target.fence;
          emit(target.open + target.body);
          target = undefined;
        }
      }
      return;
    }
    if (foreign) {
      if (lineStart && closing(line, foreign)) { foreign = undefined; }
      emit(line);
      return;
    }
    const fence = lineStart ? opening(line) : undefined;
    if (fence?.language === 'dsh-ui') { target = { fence, open: line, body: '' }; }
    else { if (fence) { foreign = fence; } emit(line); }
  };
  const flush = () => {
    if (target && closing(pending, target.fence)) { finishTarget(pending); }
    else if (target) { emit(target.open + target.body + pending); target = undefined; }
    else { emit(pending); }
    pending = '';
    foreign = undefined;
    lineStart = true;
  };
  const markdown = (value: string | vscode.MarkdownString) => {
    if (typeof value !== 'string') {
      // Preserve trusted MarkdownString settings and source URIs.
      flush();
      raw.markdown(value);
      return;
    }
    pending += value;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) { break; }
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      processLine(line);
      lineStart = true;
    }
    if (target && Buffer.byteLength(target.body + pending, 'utf8') >= DSH_VIEW_MAX_BYTES) {
      foreign = target.fence;
      emit(target.open + target.body);
      target = undefined;
    }
    if (!target && pending && (!lineStart || !possibleFencePrefix(pending))) {
      emit(pending);
      pending = '';
      lineStart = false;
    }
  };
  return new Proxy(raw as DshRenderStream, {
    get(targetStream, key) {
      if (key === 'markdown') { return markdown; }
      if (key === 'flushDshRender') { return flush; }
      if (key === 'richView') {
        return (view: DshRichView, meta?: SerializableStreamPartMeta) => {
          flush();
          emit(host.markdown(view, meta?.subAgentInvocationId || meta?.parentSessionId ? undefined : route));
        };
      }
      const value = Reflect.get(targetStream, key, targetStream);
      return typeof value === 'function' ? value.bind(targetStream) : value;
    },
  });
}
