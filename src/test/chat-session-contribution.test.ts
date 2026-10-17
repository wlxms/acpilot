import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ChatSessionContribution {
  type?: string;
  requiresCustomModels?: boolean;
}

interface ExtensionManifest {
  contributes?: {
    chatSessions?: ChatSessionContribution[];
  };
}

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as ExtensionManifest;
}

describe('OpenCode chat session contribution', () => {
  it('enables the native custom model picker for the OpenCode Agent target', () => {
    const contribution = readManifest().contributes?.chatSessions?.find(
      session => session.type === 'acpilot.opencode',
    );

    expect(contribution).toBeDefined();
    expect(contribution?.requiresCustomModels).toBe(true);
  });
});
