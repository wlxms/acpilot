import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ExtensionManifest {
  dependencies?: Record<string, string>;
}

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as ExtensionManifest;
}

function minimumVersion(versionRange: string): [number, number, number] {
  const match = versionRange.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Unsupported version range: ${versionRange}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('bundled OpenCode runtime', () => {
  it('uses a server version that supports OpenCode free-tier models', () => {
    const manifest = readManifest();
    const versionRange = manifest.dependencies?.['opencode-ai'];
    expect(versionRange).toBeDefined();

    const [major, minor] = minimumVersion(versionRange!);
    expect(major > 1 || (major === 1 && minor >= 18)).toBe(true);
  });
});
