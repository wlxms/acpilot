import { describe, expect, it, vi } from 'vitest';
import type { SspStream } from '../../ssp/types';
import {
  QuestionSSP,
  normalizeQuestionsForCarousel,
} from '../../ssp/impl/question';

function streamWithCarousel(
  result: Record<string, unknown> | undefined = undefined,
): SspStream & { questionCarousel: ReturnType<typeof vi.fn> } {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
    questionCarousel: vi.fn(async () => result),
  };
}

describe('QuestionSSP question normalization', () => {
  it('maps a backend question to the VS Code carousel shape', () => {
    const [question] = normalizeQuestionsForCarousel([{
      question: 'Which provider should be used?',
      header: 'Provider',
      options: [{ label: 'OpenCode', description: 'Backend provider' }],
    }]);

    expect(question).toMatchObject({
      id: 'q_0',
      type: 2,
      title: 'Provider',
      message: 'Which provider should be used?',
      allowFreeformInput: true,
    });
    expect(question.options).toEqual([{
      id: 'q_0-option-0',
      label: 'OpenCode',
      value: 'OpenCode',
      detail: 'Backend provider',
    }]);
  });

  it('maps multi-select and text questions to their distinct types', () => {
    const questions = normalizeQuestionsForCarousel([
      {
        question: 'Select capabilities',
        header: 'Capabilities',
        multiple: true,
        custom: true,
        options: [
          { label: 'Tools', description: '' },
          { label: 'Images', description: '' },
        ],
      },
      {
        question: 'What is the project name?',
        header: 'Project',
        options: [],
      },
    ]);

    expect(questions[0]).toMatchObject({
      id: 'q_0',
      type: 3,
      allowFreeformInput: true,
    });
    expect(questions[1]).toMatchObject({
      id: 'q_1',
      type: 1,
      title: 'Project',
      message: 'What is the project name?',
      allowFreeformInput: true,
    });
  });

  it('normalizes permission-shaped records before rendering and persistence', async () => {
    const stream = streamWithCarousel();
    const ssp = new QuestionSSP({
      questionId: 'permission-1',
      questions: [{
        question: 'Allow the edit?',
        header: 'Permission',
        custom: false,
        options: [{ label: 'Allow once', value: 'once' }],
      }],
      status: 'asked',
    });

    ssp.render(stream);
    await Promise.resolve();

    const rendered = stream.questionCarousel.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(rendered[0]).toMatchObject({
      id: 'q_0',
      type: 2,
      title: 'Permission',
      message: 'Allow the edit?',
    });
    expect(rendered[0].options).toEqual([{
      id: 'q_0-option-0',
      label: 'Allow once',
      value: 'once',
    }]);
    expect(ssp.toJSON().payload).toMatchObject({
      questionId: 'permission-1',
      questions: rendered,
    });
  });

  it('repairs an older record with missing question fields', () => {
    const ssp = new QuestionSSP({
      questionId: 'legacy',
      questions: [{ options: [{ label: 'Continue' }] }],
      status: 'asked',
    });

    const [question] = ssp.toJSON().payload.questions as Array<Record<string, unknown>>;
    expect(question).toMatchObject({
      id: 'q_0',
      type: 2,
      title: 'Question 1',
    });
    expect(question.message).toBeUndefined();
    expect(question.options).toEqual([{
      id: 'q_0-option-0',
      label: 'Continue',
      value: 'Continue',
    }]);
  });

  it('keeps primitive options usable while normalizing malformed records', () => {
    const [question] = normalizeQuestionsForCarousel([{
      question: 'Continue?',
      options: ['Yes', 'No'],
    }]);

    expect(question.options).toEqual([
      { id: 'q_0-option-0', label: 'Yes', value: 'Yes' },
      { id: 'q_0-option-1', label: 'No', value: 'No' },
    ]);
  });

  it('fills sparse question and option slots with safe values', () => {
    const questions: unknown[] = [];
    questions.length = 2;
    questions[1] = { options: [] as unknown[] };
    const firstOptions: unknown[] = [];
    firstOptions.length = 2;
    questions[0] = { options: firstOptions };

    const normalized = normalizeQuestionsForCarousel(questions);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({ id: 'q_0', title: 'Question 1', type: 2 });
    expect(normalized[0].options).toEqual([
      { id: 'q_0-option-0', label: 'Option 1', value: 'Option 1' },
      { id: 'q_0-option-1', label: 'Option 2', value: 'Option 2' },
    ]);
  });

  it('skips an empty question list instead of invoking VS Code carousel', () => {
    const stream = streamWithCarousel();
    const onSkip = vi.fn();
    const ssp = new QuestionSSP({
      questionId: 'empty',
      questions: [],
      status: 'asked',
    }, { onResult: vi.fn(), onSkip });

    expect(() => ssp.render(stream)).not.toThrow();
    expect(stream.questionCarousel).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledOnce();
    expect(ssp.payload.status).toBe('skipped');
  });

  it('normalizes a non-array question update before rendering', () => {
    const stream = streamWithCarousel();
    const onSkip = vi.fn();
    const ssp = new QuestionSSP({
      questionId: 'updated',
      questions: [{ question: 'Initial question' }],
      status: 'asked',
    }, { onResult: vi.fn(), onSkip });

    ssp.update({ questions: null as never });
    expect(ssp.payload.questions).toEqual([]);
    ssp.render(stream);
    expect(stream.questionCarousel).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('treats a synchronous carousel failure as a skipped interaction', () => {
    const stream = streamWithCarousel();
    stream.questionCarousel.mockImplementation(() => {
      throw new Error('carousel unavailable');
    });
    const onSkip = vi.fn();
    const ssp = new QuestionSSP({
      questionId: 'throws',
      questions: [{ question: 'Continue?' }],
      status: 'asked',
    }, { onResult: vi.fn(), onSkip });

    expect(() => ssp.render(stream)).not.toThrow();
    expect(onSkip).toHaveBeenCalledOnce();
    expect(ssp.payload.status).toBe('skipped');
  });

  it('rechecks the public payload at the rendering boundary', () => {
    const stream = streamWithCarousel();
    const ssp = new QuestionSSP({
      questionId: 'mutated',
      questions: [{ question: 'Initial question' }],
      status: 'asked',
    });
    ssp.payload.questions = [{ options: [{ label: 'Continue' }] }];

    ssp.render(stream);
    const rendered = stream.questionCarousel.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(rendered[0]).toMatchObject({ title: 'Question 1', type: 2 });
  });
});
