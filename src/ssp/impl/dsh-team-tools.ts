import type { SerializableToolState } from '../types';
import type { ChatSimpleToolResultData } from '../../types/vscode-proposed-additions';

type TeamToolName = 'team_task_create' | 'team_task_update' | 'wait_agent' | 'send_message';

interface TeamToolPresentation {
  invocationMessage: string;
  pastTenseMessage: string;
  data: ChatSimpleToolResultData;
}

const taskActions: Record<string, { label: string; running: string; completed: string }> = {
  claim: { label: 'Claim', running: 'Claiming', completed: 'Claimed' },
  release: { label: 'Release', running: 'Releasing', completed: 'Released' },
  edit: { label: 'Edit', running: 'Editing', completed: 'Edited' },
  set_dependencies: { label: 'Set dependencies', running: 'Setting dependencies for', completed: 'Set dependencies for' },
  complete: { label: 'Complete', running: 'Completing', completed: 'Completed' },
  reopen: { label: 'Reopen', running: 'Reopening', completed: 'Reopened' },
  reassign: { label: 'Reassign', running: 'Reassigning', completed: 'Reassigned' },
  delete: { label: 'Delete', running: 'Deleting', completed: 'Deleted' },
};

const taskStatuses: Record<string, string> = {
  pending: 'Pending', in_progress: 'In progress', completed: 'Completed', deleted: 'Deleted',
};

const taskActionStatuses: Record<string, string> = {
  claim: 'in_progress', release: 'pending', complete: 'completed', reopen: 'pending', delete: 'deleted',
};

