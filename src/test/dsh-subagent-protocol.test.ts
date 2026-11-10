import { describe, expect, it } from 'vitest';
import { DSH_BRIDGE_TOOL_PREFIX, parseDshBridgeToolLine, serializeDshBridgeToolMessage } from '../backends/dsh/bridge-protocol';
const message = { type: 'tool_call', protocol: 1, sessionId: 'root', agentSessionId: 'grandchild', subAgentInvocationId: 'nested', parentSubAgentInvocationId: 'delegate',
  toolCallId: 'read', rootToolCallId: 'read', toolName: 'read', presentation: { card: 'read', path: 'a.ts' } } as const;
describe('DSH scoped bridge protocol', () => {
  it('preserves the actual owner and nested Copilot invocation scope', () => {
    expect(parseDshBridgeToolLine(serializeDshBridgeToolMessage(message))).toEqual(message);
  });
  it('rejects malformed or self-parenting scope identity', () => {
    for (const patch of [{ agentSessionId: 3 }, { subAgentInvocationId: '' }, { parentSubAgentInvocationId: false }, { parentSubAgentInvocationId: 'nested' }]) {
      expect(parseDshBridgeToolLine(DSH_BRIDGE_TOOL_PREFIX + JSON.stringify({ ...message, ...patch }))).toBeUndefined();
    }
  });
});
