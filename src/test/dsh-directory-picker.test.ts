import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';

type DirectoryField = 'launchCwd' | 'installDirectory';
type DirectoryPicker = (
  field: DirectoryField,
  currentValue: string,
  workspacePath: string | undefined,
  showOpenDialog: (options: Record<string, unknown>) => Promise<readonly vscode.Uri[] | undefined>,
) => Promise<{ field: DirectoryField; value: string } | undefined>;

describe('DSH directory picker', () => {
  it('uses the current value as the default folder and returns the selected path', async () => {
    const extension = await import('../extension') as unknown as { chooseDshDirectory?: DirectoryPicker };
    expect(typeof extension.chooseDshDirectory).toBe('function');

    let options: Record<string, unknown> | undefined;
    const selected = vscode.Uri.file('D:\\dsh-mydsh\\deepseek-harness');
    const result = await extension.chooseDshDirectory!(
      'launchCwd',
      'D:\\dsh-mydsh\\old-dsh',
      'D:\\acpilot',
      async (nextOptions) => {
        options = nextOptions;
        return [selected];
      },
    );

    expect(options).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file('D:\\dsh-mydsh\\old-dsh'),
    });
    expect(result).toEqual({ field: 'launchCwd', value: selected.fsPath });
  });

  it('returns no update when the user cancels the folder chooser', async () => {
    const extension = await import('../extension') as unknown as { chooseDshDirectory?: DirectoryPicker };
    expect(typeof extension.chooseDshDirectory).toBe('function');

    const result = await extension.chooseDshDirectory!(
      'installDirectory',
      '',
      'D:\\acpilot',
      async () => undefined,
    );

    expect(result).toBeUndefined();
  });
});
