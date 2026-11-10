import { describe, expect, it } from 'vitest';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import type { SerializableToolState } from '../../ssp/types';

function renderData(toolName: string, state: Partial<SerializableToolState>) {
  const parts: any[] = [];
  new ToolInvocationSSP({ partId: 'search', callId: 'search', toolName, state: { status: 'completed', input: {}, ...state } }).render({
    push: part => { parts.push(part); }, markdown() {}, progress() {},
  });
  return parts[0].toolSpecificData;
}

describe('DSH search resources', () => {
  it.each(['glob', 'grep'])('does not expose the search root as a %s result when no files matched', toolName => {
    const data = renderData(toolName, {
      input: { path: 'D:/workspace', pattern: '*.cs' }, output: 'No matches found.',
      metadata: { dshToolName: toolName, dshPresentation: { card: 'search', paths: [], locations: [] } },
    });
    expect(data?.values).toBeUndefined();
    expect(data.output).toBe('No matches found.');
    expect(data.input).toContain('pattern: *.cs');
  });

  it('does not expose the call-time search scope as a file while waiting for results', () => {
    const data = renderData('grep', {
      status: 'running', input: { path: 'D:/workspace', pattern: 'RpcRole' },
      metadata: { dshToolName: 'grep', dshPresentation: { card: 'generic', kind: 'search', title: 'grep' } },
    });
    expect(data?.values).toBeUndefined();
  });


  it.each(['websearch', 'websearch_web_search_exa'])('preserves native URL resources for a running %s with generic search presentation', toolName => {
    const data = renderData(toolName, {
      status: 'running', input: { query: 'rpc roles' },
      metadata: { dshToolName: toolName, dshPresentation: { card: 'generic', kind: 'search', title: 'rpc roles' } },
    });
    expect(data?.values?.map((value: any) => ({ scheme: value.scheme, authority: value.authority, path: value.path }))).toEqual([
      { scheme: 'https', authority: 'www.bing.com', path: '/search' },
    ]);
  });

  it.each(['websearch', 'websearch_web_search_exa'])('preserves returned %s URLs with generic search presentation', toolName => {
    const data = renderData(toolName, {
      input: { query: 'rpc roles' }, output: 'Sources: https://docs.example.com/network',
      metadata: { dshToolName: toolName, dshPresentation: { card: 'generic', kind: 'search', title: 'rpc roles' } },
    });
    expect(data?.values?.map((value: any) => ({ scheme: value.scheme, authority: value.authority, path: value.path }))).toEqual([
      { scheme: 'https', authority: 'www.bing.com', path: '/search' },
      { scheme: 'https', authority: 'docs.example.com', path: '/network' },
    ]);
  });

  it.each(['glob', 'grep', 'list'])('continues suppressing the generic %s filesystem search root', toolName => {
    const data = renderData(toolName, {
      input: { path: 'D:/workspace', pattern: '*.cs' }, output: 'No matches found.',
      metadata: { dshToolName: toolName, dshPresentation: { card: 'generic', kind: 'search', title: toolName } },
    });
    expect(data?.values).toBeUndefined();
    expect(data.output).toBe('No matches found.');
  });

  it('uses canonical returned paths when a DSH search has matches', () => {
    const data = renderData('glob', {
      input: { path: 'D:/workspace', pattern: '*.cs' }, output: 'Actor.cs',
      metadata: { dshToolName: 'glob', dshPresentation: { card: 'search', paths: ['D:/workspace/src/Actor.cs'] } },
    });
    expect(data.values.map((value: any) => value.fsPath.replace(/\\/g, '/'))).toEqual(['D:/workspace/src/Actor.cs']);
  });

  it('preserves the existing read-without-resources and non-DSH search behavior', () => {
    expect(renderData('read', { input: { filePath: 'D:/workspace/Actor.cs' }, metadata: { dshPresentation: { card: 'read' } } })).toBeUndefined();
    const data = renderData('grep', { input: { path: 'D:/workspace', pattern: 'RpcRole' }, output: '' });
    expect(data.values[0].fsPath.replace(/\\/g, '/')).toBe('D:/workspace');
  });
});
