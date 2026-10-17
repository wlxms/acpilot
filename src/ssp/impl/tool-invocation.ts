/**
 * ToolInvocationSSP — handles tool call lifecycle rendering.
 *
 * Kind: 'toolInvocation'
 *
 * This is the CORE SSP — it internalizes all tool rendering logic from the
 * trunk opencode pipeline (formatInvocationMsg, formatPastTenseMsg,
 * buildToolSpecificData) to avoid the v2 "death by extraction" failure
 * where tool-data.ts became dead code.
 *
 * ════════════════════════════════════════════════════════════════════════
 * BEHAVIOR CONTRACTS (must NEVER regress — see plan C1-C5):
 * ════════════════════════════════════════════════════════════════════════
 *
 * C1: read complete does NOT set pastTenseMessage
 *     - completed read → invocationMessage only (present tense "Read [file]")
 *     - fallback path → return immediately (no update at all)
 *     Source: trunk pushToolInvocation L1267-1269, fallback L1335-1337
 *
 * C3: progressive idempotency
 *     - First running → push(isComplete=false) + _progressivePushed=true
 *     - Subsequent running → updateToolInvocation(invocationMessage) only
 *     - completed/error → push(isComplete=true) new part (always)
 *     Source: trunk progressivePushed Set L137
 *
 * C4: toolSpecificData 7-type mapping
 *     - read/write/edit → undefined (no toolSpecificData)
 *     - bash → ChatTerminalToolInvocationData
 *     - list/grep/glob/websearch/fetch/context → ChatSimpleToolResultData
 *     - task/subagent → ChatSubagentToolInvocationData
 *     - todo → ChatTodoToolInvocationData or ChatSimpleToolResultData
 *     - other → ChatSimpleToolResultData or undefined
 *
 * C5: presentation
 *     - read/write/edit/internal/step-start/step-finish → 'hiddenAfterComplete'
 *     Source: trunk isTransientFileTool L2136-2143
 */

