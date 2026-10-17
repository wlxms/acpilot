import { describe, expect, it } from 'vitest';
import {
  DSH_BRIDGE_MARKER_PREFIX,
  createDshBridgeLaunchNonce,
  parseDshBridgeReadyLine,
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
});
