/**
 * Proposed API types from vscode.proposed.chatParticipantAdditions.d.ts (version 3)
 *
 * Source: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts
 *
 * These types are NOT yet in @types/vscode. They are available at runtime
 * ONLY when `chatParticipantAdditions` is enabled in package.json's `enabledApiProposals`.
 *
 * Declared here locally for compile-time type safety. When VSCode stabilizes
 * these APIs and they land in @types/vscode, switch to importing from 'vscode' directly.
 *
 * NOTE: Do NOT augment the 'vscode' module here — that is done in the separate
 * file vscode-proposed.d.ts for chatParticipantPrivate. This file exports
 * standalone types for direct import.
 */

import type {
  Location,
  MarkdownString,
  Uri,
} from 'vscode';

// ---------------------------------------------------------------------------
// Tool streaming data
// ---------------------------------------------------------------------------

/**
 * Streaming data for beginToolInvocation / updateToolInvocation.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatToolInvocationStreamData {
  readonly partialInput?: unknown;
  readonly invocationMessage?: string | MarkdownString;
  readonly subagentInvocationId?: string;
  /**
   * Internal VS Code runtime hint used experimentally to keep tool cards
   * attached to the current thinking block.
   */
  readonly isAttachedToThinking?: boolean;
}

// ---------------------------------------------------------------------------
// toolSpecificData types
// ---------------------------------------------------------------------------

/**
 * Terminal/shell command invocation data.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatTerminalToolInvocationData {
  commandLine: {
    original: string;
    userEdited?: string;
    toolEdited?: string;
  };
  language: string;
  presentationOverrides?: {
    commandLine: string;
    language?: string;
  };
  output?: { text: string };
  state?: { exitCode?: number; duration?: number };
}

/**
 * Simple collapsible input/output result data.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatSimpleToolResultData {
  input: string;
  output: string;
}

/**
 * File/resource list invocation data — renders as a collapsible list.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatToolResourcesInvocationData {
  values: Array<Uri | Location>;
}

/**
 * Subagent invocation data — click to expand subagent details.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export class ChatSubagentToolInvocationData {
  description?: string;
  agentName?: string;
  prompt?: string;
  result?: string;

  constructor(
    description?: string,
    agentName?: string,
    prompt?: string,
    result?: string,
  ) {
    this.description = description;
    this.agentName = agentName;
    this.prompt = prompt;
    this.result = result;
  }
}

/**
 * MCP (Model Context Protocol) tool invocation data.
 * Placeholder — exact interface TBD from VSCode API.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatMcpToolInvocationData {
  /** MCP server name */
  name?: string;
  /** JSON arguments for the MCP tool call */
  input?: unknown;
  /** Text output from the MCP tool */
  output?: string;
}

/**
 * Status of a single todo item.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export enum ChatTodoStatus {
  NotStarted = 1,
  InProgress = 2,
  Completed = 3,
}

/**
 * Todo tool invocation data — renders an interactive todo list in chat.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatTodoToolInvocationData {
  todoList: Array<{
    id: number;
    title: string;
    status: ChatTodoStatus;
  }>;
}

/**
 * Union of all tool-specific data types accepted by ChatToolInvocationPart.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export type ChatToolSpecificData =
  | ChatTerminalToolInvocationData
  | ChatMcpToolInvocationData
  | ChatTodoToolInvocationData
  | ChatSimpleToolResultData
  | ChatToolResourcesInvocationData
  | ChatSubagentToolInvocationData;

// ---------------------------------------------------------------------------
// ChatToolInvocationPart
// ---------------------------------------------------------------------------

/**
 * A chat response part that renders a tool invocation with rich UI.
 *
 * Properties:
 * - toolName / toolCallId — identifies the tool
 * - invocationMessage — shown while tool is running (e.g., "Running grep...")
 * - pastTenseMessage — shown after completion (e.g., "Searched in 0.3s")
 * - isError — if true, renders with error styling
 * - toolSpecificData — drives the expandable card UI per tool type
 * - presentation — controls visibility ('hidden' hides it entirely)
 * - subAgentInvocationId — links to a sub-agent's session
 * - enablePartialUpdate — enables progressive push (isComplete=false → true)
 *
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export class ChatToolInvocationPart {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  invocationMessage?: string | MarkdownString;
  originMessage?: string | MarkdownString;
  pastTenseMessage?: string | MarkdownString;
  isConfirmed?: boolean;
  isComplete?: boolean;
  toolSpecificData?: ChatToolSpecificData;
  subAgentInvocationId?: string;
  presentation?: 'hidden' | 'hiddenAfterComplete' | undefined;
  enablePartialUpdate?: boolean;
  /**
   * Internal VS Code runtime hint used experimentally to keep tool cards
   * attached to the current thinking block.
   */
  isAttachedToThinking?: boolean;

  constructor(
    toolName: string,
    toolCallId: string,
    errorMessage?: string,
  ) {
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.isError = !!errorMessage;
  }
}

// ---------------------------------------------------------------------------
// ChatResponseExternalEditPart
// ---------------------------------------------------------------------------

export interface ChatWorkspaceFileEdit {
  oldResource?: Uri;
  newResource?: Uri;
}

/**
 * A chat response part representing an external file edit.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts
 */
export class ChatResponseExternalEditPart {
  readonly uris: readonly Uri[];
  readonly callback: () => Thenable<unknown>;
  readonly applied: Thenable<string>;