import * as vscode from 'vscode';
import { SerializableStreamPart, type IMutableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { SerializableStreamPartMeta, SerializableToolState } from '../types';
import type { ToolInvocationStreamPartPayload } from '../types';
import type {
  ChatTerminalToolInvocationData,
  ChatSimpleToolResultData,
  ChatSubagentToolInvocationData,
  ChatTodoToolInvocationData,
  ChatToolResourcesInvocationData,
  ChatToolInvocationPart,
} from '../../types/vscode-proposed-additions';
import { ChatTodoStatus } from '../../types/vscode-proposed-additions';

// ---------------------------------------------------------------------------
// Proposed vscode type accessor (runtime may not have these)
// ---------------------------------------------------------------------------

type ProposedVscode = typeof vscode & {
  ChatToolInvocationPart?: new (
    toolName: string,
    toolCallId: string,
    errorMessage?: string,
  ) => ChatToolInvocationPart;
  ChatSubagentToolInvocationData?: new (
    description?: string,
    agentName?: string,
    prompt?: string,
    result?: string,
  ) => ChatSubagentToolInvocationData;
};

const VS = vscode as ProposedVscode;

// ---------------------------------------------------------------------------
// ToolInvocationSSP
// ---------------------------------------------------------------------------

export class ToolInvocationSSP extends SerializableStreamPart<
  'toolInvocation',
  ToolInvocationStreamPartPayload
> implements IMutableStreamPart<ToolInvocationStreamPartPayload> {

  readonly kind = 'toolInvocation' as const;

  /** Progressive push idempotency (contract C3). */
  private _progressivePushed = false;
  private nextRenderMode: 'updateOnly' | undefined;

  /** Whether this SSP has pushed a progressive (isComplete=false) part. */
  get isProgressivePushed(): boolean {
    return this._progressivePushed;
  }

  /** Subagent nesting id (passed via constructor for immutability). */
  readonly subAgentInvocationId?: string;

  constructor(
    payload: ToolInvocationStreamPartPayload & { subAgentInvocationId?: string },
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    const stableId = id ?? payload.callId ?? payload.partId;
    super(payload, {
      ...meta,
      subAgentId: meta?.subAgentId ?? payload.subAgentId,
      sessionId: meta?.sessionId ?? payload.sessionId,
      toolCallId: meta?.toolCallId ?? payload.callId ?? payload.partId,
      sourcePartId: meta?.sourcePartId ?? payload.partId,
    }, stableId);
    this.subAgentInvocationId = payload.subAgentInvocationId;
  }

  /** IMutableStreamPart.update — merge only, no emitStateChange */
  update(
    data: Partial<Omit<ToolInvocationStreamPartPayload, 'state'>> & {
      state?: Partial<SerializableToolState>;
    },
  ): void {
    this.nextRenderMode = (
      data as Partial<ToolInvocationStreamPartPayload> & { renderMode?: 'updateOnly' }
    ).renderMode;
    if (data.state) {
      this.payload.state = { ...this.payload.state, ...data.state };
    }
    if (data.toolName !== undefined) {this.payload.toolName = data.toolName;}
    if (data.callId !== undefined) {this.payload.callId = data.callId;}
    if (data.messageId !== undefined) {this.payload.messageId = data.messageId;}
    if (data.sessionId !== undefined) {this.payload.sessionId = data.sessionId;}
    if (data.partId !== undefined) {this.payload.partId = data.partId;}
  }

  /**
   * Core render state machine.
   * Routes to pushToolInvocation (proposed API) or renderFallback.
   */
  render(stream: SspStream): void {
    const { callId, toolName, state } = this.payload;
    const effectiveCallId = callId ?? this.payload.partId;
    if (!effectiveCallId) {return;}

    const status = state.status;

    // PENDING: call beginToolInvocation (NOT push) — matches trunk L1061-1065
    if (status === 'pending') {
      if (stream.beginToolInvocation) {
        const subAgentInvocationId = this.getEffectiveSubAgentInvocationId();
        stream.beginToolInvocation(
          effectiveCallId,
          toolName,
          buildAttachedToolStreamData(subAgentInvocationId),
        );
      } else {
        stream.progress(`\u{1F527} ${toolName}...`);
      }
      return;
    }

    // RUNNING / COMPLETED / ERROR: push or fallback
    const isError = status === 'error';
    const ToolInvocationPartCtor = VS.ChatToolInvocationPart;
    if (ToolInvocationPartCtor) {
      this.pushToolInvocation(stream, effectiveCallId, toolName, state, isError);
    } else {
      this.renderFallback(stream, effectiveCallId, toolName, state, isError);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Core rendering (proposed API path) — trunk pushToolInvocation L1234-1296
  // ════════════════════════════════════════════════════════════════════════

  private pushToolInvocation(
    stream: SspStream,
    callId: string,
    toolName: string,
    state: SerializableToolState,
    isError: boolean,
  ): void {
    try {
      const input = state.input ?? {};
      const output = state.output ?? '';
      const title = state.title ?? '';

    const ToolInvocationPartCtor = VS.ChatToolInvocationPart;
    if (!ToolInvocationPartCtor) {
      this.renderFallback(stream, callId, toolName, state, isError);
      return;
    }

    // ★ Contract C3: subsequent running → updateToolInvocation (progressive update).
    // First running pushes a new part (isComplete=false); later running only
    // updates the invocationMessage via the streaming API — no redundant push.
    if (this.nextRenderMode === 'updateOnly' && stream.updateToolInvocation) {
      this.nextRenderMode = undefined;
      this.updateToolInvocationMessage(stream, callId, toolName, state);
      return;
    }
    this.nextRenderMode = undefined;

    if (state.status === 'running' && this._progressivePushed) {
      this.updateToolInvocationMessage(stream, callId, toolName, state);
      return;
    }

    const part = new ToolInvocationPartCtor(
        toolName,
        callId,
        isError ? (state.error ?? 'Error') : undefined,
      );
      part.enablePartialUpdate = true;
      part.isAttachedToThinking = true;

      // isComplete logic (trunk L1256-1259)
      const subAgentInvocationId = this.getEffectiveSubAgentInvocationId();
      part.isComplete = state.status === 'completed' || state.status === 'error';
      if (state.status === 'pending' || (state.status === 'running' && !this._progressivePushed)) {
        part.isComplete = false;
      }

      // ★ Contract C1: message selection by status + toolName
      if (state.status === 'running' || state.status === 'pending') {
        const msg = this.formatInvocationMsg(toolName, input, title);
        part.invocationMessage = typeof msg === 'string' ? msg : msg.value;
      } else if (state.status === 'completed' || state.status === 'error') {
        if (toolName === 'read') {
          // ★ C1: read complete → invocationMessage (present tense), NOT pastTenseMessage
          const msg = this.formatInvocationMsg(toolName, input, title);
          part.invocationMessage = typeof msg === 'string' ? msg : msg.value;
        } else {
          const pastMsg = this.formatPastTenseMsg(toolName, title, state.startTime, state.endTime, input);
          part.pastTenseMessage = typeof pastMsg === 'string' ? pastMsg : pastMsg.value;
        }
        if (state.metadata?.presentation === 'system') {
          part.pastTenseMessage = title;
        }
      }

      // Contract C4: toolSpecificData mapping
      const specific = this.buildToolSpecificData(toolName, input, output, title);
      if (specific) {
        part.toolSpecificData = specific as any;
      }

      // Contract C5: presentation
      if (isTransientFileTool(toolName)) {
        part.presentation = 'hiddenAfterComplete';
      }
      if (state.metadata?.presentation === 'hidden' || state.metadata?.externalEdit === true) {
        part.presentation = 'hidden';
      }

      // Subagent nesting
      if (subAgentInvocationId) {
        part.subAgentInvocationId = subAgentInvocationId;
      }

      stream.push!(part as unknown as any);

      // Contract C3: mark progressive pushed on first running push
      if (state.status === 'running' || state.status === 'pending') {
        this._progressivePushed = true;
      }
    } catch {
      this.renderFallback(stream, callId, toolName, state, isError);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Fallback rendering — trunk pushToolInvocationFallback L1302-1346
  // ════════════════════════════════════════════════════════════════════════

  private updateToolInvocationMessage(
    stream: SspStream,
    callId: string,
    toolName: string,
    state: SerializableToolState,
  ): void {
    const input = state.input ?? {};
    const title = state.title ?? '';
    const msg = this.formatUpdateInvocationMsg(toolName, input, title);
    stream.updateToolInvocation?.(callId, {
      invocationMessage: typeof msg === 'string' ? msg : msg.value,
      isAttachedToThinking: true,
    } as any);
  }

  private formatUpdateInvocationMsg(
    toolName: string,
    input: Record<string, unknown>,
    title: string,
  ): string | vscode.MarkdownString {
    if ((toolName === 'task' || toolName === 'subagent') && title) {
      return title;
    }
    return this.formatInvocationMsg(toolName, input, title);
  }

  private renderFallback(
    stream: SspStream,
    callId: string,
    toolName: string,
    state: SerializableToolState,
    isError: boolean,
  ): void {
    if (!stream.beginToolInvocation) {return;}

    const title = state.title ?? toolName;
    const input = state.input ?? {};

    if (state.status === 'pending') {
      try {
        const subAgentInvocationId = this.getEffectiveSubAgentInvocationId();
        stream.beginToolInvocation(
          callId,
          toolName,
          buildAttachedToolStreamData(subAgentInvocationId),
        );
      } catch { /* ignore */ }
      return;
    }

    if (state.status === 'running') {
      try {
        const msg = this.formatInvocationMsg(toolName, input, title);
        stream.updateToolInvocation?.(callId, {
          invocationMessage: typeof msg === 'string' ? msg : msg.value,
          isAttachedToThinking: true,
        } as any);
      } catch { /* ignore */ }
      return;
    }

    if (state.status === 'completed' || state.status === 'error') {
      // ★ C1 fallback: read complete → return immediately (no update)
      if (toolName === 'read') {
        return;
      }
      const pastMsg = state.metadata?.presentation === 'system'
        ? title
        : this.formatPastTenseMsg(toolName, title, state.startTime, state.endTime, input);
      try {
        stream.updateToolInvocation?.(callId, {
          pastTenseMessage: typeof pastMsg === 'string' ? pastMsg : pastMsg.value,
          invocationMessage: state.metadata?.presentation === 'system'
            ? title
            : isError ? `✗ ${toolName}` : `✓ ${toolName}`,
          isAttachedToThinking: true,
        } as any);
      } catch { /* ignore */ }
    }
  }

  private getEffectiveSubAgentInvocationId(): string | undefined {
    return this.subAgentInvocationId ?? this.payload.subAgentInvocationId ?? this.meta.subAgentInvocationId;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Message formatting — trunk formatInvocationMsg L1479-1553
  // ════════════════════════════════════════════════════════════════════════

  private formatInvocationMsg(
    toolName: string,
    input: Record<string, unknown>,
    title: string,
  ): string | vscode.MarkdownString {
    const formatFileBubbleMessage = (
      verb: 'Read' | 'Editing' | 'Writing',
      filePath: string,
      offset?: number,
      limit?: number,
    ): vscode.MarkdownString => {
      const uri = vscode.Uri.file(filePath).toString().toLowerCase();
      const range = offset !== undefined || limit !== undefined
        ? (() => {
            const start = offset ?? 1;
            const end = limit !== undefined ? start + limit - 1 : start;
            return `#${start}-${end}`;
          })()
        : '';
      return new vscode.MarkdownString(`${verb} [](${uri}${range})`);
    };

    if (toolName === 'read') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        const offset = input?.offset as number | undefined;
        const limit = input?.limit as number | undefined;
        return formatFileBubbleMessage('Read', filePath, offset, limit);
      }
    } else if (toolName === 'edit') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        return formatFileBubbleMessage('Editing', filePath);
      }
    } else if (toolName === 'write') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        return formatFileBubbleMessage('Writing', filePath);
      }
    } else if (toolName === 'bash') {
      const command = (input.command as string) ?? (input.script as string) ?? title;
      const short = command.length > 80 ? command.substring(0, 77) + '...' : command;
      return `\`${short}\``;
    } else if (toolName === 'todo') {
      return `Todos`;
    } else if (toolName === 'task' || toolName === 'subagent') {
      const desc = (input.description as string) ?? title;
      return desc || 'Run subagent';
    } else if (toolName === 'list' || toolName === 'grep') {
      const filePath = (input.filePath as string) ?? (input.path as string) ?? (input.pattern as string) ?? title;
      const short = filePath.length > 60 ? filePath.substring(0, 57) + '...' : filePath;
      return `${toolName === 'list' ? 'List' : 'Search'} \`${short}\``;
    } else if (toolName === 'glob') {
      const pattern = (input.pattern as string) ?? title;
      const short = pattern.length > 60 ? pattern.substring(0, 57) + '...' : pattern;
      return `Glob \`${short}\``;
    } else if (toolName === 'websearch' || toolName === 'websearch_web_search_exa') {
      const query = (input.query as string) ?? title;
      if (query) {
        const short = query.length > 80 ? query.substring(0, 77) + '...' : query;
        return new vscode.MarkdownString(`Web Searching \`${short}\``);
      }
    }

    const display = title || toolName;
    if (!input || Object.keys(input).length === 0) {
      return `Running ${display}`;
    }
    const firstKey = Object.keys(input)[0];
    const firstVal = input[firstKey];
    const short = typeof firstVal === 'string'
      ? firstVal.length > 60 ? firstVal.substring(0, 57) + '...' : firstVal
      : JSON.stringify(firstVal);
    return `Running ${display} (${firstKey}: ${short})`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Past tense formatting — trunk formatPastTenseMsg L1555-1644
  // ════════════════════════════════════════════════════════════════════════

  private formatPastTenseMsg(
    toolName: string,
    title: string,
    timeStart?: number,
    timeEnd?: number,
    input?: Record<string, unknown>,
  ): string | vscode.MarkdownString {
    const duration = (timeStart !== undefined && timeEnd !== undefined)
      ? ` (${((timeEnd - timeStart) / 1000).toFixed(1)}s)`
      : '';

    const formatFileBubbleMessage = (
      verb: 'Read' | 'Edited' | 'Wrote',
      filePath: string,
      offset?: number,
      limit?: number,
      suffix = '',
    ): vscode.MarkdownString => {
      const uri = vscode.Uri.file(filePath).toString().toLowerCase();
      const range = offset !== undefined || limit !== undefined
        ? (() => {
            const start = offset ?? 1;
            const end = limit !== undefined ? start + limit - 1 : start;
            return `#${start}-${end}`;
          })()
        : '';
      let lineInfo = '';
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : undefined;
        lineInfo = end !== undefined ? ` line ${start}-${end}` : ` line ${start}`;
      }
      return new vscode.MarkdownString(`${verb} [](${uri}${range})${lineInfo}${suffix}${duration}`);
    };

    if (toolName === 'read') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        const offset = input?.offset as number | undefined;
        const limit = input?.limit as number | undefined;
        return formatFileBubbleMessage('Read', filePath, offset, limit);
      }
    } else if (toolName === 'edit') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        const offset = input?.offset as number | undefined;
        const limit = input?.limit as number | undefined;
        return formatFileBubbleMessage('Edited', filePath, offset, limit, '');
      }
    } else if (toolName === 'write') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        return formatFileBubbleMessage('Wrote', filePath, undefined, undefined, '');
      }
    } else if (toolName === 'bash') {
      const command = (input?.command as string) ?? (input?.script as string) ?? title;
      const short = command.length > 60 ? command.substring(0, 57) + '...' : command;
      return `\`${short}\`${duration}`;
    } else if (toolName === 'list') {
      const filePath = (input?.filePath as string) ?? (input?.path as string) ?? title;
      const short = filePath.length > 60 ? filePath.substring(0, 57) + '...' : filePath;
      return `Listed \`${short}\`${duration}`;
    } else if (toolName === 'grep') {
      const pattern = (input?.pattern as string) ?? title;
      const short = pattern.length > 60 ? pattern.substring(0, 57) + '...' : pattern;
      return `Searched \`${short}\`${duration}`;
    } else if (toolName === 'glob') {
      const pattern = (input?.pattern as string) ?? title;
      const short = pattern.length > 60 ? pattern.substring(0, 57) + '...' : pattern;
      return `Globbed \`${short}\`${duration}`;
    } else if (toolName === 'todo') {
      return `Updated todos${duration}`;
    } else if (toolName === 'websearch' || toolName === 'websearch_web_search_exa') {
      const query = (input?.query as string) ?? title;
      if (query) {
        const short = query.length > 80 ? query.substring(0, 77) + '...' : query;
        return `Web Searched \`${short}\`${duration}`;
      }
    } else if (toolName === 'task' || toolName === 'subagent') {
      const desc = (input?.description as string) ?? title;
      return `${desc || 'Run subagent'}${duration}`;
    }

    const display = title || toolName;
    return `Completed ${display}${duration}`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Tool-specific data mapping — trunk buildToolSpecificData L1352-1473
  // ════════════════════════════════════════════════════════════════════════

  private buildToolSpecificData(
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    title: string,
  ): ChatTerminalToolInvocationData | ChatSimpleToolResultData | ChatToolResourcesInvocationData | (ChatSubagentToolInvocationData & { kind?: 'subagent' }) | ChatTodoToolInvocationData | undefined {
    const formatInput = (data: Record<string, unknown>, fallbackTitle: string): string => {
      const keys = Object.keys(data);
      if (keys.length === 0) {return fallbackTitle;}
      const parts = keys.map((k) => {
        const val = typeof data[k] === 'string'
          ? (data[k] as string).substring(0, 100)
          : JSON.stringify(data[k]).substring(0, 100);
        return `${k}: ${val}`;
      });
      return parts.join('\n');
    };

    const truncate = (s: string, max: number): string =>
      s.length > max ? s.substring(0, max) + '...' : s;

    // Whether this tool runs nested inside a subagent (child tool).
    // Drives the todo-rendering distinction: root → native todo widget,
    // subagent → text fallback (no native widget in nested context).
    const isSubagentTool = !!this.getEffectiveSubAgentInvocationId();

    switch (toolName) {
      case 'read':
        return undefined;

      case 'write':
      case 'edit':
        return undefined;

      case 'bash': {
        const command = (input.command as string) ?? (input.script as string) ?? formatInput(input, title);
        const exitCode = ((): number | undefined => {
          if (stateOutputHasExitCode(output)) {
            const match = output.match(/exitCode:\s*(-?\d+)/);
            return match ? parseInt(match[1], 10) : undefined;
          }
          return undefined;
        })();
        return {
          commandLine: { original: command },
          language: (input.language as string) ?? 'bash',
          output: output ? { text: truncate(output, 2000) } : undefined,
          state: exitCode !== undefined ? { exitCode } : undefined,
        } satisfies ChatTerminalToolInvocationData;
      }

      case 'list':
      case 'grep':
      case 'glob':
      case 'grep_app_searchGitHub': {
        // Collapsible file references list (matches VSCode Copilot search pattern).
        // Parse file paths from input.path/filePath and from output lines.
        const values: Array<vscode.Uri | vscode.Location> = [];
        const path = (input.path as string | undefined) ?? (input.filePath as string | undefined);
        if (path) {
          try { values.push(vscode.Uri.file(path)); } catch { /* skip invalid path */ }
        }
        if (output) {
          const lines = output.split('\n');
          for (const line of lines) {
            const fileMatch = line.match(/^[A-Za-z]:\\(?:[^\\]+\\)*[^:]+|^\/(?:[^/]+\/)*[^:]+/);
            if (fileMatch) {
              try { values.push(vscode.Uri.file(fileMatch[0])); } catch { /* skip */ }
            }
          }
        }
        if (values.length > 0) {
          return { values } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'fetch':
      case 'webfetch':
      case 'read_url':
      case 'readUrl':
      case 'context': {
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'websearch':
      case 'websearch_web_search_exa': {
        // Clickable web URL references: a Bing search link for the query plus
        // any URLs parsed from the result output.
        const values: Array<vscode.Uri | vscode.Location> = [];
        const query = input.query as string | undefined;
        if (query) {
          values.push(vscode.Uri.parse(`https://www.bing.com/search?q=${encodeURIComponent(query)}`));
        }
        if (output) {
          const urlRegex = /https?:\/\/[^\s"')>]+/g;
          let match: RegExpExecArray | null;
          while ((match = urlRegex.exec(output)) !== null) {
            try { values.push(vscode.Uri.parse(match[0])); } catch { /* skip */ }
          }
        }
        if (values.length > 0) {
          return { values } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'todo':
      case 'todowrite': {
        // Parse todo items from tool input (todos array).
        const todos = input.todos as Array<{ content: string; status: string }> | undefined;
        if (todos && Array.isArray(todos)) {
          if (isSubagentTool) {
            // Subagent-nested todo: formatted text fallback (no native todo widget
            // available in the nested subagent card context).
            const check = (s: string) =>
              s === 'completed' ? '✓' : s === 'in_progress' ? '⟳' : '○';
            const formatted = todos.map((item, idx) => {
              return `[${check(item.status)}] ${idx + 1}. ${item.content}`;
            }).join('\n');
            return {
              input: formatted,
              output: truncate(output, 2000),
            } satisfies ChatSimpleToolResultData;
          }
          // Root session: native ChatTodoToolInvocationData with proper status enum.
          const todoList = todos.map((item, idx) => ({
            id: idx,
            title: item.content,
            status: item.status === 'completed'
              ? ChatTodoStatus.Completed
              : item.status === 'in_progress'
                ? ChatTodoStatus.InProgress
                : ChatTodoStatus.NotStarted,
          }));
          return { todoList } satisfies ChatTodoToolInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'task':
      case 'subagent': {
        return this.buildSubagentToolSpecificData(input, output, title);
      }

      default:
        if (Object.keys(input).length > 0 || output) {
          return {
            input: formatInput(input, title),
            output: truncate(output, 2000),
          } satisfies ChatSimpleToolResultData;
        }
        return undefined;
    }
  }

  private buildSubagentToolSpecificData(
    input: Record<string, unknown>,
    output: string,
    title: string,
  ): ChatSubagentToolInvocationData {
    const truncate = (s: string, max: number): string =>
      s.length > max ? s.substring(0, max) + '...' : s;
    const description = (input.description as string) ?? title;
    const agentName = (input.subagent_type as string)
      ?? (input.agentName as string)
      ?? (input.agent_type as string)
      ?? (input.agentType as string)
      ?? title
      ?? 'Subagent';
    const prompt = (input.prompt as string) ?? formatSubagentInput(input);
    const result = truncate(output, 4000);

    if (VS.ChatSubagentToolInvocationData) {
      return new VS.ChatSubagentToolInvocationData(description, agentName, prompt, result);
    }
    return { description, agentName, prompt, result };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (trunk L2132-2147)
// ---------------------------------------------------------------------------

function formatSubagentInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) {return '';}
  return entries
    .map(([key, value]) => {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${rendered}`;
    })
    .join('\n');
}

function stateOutputHasExitCode(output: string): boolean {
  return /exitCode:\s*-?\d+/.test(output);
}

function isTransientFileTool(toolName: string): boolean {
  return toolName === 'read'
    || toolName === 'write'
    || toolName === 'edit'
    || toolName === 'internal'
    || toolName === 'step-start'
    || toolName === 'step-finish';
}

function buildAttachedToolStreamData(subAgentInvocationId?: string): Record<string, unknown> {
  return {
    isAttachedToThinking: true,
    ...(subAgentInvocationId ? { subagentInvocationId: subAgentInvocationId } : {}),
  };
}
