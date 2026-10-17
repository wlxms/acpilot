/**
 * QuestionSSP — mutable user interaction via questionCarousel.
 *
 * Kind: 'question'
 *
 * Lifecycle:
 *   push (status='asked') → render() shows questionCarousel
 *     → user answers → callbacks.onResult(vscodeRawResult)  ← Pipeline maps format
 *     → user skips  → callbacks.onSkip()
 *     → payload.status updated to 'answered'/'skipped'
 *     → emitStateChange() → SSS writes metadata
 *
 *   update (status='replied'|'skipped') → no-op render (lifecycle guard)
 *
 * Guards:
 *   carouselShown: prevents re-launching questionCarousel on repeated render()
 */

import { SerializableStreamPart, type IMutableStreamPart } from '../types';
import type { SerializableStreamPartMeta, SspStream, QuestionStreamPartPayload } from '../types';

/**
 * Runtime shape accepted by VS Code's chatParticipantAdditions bridge.
 *
 * Keep this structural instead of importing `vscode`: SSPs are also restored
 * and exercised outside an extension host. The numeric values mirror
 * `vscode.ChatQuestionType` (Text=1, SingleSelect=2, MultiSelect=3).
 */
export interface CarouselQuestion {
  id: string;
  type: 1 | 2 | 3;
  title: string;
  message?: string;
  options?: Array<{ id: string; label: string; value: unknown; detail?: string }>;
  defaultValue?: string | string[];
  allowFreeformInput?: boolean;
}

export interface QuestionSSPCallbacks {
  /** Called with the RAW VS Code result — Pipeline is responsible for format mapping */
  onResult: (vscodeRawResult: unknown) => void;
  /** Called when user skips / cancels */
  onSkip: () => void;
}

export class QuestionSSP extends SerializableStreamPart<
  'question',
  QuestionStreamPartPayload
> implements IMutableStreamPart<QuestionStreamPartPayload> {

  readonly kind = 'question' as const;
  private carouselShown = false;

  constructor(
    payload: QuestionStreamPartPayload,
    private readonly callbacks?: QuestionSSPCallbacks,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    const normalizedPayload = normalizeQuestionPayload(payload);
    super(normalizedPayload, {
      ...meta,
      sourcePartId: meta?.sourcePartId ?? normalizedPayload.questionId,
      toolCallId: meta?.toolCallId,
    }, id ?? normalizedPayload.questionId);
  }

  render(stream: SspStream): void {
    if (this.carouselShown || this.payload.status !== 'asked') {return;}
    this.carouselShown = true;

    // Keep the rendering boundary defensive even though constructors and
    // update() already normalize payloads. Payload is intentionally public for
    // SSS serialization, so callers may have mutated it between those calls.
    this.payload = normalizeQuestionPayload(this.payload);

    // VS Code's carousel assumes at least one question and dereferences the
    // current question's message/title while constructing its accessibility
    // label. Treat an empty/malformed backend request as a skipped request so
    // it cannot reintroduce `undefined.value` in the renderer.
    if (this.payload.questions.length === 0) {
      this.skip();
      return;
    }

    if (typeof stream.questionCarousel === 'function') {
      // Backend events and older persisted records use different question
      // field names. Normalize at the single Copilot rendering boundary so a
      // malformed/legacy question can never make VS Code read `undefined.value`.
      let carouselResult: PromiseLike<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
      try {
        carouselResult = stream.questionCarousel(this.payload.questions, true);
      } catch {
        this.skip();
        return;
      }

      Promise.resolve(carouselResult).then(
        (result) => {
          if (result === undefined) {
            this.skip();
            return;
          }
          this.payload.status = 'replied';
          this.payload.answers = result;
          this.callbacks?.onResult(result);
          this.emitStateChange();
        },
        () => {
          // questionCarousel rejected — treat as skip
          this.skip();
        },
      );
    } else {
      // Fallback: no questionCarousel API available
      // Pipeline should handle fallback via its own logic
      this.skip();
    }
  }

  update(data: Partial<QuestionStreamPartPayload>): void {
    if (!data || typeof data !== 'object') {return;}
    if (Object.prototype.hasOwnProperty.call(data, 'questions')) {
      Object.assign(this.payload, {
        ...data,
        questions: normalizeQuestionsForCarousel(data.questions),
      });
    } else {
      Object.assign(this.payload, data);
    }
    // No emitStateChange — SSS handles render + append
  }

  private skip(): void {
    this.payload.status = 'skipped';
    this.callbacks?.onSkip();
    this.emitStateChange();
  }
}

