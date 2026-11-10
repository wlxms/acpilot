import { describe, expect, it } from 'vitest';
import { DSH_BRIDGE_TOOL_PREFIX, parseDshBridgeToolLine } from '../backends/dsh/bridge-protocol';

const base = { type: 'tool_result', protocol: 1, sessionId: 'root', toolCallId: 'render-1', rootToolCallId: 'render-1', toolName: 'render_ui', isError: false, output: 'Rendered' };
const view = { protocol: 1, renderer: { id: 'dsh.genui', version: 1 }, viewId: 'render-1', data: { items: [{ type: 'text', content: 'Hello' }], 'dsh-go/view': { native: true } } };
const parse = (richView: unknown) => parseDshBridgeToolLine(DSH_BRIDGE_TOOL_PREFIX + JSON.stringify({ ...base, richView }));

describe('DSH rich view bridge protocol', () => {
  it('preserves complete versioned renderer data', () => {
    expect(parse(view)).toEqual({ ...base, richView: view });
  });

  it.each([
    { ...view, protocol: 2 },
    { ...view, renderer: { id: '', version: 1 } },
    { ...view, renderer: { id: 'x'.repeat(129), version: 1 } },
    { ...view, renderer: { id: 'dsh.genui', version: 0 } },
    { ...view, renderer: { id: 'dsh.genui', version: 1.5 } },
    { ...view, viewId: '' },
    { ...view, viewId: 'x'.repeat(1025) },
    { protocol: 1, renderer: view.renderer, viewId: view.viewId },
    { ...view, data: 'x'.repeat(2 * 1024 * 1024) },
  ].map((richView, index) => ({ richView, index })))('rejects malformed or oversized rich envelope $index', ({ richView }) => {
    expect(parse(richView) === undefined).toBe(true);
  });

  it('preserves unknown renderer identities for a readable host fallback', () => {
    const richView = { ...view, renderer: { id: 'custom.renderer', version: 2 } };
    expect(parse(richView)).toEqual({ ...base, richView });
  });

  it('rejects the exact renderer size limit before a pipeline can construct its SSP', () => {
    const minimal = { ...view, data: '' };
    const overhead = Buffer.byteLength(JSON.stringify(minimal), 'utf8');
    const richView = { ...minimal, data: 'x'.repeat(2 * 1024 * 1024 - overhead) };
    expect(Buffer.byteLength(JSON.stringify(richView), 'utf8')).toBe(2 * 1024 * 1024);
    expect(parse(richView) === undefined).toBe(true);
  });
});
