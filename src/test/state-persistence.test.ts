import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  loadPersistedSettingsState,
  savePersistedSettingsState,
} from '../settings/state-persistence';
import type { SelectionState } from '../backend/app-event-bus';

class TestMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  setKeysForSync(_keys: readonly string[]): void {
    // no-op for tests
  }
}

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: '/mock',
    extensionUri: vscode.Uri.parse('file:///mock'),
    globalState: new TestMemento(),
    workspaceState: new TestMemento(),
    storageUri: undefined,
    globalStorageUri: vscode.Uri.parse('file:///mock/globalStorage'),
    logUri: vscode.Uri.parse('file:///mock/logs'),
  } as unknown as vscode.ExtensionContext;
}

describe('state-persistence', () => {
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    context = createMockContext();
  });

  it('returns empty object when no persisted state exists', () => {
    expect(loadPersistedSettingsState(context, 'opencode')).toEqual({});
  });

  it('saves and loads full selection state', () => {
    const state: SelectionState = {
      agent: 'coder',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      modelDisplayName: 'Claude Sonnet 4',
      permissionMode: 'read-only',
    };

    savePersistedSettingsState(context, 'opencode', state);

    expect(loadPersistedSettingsState(context, 'opencode')).toEqual(state);
  });

  it('saves and loads partial selection state', () => {
    const state: SelectionState = {
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    };

    savePersistedSettingsState(context, 'opencode', state);

    expect(loadPersistedSettingsState(context, 'opencode')).toEqual({
      agent: undefined,
      model: { providerID: 'openai', modelID: 'gpt-4o' },
      modelDisplayName: undefined,
      permissionMode: undefined,
    });
  });

  it('overwrites prior persisted state on subsequent saves', () => {
    savePersistedSettingsState(context, 'opencode', {
      agent: 'old-agent',
      model: { providerID: 'openai', modelID: 'gpt-4' },
      modelDisplayName: 'GPT-4',
    });

    savePersistedSettingsState(context, 'opencode', {
      agent: 'new-agent',
      model: { providerID: 'google', modelID: 'gemini-2.5-pro' },
      modelDisplayName: 'Gemini 2.5 Pro',
    });

    expect(loadPersistedSettingsState(context, 'opencode')).toEqual({
      agent: 'new-agent',
      model: { providerID: 'google', modelID: 'gemini-2.5-pro' },
      modelDisplayName: 'Gemini 2.5 Pro',
    });
  });

  it('keeps ACP target selections in separate instance namespaces', () => {
    savePersistedSettingsState(context, 'acp:target-a', {
      agent: 'agent-a',
      model: { providerID: 'provider-a', modelID: 'model-a' },
    });
    savePersistedSettingsState(context, 'acp:target-b', {
      agent: 'agent-b',
      model: { providerID: 'provider-b', modelID: 'model-b' },
    });

    expect(loadPersistedSettingsState(context, 'acp:target-a')).toMatchObject({
      agent: 'agent-a',
      model: { providerID: 'provider-a', modelID: 'model-a' },
    });
    expect(loadPersistedSettingsState(context, 'acp:target-b')).toMatchObject({
      agent: 'agent-b',
      model: { providerID: 'provider-b', modelID: 'model-b' },
    });
  });
});
