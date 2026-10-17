import { describe, expect, it } from 'vitest';
import { buildTitlePrompt } from '../participant/session-title';

describe('buildTitlePrompt', () => {
  it('asks the model to follow the user request language', () => {
    const prompt = buildTitlePrompt('分析 session id 和 title 的关系');

    expect(prompt).toContain('same natural language as the user request');
    expect(prompt).toContain('dominant natural language');
    expect(prompt).toContain('Preserve product names, APIs, file names, commands, code symbols');
    expect(prompt).toContain('修复 session 标题');
    expect(prompt).toContain('分析 session id 和 title 的关系');
  });

  it('truncates long user requests without dropping language instructions', () => {
    const prompt = buildTitlePrompt('修复'.repeat(400));

    expect(prompt).toContain('same natural language as the user request');
    expect(prompt).toContain('...');
    expect(prompt.length).toBeLessThan(1200);
  });
});
