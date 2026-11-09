import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SettingsPanel } from '../settings/panel';

function webview() {
  type Listener = (event: { target: unknown }) => void;
  const elements = new Map<string, ReturnType<typeof element>>();
  const messages: Array<Record<string, unknown>> = [];
  let receive: (event: { data: unknown }) => void = () => {};
  function element(id: string) {
    const listeners = new Map<string, Listener>();
    return {
      id, value: '', textContent: '', innerHTML: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      appendChild() {}, querySelectorAll: () => [],
      listeners,
    };
  }
  function get(id: string) {
    if (!elements.has(id)) { elements.set(id, element(id)); }
    return elements.get(id)!;
  }
  const document = {
    activeElement: null as ReturnType<typeof element> | null,
    getElementById: get, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => element(''), addEventListener() {},
  };
  const html = (Object.create(SettingsPanel.prototype) as { getHtml(): string }).getHtml();
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const context = {
    document,
    window: { addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } },
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message) }),
    alert: (message: string) => { throw new Error(message); },
  };
  runInNewContext(script, context);
  return {
    get, messages,
    send: (data: unknown) => receive({ data }),
    selectTarget: (targetId: string) => {
      document.activeElement = get('btn-backend-chooser');
      runInNewContext(`selectBackendTarget(${JSON.stringify(targetId)})`, context);
    },
    click: (id: string) => {
      document.activeElement = get(id);
      get(id).listeners.get('click')?.({ target: get(id) });
    },
  };
}

const target = {
  id: 'target-a', name: 'DeepSeek Harness', command: 'dsh',
  args: ['--profile', 'acp'], launchCwd: 'D:/workspace',
  installDirectory: 'D:/extension-storage/dsh', packageSpec: '@deepseek-ai/dsh@latest',
};
const desktopPath = 'C:/Users/Administrator/AppData/Local/Programs/DSH Desktop';
function update(ui: ReturnType<typeof webview>, dshTarget = target) {
  ui.send({ type: 'updateData', data: { dshTarget, agents: [], models: [], config: {} } });
}

describe('DSH settings draft across background refreshes', () => {
  it('retains a browsed Desktop command after focus returns to Browse and starts with that command', () => {
    const ui = webview();
    update(ui);
    ui.click('btn-dsh-desktop-browse');
    expect(ui.messages.at(-1)).toMatchObject({ type: 'selectDirectory', field: 'command', currentValue: 'dsh' });
    ui.send({ type: 'directorySelected', field: 'command', value: desktopPath });
    update(ui);

    expect(ui.get('dsh-command').value).toBe(desktopPath);
    ui.click('btn-dsh-start');
    expect(ui.messages.at(-1)).toMatchObject({
      type: 'startDsh', targetId: 'target-a', command: desktopPath,
      args: ['--profile', 'acp'], launchCwd: 'D:/workspace',
    });
  });

  it('retains edited launch fields after blur so Save submits the draft', () => {
    const ui = webview();
    update(ui);
    ui.get('dsh-command').value = desktopPath;
    ui.get('dsh-launch-cwd').value = 'D:/another-workspace';
    ui.click('btn-backend-chooser');
    update(ui);
    ui.click('btn-dsh-save');

    expect(ui.messages.at(-1)).toMatchObject({
      type: 'updateDshTarget', targetId: 'target-a', command: desktopPath,
      launchCwd: 'D:/another-workspace',
    });
  });

  it('accepts a saved target response and protects subsequent edits against its refresh', () => {
    const ui = webview();
    update(ui);
    ui.get('dsh-command').value = desktopPath;
    ui.click('btn-dsh-save');
    update(ui, { ...target, command: desktopPath });
    ui.get('dsh-launch-cwd').value = 'D:/another-workspace';
    update(ui, { ...target, command: desktopPath });

    expect(ui.get('dsh-command').value).toBe(desktopPath);
    expect(ui.get('dsh-launch-cwd').value).toBe('D:/another-workspace');
  });

  it('loads another selected target even when the previous form has unsaved edits', () => {
    const ui = webview();
    update(ui);
    ui.get('dsh-command').value = desktopPath;
    update(ui, { ...target, id: 'target-b', command: 'D:/tools/custom-dsh.cmd' });

    expect(ui.get('dsh-target-id').value).toBe('target-b');
    expect(ui.get('dsh-command').value).toBe('D:/tools/custom-dsh.cmd');
  });

  it('keeps a new target draft through refresh and adopts its id after creation', () => {
    const ui = webview();
    update(ui);
    ui.click('btn-open-dsh-target-form');
    ui.get('dsh-command').value = desktopPath;
    update(ui);
    ui.click('btn-dsh-save');

    expect(ui.messages.at(-1)).toMatchObject({ type: 'createDshTarget', command: desktopPath });
    update(ui, { ...target, id: 'target-new', command: desktopPath });
    expect(ui.get('dsh-target-id').value).toBe('target-new');
    expect(ui.get('dsh-command').value).toBe(desktopPath);
  });

  it('keeps the new target intent when its default fields have not been edited', () => {
    const ui = webview();
    update(ui);
    ui.click('btn-open-dsh-target-form');
    update(ui);
    ui.click('btn-dsh-save');

    expect(ui.messages.at(-1)).toMatchObject({ type: 'createDshTarget', command: 'dsh' });
  });

  it('loads the current saved target when the user explicitly reselects it from a new draft', () => {
    const ui = webview();
    update(ui);
    ui.click('btn-open-dsh-target-form');
    ui.get('dsh-command').value = desktopPath;
    ui.selectTarget('dsh:target-a');
    update(ui);
    ui.click('btn-dsh-save');

    expect(ui.messages.at(-1)).toMatchObject({
      type: 'updateDshTarget', targetId: 'target-a', command: 'dsh',
    });
  });
});
