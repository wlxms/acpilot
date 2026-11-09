import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ChatSessionContribution {
  type?: string;
  name?: string;
  icon?: string;
  requiresCustomModels?: boolean;
}

interface IconContribution {
  description?: string;
  default?: {
    fontPath?: string;
    fontCharacter?: string;
  };
}

interface LanguageModelProviderContribution {
  vendor?: string;
}

interface ExtensionManifest {
  activationEvents?: string[];
  enabledApiProposals?: string[];
  contributes?: {
    icons?: Record<string, IconContribution>;
    chatSessions?: ChatSessionContribution[];
    languageModelChatProviders?: LanguageModelProviderContribution[];
  };
}

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as ExtensionManifest;
}

describe('chat session contributions', () => {
  it('declares the proposed API and activation events used by current Agent sessions', () => {
    const manifest = readManifest();

    expect(manifest.enabledApiProposals).toContain('chatSessionsProvider');
    expect(manifest.activationEvents).toEqual(expect.arrayContaining([
      'onChatSession:acpilot.opencode',
      'onChatSession:acpilot.dsh',
    ]));
  });

  it('keeps DeepSeek Harness as its own Agent target and vendor', () => {
    const manifest = readManifest();
    const contribution = manifest.contributes?.chatSessions?.find(
      session => session.type === 'acpilot.dsh',
    );
    expect(contribution).toMatchObject({
      name: 'dsh',
      requiresCustomModels: true,
    });
    expect(contribution?.icon).toMatch(/^\$\([A-Za-z0-9-]+\)$/);
    const iconReference = contribution?.icon;
    expect(iconReference).toBeDefined();
    const iconId = iconReference!.slice(2, -1);
    expect(manifest.contributes?.icons?.[iconId]).toMatchObject({
      default: {
        fontPath: './resources/font-icons/opencode-icon.woff',
        fontCharacter: '\\E003',
      },
    });
    expect(iconId).toBe('dsh-logo');
    expect(iconId).not.toBe('acpilot-a');
    expect(iconId).not.toBe('opencode-logo');
    expect(contribution?.icon).not.toMatch(/^resources\//);
    expect(manifest.contributes?.languageModelChatProviders).toEqual(
      expect.arrayContaining([expect.objectContaining({ vendor: 'dsh' })]),
    );
  });

  it('does not advertise the ACP or Reasonix backends as chat targets or model vendors', () => {
    const manifest = readManifest();
    const sessionTypes = manifest.contributes?.chatSessions?.map(session => session.type) ?? [];
    const vendors = manifest.contributes?.languageModelChatProviders?.map(provider => provider.vendor) ?? [];

    expect(sessionTypes).not.toContain('acpilot.acp');
    expect(sessionTypes).not.toContain('acpilot.reasonix');
    expect(vendors).not.toContain('acp');
    expect(vendors).not.toContain('reasonix');
  });

  it('enables the native custom model picker for the OpenCode Agent target', () => {
    const contribution = readManifest().contributes?.chatSessions?.find(
      session => session.type === 'acpilot.opencode',
    );

    expect(contribution).toBeDefined();
    expect(contribution?.requiresCustomModels).toBe(true);
  });

  it('keeps local caches and development-only files out of the VSIX', () => {
    const ignore = readFileSync(join(process.cwd(), '.vscodeignore'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);

    expect(ignore).toEqual(expect.arrayContaining([
      'tmp/',
      'build/',
      '.vscode/',
      '.acpilot/',
      '.sisyphus/',
      'node_modules-recovery-old/',
      '.tmp-node-call.json',
      'doc/',
      'docs/',
      'scripts/',
    ]));
  });
});
