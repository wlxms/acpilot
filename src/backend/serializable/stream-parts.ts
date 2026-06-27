import type {
  AcpEvent,
  AcpPartDeltaEvent,
  AcpPartUpdatedEvent,
  AcpPermissionReplyEvent,
  AcpPermissionRequestEvent,
  AcpQuestionRejectedEvent,
  AcpQuestionReplyEvent,
  AcpQuestionRequestEvent,
  AcpSessionDiffEvent,
  AcpSessionIdleEvent,
  AcpSessionLifecycleEvent,
  AcpSessionStatusEvent,
  AcpStreamPart,
  AcpTextPart,
  AcpToolPart,
} from '../types';
import type {
  AssistantTextDeltaStreamPartPayload,
  AssistantTextStreamPartPayload,
  ExternalEditStreamPartPayload,
  InteractionRequestStreamPartPayload,
  InteractionResponseStreamPartPayload,
  KnownSerializableStreamPart,
  RawAcpEventStreamPart,
  ReasoningDeltaStreamPartPayload,
  ReasoningStreamPartPayload,
  SerializableRequestDetails,
  SerializableStreamPart,
  SerializableStreamPartKind,
  SerializableStreamPartMeta,
  SessionDiffStreamPartPayload,
  SessionLifecycleStreamPartPayload,
  ToolInvocationStreamPartPayload,
  UserPromptStreamPartPayload,
} from './types';

interface StreamPartEventHandlerOptions {
  turnIndex: number;
  requestId: string;
  prompt?: string;
  sequenceStart?: number;
}

interface StreamPartEventHandlerState {
  partKinds: Map<string, AcpStreamPart['type']>;
  userPromptWritten: boolean;
}

export class SerializableStreamPartEventHandler {
  private sequence: number;
  private readonly state: StreamPartEventHandlerState = {
    partKinds: new Map(),
    userPromptWritten: false,
  };

  constructor(private readonly options: StreamPartEventHandlerOptions) {
    this.sequence = options.sequenceStart ?? 0;
  }

  serializeEvent(event: AcpEvent): KnownSerializableStreamPart[] {
    switch (event.type) {
      case 'part.updated':
        return [this.serializePartUpdated(event)];
      case 'part.delta':
        return [this.serializePartDelta(event)];
      case 'session.diff':
        return [this.createPart('sessionDiff', {
          sessionId: event.sessionId,
          diffs: event.diffs,
        }, event)];
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'session.error':
      case 'session.idle':
      case 'session.status':
      case 'server.connected':
      case 'server.heartbeat':
        return [this.serializeSessionLifecycle(event)];
      case 'permission.asked':
      case 'question.asked':
        return [this.serializeInteractionRequest(event)];
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
        return [this.serializeInteractionResponse(event)];
      default:
        return [this.createRawAcpEventPart(event)];
    }
  }

  createExternalEditPart(
    toolCallId: string,
    editId: string,
    uri?: string,
  ): SerializableStreamPart<'externalEdit', ExternalEditStreamPartPayload> {
    return this.createPart('externalEdit', { toolCallId, editId, uri }, undefined, {
      source: 'synthetic',
      sourceType: 'externalEdit',
      toolCallId,
      editId,
      uri,
    });
  }

  createExternalEditMetadataPart(
    toolCallId: string,
    editId: string,
    uri?: string,
  ): SerializableStreamPart<'externalEditMetadata', ExternalEditStreamPartPayload> {
    return this.createPart('externalEditMetadata', { toolCallId, editId, uri }, undefined, {
      source: 'synthetic',
      sourceType: 'externalEdit',
      toolCallId,
      editId,
      uri,
    });
  }

  private serializePartUpdated(
    event: AcpPartUpdatedEvent,
  ): KnownSerializableStreamPart {
    this.state.partKinds.set(event.part.id, event.part.type);

    switch (event.part.type) {
      case 'text': {
        const payload = textPayload(event.part, event.sessionId);
        const isFirstPrompt =
          !this.state.userPromptWritten &&
          !!this.options.prompt &&
          payload.text === this.options.prompt;
        if (isFirstPrompt) {
          this.state.userPromptWritten = true;
          return this.createPart('userPrompt', {
            text: payload.text,
            partId: payload.partId,
            messageId: payload.messageId,
            sessionId: payload.sessionId,
          }, event);
        }

        return this.createPart('assistantText', payload, event);
      }
      case 'reasoning':
        return this.createPart('reasoning', {
          partId: event.part.id,
          text: event.part.text,
          messageId: event.part.messageId,
          sessionId: event.sessionId ?? event.part.sessionId,
        }, event);
      case 'tool':
        return this.createPart('toolInvocation', {
          partId: event.part.id,
          toolName: event.part.toolName,
          callId: event.part.callId,
          state: event.part.state,
          messageId: event.part.messageId,
          sessionId: event.sessionId ?? event.part.sessionId,
        }, event);
      default:
        return this.createRawAcpEventPart(event);
    }
  }

