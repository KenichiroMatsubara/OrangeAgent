import { describe, expect, it } from 'vitest';

import { geminiEfforts, geminiThinking, modelEfforts, openAiEfforts, refusesEffort } from './effort';

describe('the levels of effort a model takes', () => {
  it('reads an OpenAI model\'s levels from its family, and offers none to a model that does not reason', () => {
    expect(openAiEfforts('o4-mini')).toEqual({ levels: ['low', 'medium', 'high'], default: 'medium' });
    expect(openAiEfforts('gpt-5-mini')).toEqual({ levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' });
    expect(openAiEfforts('gpt-5.1')).toEqual({ levels: ['none', 'low', 'medium', 'high'], default: 'none' });
    expect(openAiEfforts('gpt-5.5')).toEqual({ levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' });
    expect(openAiEfforts('gpt-5.1-codex')).toEqual({ levels: ['low', 'medium', 'high'], default: 'medium' });
    // A later family takes what every OpenAI reasoning model takes, its default unknown.
    expect(openAiEfforts('gpt-6.1')).toEqual({ levels: ['low', 'medium', 'high'], default: null });
    for (const model of ['gpt-4.1', 'gpt-4o', 'gpt-5-chat-latest', 'gpt-5-pro', 'text-embedding-3-small']) expect(openAiEfforts(model)).toBeNull();
  });

  it('reads a Gemini model\'s levels from its family, whatever path it was saved with', () => {
    expect(geminiEfforts('models/gemini-3-pro-preview')).toEqual({ levels: ['low', 'high'], default: 'high' });
    expect(geminiEfforts('gemini-3.1-pro-preview')).toEqual({ levels: ['low', 'medium', 'high'], default: 'high' });
    expect(geminiEfforts('gemini-3-flash')).toEqual({ levels: ['minimal', 'low', 'medium', 'high'], default: 'high' });
    expect(geminiEfforts('gemini-2.5-pro')).toEqual({ levels: ['low', 'medium', 'high'], default: null });
    expect(geminiEfforts('gemini-2.5-flash-lite')).toEqual({ levels: ['none', 'low', 'medium', 'high'], default: null });
    expect(geminiEfforts('gemini-4-ultra')).toEqual({ levels: ['low', 'high'], default: null });
    expect(geminiEfforts('gemini-2.0-flash')).toBeNull();
  });

  it('sends Gemini 2.5 a budget of tokens for a level, and a later Gemini the level itself', () => {
    expect(geminiThinking('gemini-3-flash', 'minimal')).toEqual({ thinkingLevel: 'minimal' });
    expect(geminiThinking('gemini-2.5-flash', 'none')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinking('gemini-2.5-flash', 'medium')).toEqual({ thinkingBudget: 8_192 });
    expect(geminiThinking('gemini-2.5-flash', 'high')).toEqual({ thinkingBudget: 24_576 });
    expect(geminiThinking('models/gemini-2.5-pro', 'high')).toEqual({ thinkingBudget: 32_768 });
  });

  it('offers an OpenRouter model low to high when OpenRouter says it takes reasoning, read once', async () => {
    const reads: string[] = [];
    const fetcher = async (url: string): Promise<Response> => {
      reads.push(url);
      return new Response(JSON.stringify({ data: [
        { id: 'deepseek/deepseek-r1', supported_parameters: ['max_tokens', 'reasoning', 'include_reasoning'] },
        { id: 'openai/gpt-4o', supported_parameters: ['max_tokens', 'tools'] },
      ] }), { headers: { 'Content-Type': 'application/json' } });
    };
    const connection = { apiKey: 'key', baseUrl: 'https://openrouter.ai/api/v1' };

    expect(await modelEfforts({ ...connection, model: 'deepseek/deepseek-r1' }, fetcher)).toEqual({ levels: ['low', 'medium', 'high'], default: null });
    expect(await modelEfforts({ ...connection, model: 'openai/gpt-4o' }, fetcher)).toBeNull();
    expect(reads).toEqual(['https://openrouter.ai/api/v1/models']);
    // A Connection on another API than the four offers no choice.
    expect(await modelEfforts({ ...connection, baseUrl: 'https://llm.example.com/v1', model: 'm' }, fetcher)).toBeNull();
  });

  it('takes a 400 about reasoning, effort, or thinking for a refusal of the level, and nothing else', () => {
    expect(refusesEffort(400, 'Unsupported value', 'reasoning.effort')).toBe(true);
    expect(refusesEffort(400, 'Gemini API: Thinking level is not supported for this model.')).toBe(true);
    expect(refusesEffort(400, 'OpenAI 互換 API: messages must not be empty')).toBe(false);
    expect(refusesEffort(401, 'reasoning requires a paid key')).toBe(false);
  });
});
