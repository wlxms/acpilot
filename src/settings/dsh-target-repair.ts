import type * as vscode from 'vscode';
import { isAbsolute } from 'node:path';
import { resolveDshLaunch, type DshResolverOptions } from '../backends/dsh/resolver';
import { DEFAULT_DSH_ARGS, DEFAULT_DSH_COMMAND, normalizeDshTarget, type DshTarget } from '../backends/dsh/target';
import { DSH_TARGET_STATE_KEY, loadDshTargetState } from './state-persistence';

/** Correct only the default target whose launch directory is a verified Desktop install. */
export async function repairMisplacedDshDesktopTarget(
  context: vscode.ExtensionContext,
  workspaceDirectory: string | undefined,
  resolverOptions?: DshResolverOptions,
): Promise<DshTarget | undefined> {
  const workspace = workspaceDirectory?.trim();
  if (!workspace || !isAbsolute(workspace)) { return undefined; }
  const state = loadDshTargetState(context);
  const index = state.targets.findIndex(target => target.id === state.activeTargetId);
  const existing = state.targets[index];
  if (!existing
    || existing.command !== DEFAULT_DSH_COMMAND
    || existing.endpoint !== undefined
    || existing.args.length !== DEFAULT_DSH_ARGS.length
    || existing.args.some((argument, position) => argument !== DEFAULT_DSH_ARGS[position])) {
    return undefined;
  }
  const resolution = resolveDshLaunch({
    ...existing, command: existing.launchCwd, launchCwd: workspace,
  }, resolverOptions);
  if (resolution.kind !== 'local' || resolution.source !== 'desktop') { return undefined; }

  const repaired = normalizeDshTarget({
    ...existing, command: existing.launchCwd, launchCwd: workspace,
  }, existing);
  const targets = [...state.targets];
  targets[index] = repaired;
  // Memento updates its live value synchronously. Do not await before this write:
  // activation can already read the repaired launch while persistence completes.
  await context.globalState.update(DSH_TARGET_STATE_KEY, { ...state, targets });
  return repaired;
}
