/**
 * Vitest mock for the `vscode` module.
 *
 * The `vscode` module is a virtual module provided by VS Code's extension host
 * at runtime — it does NOT exist as an installable npm package. Vitest (running
 * in node) cannot resolve `import * as vscode from 'vscode'` without this mock.
 *
 * This mock provides only the minimal surface area needed by the unit tests.
 * It is NOT a full VS Code API polyfill.
 */

import type { ChatToolSpecificData, ChatToolInvocationStreamData } from '../types/vscode-proposed-additions';

// ---------------------------------------------------------------------------
// Enums / Constants
// ---------------------------------------------------------------------------

export enum ChatResultFeedbackKind {
    Helpful = 1,
    Unhelpful = 2,
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export class ThemeIcon {
    constructor(
        public id: string,
        public color?: ThemeColor,
    ) {}
}

export class ThemeColor {
    constructor(public id: string) {}
}

export enum ChatSessionStatus {
    Failed = 0,
    Completed = 1,
    InProgress = 2,
    NeedsInput = 3,
}

export class OutputChannel {
    public readonly lines: string[] = [];

    constructor(public readonly name: string) {}

    appendLine(message: string): void {
        this.lines.push(message);
    }

    append(_message: string): void {
        // no-op for tests
    }

    clear(): void {
        this.lines.length = 0;
    }

    show(_preserveFocus?: boolean): void {
        // no-op for tests
    }

    hide(): void {
        // no-op for tests
    }

    dispose(): void {
        this.lines.length = 0;
    }
}

export class EventEmitter<T> {
    private listeners: Array<(value: T) => unknown> = [];

    readonly event = (listener: (value: T) => unknown): { dispose(): void } => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            },
        };
    };

    fire(value: T): void {
        for (const listener of this.listeners) {
            listener(value);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

export class ChatParticipant {
    public iconPath: ThemeIcon | { light: ThemeIcon; dark: ThemeIcon } | undefined;
    public requestHandler: ChatRequestHandler;
    private _feedbackListeners: Array<(e: ChatResultFeedback) => unknown> = [];

    constructor(
        public readonly id: string,
        handler: ChatRequestHandler,
    ) {
        this.requestHandler = handler;
    }

    onDidReceiveFeedback(
        listener: (e: ChatResultFeedback) => unknown,
    ): { dispose(): void } {
        this._feedbackListeners.push(listener);
        return { dispose: () => { /* no-op */ } };
    }

    dispose(): void {
        this._feedbackListeners = [];
    }
}

export class LanguageModelTextPart {
    constructor(public readonly value: string) {}
}

export class LanguageModelChatMessage {
    static User(content: string): LanguageModelChatMessage {
        return new LanguageModelChatMessage(content);
    }

    constructor(public readonly content: string) {}
}

export class LanguageModelThinkingPart {
    constructor(
        public readonly value: string,
        public readonly id?: string,
        public readonly metadata?: { readonly [key: string]: unknown },
    ) {}
}

export class LanguageModelToolCallPart {
    constructor(
        public readonly callId: string,
        public readonly name: string,
        public readonly input: Record<string, unknown>,
    ) {}
}

export interface LanguageModelChatCapabilities {
    readonly imageInput?: boolean;
    readonly toolCalling?: boolean | number;
    readonly agentMode?: boolean;
}

export interface LanguageModelChatInformation {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: LanguageModelChatCapabilities;
    readonly isBYOK?: boolean;
    readonly targetChatSessionType?: string;
    readonly isUserSelectable?: boolean;
    readonly isDefault?: boolean | Record<string, boolean>;
}

export interface LanguageModelChat {
    readonly id: string;
    readonly family: string;
    readonly vendor?: string;
    readonly name?: string;
    readonly version?: string;
    sendRequest?(
        messages: LanguageModelChatMessage[],
        options?: unknown,
        token?: CancellationToken,
    ): Thenable<{ text: AsyncIterable<string> }>;
}

// ---------------------------------------------------------------------------
// Interfaces (minimal shape for unit tests)
// ---------------------------------------------------------------------------

/** Promise-like interface (from VS Code API) */
export interface Thenable<T> {
    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | Thenable<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | Thenable<TResult2>) | null,
    ): Thenable<TResult1 | TResult2>;
}

export interface ExtensionContext {
    subscriptions: Array<{ dispose(): void }>;
    extensionPath: string;
    extensionUri: Uri;
    globalState: Memento;
    workspaceState: Memento;
    storageUri: Uri | undefined;
    globalStorageUri: Uri;
    logUri: Uri;
}