  private serializePartDelta(event: AcpPartDeltaEvent): KnownSerializableStreamPart {
    const kind = this.state.partKinds.get(event.partId);
    if (kind === 'reasoning') {
      return this.createPart('reasoningDelta', {
        partId: event.partId,
        delta: event.delta,
        field: event.field,
        sessionId: event.sessionId,
      }, event);
    }

    return this.createPart('assistantTextDelta', {
      partId: event.partId,
      delta: event.delta,
      field: event.field,
      sessionId: event.sessionId,
    }, event);
  }

  private serializeSessionLifecycle(
    event:
      | AcpSessionLifecycleEvent
      | AcpSessionIdleEvent
      | AcpSessionStatusEvent
      | Extract<AcpEvent, { type: 'server.connected' | 'server.heartbeat' }>,
  ): SerializableStreamPart<'sessionLifecycle', SessionLifecycleStreamPartPayload> {
    return this.createPart('sessionLifecycle', {
      eventType: event.type,
      sessionId: 'sessionId' in event ? event.sessionId : undefined,
      parentId: 'parentId' in event ? event.parentId : undefined,
      title: 'title' in event ? event.title : undefined,
      error: 'error' in event ? event.error : undefined,
      status: 'status' in event ? event.status : undefined,
    }, event);
  }

  private serializeInteractionRequest(
    event: AcpPermissionRequestEvent | AcpQuestionRequestEvent,
  ): SerializableStreamPart<'interactionRequest', InteractionRequestStreamPartPayload> {
    if (event.type === 'permission.asked') {
      return this.createPart('interactionRequest', {
        interactionType: 'permission',
        permissionId: event.permissionId,
        sessionId: event.sessionId,
        permission: event.permission,
        patterns: event.patterns,
        metadata: event.metadata,
        always: event.always,
        tool: event.tool,
      }, event);
    }

    return this.createPart('interactionRequest', {
      interactionType: 'question',
      questionId: event.questionId,
      sessionId: event.sessionId,
      questions: event.questions,
      tool: event.tool,
    }, event);
  }

  private serializeInteractionResponse(
    event: AcpPermissionReplyEvent | AcpQuestionReplyEvent | AcpQuestionRejectedEvent,
  ): SerializableStreamPart<'interactionResponse', InteractionResponseStreamPartPayload> {
    if (event.type === 'permission.replied') {
      return this.createPart('interactionResponse', {
        interactionType: 'permission',
        eventType: event.type,
        sessionId: event.sessionId,
        permissionId: event.permissionId,
        response: event.response,
      }, event);
    }

    return this.createPart('interactionResponse', {
      interactionType: 'question',
      eventType: event.type,
      sessionId: event.sessionId,
      requestId: event.requestId,
    }, event);
  }

  private createRawAcpEventPart(event: AcpEvent): RawAcpEventStreamPart<AcpEvent> {
    return this.createPart('rawAcpEvent', { event }, event);
  }

  private createPart<TKind extends SerializableStreamPartKind, TPayload>(
    kind: TKind,
    payload: TPayload,
    event?: AcpEvent,
    metaOverride?: Partial<SerializableStreamPartMeta>,
  ): SerializableStreamPart<TKind, TPayload> {
    const sequence = this.sequence++;
    const meta = this.createMeta(sequence, event, metaOverride);
    return {
      kind,
      version: 1,
      id: `ssp-${this.options.turnIndex}-${sequence}`,
      payload,
      meta,
    };
  }

  private createMeta(
    sequence: number,
    event?: AcpEvent,
    override?: Partial<SerializableStreamPartMeta>,
  ): SerializableStreamPartMeta {
    const eventPart = event?.type === 'part.updated' ? event.part : undefined;
    const toolCallId = eventPart?.type === 'tool'
      ? eventPart.callId
      : event?.type === 'permission.asked' || event?.type === 'question.asked'
        ? event.tool?.callId
        : undefined;

    return {
      turnIndex: this.options.turnIndex,
      requestId: this.options.requestId,
      sequence,
      createdAt: new Date().toISOString(),
      source: event ? 'acp-event' : 'synthetic',
      sourceType: event?.type,
      sourcePartId: eventPart?.id ?? (event?.type === 'part.delta' ? event.partId : undefined),
      toolCallId,
      uri: getEventUri(event),
      sessionId: getEventSessionId(event),
      ...override,
    };
  }
}

