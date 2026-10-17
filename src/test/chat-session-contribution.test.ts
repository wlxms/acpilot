import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ChatSessionContribution {
  type?: string;
  name?: string;
  requiresCustomModels?: boolean;
}

interface LanguageModelProviderContribution {
  vendor?: string;
}

interface ExtensionManifest {
  contributes?: {
    chatSessions?: ChatSessionContribution[];
    languageModelChatProviders?: LanguageModelProviderContribution[];
  };
}

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as ExtensionManifest;
}

describe('chat session contributions', () => {
  it('keeps DeepSeek Harness as its own Agent target and vendor', () => {
    const manifest = readManifest();
    const contribution = manifest.contributes?.chatSessions?.find(
      session => session.type === 'acpilot.dsh',
    );
    expect(contribution).toMatchObject({ name: 'dsh', requiresCustomModels: true });
    expect(manifest.contributes?.languageModelChatProviders).toEqual(
      expect.arrayContaining([expect.objectContaining({ vendor: 'dsh' })]),
    );
  });

  it('enables the native custom model picker for the OpenCode Agent target', () => {
    const contribution = readManifest().contributes?.chatSessions?.find(
      session => session.type === 'acpilot.opencode',
    );

    expect(contribution).toBeDefined();
    expect(contribution?.requiresCustomModels).toBe(true);
  });
});