export class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fragment: string;
    readonly query: string;
    readonly fsPath: string;

    static file(path: string): Uri {
        const normalized = path.replace(/\\/g, '/');
        const uriPath = /^[a-zA-Z]:\//.test(normalized)
            ? `/${normalized}`
            : normalized;
        return new Uri('file', '', uriPath, '', '');
    }

    static parse(value: string): Uri {
        if (/^[a-zA-Z][a-zA-Z\d+.-]*:\//.test(value)) {
            const parsed = new URL(value);
            return new Uri(
                parsed.protocol.slice(0, -1),
                parsed.host,
                parsed.pathname,
                parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search,
                parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash,
            );
        }

        // basic fallback — enough for tests
        return new Uri('file', '', value, '', '');
    }

    constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
        this.fsPath = path.replace(/^\/([a-zA-Z]:)(?=\/)/, '$1').replace(/\//g, '\\');
    }

    with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): this {
        return new Uri(
            change.scheme ?? this.scheme,
            change.authority ?? this.authority,
            change.path ?? this.path,
            change.query ?? this.query,
            change.fragment ?? this.fragment,
        ) as this;
    }

    toString(): string {
        return `${this.scheme}://${this.authority}${this.path}`;
    }
}

export interface Memento {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export type ChatRequestHandler = (
    request: ChatRequest,
    context: ChatContext,
    stream: ChatResponseStream,
    token: CancellationToken,
) => Promise<ChatResult>;

export interface ChatRequest {
    prompt: string;
    command: string | undefined;
    references: Array<unknown>;
    toolReferences?: unknown[];
    toolInvocationToken?: string;
    model?: unknown;
    /** From chatParticipantPrivate proposed API — identifies the VSCode chat panel */
    sessionId?: string;
}

export interface ChatContext {
    history: Array<unknown>;
}

/**
 * Minimal MarkdownString mock — needed by streaming.ts formatPastTenseMsg / formatFileBubbleMessage.
 * The real class concatenates markdown; for tests a plain string container suffices.
 */
export class MarkdownString {
    value: string;
    constructor(value: string) { this.value = value; }
    toString() { return this.value; }
}

export class ChatResponseMarkdownPart {
    constructor(public readonly value: MarkdownString | string) {}
}

export class ChatResponseThinkingProgressPart {
    constructor(
        public readonly value: string | string[],
        public readonly id?: string,
        public readonly metadata?: { readonly [key: string]: any },
    ) {}
}

export class ChatResponseCodeblockUriPart {
    constructor(
        public readonly value: Uri,
        public readonly isEdit?: boolean,
        public readonly undoStopId?: string,
    ) {}
}

export class ChatResponseTextEditPart {
    constructor(
        public readonly uri: Uri,
        public readonly editsOrDone: unknown,
    ) {
        if (editsOrDone === true) {
            this.isDone = true;
            this.edits = [];
        } else {
            this.edits = Array.isArray(editsOrDone) ? editsOrDone : [editsOrDone];
        }
    }
    readonly edits: unknown[];
    readonly isDone?: boolean;
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(
        public readonly startLine: number,
        public readonly startCharacter: number,
        public readonly endLine: number,
        public readonly endCharacter: number,
    ) {}
}

export class TextEdit {
    constructor(
        public readonly range: Range,
        public readonly newText: string,
    ) {}
}

export class WorkspaceEdit {
    readonly operations: unknown[] = [];

    createFile(uri: Uri, options?: unknown): void {
        this.operations.push({ type: 'createFile', uri, options });
    }

    deleteFile(uri: Uri, options?: unknown): void {
        this.operations.push({ type: 'deleteFile', uri, options });
    }

    replace(uri: Uri, range: Range, text: string): void {
        this.operations.push({ type: 'replace', uri, range, text });
    }
}

export class ChatResponseExternalEditPart {
    static nextUndoStopId = '';
    readonly applied: Thenable<string>;

