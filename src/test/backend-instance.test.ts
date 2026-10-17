import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSessionResourcePath,
  createBackendInstanceKey,
  getBackendStorageNamespace,
} from '../backend/backend-instance';
import { SessionStore } from '../backend/streaming/session-store';

describe('backend instance isolation', () => {
  it('gives different ACP targets disjoint paths for the same session id', () => {
    const targetA = createBackendInstanceKey('acp', 'target-a');
    const targetB = createBackendInstanceKey('acp', 'target-b');
    const storeA = new SessionStore({
      workspaceRoot: 'D:/workspace',
      backendName: getBackendStorageNamespace(targetA),
    });
    const storeB = new SessionStore({
      workspaceRoot: 'D:/workspace',
      backendName: getBackendStorageNamespace(targetB),
    });

    expect(targetA).toBe('acp:target-a');
    expect(targetB).toBe('acp:target-b');
    expect(path.normalize(storeA.getSessionDir('same-session')))
      .not.toBe(path.normalize(storeB.getSessionDir('same-session')));
    expect(storeA.getSessionDir('same-session')).toContain(path.join('acp', 'instance-target-a', 'same-session'));
    expect(storeB.getSessionDir('same-session')).toContain(path.join('acp', 'instance-target-b', 'same-session'));
  });

  it('keeps hostile instance ids inside the backend namespace', () => {
    expect(getBackendStorageNamespace(createBackendInstanceKey('acp', '..'))).toBe('acp/instance-..');
    expect(getBackendStorageNamespace(createBackendInstanceKey('acp', 'CON'))).toBe('acp/instance-CON');
    expect(getBackendStorageNamespace(createBackendInstanceKey('acp', '../other')))
      .toBe('acp/instance-..%2Fother');
    expect(() => createBackendInstanceKey('../acp', 'target')).toThrow(/Backend ID/);
  });

  it('rejects unscoped and foreign session resources for an ACP target', () => {
    const instanceKey = createBackendInstanceKey('acp', 'target-a');
    expect(() => assertSessionResourcePath('/session-1', 'acp', instanceKey))
      .toThrow(/must include backend instance/);
    expect(() => assertSessionResourcePath('/acp%3Atarget-b/session-1', 'acp', instanceKey))
      .toThrow(/belongs to backend instance/);
    expect(() => assertSessionResourcePath('/acp%3Atarget-a/session-1', 'acp', instanceKey))
      .not.toThrow();
  });
});
