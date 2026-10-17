import * as vscode from 'vscode';
import type { BackendSettingsDescriptor } from '../backend/types';
import type { PermissionMode } from '../backend/types';

export interface GlobalSettingItem {
  key: string;
  label: string;
  description: string;
  type: 'toggle' | 'select';
  value: boolean | string;
  options?: Array<{ value: string; label: string }>;
}

export type SettingsMessage =
  | { type: 'ready' }
  | { type: 'refreshData' }
  | { type: 'setAgent'; agentId: string }
  | { type: 'setPermissionMode'; permissionMode: PermissionMode }
  | { type: 'setModel'; providerID: string; modelID: string }
  | { type: 'setDefaultModel'; model: string }
  | { type: 'setDefaultAgent'; agent: string }
  | { type: 'saveBackendSettings'; values: Record<string, unknown> }
  | { type: 'setGlobalSetting'; key: string; value: boolean | string }
  | { type: 'setBackendTarget'; targetId: string }
  | { type: 'createAcpTarget'; name?: string; endpoint: string; authToken?: string }
  | { type: 'updateAcpTarget'; targetId: string; name?: string; endpoint: string; authToken?: string }
  | { type: 'deleteAcpTarget'; targetId: string }
  | { type: 'createDshTarget'; name?: string; command: string; args: string[]; launchCwd: string; installDirectory?: string; packageSpec?: string }
  | { type: 'updateDshTarget'; targetId: string; name?: string; command: string; args: string[]; launchCwd: string; installDirectory?: string; packageSpec?: string }
  | { type: 'deleteDshTarget'; targetId: string }
  | { type: 'installDsh'; targetId?: string; name?: string; command: string; args: string[]; launchCwd: string; installDirectory: string; packageSpec?: string }
  | { type: 'updateDsh'; targetId?: string; name?: string; command: string; args: string[]; launchCwd: string; installDirectory: string; packageSpec?: string }
  | { type: 'connectProvider'; providerId: string; apiKey: string; baseURL?: string; displayName?: string }
  | { type: 'disconnectProvider'; configKey: string }
  | { type: 'updateProvider'; configKey: string; apiKey: string; baseURL?: string };

export interface BackendTargetItem {
  id: string;
  kind: 'builtin' | 'acp' | 'dsh';
  name: string;
  description: string;
  endpoint?: string;
  command?: string;
  args?: string[];
  launchCwd?: string;
  installDirectory?: string;
  packageSpec?: string;
  active: boolean;
  editable: boolean;
}