    constructor(
        public readonly uris: readonly Uri[],
        public readonly callback: () => Thenable<unknown>,
    ) {
        this.applied = Promise.resolve(callback()).then(() => ChatResponseExternalEditPart.nextUndoStopId);
    }
}

export class ChatSessionChangedFile {
    constructor(
        public readonly uri: Uri,
        public readonly originalUri?: Uri,
        public readonly modifiedUri?: Uri,
        public insertions: number = 0,
        public deletions: number = 0,
    ) {}
}

export interface ChatResponseDiffEntry {
    originalUri?: Uri;
    modifiedUri?: Uri;
    goToFileUri?: Uri;
    added?: number;
    removed?: number;
}

export class ChatResponseMultiDiffPart {
    constructor(
        public readonly value: ChatResponseDiffEntry[],
        public readonly title: string,
        public readonly readOnly?: boolean,
    ) {}
}

/**
 * Mock for proposed API: ChatToolInvocationPart
 * This is NOT in @types/vscode — available at runtime with chatParticipantAdditions.
 */
export class ChatToolInvocationPart {
    toolName: string;
    toolCallId: string;
    isError?: boolean;
    invocationMessage?: string;
    originMessage?: string;
    pastTenseMessage?: string;
    isConfirmed?: boolean;
    isComplete?: boolean;
    toolSpecificData?: ChatToolSpecificData;
    subAgentInvocationId?: string;
    presentation?: 'hidden' | 'hiddenAfterComplete';
    enablePartialUpdate?: boolean;
    isAttachedToThinking?: boolean;

    constructor(toolName: string, toolCallId: string, errorMessage?: string) {
        this.toolName = toolName;
        this.toolCallId = toolCallId;
        this.isError = !!errorMessage;
    }
}

export interface ChatResponseStream {
    markdown(value: string): void;
    progress(value: string): void;
    push(part: unknown): void;
    externalEdit?(target: Uri | Uri[], callback: () => Thenable<unknown>): Thenable<string>;
    anchor?(value: unknown, title?: string): void;
    button?(command: unknown): void;
    filetree?(value: unknown, baseUri?: unknown): void;
    reference?(value: unknown, iconPath?: unknown): void;
    /** Proposed API: stream thinking tokens */
    thinkingProgress?(delta: unknown): void;
    /** Proposed API: begin streaming tool invocation */
    beginToolInvocation?(toolCallId: string, toolName: string, streamData?: ChatToolInvocationStreamData): void;
    /** Proposed API: update streaming tool invocation */
    updateToolInvocation?(toolCallId: string, streamData: ChatToolInvocationStreamData): void;
}

export interface CancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested: (listener: () => unknown) => { dispose(): void };
}

/** Minimal cancellation source used by runtime-control tests. */
export class CancellationTokenSource {
    private cancelled = false;
    private readonly emitter = new EventEmitter<void>();
    readonly token: CancellationToken;

    constructor() {
        const token = {} as CancellationToken;
        // Define the getter with an arrow so it remains bound to this source
        // when the token is passed through the runtime API.
        Object.defineProperty(token, 'isCancellationRequested', {
            enumerable: true,
            get: () => this.cancelled,
        });
        token.onCancellationRequested = (listener) => this.emitter.event(listener);
        this.token = token;
    }

    cancel(): void {
        if (this.cancelled) {return;}
        this.cancelled = true;
        this.emitter.fire(undefined);
    }

    dispose(): void {
        this.emitter.dispose();
    }
}

export interface ChatResult {
    metadata: Record<string, unknown>;
}

export interface ChatSessionItem {
    readonly resource: Uri;
    label: string;
    iconPath?: unknown;
    description?: string;
    badge?: string;
    changes?: ChatSessionChangedFile[];
    status?: ChatSessionStatus;
    tooltip?: string;
    archived?: boolean;
    timing?: { readonly created: number };
}