/** Team board changes and mailbox receipts are simple cards, never root todos or subagent results. */
export function buildDshTeamToolPresentation(
  state: SerializableToolState,
): TeamToolPresentation | undefined {
  // The same tool names may belong to OpenCode or another ACP backend. Only
  // DSH-owned metadata, also persisted with history, identifies this protocol.
  const name = state.metadata?.dshToolName;
  if (!isTeamToolName(name)) {return undefined;}
  const input = isRecord(state.input) ? state.input : {};
  const output = typeof state.output === 'string' ? state.output : '';
  const result = parseResult(output);
  const isError = state.status === 'error';
  const error = state.error || output || 'No failure details were supplied.';
  const active = state.status === 'running' || state.status === 'pending';

  if (name === 'team_task_create' || name === 'team_task_update') {
    const action = text(input.action);
    const transition = action && Object.prototype.hasOwnProperty.call(taskActions, action) ? taskActions[action] : undefined;
    const task = result && text(result.id) && text(result.subject)
      && typeof result.revision === 'number' && Number.isSafeInteger(result.revision)
      && typeof result.status === 'string' && Object.prototype.hasOwnProperty.call(taskStatuses, result.status)
      ? result : undefined;
    const subject = text(task?.subject) ?? text(input.subject);
    const taskId = text(task?.id) ?? text(input.task_id);
    const confirmsAction = !!task && !!transition
      && (!taskActionStatuses[action!] || task.status === taskActionStatuses[action!]);
    const completedVerb = name === 'team_task_create'
      ? task ? 'Created' : 'Finished creating'
      : confirmsAction ? transition!.completed : task ? 'Updated' : 'Finished updating';
    const label = short(subject ?? taskId ?? 'shared task');
    const invocationMessage = name === 'team_task_create'
      ? 'Creating team task: ' + label
      : (transition?.running ?? 'Updating') + ' team task: ' + label;
    const pastTenseMessage = isError
      ? (name === 'team_task_create' ? 'Team task creation' : 'Team task update') + ' failed: ' + label
      : completedVerb + ' team task: ' + label;
    const args = [
      line('Task', text(input.task_id)), line('Title', text(input.subject)),
      line('Action', transition?.label ?? action), line('Expected revision', number(input.expected_revision)),
      line('Owner', text(input.owner)), line('Blocked by', list(input.blocked_by)),
      line('Write scopes', list(input.write_scopes)), line('Description', text(input.description)),
    ].filter(Boolean).join('\n');
    const taskStatus = text(task?.status);
    const details = task ? [
      line('Task', text(task.id)), line('Title', text(task.subject)),
      line('Status', taskStatus ? taskStatuses[taskStatus] ?? taskStatus : 'Unknown'),
      line('Owner', text(task.ownerName) ?? 'Unassigned'), line('Revision', number(task.revision)),
      line('Ready', typeof task.ready === 'boolean' ? task.ready ? 'Yes' : 'No' : undefined),
      line('Blocked by', list(task.blockedBy)), line('Write scopes', list(task.writeScopes)),
      line('Write scope warnings', list(task.writeScopeWarnings)), line('Description', text(task.description)),
    ].filter(Boolean).join('\n') : output;
    return {
      invocationMessage, pastTenseMessage,
      data: { input: args || 'Shared team task', output: isError ? error : active ? '' : details || 'No task details were supplied.' },
    };
  }

  if (name === 'wait_agent') {
    const timeout = typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms)
      ? input.timeout_ms / 1000 + 's' : '30s (default)';
    const targets = list(input.targets) ?? text(input.target) ?? text(input.agent_id) ?? 'Team activity';
    const noProgress = isRecord(result?.noProgress) ? result.noProgress : undefined;
    const noActivePeer = noProgress?.reason === 'no-active-peer';
    const timedOut = result?.timedOut;
    const pastTenseMessage = isError ? 'Wait for team changes failed'
      : noActivePeer ? 'No active teammate to wait for'
      : timedOut === true ? 'Wait timed out'
      : timedOut === false ? 'Team change observed' : 'Finished waiting for team changes';
    const detail = noActivePeer
      ? text(noProgress.message) ?? 'No other team member is running or provisioning.'
      : timedOut === true ? 'Wait timed out before the next team change.'
      : timedOut === false ? 'A teammate status, mailbox, or shared task changed. Check team status for the latest state.'
      : output || 'No wait result was supplied.';
    return {
      invocationMessage: 'Waiting for team changes', pastTenseMessage,
      data: {
        input: 'Targets: ' + targets + '\nTimeout: ' + timeout + '\nObserves: Teammate status, mailbox, and shared task changes',
        output: isError ? error : active ? '' : detail,
      },
    };
  }

  const recipient = text(input.target) ?? text(input.agent_id) ?? 'agent';
  const status = text(result?.status);
  const messageId = text(result?.messageId);
  // The continuable-child presenter returns this literal receipt; team tools
  // instead return accepted/queued JSON. Neither result includes a reply.
  const childRecipient = text(input.agent_id);
  const delivered = childRecipient !== undefined && text(input.target) === undefined
    && ((status === undefined && messageId !== undefined)
      || output.trim() === 'message delivered to agent ' + childRecipient);
  const receipt = messageId && (status === 'accepted' || status === 'queued') ? status : delivered ? 'delivered' : undefined;
  const pastTenseMessage = isError ? 'Message to ' + short(recipient) + ' failed'
    : receipt ? 'Message ' + receipt + ' to ' + short(recipient)
    : 'Finished sending message to ' + short(recipient);
  return {
    invocationMessage: 'Sending message to ' + short(recipient), pastTenseMessage,
    data: {
      input: 'Recipient: ' + recipient + '\nMessage:\n' + (text(input.message) ?? '(No message text supplied)'),
      output: isError ? error : active ? '' : receipt
        ? [line('Delivery', receipt), line('Message', messageId)].filter(Boolean).join('\n')
        : output || 'No delivery receipt was supplied.',
    },
  };
}

function isTeamToolName(value: unknown): value is TeamToolName {
  return value === 'team_task_create' || value === 'team_task_update' || value === 'wait_agent' || value === 'send_message';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseResult(output: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) ? parsed : undefined;
  } catch {return undefined;}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function number(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function list(value: unknown): string | undefined {
  if (!Array.isArray(value)) {return undefined;}
  const items = value.filter((item): item is string => typeof item === 'string' && !!item.trim());
  return items.length ? items.join(', ') : undefined;
}

function line(label: string, value: string | undefined): string {
  return value === undefined ? '' : label + ': ' + value;
}

function short(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 100 ? singleLine.substring(0, 97) + '...' : singleLine;
}