/** Normalize a payload before it is persisted or rendered. */
function normalizeQuestionPayload(payload: QuestionStreamPartPayload): QuestionStreamPartPayload {
  const source = payload && typeof payload === 'object' ? payload : {} as QuestionStreamPartPayload;
  return {
    ...source,
    questionId: nonEmptyString(source.questionId) ?? 'question',
    questions: normalizeQuestionsForCarousel(source.questions),
  };
}

/**
 * Convert backend-native and legacy question descriptors to the current
 * VS Code ChatQuestion wire shape. The helper intentionally returns plain
 * objects: VS Code's extension-host converter accepts structural values and
 * serializes them before rendering.
 */
export function normalizeQuestionsForCarousel(input: unknown): CarouselQuestion[] {
  if (!Array.isArray(input)) {return [];}
  // Array#map preserves sparse holes. Array.from deliberately visits every
  // index so a sparse/malformed payload cannot leave an undefined question
  // for VS Code's renderer to dereference.
  return Array.from(input, (value, index) => normalizeQuestion(value, index));
}

function normalizeQuestion(value: unknown, index: number): CarouselQuestion {
  const source = isRecord(value) ? value : {};
  const id = nonEmptyString(source.id) ?? `q_${index}`;
  const rawOptions = Array.isArray(source.options) ? source.options : [];
  const type = questionType(source.type, source.multiple, rawOptions.length);
  const questionText = firstText(source.question, source.message, source.detailedMessage);
  const title = firstText(source.title, source.header, questionText) ?? `Question ${index + 1}`;
  // Array#map preserves sparse holes. Fill every option slot so the VS Code
  // converter never receives an undefined option and dereferences `.value`.
  const options = Array.from(rawOptions, (option, optionIndex) => normalizeOption(option, id, optionIndex));

  const normalized: CarouselQuestion = {
    id,
    type,
    title,
    ...(questionText ? { message: questionText } : {}),
    ...(options.length > 0 ? { options } : {}),
  };

  const defaultValue = normalizeDefaultValue(source.defaultValue ?? source.selectedOptionIds);
  if (defaultValue !== undefined) {
    normalized.defaultValue = defaultValue;
  }

  if (typeof source.allowFreeformInput === 'boolean') {
    normalized.allowFreeformInput = source.allowFreeformInput;
  } else if (typeof source.custom === 'boolean') {
    // OpenCode's `custom` flag is the backend spelling for free-form input.
    normalized.allowFreeformInput = source.custom;
  } else if (isBackendQuestion(source)) {
    // OpenCode's question schema defaults `custom` to true. Preserve that
    // behavior when older records omit the optional flag; VS Code also treats
    // an omitted allowFreeformInput as enabled.
    normalized.allowFreeformInput = true;
  }

  return normalized;
}

function normalizeOption(
  value: unknown,
  questionId: string,
  index: number,
): { id: string; label: string; value: unknown; detail?: string } {
  const source = isRecord(value) ? value : {};
  const primitiveLabel = typeof value === 'string' && value.trim() ? value : undefined;
  const label = firstText(source.label, source.name, source.value, source.description)
    ?? primitiveLabel
    ?? `Option ${index + 1}`;
  const optionValue = Object.prototype.hasOwnProperty.call(source, 'value')
    && source.value !== undefined
    ? source.value
    : label;
  return {
    id: nonEmptyString(source.id) ?? `${questionId}-option-${index}`,
    label,
    value: optionValue,
    ...(typeof source.detail === 'string'
      ? { detail: source.detail }
      : typeof source.description === 'string' && source.description !== label
        ? { detail: source.description }
        : {}),
  };
}

function questionType(rawType: unknown, multiple: unknown, optionCount: number): 1 | 2 | 3 {
  const normalizedType = typeof rawType === 'string' ? rawType.replace(/[-_]/g, '').toLowerCase() : rawType;
  if (rawType === 1 || normalizedType === 'text') {return 1;}
  if (rawType === 3 || normalizedType === 'multiselect' || multiple === true) {return 3;}
  if (rawType === 2 || normalizedType === 'singleselect' || optionCount > 0) {return 2;}
  return 1;
}

function normalizeDefaultValue(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {return value;}
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return [...value];
  }
  return undefined;
}

function isBackendQuestion(value: Record<string, unknown>): boolean {
  return 'question' in value || 'header' in value || 'multiple' in value || 'custom' in value;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {return value;}
    if (isRecord(value) && typeof value.value === 'string' && value.value.trim()) {
      return value.value;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
