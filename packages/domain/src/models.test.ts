import { describe, expect, it } from 'vitest';

import { AI_MODEL_LIMIT, modelLabel, modelNameProblem, shortModelLabel } from './models';

describe('models', () => {
  it('reads a Claude model as its family and version', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelLabel('claude-fable-5-2')).toBe('Claude Fable 5.2');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(modelLabel('claude-opus-4')).toBe('Claude Opus 4');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Claude Sonnet 3.5');
    expect(shortModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
  });

  it('shows every other model by its own name', () => {
    expect(modelLabel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(shortModelLabel('openai/gpt-4.1')).toBe('openai/gpt-4.1');
    expect(modelLabel('claude-opus-5-5-thinking-preview')).toBe('claude-opus-5-5-thinking-preview');
  });

  it('refuses a model name that is empty, spaced, or already listed, and a list that is full', () => {
    expect(modelNameProblem('', [])).not.toBeNull();
    expect(modelNameProblem('claude opus', [])).not.toBeNull();
    expect(modelNameProblem('claude-opus-5-5', ['claude-opus-5-5'])).not.toBeNull();
    expect(modelNameProblem('m', Array.from({ length: AI_MODEL_LIMIT }, (_, index) => `m-${index}`))).not.toBeNull();
    expect(modelNameProblem('claude-opus-5-5', ['claude-haiku-5-5'])).toBeNull();
  });
});
