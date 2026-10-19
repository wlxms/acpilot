import { describe, expect, it } from 'vitest';
import {
  DSH_BRIDGE_MARKER_PREFIX,
  DSH_BRIDGE_TOOL_PREFIX,
  createDshBridgeLaunchNonce,
  parseDshBridgeReadyLine,
  parseDshBridgeToolLine,
  serializeDshBridgeToolMessage,
} from '../backends/dsh/bridge-protocol';

describe('DeepSeek Harness bridge protocol', () => {
  it('parses only the expected plugin marker and protocol', () => {
    const nonce = 'launch-123';
    expect(parseDshBridgeReadyLine(
      `${DSH_BRIDGE_MARKER_PREFIX}${JSON.stringify({
        plugin: '@wlxms/acpilot-dsh-bridge',
        protocol: 1,
        nonce,
      })}`,
    )).toEqual({ plugin: '@wlxms/acpilot-dsh-bridge', protocol: 1, nonce });
  });

  it('ignores unrelated, malformed, wrong-plugin, and wrong-protocol lines', () => {
    expect(parseDshBridgeReadyLine('normal dsh log')).toBeUndefined();
    expect(parseDshBridgeReadyLine(`${DSH_BRIDGE_MARKER_PREFIX}not-json`)).toBeUndefined();
    expect(parseDshBridgeReadyLine(`${DSH_BRIDGE_MARKER_PREFIX}${JSON.stringify({ plugin: 'other', protocol: 1, nonce: 'x' })}`)).toBeUndefined();
    expect(parseDshBridgeReadyLine(`${DSH_BRIDGE_MARKER_PREFIX}${JSON.stringify({ plugin: '@wlxms/acpilot-dsh-bridge', protocol: 2, nonce: 'x' })}`)).toBeUndefined();
    expect(parseDshBridgeReadyLine(
      `${DSH_BRIDGE_MARKER_PREFIX}${JSON.stringify({ plugin: '@wlxms/acpilot-dsh-bridge', protocol: 1, nonce: 'other' })}`,
      'expected',
    )).toBeUndefined();
  });

  it('creates non-empty unique launch nonces', () => {
    const first = createDshBridgeLaunchNonce();
    const second = createDshBridgeLaunchNonce();
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(second).not.toBe(first);
  });

  it('round-trips a structured tool-call presentation', () => {
    const message = {
      type: 'tool_call' as const,
      protocol: 1 as const,
      sessionId: 'session-1',
      toolCallId: 'call-1',
      rootToolCallId: 'call-1',
      toolName: 'pwsh',
      presentation: {
        card: 'terminal' as const,
        title: 'Get-ChildItem',
        cwd: 'D:/workspace',
      },
    };

    const encoded = serializeDshBridgeToolMessage(message);
    expect(encoded.startsWith(DSH_BRIDGE_TOOL_PREFIX)).toBe(true);
    expect(parseDshBridgeToolLine(encoded)).toEqual(message);
  });

  it('round-trips a structured tool-result presentation with diff data', () => {
    const message = {
      type: 'tool_result' as const,
      protocol: 1 as const,
      sessionId: 'session-1',
      toolCallId: 'call-2',
      rootToolCallId: 'call-2',
      toolName: 'write',
      isError: false,
      presentation: {
        card: 'diff' as const,
        title: 'Write src/index.ts',
        diffs: [{ path: 'src/index.ts', oldText: 'old', newText: 'new' }],
        locations: [{ path: 'src/index.ts', line: 1 }],
      },
    };

    expect(parseDshBridgeToolLine(serializeDshBridgeToolMessage(message))).toEqual(message);
  });

  it('rejects malformed, unsupported, incomplete, and unrelated tool lines', () => {
    expect(parseDshBridgeToolLine('normal dsh log')).toBeUndefined();
    expect(parseDshBridgeToolLine(`${DSH_BRIDGE_TOOL_PREFIX}not-json`)).toBeUndefined();
    expect(parseDshBridgeToolLine(`${DSH_BRIDGE_TOOL_PREFIX}${JSON.stringify({
      type: 'tool_call', protocol: 2, sessionId: 's', toolCallId: 'c', toolName: 'read',
    })}`)).toBeUndefined();
    expect(parseDshBridgeToolLine(`${DSH_BRIDGE_TOOL_PREFIX}${JSON.stringify({
      type: 'unknown', protocol: 1, sessionId: 's', toolCallId: 'c', toolName: 'read',
    })}`)).toBeUndefined();
    expect(parseDshBridgeToolLine(`${DSH_BRIDGE_TOOL_PREFIX}${JSON.stringify({
      type: 'tool_call', protocol: 1, sessionId: '', toolCallId: 'c', toolName: 'read',
    })}`)).toBeUndefined();
  });
});