export interface SettingsData {
  backendName: string;
  agents: Array<{ id: string; name?: string; description?: string; model?: string; mode?: string; hidden?: boolean }>;
  models: Array<{ id: string; name?: string; provider?: string; providerId?: string; capabilities?: string[] }>;
  currentAgent?: string;
  currentModel?: { providerID: string; modelID: string };
  currentModelDisplayName?: string;
  currentPermissionMode?: PermissionMode;
  /** Default agent from backend config */
  defaultAgent?: string;
  /** Default model from backend config */
  defaultModel?: string;
  /** Backend-specific settings descriptor (pluggable per backend) */
  backendSettings?: BackendSettingsDescriptor;
  /** Connected providers with masked API key info */
  connectedProviders: Array<{
    configKey: string;
    id: string;
    name: string;
    hasApiKey: boolean;
    apiKeyPreview?: string;
    baseURL?: string;
  }>;
  /** All supported provider definitions */
  availableProviders: Array<{
    id: string;
    name: string;
    description: string;
    requiresBaseURL: boolean;
    isOpenAICompatible: boolean;
    icon: string;
  }>;
  /** Extension-level global settings (acpilot.experimental.*) */
  globalSettings?: GlobalSettingItem[];
  /** Built-in and user-managed backend targets shown in the global Target picker. */
  backendTargets?: BackendTargetItem[];
  /** Selected settings target; ACP sessions use the selected ACP target when kind='acp'. */
  activeBackendTargetId?: string;
  /** DSH command configuration shown even before a target has been saved. */
  dshTarget?: {
    id?: string;
    name: string;
    command: string;
    args: string[];
    launchCwd: string;
    installDirectory: string;
    packageSpec: string;
  };
}

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  public static readonly viewType = 'opencodeSettings';

  public static createOrShow(_extensionUri: vscode.Uri): SettingsPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      return SettingsPanel.currentPanel;
    }

    SettingsPanel.currentPanel = new SettingsPanel(column);
    return SettingsPanel.currentPanel;
  }

  private constructor(column?: vscode.ViewColumn) {
    this.panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'ACP Settings',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('gear');
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => { this.dispose(); }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: SettingsMessage) => { this.handleMessage(message); },
      null,
      this.disposables,
    );
  }

  public updateData(data: SettingsData): void {
    void this.panel.webview.postMessage({ type: 'updateData', data });
  }

  public onDidRequestChange: ((message: SettingsMessage) => Promise<void>) | undefined;
  private messageQueue: Promise<void> = Promise.resolve();

  private handleMessage(message: SettingsMessage): void {
    this.messageQueue = this.messageQueue
      .then(async () => this.onDidRequestChange?.(message))
      .then(() => undefined, (error: unknown) => {
        void this.panel.webview.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ACP Settings</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --card: var(--vscode-editorWidget-background);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, transparent);
      --accent: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --accent-fg: var(--vscode-button-foreground);
      --focus: var(--vscode-focusBorder);
      --toc-active: var(--vscode-list-activeSelectionBackground);
      --toc-hover: var(--vscode-list-hoverBackground);
      --row-hover: var(--vscode-list-hoverBackground);
      --group-title-fg: var(--vscode-foreground);
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family);
      background: var(--bg);
      color: var(--fg);
      font-size: 13px;
      line-height: 1.4;
      overflow: hidden;
    }

    /* ── Root split layout: left TOC + right body ────────────────────── */
    .settings-root {
      display: flex;
      align-items: stretch;
      height: 100%;
      width: 100%;
    }

    /* ── Left navigation TOC (native settings sidebar) ───────────────── */
    .settings-toc {
      width: 220px;
      flex-shrink: 0;
      padding: 12px 0;
      background: var(--bg);
      border-right: 1px solid var(--border);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .toc-header {
      padding: 0 20px 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
    }
    .toc-item {
      padding: 4px 20px;
      line-height: 22px;
      cursor: pointer;
      color: var(--muted);
      opacity: 0.9;
      user-select: none;
    }
    .toc-item:hover { background: var(--toc-hover); opacity: 1; }
    .toc-item.active {
      font-weight: 700;
      color: var(--fg);
      background: var(--toc-active);
      opacity: 1;
    }
    .toc-spacer { flex: 1; }
    .toc-separator {
      margin: 8px 16px;
      border-top: 1px solid var(--border);
    }
    .toc-add-btn {
      margin: 0 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 28px;
      padding: 0 12px;
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .toc-add-btn:hover { background: var(--input-bg); border-color: var(--accent); }

    /* ── Right body ──────────────────────────────────────────────────── */
    .settings-body {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      padding: 20px 28px 40px;
    }
    .settings-body-inner {
      max-width: 1000px;
      margin: 0 auto;
    }

    /* ── Common elements ─────────────────────────────────────────────── */
    .hidden { display: none !important; }

    /* Settings group title — like native settings-group-title-label */
    .group-title {
      margin: 22px 0 8px;
      font-size: 17px;
      font-weight: 600;
      color: var(--group-title-fg);
    }
    .group-title:first-child { margin-top: 0; }

    /* Setting row — VS Code native style.
       Default (text/select): label / desc / control stacked vertically.
       Bool variant: label on top, then a row with toggle + description.
       Mirrors setting-item-contents (padding 12px 14px 18px) and
       setting-value (margin-top: 9px) from settingsEditor2.css. */
    .setting-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px 14px 18px;
      border-radius: 4px;
    }
    .setting-item:hover { background: var(--row-hover); }
    .setting-item.is-bool { gap: 9px; }
    .setting-label { font-weight: 600; font-size: 13px; }
    .setting-desc { color: var(--fg); opacity: 0.9; font-size: 12px; }
    /* Inline control+description row for bool settings (toggle then desc) */
    .setting-bool-row { display: flex; align-items: center; gap: 9px; }
    /* Control sits below the description with native setting-value spacing */
    .setting-control {
      display: flex;
      align-items: center;
      width: 100%;
      margin-top: 5px;
    }
    .setting-item.is-bool .setting-bool-row { margin-top: 0; }
    /* Native VS Code toggle switch */
    .setting-toggle {
      position: relative;
      width: 40px;
      height: 20px;
      flex-shrink: 0;
      background: var(--input-border);
      border: 1px solid var(--vscode-checkbox-border, transparent);
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
      appearance: none;
      -webkit-appearance: none;
      margin: 0;
    }
    .setting-toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--fg);
      opacity: 0.8;
      transition: left 0.12s ease, background 0.12s ease;
    }
    .setting-toggle:checked {
      background: var(--accent);
      border-color: var(--accent);
    }
    .setting-toggle:checked::after { left: 22px; background: var(--accent-fg); opacity: 1; }

    /* Cards retained for Backend Target / Current Session */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 10px;
    }
    .backend-target { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .backend-target-main { display: flex; align-items: center; gap: 10px; }
    .backend-badge {
      width: 32px; height: 32px; border-radius: 8px; background: var(--accent); color: var(--accent-fg);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .backend-badge svg { width: 20px; height: 20px; display: block; }
    .backend-meta { color: var(--muted); font-size: 11px; }
    .target-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
    .target-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .target-row-main { min-width: 0; flex: 1; cursor: pointer; }
    .target-row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .target-row .item-title, .target-row .item-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .target-form .setting-item { padding: 8px 0; }
    .target-form input { width: 100%; }

    .session-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .session-grid > .card { display: flex; flex-direction: column; margin-bottom: 0; }
    .session-grid h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
    .session-grid .desc { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
    @media (max-width: 720px) { .session-grid { grid-template-columns: 1fr; } }

    /* Dropdowns */
    .dropdown-container { position: relative; width: 100%; min-width: 0; }
    .dropdown-trigger {
      display: flex; justify-content: space-between; align-items: center; width: 100%;
      padding: 6px 10px; background: var(--input-bg); border: 1px solid var(--input-border);
      border-radius: 4px; cursor: pointer; color: var(--fg); text-align: left; gap: 8px;
      transition: border-color 0.12s ease;
      min-width: 0;
    }
    .dropdown-trigger:hover { border-color: var(--focus); }
    /* Selected (collapsed) value container — truncate long titles */
    .dropdown-trigger > #agent-dropdown-selected,
    .dropdown-trigger > #model-dropdown-selected {
      min-width: 0;
      overflow: hidden;
      flex: 1;
    }
    .dropdown-trigger .item-title {
      font-weight: 600; font-size: 13px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dropdown-trigger .item-meta { color: var(--muted); font-size: 11px; }
    .dropdown-trigger-icon { margin-left: auto; color: var(--muted); font-size: 10px; flex-shrink: 0; }
    .dropdown-panel {
      position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px;
      background: var(--card); border: 1px solid var(--border); border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2); max-height: 240px; overflow-y: auto; z-index: 100;
      padding: 4px; display: none;
    }
    .dropdown-panel.open { display: block; }
    .list-card-item {
      padding: 7px 10px; border-radius: 4px; margin-bottom: 2px; cursor: pointer;
      transition: background 0.12s ease;
    }
    .list-card-item:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
    .list-card-item.selected { background: color-mix(in srgb, var(--accent) 18%, transparent); }
    .list-card-item .item-title { font-weight: 600; font-size: 12px; }
    .list-card-item .item-meta { color: var(--muted); font-size: 11px; }

    /* Controls — native VS Code sizing (text 420px, select 320px), height 26px,
       border-radius 2px. Inputs are NOT full-width — mirrors native settings. */
    input[type="text"], input[type="password"] {
      width: 420px;
      max-width: 100%;
      height: 26px;
      padding: 2px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      outline: none;
      font: inherit;
    }
    select {
      width: 320px;
      max-width: 100%;
      height: 26px;
      padding: 2px 6px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      outline: none;
      font: inherit;
    }
    select:focus, input:focus { border-color: var(--focus); }
    button {
      height: 26px;
      padding: 2px 12px;
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: var(--accent-hover); }
    .button-secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .button-secondary:hover { background: var(--input-bg); }
    .section-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }

    .empty-state {
      color: var(--muted); padding: 16px; border: 1px dashed var(--border); border-radius: 4px;
      text-align: center; font-size: 12px;
    }

    /* Subtabs inside OpenCode (Setting | Provider) */
    .subtabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 10px;
    }
    .subtab {
      padding: 6px 14px;
      cursor: pointer;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      user-select: none;
      font-size: 12px;
    }
    .subtab.active { color: var(--fg); border-bottom-color: var(--accent); }

    /* Collapsible group — the summary IS the section header (group-title level).
       The foldout marker hangs to the LEFT (negative margin) so the title text
       aligns with non-collapsible group titles — the icon never pushes text. */
    details { margin: 22px 0 0; }
    details:first-child { margin-top: 0; }
    details > summary {
      cursor: pointer;
      font-size: 17px;
      font-weight: 600;
      color: var(--group-title-fg);
      margin: 0 0 8px;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 4px;
      user-select: none;
    }
    details > summary::-webkit-details-marker { display: none; }
    /* Marker hangs in the left gutter (negative margin), outside the text column */
    details > summary::before {
      content: '▸'; color: var(--muted); font-size: 13px;
      width: 14px; flex-shrink: 0; text-align: center;
      margin-left: -18px;   /* pull the marker out into the left gutter */
    }
    details[open] > summary::before { content: '▾'; }

    /* Map field — its label becomes a subsection subtitle under the group header */
    .map-subtitle {
      font-size: 12px;
      color: var(--muted);
      margin: 0 0 8px;
    }

    /* Map field items (e.g. each agent) — tertiary headers */
    .map-item-title {
      font-weight: 600; font-size: 13px;
      margin: 12px 0 4px;
      padding-bottom: 3px;
      border-bottom: 1px solid var(--border);
    }
    .map-item-title:first-child { margin-top: 0; }

    /* Provider management */
    .provider-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
    .provider-item {
      padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg);
      display: flex; flex-direction: column; gap: 4px;
    }
    .provider-item-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .provider-item-name { font-weight: 600; font-size: 13px; }
    .provider-item-status {
      font-size: 9px; padding: 1px 6px; border-radius: 2px;
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .provider-item-actions { display: flex; gap: 6px; margin-top: 2px; }
    .provider-item-actions button { font-size: 11px; padding: 1px 8px; }
    .provider-add-btn {
      width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--border);
      background: transparent; color: var(--fg); cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center; line-height: 1;
    }
    .provider-add-btn:hover { background: var(--input-bg); border-color: var(--accent); }
    .provider-grid-add { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .provider-option {
      padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg);
      cursor: pointer; text-align: center; transition: all 0.12s ease;
    }
    .provider-option:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .provider-option.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .provider-option-name { font-weight: 600; font-size: 12px; }
    .provider-option-desc { color: var(--muted); font-size: 10px; margin-top: 2px; }
    .provider-form { margin-top: 8px; }
    .provider-form .setting-item { padding: 8px 0; }
    .provider-form input { width: 100%; }

    /* Modals */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 10;
    }
    .modal { width: min(540px, calc(100vw - 32px)); background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 18px; }
    .modal h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    .modal .desc { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
     textarea { width: 100%; resize: vertical; font: inherit; color: var(--input-fg); background: var(--input-bg); border: 1px solid var(--input-border); padding: 6px 8px; border-radius: 3px; }
     .dsh-status { margin-top: 10px; color: var(--muted); min-height: 18px; }
  </style>
</head>
<body>
  <div class="settings-root">
    <!-- Left navigation TOC -->
    <nav class="settings-toc">
      <div class="toc-header">Settings</div>
      <div class="toc-item active" data-nav="global">Global</div>
      <div class="toc-item" data-nav="opencode">OpenCode</div>
       <div class="toc-item" data-nav="dsh">DeepSeek Harness</div>
      <div class="toc-spacer"></div>
      <div class="toc-separator"></div>
      <button id="btn-acp-backend-add" class="toc-add-btn">+ ACP Backend</button>
    </nav>

    <!-- Right content body -->
    <main class="settings-body">
      <!-- ═══ Global nav content ═══ -->
      <section id="nav-global" class="settings-body-inner">
        <div class="group-title">Backend Target</div>
        <div class="card">
          <div class="backend-target">
            <div class="backend-target-main">
              <div class="backend-badge">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-label="OpenCode">
                  <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/>
                </svg>
              </div>
              <div>
                <div style="font-weight:600;" id="backend-target-name">OpenCode</div>
                <div class="backend-meta">Current backend target</div>
              </div>
            </div>
            <button id="btn-backend-chooser" class="button-secondary">Backend</button>
          </div>
        </div>

        <div class="group-title">Current Session</div>
        <div class="session-grid">
          <div class="card">
            <h3>Agent</h3>
            <div class="desc">Agent for the next request</div>
            <div class="dropdown-container">
              <button id="agent-dropdown-trigger" class="dropdown-trigger">
                <div id="agent-dropdown-selected">
                  <div class="item-title">Select Agent</div>
                  <div class="item-meta">...</div>
                </div>
                <div class="dropdown-trigger-icon">▼</div>
              </button>
              <div id="agent-dropdown-panel" class="dropdown-panel"></div>
            </div>
          </div>
          <div class="card">
            <h3>Permissions</h3>
            <div class="desc">Access scope for the next request</div>
            <div class="dropdown-container">
              <button id="permission-mode-dropdown-trigger" class="dropdown-trigger">
                <div id="permission-mode-dropdown-selected">
                  <div class="item-title">Ask</div>
                </div>
                <div class="dropdown-trigger-icon">▼</div>
              </button>
              <div id="permission-mode-dropdown-panel" class="dropdown-panel"></div>
            </div>
          </div>
          <div class="card">
            <h3>Model</h3>
            <div class="desc">Model for the next request</div>
            <div class="dropdown-container">
              <button id="model-dropdown-trigger" class="dropdown-trigger">
                <div id="model-dropdown-selected">
                  <div class="item-title">Select Model</div>
                  <div class="item-meta">...</div>
                </div>
                <div class="dropdown-trigger-icon">▼</div>
              </button>
              <div id="model-dropdown-panel" class="dropdown-panel"></div>
            </div>
          </div>
        </div>

        <details id="global-settings-details" open>
          <summary>Extension Settings</summary>
          <div class="details-content" id="global-settings-container">
            <div class="empty-state">Loading global settings...</div>
          </div>
        </details>
      </section>

      <!-- ═══ OpenCode nav content ═══ -->
      <section id="nav-opencode" class="settings-body-inner hidden">
        <div id="backend-settings-container">
          <div class="empty-state">Loading backend settings...</div>
        </div>
      </section>

      <!-- ═══ DeepSeek Harness nav content ═══ -->
      <section id="nav-dsh" class="settings-body-inner hidden">
        <div class="group-title">DeepSeek Harness Runtime</div>
        <div class="card">
          <div class="desc">ACPilot launches the DSH command you configure here. The launch directory is the DSH process directory; the workspace directory is still sent separately in ACP session/new.</div>
          <input type="hidden" id="dsh-target-id">
          <div class="setting-item">
            <div class="setting-label">Target name</div>
            <div class="setting-desc">Display name in the backend target picker</div>
            <div class="setting-control"><input type="text" id="dsh-target-name" placeholder="DeepSeek Harness"></div>
          </div>
          <div class="setting-item">
            <div class="setting-label">DSH command</div>
            <div class="setting-desc">Your own dsh executable, script, or wrapper command</div>
            <div class="setting-control"><input type="text" id="dsh-command" placeholder="dsh"></div>
          </div>
          <div class="setting-item">
            <div class="setting-label">Arguments</div>
            <div class="setting-desc">One argument per line. The official ACP profile is --profile acp.</div>
            <div class="setting-control"><textarea id="dsh-args" rows="3" placeholder="--profile&#10;acp"></textarea></div>
          </div>
          <div class="setting-item">
            <div class="setting-label">DSH launch directory</div>
            <div class="setting-desc">Working directory used to start your DSH server</div>
            <div class="setting-control"><input type="text" id="dsh-launch-cwd" placeholder="C:\\path\\to\\your\\dsh"></div>
          </div>
          <div class="setting-item">
            <div class="setting-label">Install directory</div>
            <div class="setting-desc">Directory used by the Install and Update buttons</div>
            <div class="setting-control"><input type="text" id="dsh-install-directory" placeholder="C:\\path\\to\\acpilot-dsh"></div>
          </div>
          <div class="setting-item">
            <div class="setting-label">Package spec</div>
            <div class="setting-desc">npm package or version used by Install and Update</div>
            <div class="setting-control"><input type="text" id="dsh-package-spec" placeholder="@deepseek-ai/dsh@latest"></div>
          </div>
          <div class="modal-actions">
            <button id="btn-dsh-delete" class="button-secondary hidden" style="color:#f48771; border-color:#f48771;">Delete target</button>
            <button id="btn-dsh-save" class="button-secondary">Save target</button>
            <button id="btn-dsh-install">Install DSH</button>
            <button id="btn-dsh-update">Update DSH</button>
          </div>
          <div id="dsh-status" class="dsh-status"></div>
        </div>
      </section>
    </main>
  </div>

  <!-- Provider modals + backend chooser (kept outside root for fixed overlay) -->
  <div id="add-provider-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3>Connect Provider</h3>
      <div id="add-provider-grid" class="provider-grid-add"></div>
      <div id="add-provider-form-section" class="provider-form hidden">
        <div class="setting-item" style="padding:8px 0;">
          <div class="setting-text">
            <div class="setting-label">API Key</div>
            <div class="setting-desc">Enter your API key for this provider</div>
          </div>
          <div class="setting-control"><input type="password" id="add-provider-apikey" placeholder="Enter API key"></div>
        </div>
        <div class="setting-item hidden" id="add-provider-baseurl-field" style="padding:8px 0;">
          <div class="setting-text">
            <div class="setting-label">Base URL</div>
            <div class="setting-desc">Custom API endpoint (optional)</div>
          </div>
          <div class="setting-control"><input type="text" id="add-provider-baseurl" placeholder="https://api.example.com/v1"></div>
        </div>
        <div class="modal-actions">
          <button id="btn-add-provider-cancel" class="button-secondary">Cancel</button>
          <button id="btn-add-provider-connect">Connect</button>
        </div>
      </div>
    </div>
  </div>

  <div id="edit-provider-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3>Edit Provider</h3>
      <div class="provider-form">
        <div class="setting-item" style="padding:8px 0;">
          <div class="setting-text">
            <div class="setting-label">API Key</div>
            <div class="setting-desc">Update your API key for this provider</div>
          </div>
          <div class="setting-control"><input type="password" id="edit-provider-apikey" placeholder="Enter new API key"></div>
        </div>
        <div class="setting-item hidden" id="edit-provider-baseurl-field" style="padding:8px 0;">
          <div class="setting-text">
            <div class="setting-label">Base URL</div>
            <div class="setting-desc">Custom API endpoint (optional)</div>
          </div>
          <div class="setting-control"><input type="text" id="edit-provider-baseurl" placeholder="https://api.example.com/v1"></div>
        </div>
        <div class="modal-actions">
          <button id="btn-edit-provider-disconnect" class="button-secondary" style="color:#f48771; border-color:#f48771;">Disconnect</button>
          <button id="btn-edit-provider-cancel" class="button-secondary">Cancel</button>
          <button id="btn-edit-provider-save">Save</button>
        </div>
      </div>
    </div>
  </div>

  <div id="backend-chooser-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3>Choose Target</h3>
      <div class="desc">Select the Settings target. When an ACP target is selected, the Copilot ACP session target connects to that remote endpoint.</div>
      <div id="backend-target-list" class="target-list"></div>
      <div class="modal-actions">
        <button id="btn-open-acp-target-form" class="button-secondary">Add ACP Target</button>
        <button id="btn-open-dsh-target-form" class="button-secondary">Add DSH Target</button>
        <button id="btn-close-backend-chooser" class="button-secondary">Close</button>
      </div>
    </div>
  </div>

  <div id="acp-target-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3 id="acp-target-modal-title">ACP Target</h3>
      <div class="desc">Configure a remote Agent Client Protocol endpoint.</div>
      <div class="target-form">
        <input type="hidden" id="acp-target-id">
        <div class="setting-item">
          <div class="setting-label">Name</div>
          <div class="setting-desc">Display name shown in the Target picker</div>
          <div class="setting-control"><input type="text" id="acp-target-name" placeholder="Production ACP"></div>
        </div>
        <div class="setting-item">
          <div class="setting-label">Endpoint</div>
          <div class="setting-desc">WebSocket URL for the remote ACP agent</div>
          <div class="setting-control"><input type="text" id="acp-target-endpoint" placeholder="wss://agent.example.com/acp"></div>
        </div>
        <div class="setting-item">
          <div class="setting-label">Auth Token</div>
          <div class="setting-desc">Optional bearer token for the remote endpoint. Leave blank while editing to keep the current token.</div>
          <div class="setting-control"><input type="password" id="acp-target-token" placeholder="Optional"></div>
        </div>
        <div class="modal-actions">
          <button id="btn-delete-acp-target" class="button-secondary hidden" style="color:#f48771; border-color:#f48771;">Delete</button>
          <button id="btn-cancel-acp-target" class="button-secondary">Cancel</button>
          <button id="btn-save-acp-target">Save</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentData = null;

    // ── Left navigation switching ──────────────────────────────────────
    document.querySelectorAll('.toc-item').forEach(item => {
      item.addEventListener('click', () => {
        const nav = item.dataset.nav;
        if (!nav) return;
        document.querySelectorAll('.toc-item').forEach(t => t.classList.remove('active'));
        item.classList.add('active');
        document.getElementById('nav-global').classList.toggle('hidden', nav !== 'global');
        showNav(nav);
      });
    });

    // Subtab switching via event delegation (Setting | Provider inside OpenCode)
    document.getElementById('backend-settings-container').addEventListener('click', (event) => {
      const subtab = event.target.closest('.subtab');
      if (subtab && subtab.dataset.subtab) {
        const container = document.getElementById('backend-settings-container');
        container.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
        container.querySelectorAll('.subtab-content').forEach(c => c.classList.add('hidden'));
        subtab.classList.add('active');
        const target = document.getElementById('bs-tab-' + subtab.dataset.subtab);
        if (target) { target.classList.remove('hidden'); }
      }
    });

    // Backend chooser
    document.getElementById('btn-backend-chooser').addEventListener('click', () => {
      renderBackendTargets(currentData);
      document.getElementById('backend-chooser-modal').classList.remove('hidden');
    });
    document.getElementById('btn-close-backend-chooser').addEventListener('click', () => {
      document.getElementById('backend-chooser-modal').classList.add('hidden');
    });
    document.getElementById('backend-chooser-modal').addEventListener('click', (event) => {
      if (event.target && event.target.id === 'backend-chooser-modal') {
        document.getElementById('backend-chooser-modal').classList.add('hidden');
      }
    });
    document.getElementById('btn-acp-backend-add').addEventListener('click', () => {
      openAcpTargetModal();
    });
    document.getElementById('btn-open-acp-target-form').addEventListener('click', () => {
      openAcpTargetModal();
    });
    document.getElementById('btn-open-dsh-target-form').addEventListener('click', () => {
      openDshSettings();
    });
    document.getElementById('btn-dsh-save').addEventListener('click', saveDshSettings);
    document.getElementById('btn-dsh-delete').addEventListener('click', deleteDshSettings);
    document.getElementById('btn-dsh-install').addEventListener('click', () => installDshFromSettings('installDsh'));
    document.getElementById('btn-dsh-update').addEventListener('click', () => installDshFromSettings('updateDsh'));
    document.getElementById('btn-cancel-acp-target').addEventListener('click', () => {
      closeAcpTargetModal();
    });
    document.getElementById('btn-save-acp-target').addEventListener('click', saveAcpTargetFromForm);
    document.getElementById('btn-delete-acp-target').addEventListener('click', () => {
      const id = document.getElementById('acp-target-id').value;
      if (!id) return;
      if (!confirm('Delete this ACP target?')) return;
      vscode.postMessage({ type: 'deleteAcpTarget', targetId: id });
      closeAcpTargetModal();
    });
    document.getElementById('acp-target-modal').addEventListener('click', (event) => {
      if (event.target && event.target.id === 'acp-target-modal') {
        closeAcpTargetModal();
      }
    });

    // Click-outside to close dropdowns
    document.addEventListener('click', (event) => {
      const isAgentDropdown = event.target.closest('#agent-dropdown-trigger');
      const isModelDropdown = event.target.closest('#model-dropdown-trigger');
      const isPermissionModeDropdown = event.target.closest('#permission-mode-dropdown-trigger');

      if (isAgentDropdown) {
        document.getElementById('agent-dropdown-panel').classList.toggle('open');
        document.getElementById('model-dropdown-panel').classList.remove('open');
        document.getElementById('permission-mode-dropdown-panel').classList.remove('open');
      } else if (isModelDropdown) {
        document.getElementById('model-dropdown-panel').classList.toggle('open');
        document.getElementById('agent-dropdown-panel').classList.remove('open');
        document.getElementById('permission-mode-dropdown-panel').classList.remove('open');
      } else if (isPermissionModeDropdown) {
        document.getElementById('permission-mode-dropdown-panel').classList.toggle('open');
        document.getElementById('agent-dropdown-panel').classList.remove('open');
        document.getElementById('model-dropdown-panel').classList.remove('open');
      } else if (!event.target.closest('.dropdown-panel')) {
        document.getElementById('agent-dropdown-panel').classList.remove('open');
        document.getElementById('model-dropdown-panel').classList.remove('open');
        document.getElementById('permission-mode-dropdown-panel').classList.remove('open');
      }
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'updateData') {
        currentData = msg.data;
        renderData(msg.data);
        renderProviders();
        renderGlobalSettings(msg.data.globalSettings);
      } else if (msg.type === 'error') {
        setDshStatus(msg.message || 'Request failed');
      }
    });

    function renderBackendTargets(data) {
      const targets = data?.backendTargets || [];
      const active = targets.find(t => t.active) || targets[0];
      document.getElementById('backend-target-name').textContent = active?.name || data?.backendName || 'Backend';
      const meta = document.querySelector('.backend-meta');
      if (meta) {
        meta.textContent = active?.kind === 'acp'
          ? (active.endpoint || active.description || 'ACP remote target')
          : active?.kind === 'dsh'
            ? (active.launchCwd || active.command || active.description || 'DSH target')
            : (active?.description || 'Current backend target');
      }

      const list = document.getElementById('backend-target-list');
      if (!list) return;
      list.innerHTML = '';

      if (targets.length === 0) {
        list.innerHTML = '<div class="empty-state">No targets available.</div>';
        return;
      }

      targets.forEach(target => {
        const row = document.createElement('div');
        row.className = 'list-card-item target-row' + (target.active ? ' selected' : '');

        const main = document.createElement('div');
        main.className = 'target-row-main';
        main.innerHTML =
          '<div class="item-title">' + escapeHtml(target.name) + '</div>' +
          '<div class="item-meta">' + escapeHtml(target.endpoint || target.description || '') + '</div>';
        main.addEventListener('click', () => selectBackendTarget(target.id));
        row.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'target-row-actions';

        if (!target.active) {
          const useBtn = document.createElement('button');
          useBtn.className = 'button-secondary';
          useBtn.textContent = 'Use';
          useBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            selectBackendTarget(target.id);
          });
          actions.appendChild(useBtn);
        }

        if (target.editable) {
          const editBtn = document.createElement('button');
          editBtn.className = 'button-secondary';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (target.kind === 'dsh') {
              openDshSettings(target);
            } else {
              openAcpTargetModal(target);
            }
          });
          actions.appendChild(editBtn);
        }

        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    function showNav(nav) {
      document.querySelectorAll('.toc-item').forEach(item => item.classList.toggle('active', item.dataset.nav === nav));
      document.querySelectorAll('.settings-body-inner').forEach(section => section.classList.toggle('hidden', section.id !== 'nav-' + nav));
    }

    function selectBackendTarget(targetId) {
      vscode.postMessage({ type: 'setBackendTarget', targetId });
      document.getElementById('backend-chooser-modal').classList.add('hidden');
      showNav(targetId.startsWith('dsh:') || targetId === 'builtin:dsh' ? 'dsh' : targetId.startsWith('builtin:opencode') ? 'opencode' : 'global');
    }

    function fillDshSettings(target) {
      const value = target || currentData?.dshTarget || {};
      const targetId = value.id?.replace(/^dsh:/, '') || value.id || '';
      document.getElementById('dsh-target-id').value = targetId;
      document.getElementById('btn-dsh-delete').classList.toggle('hidden', !targetId);
      document.getElementById('dsh-target-name').value = value.name || 'DeepSeek Harness';
      document.getElementById('dsh-command').value = value.command || 'dsh';
      document.getElementById('dsh-args').value = (value.args || ['--profile', 'acp']).join('\n');
      document.getElementById('dsh-launch-cwd').value = value.launchCwd || '';
      document.getElementById('dsh-install-directory').value = value.installDirectory || '';
      document.getElementById('dsh-package-spec').value = value.packageSpec || '@deepseek-ai/dsh@latest';
    }

    function openDshSettings(target) {
      document.getElementById('backend-chooser-modal').classList.add('hidden');
      if (target) {
        fillDshSettings(target);
      } else {
        const defaults = { ...(currentData?.dshTarget || {}), id: undefined };
        fillDshSettings(defaults);
      }
      showNav('dsh');
    }

    function readDshSettings() {
      return {
        targetId: document.getElementById('dsh-target-id').value.trim() || undefined,
        name: document.getElementById('dsh-target-name').value.trim() || undefined,
        command: document.getElementById('dsh-command').value.trim(),
        args: document.getElementById('dsh-args').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        launchCwd: document.getElementById('dsh-launch-cwd').value.trim(),
        installDirectory: document.getElementById('dsh-install-directory').value.trim(),
        packageSpec: document.getElementById('dsh-package-spec').value.trim() || undefined,
      };
    }

    function saveDshSettings() {
      const value = readDshSettings();
      if (!value.command || !value.launchCwd) {
        alert('DSH command and launch directory are required');
        return;
      }
      vscode.postMessage({
        type: value.targetId ? 'updateDshTarget' : 'createDshTarget',
        ...(value.targetId ? { targetId: value.targetId } : {}),
        name: value.name,
        command: value.command,
        args: value.args,
        launchCwd: value.launchCwd,
        installDirectory: value.installDirectory || undefined,
        packageSpec: value.packageSpec,
      });
      setDshStatus('Saving DSH target...');
    }

    function deleteDshSettings() {
      const targetId = document.getElementById('dsh-target-id').value.trim();
      if (!targetId || !confirm('Delete this DSH target?')) return;
      vscode.postMessage({ type: 'deleteDshTarget', targetId });
      fillDshSettings({});
      setDshStatus('Deleting DSH target...');
    }

    function installDshFromSettings(operation) {
      const value = readDshSettings();
      if (!value.installDirectory || !value.launchCwd) {
        alert('Install directory and launch directory are required');
        return;
      }
      vscode.postMessage({
        type: operation,
        targetId: value.targetId,
        name: value.name,
        command: value.command || 'dsh',
        args: value.args,
        launchCwd: value.launchCwd,
        installDirectory: value.installDirectory,
        packageSpec: value.packageSpec,
      });
      setDshStatus(operation === 'installDsh' ? 'Installing DSH...' : 'Updating DSH...');
    }

    function setDshStatus(message) {
      const status = document.getElementById('dsh-status');
      if (status) status.textContent = message || '';
    }

    function openAcpTargetModal(target) {
      document.getElementById('acp-target-modal-title').textContent = target ? 'Edit ACP Target' : 'Add ACP Target';
      document.getElementById('acp-target-id').value = target?.kind === 'acp'
        ? target.id.replace(/^acp:/, '')
        : '';
      document.getElementById('acp-target-name').value = target?.name || '';
      document.getElementById('acp-target-endpoint').value = target?.endpoint || '';
      document.getElementById('acp-target-token').value = '';
      document.getElementById('btn-delete-acp-target').classList.toggle('hidden', !target || target.kind !== 'acp');
      document.getElementById('backend-chooser-modal').classList.add('hidden');
      document.getElementById('acp-target-modal').classList.remove('hidden');
    }

    function closeAcpTargetModal() {
      document.getElementById('acp-target-modal').classList.add('hidden');
      document.getElementById('acp-target-id').value = '';
      document.getElementById('acp-target-name').value = '';
      document.getElementById('acp-target-endpoint').value = '';
      document.getElementById('acp-target-token').value = '';
    }

    function saveAcpTargetFromForm() {
      const id = document.getElementById('acp-target-id').value.trim();
      const name = document.getElementById('acp-target-name').value.trim();
      const endpoint = document.getElementById('acp-target-endpoint').value.trim();
      const authToken = document.getElementById('acp-target-token').value.trim();
      if (!endpoint) {
        alert('Endpoint is required');
        return;
      }
      if (!/^wss?:\\/\\//i.test(endpoint)) {
        alert('Endpoint must start with ws:// or wss://');
        return;
      }
      vscode.postMessage({
        type: id ? 'updateAcpTarget' : 'createAcpTarget',
        ...(id ? { targetId: id } : {}),
        name: name || undefined,
        endpoint,
        authToken: authToken || undefined,
      });
      closeAcpTargetModal();
    }

    function renderDshSettings(data) {
      if (!data?.dshTarget) return;
      const activeElement = document.activeElement;
      const dshIds = ['dsh-target-id', 'dsh-target-name', 'dsh-command', 'dsh-args', 'dsh-launch-cwd', 'dsh-install-directory', 'dsh-package-spec'];
      if (activeElement && dshIds.includes(activeElement.id)) return;
      fillDshSettings(data.dshTarget);
    }

    function renderData(data) {
      renderBackendTargets(data);

      const agentSelected = document.getElementById('agent-dropdown-selected');
      const agentPanel = document.getElementById('agent-dropdown-panel');
      agentPanel.innerHTML = '';

      let currentAgentName = 'Select Agent';
      let currentAgentMeta = '...';

      (data.agents || []).filter(a => !a.hidden && a.mode !== 'subagent').forEach(a => {
        const isSelected = a.id === data.currentAgent;
        if (isSelected) {
          currentAgentName = a.name || a.id;
          currentAgentMeta = a.description || a.mode || '';
        }
        const item = document.createElement('div');
        item.className = 'list-card-item' + (isSelected ? ' selected' : '');
        item.innerHTML = '<div class="item-title">' + escapeHtml(a.name || a.id) + '</div>' +
          '<div class="item-meta">' + escapeHtml(a.description || a.mode || '') + '</div>';
        item.onclick = (e) => {
          e.stopPropagation();
          document.getElementById('agent-dropdown-panel').classList.remove('open');
          vscode.postMessage({ type: 'setAgent', agentId: a.id });
        };
        agentPanel.appendChild(item);
      });

      // Collapsed trigger shows only the selected title (description is shown
      // inside the expanded dropdown panel on each option).
      agentSelected.innerHTML = '<div class="item-title">' + escapeHtml(currentAgentName) + '</div>';

      const permissionModeOptions = [
        { value: 'full-edit', label: 'Full access', description: 'Allow editing, execution, and subagents without prompting' },
        { value: 'approval', label: 'Ask', description: 'Ask before editing, execution, and subagent operations' },
        { value: 'read-only', label: 'Read-only', description: 'Disallow editing, execution, and subagent operations' },
      ];
      const permissionModePanel = document.getElementById('permission-mode-dropdown-panel');
      const permissionModeSelected = document.getElementById('permission-mode-dropdown-selected');
      permissionModePanel.innerHTML = '';
      const currentPermissionMode = data.currentPermissionMode === 'full-edit'
        || data.currentPermissionMode === 'read-only'
        || data.currentPermissionMode === 'approval'
        ? data.currentPermissionMode
        : 'approval';
      permissionModeOptions.forEach(option => {
        const isSelected = option.value === currentPermissionMode;
        const item = document.createElement('div');
        item.className = 'list-card-item' + (isSelected ? ' selected' : '');
        item.innerHTML = '<div class="item-title">' + escapeHtml(option.label) + '</div>' +
          '<div class="item-meta">' + escapeHtml(option.description) + '</div>';
        item.onclick = (e) => {
          e.stopPropagation();
          permissionModePanel.classList.remove('open');
          vscode.postMessage({ type: 'setPermissionMode', permissionMode: option.value });
        };
        permissionModePanel.appendChild(item);
      });
      permissionModeSelected.innerHTML = '<div class="item-title">'
        + escapeHtml(permissionModeOptions.find(option => option.value === currentPermissionMode)?.label ?? 'Ask') + '</div>';

      const modelSelected = document.getElementById('model-dropdown-selected');
      const modelPanel = document.getElementById('model-dropdown-panel');
      modelPanel.innerHTML = '';

      let currentModelName = data.currentModelDisplayName || data.defaultModel || 'Select Model';
      let currentModelMeta = '...';
      const currentModelId = (data.currentModel && data.currentModel.modelID) || data.defaultModel;

      if (!data.models || data.models.length === 0) {
        modelPanel.innerHTML = '<div class="empty-state">No models available from the current backend configuration.</div>';
      } else {
        data.models.forEach(m => {
          let isSelected = false;
          if (currentModelId) {
            isSelected = m.id === currentModelId;
            if (!isSelected && currentModelId.includes('/')) {
              isSelected = m.id === currentModelId.split('/').pop();
            }
            if (!isSelected && m.id.includes('/')) {
              isSelected = m.id.split('/').pop() === currentModelId;
            }
            if (!isSelected) {
              isSelected = m.id.includes(currentModelId) || currentModelId.includes(m.id);
            }
          }
          if (isSelected) {
            currentModelName = m.name || m.id;
            currentModelMeta = m.provider || 'Unknown provider';
          }
          const item = document.createElement('div');
          item.className = 'list-card-item' + (isSelected ? ' selected' : '');
          item.innerHTML = '<div class="item-title">' + escapeHtml(m.name || m.id) + '</div>' +
            '<div class="item-meta">' + escapeHtml(m.provider || 'Unknown provider') + '</div>';
          item.onclick = (e) => {
            e.stopPropagation();
            document.getElementById('model-dropdown-panel').classList.remove('open');
            vscode.postMessage({ type: 'setModel', providerID: m.providerId || '', modelID: m.id });
          };
          modelPanel.appendChild(item);
        });
      }

      modelSelected.innerHTML = '<div class="item-title">' + escapeHtml(currentModelName) + '</div>';

      // Render backend-specific settings from descriptor (OpenCode nav)
      renderBackendSettings(data.backendSettings, data);
      renderDshSettings(data);
    }

    // =========================================================================
    // Global extension settings rendering (acpilot.experimental.*)
    // =========================================================================

    function renderGlobalSettings(items) {
      const container = document.getElementById('global-settings-container');
      if (!container) return;
      container.innerHTML = '';

      if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-state">No global settings available.</div>';
        return;
      }

      items.forEach(item => {
        const row = document.createElement('div');

        if (item.type === 'select') {
          // text/select: label / desc / control stacked
          row.className = 'setting-item';
          const label = document.createElement('div');
          label.className = 'setting-label';
          label.textContent = item.label;
          row.appendChild(label);
          if (item.description) {
            const desc = document.createElement('div');
            desc.className = 'setting-desc';
            desc.textContent = item.description;
            row.appendChild(desc);
          }
          const control = document.createElement('div');
          control.className = 'setting-control';
          const select = document.createElement('select');
          (item.options || []).forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === String(item.value)) option.selected = true;
            select.appendChild(option);
          });
          select.onchange = () => vscode.postMessage({ type: 'setGlobalSetting', key: item.key, value: select.value });
          control.appendChild(select);
          row.appendChild(control);
        } else {
          // bool: label on top, then [toggle] + desc inline
          row.className = 'setting-item is-bool';
          const label = document.createElement('div');
          label.className = 'setting-label';
          label.textContent = item.label;
          row.appendChild(label);

          const boolRow = document.createElement('div');
          boolRow.className = 'setting-bool-row';
          const toggle = document.createElement('input');
          toggle.type = 'checkbox';
          toggle.className = 'setting-toggle';
          toggle.checked = Boolean(item.value);
          toggle.onchange = () => vscode.postMessage({ type: 'setGlobalSetting', key: item.key, value: toggle.checked });
          boolRow.appendChild(toggle);
          if (item.description) {
            const desc = document.createElement('div');
            desc.className = 'setting-desc';
            desc.textContent = item.description;
            boolRow.appendChild(desc);
          }
          row.appendChild(boolRow);
        }
        container.appendChild(row);
      });
    }

    // =========================================================================
    // Dynamic backend settings rendering
    // =========================================================================

    function renderBackendSettings(descriptor, data) {
      const container = document.getElementById('backend-settings-container');
      container.innerHTML = '';

      if (!descriptor || !descriptor.tabs || descriptor.tabs.length === 0) {
        container.innerHTML = '<div class="empty-state">No backend-specific settings available for the current backend.</div>';
        return;
      }

      // Build subtabs: always show Setting | Provider
      const subtabs = document.createElement('div');
      subtabs.className = 'subtabs';
      descriptor.tabs.forEach((tab, i) => {
        const subtab = document.createElement('div');
        subtab.className = 'subtab' + (i === 0 ? ' active' : '');
        subtab.dataset.subtab = tab.id;
        subtab.textContent = tab.title;
        subtabs.appendChild(subtab);
      });
      container.appendChild(subtabs);

      // Create tab content sections
      descriptor.tabs.forEach((tab, tabIndex) => {
        const section = document.createElement('section');
        section.id = 'bs-tab-' + tab.id;
        section.className = 'subtab-content' + (tabIndex > 0 ? ' hidden' : '');

        if (tab.id === 'provider') {
          renderProviderContent(section);
        } else {
          // ── Setting tab: Default FIRST, then backend groups ──
          renderDefaultBlock(section, data);

          tab.groups.forEach(group => {
            const groupEl = renderGroup(group, descriptor.values);
            section.appendChild(groupEl);
          });

          // Save button
          const saveRow = document.createElement('div');
          saveRow.className = 'section-actions';
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save Configuration';
          saveBtn.addEventListener('click', () => {
            const values = collectBackendSettings();
            vscode.postMessage({ type: 'saveBackendSettings', values });
          });
          saveRow.appendChild(saveBtn);
          section.appendChild(saveRow);
        }

        container.appendChild(section);
      });
    }

    // Render the Default block (Default Agent / Default Model) as a collapsible
    // section — same pattern as the "Override" group so both are peer-level
    // L1 headers with indented content underneath.
    function renderDefaultBlock(section, data) {
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Default';
      details.appendChild(summary);

      const wrapper = document.createElement('div');
      wrapper.className = 'details-content';

      // Default Agent
      const agentRow = document.createElement('div');
      agentRow.className = 'setting-item';
      const agentText = document.createElement('div');
      agentText.className = 'setting-text';
      agentText.innerHTML = '<div class="setting-label">Default Agent</div><div class="setting-desc">Agent used when starting new sessions</div>';
      agentRow.appendChild(agentText);
      const agentCtrl = document.createElement('div');
      agentCtrl.className = 'setting-control';
      const selDefaultAgent = document.createElement('select');
      selDefaultAgent.id = 'sel-default-agent';
      const noneOptA = document.createElement('option');
      noneOptA.value = ''; noneOptA.textContent = '(none)';
      selDefaultAgent.appendChild(noneOptA);
      (data.agents || []).filter(a => !a.hidden && a.mode !== 'subagent').forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name || a.id;
        if (a.id === data.defaultAgent) opt.selected = true;
        selDefaultAgent.appendChild(opt);
      });
      selDefaultAgent.onchange = () => vscode.postMessage({ type: 'setDefaultAgent', agent: selDefaultAgent.value });
      agentCtrl.appendChild(selDefaultAgent);
      agentRow.appendChild(agentCtrl);
      wrapper.appendChild(agentRow);

      // Permission mode applies to requests made with the selected Agent and
      // is shared with the Current Session control above.
      const permissionRow = document.createElement('div');
      permissionRow.className = 'setting-item';
      const permissionText = document.createElement('div');
      permissionText.className = 'setting-text';
      permissionText.innerHTML = '<div class="setting-label">Permissions</div><div class="setting-desc">Permission scope used for Agent requests</div>';
      permissionRow.appendChild(permissionText);
      const permissionCtrl = document.createElement('div');
      permissionCtrl.className = 'setting-control';
      const selPermissionMode = document.createElement('select');
      selPermissionMode.id = 'sel-default-permission-mode';
      [
        { value: 'full-edit', label: 'Full access' },
        { value: 'approval', label: 'Ask' },
        { value: 'read-only', label: 'Read-only' },
      ].forEach(option => {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label;
        if (option.value === (data.currentPermissionMode === 'full-edit'
          || data.currentPermissionMode === 'read-only'
          || data.currentPermissionMode === 'approval'
          ? data.currentPermissionMode
          : 'approval')) {
          item.selected = true;
        }
        selPermissionMode.appendChild(item);
      });
      selPermissionMode.onchange = () => vscode.postMessage({
        type: 'setPermissionMode',
        permissionMode: selPermissionMode.value,
      });
      permissionCtrl.appendChild(selPermissionMode);
      permissionRow.appendChild(permissionCtrl);
      wrapper.appendChild(permissionRow);

      // Default Model
      const modelRow = document.createElement('div');
      modelRow.className = 'setting-item';
      const modelText = document.createElement('div');
      modelText.className = 'setting-text';
      modelText.innerHTML = '<div class="setting-label">Default Model</div><div class="setting-desc">Model used when no model is specified per-agent</div>';
      modelRow.appendChild(modelText);
      const modelCtrl = document.createElement('div');
      modelCtrl.className = 'setting-control';
      const selDefaultModel = document.createElement('select');
      selDefaultModel.id = 'sel-default-model';
      const noneOptM = document.createElement('option');
      noneOptM.value = ''; noneOptM.textContent = '(none)';
      selDefaultModel.appendChild(noneOptM);
      (data.models || []).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = (m.name || m.id) + (m.provider ? ' (' + m.provider + ')' : '');
        if (m.id === data.defaultModel) opt.selected = true;
        selDefaultModel.appendChild(opt);
      });
      selDefaultModel.onchange = () => vscode.postMessage({ type: 'setDefaultModel', model: selDefaultModel.value });
      modelCtrl.appendChild(selDefaultModel);
      modelRow.appendChild(modelCtrl);
      wrapper.appendChild(modelRow);

      details.appendChild(wrapper);
      section.appendChild(details);
    }

    function renderProviderContent(section) {
      const title = document.createElement('div');
      title.className = 'group-title';
      title.style.display = 'flex';
      title.style.alignItems = 'center';
      title.style.justifyContent = 'space-between';
      const titleText = document.createElement('span');
      titleText.textContent = 'Provider';
      title.appendChild(titleText);

      const addBtn = document.createElement('button');
      addBtn.className = 'provider-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add provider';
      addBtn.addEventListener('click', openAddProviderModal);
      title.appendChild(addBtn);

      section.appendChild(title);

      const list = document.createElement('div');
      list.className = 'provider-list';
      list.id = 'provider-list';
      section.appendChild(list);

      renderProviders();
    }

    function renderProviders() {
      const list = document.getElementById('provider-list');
      if (!list) return;
      list.innerHTML = '';

      const connected = currentData?.connectedProviders || [];

      if (connected.length === 0) {
        list.innerHTML = '<div class="empty-state">No providers connected yet. Click + to add one.</div>';
        return;
      }

      connected.forEach(p => {
        const card = document.createElement('div');
        card.className = 'provider-item';
        card.innerHTML =
          '<div class="provider-item-header">' +
            '<span class="provider-item-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="provider-item-status">Connected</span>' +
          '</div>' +
          '<div class="provider-item-actions">' +
            '<button class="button-secondary provider-edit-btn" data-configkey="' + escapeHtml(p.configKey) + '" data-id="' + escapeHtml(p.id) + '">Edit</button>' +
            '<button class="button-secondary provider-disconnect-btn" data-configkey="' + escapeHtml(p.configKey) + '" data-id="' + escapeHtml(p.id) + '" style="color:#f48771; border-color:#f48771;">Disconnect</button>' +
          '</div>';
        list.appendChild(card);
      });

      list.querySelectorAll('.provider-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditProviderModal(btn.dataset.configkey, btn.dataset.id);
        });
      });

      list.querySelectorAll('.provider-disconnect-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          disconnectProvider(btn.dataset.configkey);
        });
      });
    }

    // =========================================================================
    // Provider modals and interactions
    // =========================================================================

    let selectedAddProviderId = null;

    function openAddProviderModal() {
      if (!currentData?.availableProviders) return;

      const grid = document.getElementById('add-provider-grid');
      grid.innerHTML = '';

      const connectedIds = new Set((currentData.connectedProviders || []).map(p => p.id));
      const available = currentData.availableProviders.filter(p => !connectedIds.has(p.id));
      if (available.length === 0) {
        grid.innerHTML = '<div class="empty-state">All supported providers are already connected.</div>';
      } else {
        available.forEach(p => {
          const item = document.createElement('div');
          item.className = 'provider-option';
          item.dataset.providerId = p.id;
          item.innerHTML =
            '<div class="provider-option-name">' + escapeHtml(p.name) + '</div>' +
            (p.description ? '<div class="provider-option-desc">' + escapeHtml(p.description) + '</div>' : '');
          item.addEventListener('click', () => selectProviderOption(p.id));
          grid.appendChild(item);
        });
      }

      document.getElementById('add-provider-form-section').classList.add('hidden');
      selectedAddProviderId = null;
      document.getElementById('add-provider-apikey').value = '';
      document.getElementById('add-provider-baseurl').value = '';
      document.getElementById('add-provider-baseurl-field').classList.add('hidden');
      grid.querySelectorAll('.provider-option.selected').forEach(el => el.classList.remove('selected'));

      document.getElementById('add-provider-modal').classList.remove('hidden');
    }

    function selectProviderOption(providerId) {
      const grid = document.getElementById('add-provider-grid');
      grid.querySelectorAll('.provider-option').forEach(el => {
        el.classList.toggle('selected', el.dataset.providerId === providerId);
      });

      selectedAddProviderId = providerId;

      const form = document.getElementById('add-provider-form-section');
      form.classList.remove('hidden');

      const available = (currentData?.availableProviders || []);
      const provider = available.find(p => p.id === providerId);
      const baseURLField = document.getElementById('add-provider-baseurl-field');
      if (provider?.requiresBaseURL) {
        baseURLField.classList.remove('hidden');
      } else {
        baseURLField.classList.add('hidden');
      }
    }

    function submitConnectProvider() {
      if (!selectedAddProviderId) return;
      const apiKey = document.getElementById('add-provider-apikey').value.trim();
      if (!apiKey) { alert('API Key is required'); return; }
      const baseURL = document.getElementById('add-provider-baseurl').value.trim();
      vscode.postMessage({
        type: 'connectProvider',
        providerId: selectedAddProviderId,
        apiKey,
        baseURL: baseURL || undefined,
      });
      document.getElementById('add-provider-modal').classList.add('hidden');
    }

    let editingProviderConfigKey = null;

    function openEditProviderModal(configKey, providerId) {
      if (!currentData?.connectedProviders) return;
      const provider = currentData.connectedProviders.find(p => p.configKey === configKey);
      if (!provider) return;

      editingProviderConfigKey = configKey;
      document.getElementById('edit-provider-apikey').value = '';
      document.getElementById('edit-provider-baseurl').value = '';

      const baseURLField = document.getElementById('edit-provider-baseurl-field');
      if (provider.hasBaseURL || provider.baseURL) {
        baseURLField.classList.remove('hidden');
        document.getElementById('edit-provider-baseurl').value = provider.baseURL || '';
      } else {
        baseURLField.classList.add('hidden');
      }

      document.getElementById('edit-provider-modal').classList.remove('hidden');
    }

    function submitEditProvider() {
      if (!editingProviderConfigKey) return;
      const apiKey = document.getElementById('edit-provider-apikey').value.trim();
      if (!apiKey) { alert('API Key is required'); return; }
      const baseURL = document.getElementById('edit-provider-baseurl').value.trim();
      vscode.postMessage({
        type: 'updateProvider',
        configKey: editingProviderConfigKey,
        apiKey,
        baseURL: baseURL || undefined,
      });
      document.getElementById('edit-provider-modal').classList.add('hidden');
      editingProviderConfigKey = null;
    }

    function disconnectProvider(providerId) {
      if (!confirm('Disconnect this provider? You will need to re-enter the API key to use it again.')) return;
      vscode.postMessage({
        type: 'disconnectProvider',
        configKey: providerId,
      });
    }

    // ── Modal event bindings ────────────────────────────────────────────
    document.getElementById('add-provider-modal').addEventListener('click', (event) => {
      if (event.target.id === 'add-provider-modal') {
        document.getElementById('add-provider-modal').classList.add('hidden');
      }
    });
    document.getElementById('btn-add-provider-connect').addEventListener('click', submitConnectProvider);
    document.getElementById('btn-add-provider-cancel').addEventListener('click', () => {
      document.getElementById('add-provider-modal').classList.add('hidden');
    });
    document.getElementById('btn-edit-provider-save').addEventListener('click', submitEditProvider);
    document.getElementById('btn-edit-provider-cancel').addEventListener('click', () => {
      document.getElementById('edit-provider-modal').classList.add('hidden');
      editingProviderConfigKey = null;
    });
    document.getElementById('btn-edit-provider-disconnect').addEventListener('click', () => {
      if (!editingProviderConfigKey) return;
      disconnectProvider(editingProviderConfigKey);
      document.getElementById('edit-provider-modal').classList.add('hidden');
      editingProviderConfigKey = null;
    });
    document.getElementById('edit-provider-modal').addEventListener('click', (event) => {
      if (event.target.id === 'edit-provider-modal') {
        document.getElementById('edit-provider-modal').classList.add('hidden');
        editingProviderConfigKey = null;
      }
    });

    // =========================================================================

    function renderGroup(group, values) {
      const wrapper = document.createElement('div');

      if (group.collapsible && group.title) {
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = group.title;
        details.appendChild(summary);

        const inner = document.createElement('div');
        inner.className = 'details-content';
        group.fields.forEach(field => inner.appendChild(renderField(field, values)));
        details.appendChild(inner);

        wrapper.appendChild(details);
      } else if (group.title) {
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = group.title;
        wrapper.appendChild(title);
        group.fields.forEach(field => wrapper.appendChild(renderField(field, values)));
      } else {
        group.fields.forEach(field => wrapper.appendChild(renderField(field, values)));
      }

      return wrapper;
    }

    function renderField(field, values) {
      switch (field.type) {
        case 'text': return renderTextField(field, values);
        case 'select': return renderSelectField(field, values);
        case 'toggle': return renderToggleField(field, values);
        case 'info-cards': return renderInfoCards(field);
        case 'map': return renderMapField(field, values);
        default: return document.createElement('div');
      }
    }

    function renderTextField(field, values) {
      const currentValue = getNestedValue(values, field.key) || '';
      const row = document.createElement('div');
      row.className = 'setting-item';

      const text = document.createElement('div');
      text.className = 'setting-text';
      const label = document.createElement('div');
      label.className = 'setting-label';
      label.textContent = field.label;
      text.appendChild(label);
      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'setting-desc';
        desc.textContent = field.description;
        text.appendChild(desc);
      }
      row.appendChild(text);

      const control = document.createElement('div');
      control.className = 'setting-control';
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.bsPath = field.key;
      input.value = String(currentValue);
      if (field.placeholder) input.placeholder = field.placeholder;
      control.appendChild(input);
      row.appendChild(control);
      return row;
    }

    function renderSelectField(field, values) {
      const currentValue = getNestedValue(values, field.key) || '';
      const row = document.createElement('div');
      row.className = 'setting-item';

      const text = document.createElement('div');
      text.className = 'setting-text';
      const label = document.createElement('div');
      label.className = 'setting-label';
      label.textContent = field.label;
      text.appendChild(label);
      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'setting-desc';
        desc.textContent = field.description;
        text.appendChild(desc);
      }
      row.appendChild(text);

      const control = document.createElement('div');
      control.className = 'setting-control';
      const select = document.createElement('select');
      select.dataset.bsPath = field.key;
      (field.options || []).forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === currentValue) option.selected = true;
        select.appendChild(option);
      });
      control.appendChild(select);
      row.appendChild(control);
      return row;
    }

    function renderToggleField(field, values) {
      const currentValue = getNestedValue(values, field.key) || false;
      const row = document.createElement('div');
      row.className = 'setting-item is-bool';

      // Title on its own line
      const label = document.createElement('div');
      label.className = 'setting-label';
      label.textContent = field.label;
      row.appendChild(label);

      // Second line: toggle + description inline
      const boolRow = document.createElement('div');
      boolRow.className = 'setting-bool-row';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'setting-toggle';
      toggle.dataset.bsPath = field.key;
      if (currentValue) toggle.checked = true;
      boolRow.appendChild(toggle);

      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'setting-desc';
        desc.textContent = field.description;
        boolRow.appendChild(desc);
      }
      row.appendChild(boolRow);
      return row;
    }

    function renderInfoCards(field) {
      const grid = document.createElement('div');
      grid.className = 'provider-list';
      (field.items || []).forEach(item => {
        const card = document.createElement('div');
        card.className = 'provider-item';
        const title = document.createElement('div');
        title.className = 'provider-item-name';
        title.textContent = item.title;
        card.appendChild(title);
        (item.details || []).forEach(d => {
          const row = document.createElement('div');
          row.className = 'setting-desc';
          row.innerHTML = '<strong>' + escapeHtml(d.label) + ':</strong> ' + escapeHtml(d.value);
          card.appendChild(row);
        });
        grid.appendChild(card);
      });
      if ((field.items || []).length === 0) {
        grid.innerHTML = '<div class="empty-state">No provider-specific configuration is defined for the current backend.</div>';
      }
      return grid;
    }

    function renderMapField(field, values) {
      const container = document.createElement('div');
      // The map field's label/description is a SUBTITLE under the collapsible
      // group header — rendered smaller so it doesn't compete with the parent.
      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'map-subtitle';
        desc.textContent = field.description;
        container.appendChild(desc);
      } else if (field.label) {
        const desc = document.createElement('div');
        desc.className = 'map-subtitle';
        desc.textContent = field.label;
        container.appendChild(desc);
      }
      (field.items || []).forEach(item => {
        const itemTitle = document.createElement('div');
        itemTitle.className = 'map-item-title';
        itemTitle.textContent = item.label;
        container.appendChild(itemTitle);

        if (item.description) {
          const itemDesc = document.createElement('div');
          itemDesc.className = 'setting-desc';
          itemDesc.style.margin = '0 0 6px';
          itemDesc.textContent = item.description;
          container.appendChild(itemDesc);
        }

        field.fields.forEach(subField => {
          const path = field.key + '.' + item.id + '.' + subField.key;
          const subValues = getNestedValue(values, field.key + '.' + item.id) || {};
          const el = createSubFieldElement(subField, path, subValues);
          container.appendChild(el);
        });
      });
      return container;
    }

    function createSubFieldElement(field, path, values) {
      const currentValue = values[field.key] || '';

      // Bool/toggle: label on top, then [toggle] + desc inline
      if (field.type === 'toggle') {
        const row = document.createElement('div');
        row.className = 'setting-item is-bool';

        const label = document.createElement('div');
        label.className = 'setting-label';
        label.textContent = field.label;
        row.appendChild(label);

        const boolRow = document.createElement('div');
        boolRow.className = 'setting-bool-row';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'setting-toggle';
        toggle.dataset.bsPath = path;
        if (currentValue) toggle.checked = true;
        boolRow.appendChild(toggle);
        if (field.description) {
          const desc = document.createElement('div');
          desc.className = 'setting-desc';
          desc.textContent = field.description;
          boolRow.appendChild(desc);
        }
        row.appendChild(boolRow);
        return row;
      }

      // text/select: label / desc / control stacked
      const row = document.createElement('div');
      row.className = 'setting-item';

      const label = document.createElement('div');
      label.className = 'setting-label';
      label.textContent = field.label;
      row.appendChild(label);
      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'setting-desc';
        desc.textContent = field.description;
        row.appendChild(desc);
      }

      const control = document.createElement('div');
      control.className = 'setting-control';
      if (field.type === 'select') {
        const select = document.createElement('select');
        select.dataset.bsPath = path;
        (field.options || []).forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === currentValue) option.selected = true;
          select.appendChild(option);
        });
        control.appendChild(select);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.bsPath = path;
        input.value = currentValue;
        if (field.placeholder) input.placeholder = field.placeholder;
        control.appendChild(input);
      }
      row.appendChild(control);
      return row;
    }

    // -- Value collection -----------------------------------------------

    function collectBackendSettings() {
      const values = {};
      document.querySelectorAll('[data-bs-path]').forEach(el => {
        const path = el.dataset.bsPath;
        if (!path) return;
        const parts = path.split('.');
        let obj = values;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        const key = parts[parts.length - 1];
        if (el.type === 'checkbox') {
          if (el.checked) obj[key] = el.checked;
        } else {
          if (el.value) obj[key] = el.value;
        }
      });
      return values;
    }

    // -- Helpers --------------------------------------------------------

    function getNestedValue(obj, path) {
      if (!obj || !path) return undefined;
      return path.split('.').reduce((o, k) => o?.[k], obj);
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
