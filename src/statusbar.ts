/**
 * Status bar controller — single item, markdown table tooltip.
 *
 * Multi-backend aware: tracks the latest state per backend and renders only
 * the explicitly active backend. State refreshes do not change backend focus.
 *
 * Status bar: $(acpilot-a) (icon only)
 * Hover: markdown table | Backend | Agent | Model |
 * Click: acpilot.openSettings
 */
import * as vscode from 'vscode';

export interface StatusBarState {
  backendName: string;
  agentName: string;
  modelName: string;
  isBackendActive: boolean;
}

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Latest known state per backend id. */
  private readonly states = new Map<string, StatusBarState>();
  /** Backend currently rendered in the status bar (last one used). */
  private activeBackendId: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.text = '$(acpilot-a)';
    this.item.command = 'acpilot.openSettings';
    this.item.name = 'ACP';
    this.item.show();
  }

  /** Record state without allowing startup order to steal active-backend focus. */
  update(backendId: string, state: StatusBarState): void {
    this.states.set(backendId, state);
    this.activeBackendId ??= backendId;
    this.render();
  }

  /** Switch the active backend (e.g. on selection-changed) without new state. */
  setActiveBackend(backendId: string): void {
    if (this.activeBackendId === backendId) {return;}
    this.activeBackendId = backendId;
    this.render();
  }

  /** Re-render the current active backend (no-op if none recorded). */
  refresh(): void {
    this.render();
  }

  /** Record a backend failure without changing an already active backend. */
  updateError(backendId: string, backendName: string): void {
    this.update(backendId, {
      backendName,
      agentName: '--',
      modelName: '--',
      isBackendActive: false,
    });
  }

  private render(): void {
    const state = this.activeBackendId ? this.states.get(this.activeBackendId) : undefined;
    if (!state) {return;}

    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const name = state.isBackendActive
      ? state.backendName
      : `${state.backendName} (offline)`;

    md.appendMarkdown(`**ACP Copilot**\n\n`);
    md.appendMarkdown(`| Backend | Agent | Model |\n`);
    md.appendMarkdown(`|---------|-------|-------|\n`);
    md.appendMarkdown(`| ${name} | ${state.agentName} | ${state.modelName} |`);

    this.item.tooltip = md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