export function projectStreamPartToAcpEvent(part: SerializableStreamPart): AcpEvent | undefined {
  switch (part.kind) {
    case 'rawAcpEvent':
      return (part as RawAcpEventStreamPart<AcpEvent>).payload.event;
    case 'userPrompt': {
      const payload = part.payload as UserPromptStreamPartPayload;
      return {
        type: 'part.updated',
        sessionId: payload.sessionId ?? part.meta.sessionId,
        part: {
          type: 'text',
          id: payload.partId ?? part.meta.sourcePartId ?? `user-${part.meta.requestId}`,
          text: payload.text,
          messageId: payload.messageId,
          sessionId: payload.sessionId ?? part.meta.sessionId,
        },
      };
    }
    case 'assistantText': {
      const payload = part.payload as AssistantTextStreamPartPayload;
      return {
        type: 'part.updated',
        sessionId: payload.sessionId ?? part.meta.sessionId,
        part: {
          type: 'text',
          id: payload.partId,
          text: payload.text,
          messageId: payload.messageId,
          sessionId: payload.sessionId ?? part.meta.sessionId,
          synthetic: payload.synthetic,
          metadata: payload.metadata,
        },
      };
    }
    case 'assistantTextDelta': {
      const payload = part.payload as AssistantTextDeltaStreamPartPayload;
      return {
        type: 'part.delta',
        sessionId: payload.sessionId ?? part.meta.sessionId,
        partId: payload.partId,
        delta: payload.delta,
        field: payload.field,
      };
    }
    case 'reasoning': {
      const payload = part.payload as ReasoningStreamPartPayload;
      return {
        type: 'part.updated',
        sessionId: payload.sessionId ?? part.meta.sessionId,
        part: {
          type: 'reasoning',
          id: payload.partId,
          text: payload.text,
          messageId: payload.messageId,
          sessionId: payload.sessionId ?? part.meta.sessionId,
        },
      };
    }
    case 'reasoningDelta': {
      const payload = part.payload as ReasoningDeltaStreamPartPayload;
      return {
        type: 'part.delta',
        sessionId: payload.sessionId ?? part.meta.sessionId,
        partId: payload.partId,
        delta: payload.delta,
        field: payload.field,
      };
    }
    case 'toolInvocation': {
      const payload = part.payload as ToolInvocationStreamPartPayload;
      return {
        type: 'part.updated',
        sessionId: payload.sessionId ?? part.meta.sessionId,
        part: {
          type: 'tool',
          id: payload.partId,
          toolName: payload.toolName,
          callId: payload.callId,
          state: payload.state,
          messageId: payload.messageId,
          sessionId: payload.sessionId ?? part.meta.sessionId,
        },
      };
    }
    case 'sessionLifecycle':
      return projectSessionLifecycle(part.payload as SessionLifecycleStreamPartPayload);
    case 'sessionDiff': {
      const payload = part.payload as SessionDiffStreamPartPayload;
      return {
        type: 'session.diff',
        sessionId: payload.sessionId,
        diffs: payload.diffs as AcpSessionDiffEvent['diffs'],
      };
    }
    case 'interactionRequest':
      return projectInteractionRequest(part.payload as InteractionRequestStreamPartPayload);
    case 'interactionResponse':
      return projectInteractionResponse(part.payload as InteractionResponseStreamPartPayload);
    case 'externalEdit':
    case 'externalEditMetadata':
      return undefined;
    default:
      return undefined;
  }
}