export interface ChatResultFeedback {
    readonly kind: ChatResultFeedbackKind;
    readonly result: ChatResult;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

export const window = {
    createOutputChannel(name: string): OutputChannel {
        return new OutputChannel(name);
    },
};

export const chat = {
    createChatParticipant(
        id: string,
        handler: ChatRequestHandler,
    ): ChatParticipant {
        return new ChatParticipant(id, handler);
    },
    createChatSessionItemController(
        id: string,
        refreshHandler: (token: CancellationToken) => Promise<void> | Thenable<void>,
    ) {
        const items = new Map<string, ChatSessionItem>();
        const onDidChangeChatSessionItemStateEmitter = new EventEmitter<ChatSessionItem>();
        let newChatSessionItemHandler: unknown;
        return {
            id,
            refreshHandler,
            onDidChangeChatSessionItemState: onDidChangeChatSessionItemStateEmitter.event,
            get newChatSessionItemHandler() {
                return newChatSessionItemHandler;
            },
            set newChatSessionItemHandler(handler: unknown) {
                newChatSessionItemHandler = handler;
            },
            fireDidChangeChatSessionItemState(item: ChatSessionItem) {
                onDidChangeChatSessionItemStateEmitter.fire(item);
            },
            items: {
                get size() {
                    return items.size;
                },
                replace(iterable: Iterable<ChatSessionItem>) {
                    items.clear();
                    for (const item of iterable) {
                        items.set(item.resource.toString(), item);
                    }
                },
                add(item: ChatSessionItem) {
                    items.set(item.resource.toString(), item);
                },
                delete(resource: Uri) {
                    items.delete(resource.toString());
                },
                get(resource: Uri) {
                    return items.get(resource.toString());
                },
                [Symbol.iterator]() {
                    return Array.from(items.values(), item => [item.resource, item] as const)[Symbol.iterator]();
                },
            },
            createChatSessionItem(resource: Uri, label: string): ChatSessionItem {
                return { resource, label };
            },
            createChatSessionInputState(groups: unknown[]) {
                return {
                    sessionResource: undefined,
                    groups,
                    onDidDispose: () => ({ dispose() {} }),
                    onDidChange: () => ({ dispose() {} }),
                };
            },
            dispose() {
                items.clear();
            },
        };
    },
};

export const lm = {
    selectChatModels: async (_selector?: unknown): Promise<LanguageModelChat[]> => [],
    registerLanguageModelChatProvider(_vendor: string, _provider: unknown) {
        return { dispose() {} };
    },
    languageModelAccessInformation: {
        canSendRequest(_chat: LanguageModelChat) {
            return true;
        },
    },
};

export const workspace = {
    workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
    applyEdit: async (edit: WorkspaceEdit): Promise<boolean> => {
        const fs = await import('node:fs');
        for (const operation of edit.operations as Array<{ type: string; uri?: Uri; text?: string; range?: Range }>) {
            if (operation.type === 'createFile' && operation.uri) {
                if (!fs.existsSync(operation.uri.fsPath)) {
                    fs.writeFileSync(operation.uri.fsPath, '', 'utf-8');
                }
            }
            if (operation.type === 'replace' && operation.uri) {
                const current = fs.existsSync(operation.uri.fsPath)
                    ? fs.readFileSync(operation.uri.fsPath, 'utf-8')
                    : '';
                if (operation.range) {
                    const start = offsetAtPosition(current, operation.range.startLine, operation.range.startCharacter);
                    const end = offsetAtPosition(current, operation.range.endLine, operation.range.endCharacter);
                    fs.writeFileSync(
                        operation.uri.fsPath,
                        current.slice(0, start) + (operation.text ?? '') + current.slice(end),
                        'utf-8',
                    );
                } else {
                    fs.writeFileSync(operation.uri.fsPath, operation.text ?? '', 'utf-8');
                }
            }
            if (operation.type === 'deleteFile' && operation.uri && fs.existsSync(operation.uri.fsPath)) {
                fs.unlinkSync(operation.uri.fsPath);
            }
        }
        return true;
    },
    getConfiguration: (_section?: string) => ({
        get<T>(_key: string, defaultValue: T): T {
            return defaultValue;
        },
    }),
};

function offsetAtPosition(text: string, line: number, character: number): number {
    if (line <= 0) {
        return Math.max(0, character);
    }

    let currentLine = 0;
    for (let i = 0; i < text.length; i++) {
        if (currentLine === line) {
            return Math.min(text.length, i + character);
        }
        if (text.charCodeAt(i) === 10) {
            currentLine++;
        }
    }

    return text.length;
}

// ---------------------------------------------------------------------------
// Turn types for chat history
// ---------------------------------------------------------------------------

export class ChatRequestTurn {
    constructor(
        public readonly prompt: string,
        public readonly command: string | undefined,
        public readonly references: Array<{ id: string; name: string }> = [],
        public readonly participant: string = 'opencode',
        public readonly toolReferences: readonly unknown[] = [],
        public readonly editedFileEvents?: readonly unknown[],
        public readonly id?: string,
        public readonly modelId?: string,
        public readonly modeInstructions2?: unknown,
    ) {}
}

export class ChatResponseTurn {
    constructor(
        public readonly responses: unknown[],
        public readonly result?: ChatResult,
    ) {}
};

export class ChatResponseTurn2 {
    public readonly responses: unknown[];

    constructor(
        public readonly response: unknown[],
        public readonly result: ChatResult = { metadata: {} },
        public readonly participant: string = 'opencode',
        public readonly command?: string,
    ) {
        this.responses = response;
    }
}