  constructor(uris: readonly Uri[], callback: () => Thenable<unknown>) {
    this.uris = uris;
    this.callback = callback;
    this.applied = Promise.resolve('');
  }
}

// ---------------------------------------------------------------------------
// ChatResponseWorkspaceEditPart
// ---------------------------------------------------------------------------

/**
 * A chat response part representing a workspace edit.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts
 */
export class ChatResponseWorkspaceEditPart {
  readonly edits: readonly ChatWorkspaceFileEdit[];

  constructor(edits: readonly ChatWorkspaceFileEdit[]) {
    this.edits = edits;
  }
}

// ---------------------------------------------------------------------------
// ChatResponseDiffEntry & ChatResponseMultiDiffPart
// ---------------------------------------------------------------------------

/**
 * Represents a single file diff entry in a multi diff view.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts
 */
export interface ChatResponseDiffEntry {
  /**
   * The original file URI (undefined for new files).
   */
  originalUri?: Uri;
  /**
   * The modified file URI (undefined for deleted files).
   */
  modifiedUri?: Uri;
  /**
   * Optional URI to navigate to when clicking on the file.
   */
  goToFileUri?: Uri;
  /**
   * Number of added lines to show in the UI.
   */
  added?: number;
  /**
   * Number of removed lines to show in the UI.
   */
  removed?: number;
}

/**
 * A chat response part that shows multiple file diffs.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts
 */
export class ChatResponseMultiDiffPart {
  value: ChatResponseDiffEntry[];
  title: string;
  readOnly?: boolean;

  constructor(value: ChatResponseDiffEntry[], title: string, readOnly?: boolean) {
    this.value = value;
    this.title = title;
    this.readOnly = readOnly;
  }
}

// ---------------------------------------------------------------------------
// ChatQuestion — question types for questionCarousel API
// ---------------------------------------------------------------------------

/**
 * The type of a question displayed in a question carousel.
 */
export enum ChatQuestionType {
  Text = 1,
  SingleSelect = 2,
  MultiSelect = 3,
}

/**
 * An option for a question in a carousel.
 */
export interface ChatQuestionOption {
  /**
   * Unique identifier for the option.
   */
  id: string;
  /**
   * Display label for the option.
   */
  label: string;
  /**
   * The value returned when this option is selected.
   * This is what VSCode puts in selectedValue/selectedValues in the answer.
   */
  value: unknown;
  /**
   * Optional detail retained for callers that provide richer backend metadata.
   * VS Code currently renders the label/value pair only.
   */
  detail?: string;
}

/**
 * A question to be displayed in a question carousel.
 */
export class ChatQuestion {
  /**
   * Unique identifier for the question.
   */
  id: string;
  /**
   * The type of question.
   */
  type: ChatQuestionType;
  /**
   * The title/header of the question.
   */
  title: string;
  /**
   * Optional detailed message or description.
   */
  message?: string | MarkdownString;
  /**
   * Options for singleSelect or multiSelect questions.
   */
  options?: ChatQuestionOption[];
  /**
   * The id(s) of the default selected option(s).
   */
  defaultValue?: string | string[];
  /**
   * Whether to allow free-form text in addition to predefined options.
   */
  allowFreeformInput?: boolean;

  constructor(
    id: string,
    type: ChatQuestionType,
    title: string,
    options?: {
      message?: string | MarkdownString;
      options?: ChatQuestionOption[];
      defaultValue?: string | string[];
      allowFreeformInput?: boolean;
    },
  ) {
    this.id = id;
    this.type = type;
    this.title = title;
    this.message = options?.message;
    this.options = options?.options;
    this.defaultValue = options?.defaultValue;
    this.allowFreeformInput = options?.allowFreeformInput;
  }
}

/**
 * A carousel view for presenting multiple questions inline in the chat.
 * Users can navigate between questions and submit their answers.
 */
export class ChatResponseQuestionCarouselPart {
  /**
   * The questions to display in the carousel.
   */
  questions: ChatQuestion[];
  /**
   * Whether users can skip answering the questions.
   */
  allowSkip: boolean;

  constructor(questions: ChatQuestion[], allowSkip?: boolean) {
    this.questions = questions;
    this.allowSkip = allowSkip ?? false;
  }
}

// ---------------------------------------------------------------------------
// ExtendedChatResponseParts — lists all proposed chat response parts
// ---------------------------------------------------------------------------

/**
 * Internal type that lists all the proposed chat response parts.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ExtendedChatResponseParts {
  ChatResponsePart: unknown;
  ChatResponseTextEditPart: unknown;
  ChatResponseNotebookEditPart: unknown;
  ChatResponseWorkspaceEditPart: ChatResponseWorkspaceEditPart;
  ChatResponseConfirmationPart: unknown;
  ChatResponseCodeCitationPart: unknown;
  ChatResponseReferencePart2: unknown;
  ChatResponseMovePart: unknown;
  ChatResponseExtensionsPart: unknown;
  ChatResponsePullRequestPart: unknown;
  ChatToolInvocationPart: ChatToolInvocationPart;
  ChatResponseMultiDiffPart: ChatResponseMultiDiffPart;
  ChatResponseThinkingProgressPart: unknown;
  ChatResponseExternalEditPart: ChatResponseExternalEditPart;
  ChatResponseQuestionCarouselPart: ChatResponseQuestionCarouselPart;
}

/**
 * The actual type used for extended chat response parts.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export type ExtendedChatResponsePart = ExtendedChatResponseParts[keyof ExtendedChatResponseParts];
