import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { SettingsPanel } from '../settings/panel';

const panelSource = readFileSync(resolve(__dirname, '../settings/panel.ts'), 'utf8');

describe('SettingsPanel webview readiness', () => {
  it('registers the webview message listener before loading HTML so ready cannot be lost', () => {
    const listenerIndex = panelSource.indexOf('this.panel.webview.onDidReceiveMessage(');
    const htmlIndex = panelSource.indexOf('this.panel.webview.html = this.getHtml();');

    expect(listenerIndex).toBeGreaterThan(-1);
    expect(htmlIndex).toBeGreaterThan(-1);
    expect(listenerIndex).toBeLessThan(htmlIndex);
  });
});

describe('SettingsPanel webview HTML', () => {
  it('emits a syntactically valid initialization script', () => {
    const fakePanel = {
      webview: {
        html: '',
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
      },
      onDidDispose: () => ({ dispose() {} }),
      reveal() {},
      dispose() {},
      iconPath: undefined,
    } as unknown as vscode.WebviewPanel;
    const windowApi = vscode.window as unknown as {
      activeTextEditor?: unknown;
      createWebviewPanel?: (...args: unknown[]) => vscode.WebviewPanel;
    };
    const originalActiveTextEditor = windowApi.activeTextEditor;
    const originalCreateWebviewPanel = windowApi.createWebviewPanel;

    windowApi.activeTextEditor = { viewColumn: 1 };
    windowApi.createWebviewPanel = () => fakePanel;
    SettingsPanel.currentPanel = undefined;

    try {
      SettingsPanel.createOrShow(vscode.Uri.file('D:/acpilot'));
      const script = fakePanel.webview.html.match(/<script>([\s\S]*)<\/script>/)?.[1];

      expect(script).toBeTruthy();
      expect(() => new Function(script!)).not.toThrow();
    } finally {
      SettingsPanel.currentPanel = undefined;
      windowApi.activeTextEditor = originalActiveTextEditor;
      windowApi.createWebviewPanel = originalCreateWebviewPanel;
    }
  });
});

describe('SettingsPanel DSH directory controls', () => {
  it('provides a directory chooser for every DSH directory field', () => {
    expect(panelSource).toContain('id="btn-dsh-launch-cwd-browse"');
    expect(panelSource).toContain('id="btn-dsh-install-directory-browse"');
    expect(panelSource).toContain("type: 'selectDirectory'");
    expect(panelSource).toContain("msg.type === 'directorySelected'");
  });
});
