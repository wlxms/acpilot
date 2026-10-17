import { describe, expect, it } from 'vitest';
import { createBackend, listBackendIds } from '../backend/backend-registry';
import {
  assertBuiltinBackendAssembly,
  BUILTIN_BACKENDS,
} from '../backends/registry';
import type { Backend } from '../backend/backend';

describe('built-in backend registry', () => {
  it('loads every declared backend factory from the shared registry', () => {
    expect(listBackendIds()).toEqual(expect.arrayContaining(['opencode', 'acp', 'reasonix']));

    const opencode = createBackend('opencode');
    const acp = createBackend('acp');
    const reasonix = createBackend('reasonix');

    expect(opencode.name).toBe('opencode');
    expect(acp.name).toBe('acp');
    expect(reasonix.name).toBe('reasonix');
    expect(opencode.modelProvider?.vendor).toBe('opencode');
    expect(acp.modelProvider?.vendor).toBe('acp');
    expect(reasonix.modelProvider?.vendor).toBe('reasonix');
  });

  it('rejects a descriptor whose vendor differs from its model provider', () => {
    const descriptor = BUILTIN_BACKENDS[0];
    const backend = {
      modelProvider: { vendor: 'wrong-vendor' },
    } as Backend;

    expect(() => assertBuiltinBackendAssembly(descriptor, backend)).toThrow(
      'vendor mismatch',
    );
  });

  it('allows a backend without the optional model provider capability', () => {
    const descriptor = BUILTIN_BACKENDS[0];

    expect(() => assertBuiltinBackendAssembly(descriptor, {} as Backend)).not.toThrow();
  });
});