export function requestDetailsFromStreamParts(
  parts: readonly SerializableStreamPart[],
  metaIndex?: ReadonlyMap<string, Record<string, unknown>>,
): SerializableRequestDetails[] {
  const byRequest = new Map<string, SerializableRequestDetails>();

  for (const part of parts) {
    if (part.kind !== 'externalEdit' && part.kind !== 'externalEditMetadata') {
      continue;
    }
    const payload = part.payload as Partial<ExternalEditStreamPartPayload>;
    const toolCallId = payload.toolCallId ?? part.meta.toolCallId;
    let editId = payload.editId ?? part.meta.editId;

    // editId arrives asynchronously (undoStopId from VS Code externalEdit);
    // it is persisted to meta.jsonl via IMetadataProvider, not session.jsonl.
    // Fall back to meta.jsonl when the stream part record has an empty editId.
    if (!editId && metaIndex) {
      const partMeta = metaIndex.get(part.id);
      editId = (partMeta?.undoStopId as string | undefined) ?? (partMeta?.editId as string | undefined);
    }

    if (!toolCallId || !editId) {
      continue;
    }

    const key = `${part.meta.turnIndex}:${part.meta.requestId}`;
    const existing = byRequest.get(key);
    if (existing) {
      existing.toolIdEditMap[toolCallId] = editId;
      continue;
    }

    byRequest.set(key, {
      turnIndex: part.meta.turnIndex,
      vscodeRequestId: part.meta.requestId,
      toolIdEditMap: { [toolCallId]: editId },
    });
  }

  return [...byRequest.values()].sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
}

function textPayload(part: AcpTextPart, eventSessionId?: string): AssistantTextStreamPartPayload {
  return {
    partId: part.id,
    text: part.text,
    messageId: part.messageId,
    sessionId: eventSessionId ?? part.sessionId,
    synthetic: part.synthetic,
    metadata: part.metadata,
  };
}

function projectSessionLifecycle(payload: SessionLifecycleStreamPartPayload): AcpEvent | undefined {
  switch (payload.eventType) {
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
    case 'session.error':
      return {
        type: payload.eventType,
        sessionId: payload.sessionId ?? '',
        parentId: payload.parentId,
        title: payload.title,
        error: payload.error,
      } as AcpSessionLifecycleEvent;
    case 'session.idle':
      return { type: 'session.idle', sessionId: payload.sessionId };
    case 'session.status':
      return {
        type: 'session.status',
        sessionId: payload.sessionId ?? '',
        status: payload.status as AcpSessionStatusEvent['status'],
      };
    case 'server.connected':
      return { type: 'server.connected' };
    case 'server.heartbeat':
      return { type: 'server.heartbeat' };
    default:
      return undefined;
  }
}

function projectInteractionRequest(payload: InteractionRequestStreamPartPayload): AcpEvent | undefined {
  if (payload.interactionType === 'permission') {
    return {
      type: 'permission.asked',
      permissionId: payload.permissionId ?? '',
      sessionId: payload.sessionId ?? '',
      permission: payload.permission ?? '',
      patterns: payload.patterns ?? [],
      metadata: payload.metadata ?? {},
      always: payload.always ?? [],
      tool: payload.tool as AcpPermissionRequestEvent['tool'],
    };
  }

  return {
    type: 'question.asked',
    questionId: payload.questionId ?? '',
    sessionId: payload.sessionId ?? '',
    questions: payload.questions as AcpQuestionRequestEvent['questions'] ?? [],
    tool: payload.tool as AcpQuestionRequestEvent['tool'],
  };
}

function projectInteractionResponse(payload: InteractionResponseStreamPartPayload): AcpEvent | undefined {
  switch (payload.eventType) {
    case 'permission.replied':
      return {
        type: 'permission.replied',
        sessionId: payload.sessionId ?? '',
        permissionId: payload.permissionId ?? '',
        response: payload.response ?? '',
      };
    case 'question.replied':
      return {
        type: 'question.replied',
        sessionId: payload.sessionId ?? '',
        requestId: payload.requestId ?? '',
      };
    case 'question.rejected':
      return {
        type: 'question.rejected',
        sessionId: payload.sessionId ?? '',
        requestId: payload.requestId ?? '',
      };
    default:
      return undefined;
  }
}

function getEventUri(event: AcpEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }
  if (event.type === 'permission.asked') {
    return typeof event.metadata?.filepath === 'string' ? event.metadata.filepath : undefined;
  }
  if (event.type === 'part.updated' && event.part.type === 'tool') {
    return getToolInputPath(event.part);
  }
  return undefined;
}

function getEventSessionId(event: AcpEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }
  if ('sessionId' in event && event.sessionId) {
    return event.sessionId;
  }
  if (event.type === 'part.updated') {
    return event.part.sessionId;
  }
  return undefined;
}

function getToolInputPath(part: AcpToolPart): string | undefined {
  const input = part.state.input ?? {};
  const candidate = input.filePath ?? input.path ?? input.file ?? input.uri;
  return typeof candidate === 'string' ? candidate : undefined;
}
