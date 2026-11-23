import { describe, expect, it } from 'vitest';

import { answerText, cleanSuggestion, SUGGESTION_CHARACTERS, SUGGESTION_MODEL, suggestionMessages, workersAiSuggester } from './suggestion';
import type { TurnMessage } from './turns';

const exchange: TurnMessage[] = [
  { role: 'user', content: '熱田招待行事について調べて幹事、会計に送るようにテスト用で松原に送信しろ' },
  { role: 'assistant', content: '本見の通知文を作りました。\n\n確認させてください\n1. 松原健一郎さんに LINE で送ってよいですか。' },
];

/** Workers AI as the suggester calls it, answering with `answer` and recording what it was asked. */
const workersAi = (answer: unknown) => {
  const calls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
  const ai = {
    run: async (model: string, inputs: Record<string, unknown>) => {
      calls.push({ model, inputs });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as Ai;
  return { ai, calls };
};

const completion = (content: string | null) => ({ id: 'c', object: 'chat.completion', created: 0, model: SUGGESTION_MODEL, choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', logprobs: null }] });

describe('the request that predicts the next message', () => {
  it('tells the model the last exchanges as a transcript in one message, so it predicts the member rather than answers them', () => {
    const [system, user] = suggestionMessages(exchange);

    expect(system).toMatchObject({ role: 'system' });
    expect(system?.content).toContain('ユーザーが次に送るメッセージを予測します');
    expect(user?.role).toBe('user');
    expect(user?.content).toBe([
      '<会話>',
      'ユーザー: 熱田招待行事について調べて幹事、会計に送るようにテスト用で松原に送信しろ',
      '',
      'AI: 本見の通知文を作りました。\n\n確認させてください\n1. 松原健一郎さんに LINE で送ってよいですか。',
      '</会話>',
      '',
      'ユーザーが次に送るメッセージ:',
    ].join('\n'));
  });

  it('reads only the last three exchanges, the end of each answer where its question is, and the start of each message', () => {
    const history: TurnMessage[] = Array.from({ length: 5 }, (_, index): TurnMessage[] => [
      { role: 'user', content: `質問${index}${'あ'.repeat(700)}` },
      { role: 'assistant', content: `${'い'.repeat(2_500)}回答${index}` },
    ]).flat();

    const transcript = suggestionMessages(history)[1]?.content ?? '';

    expect(transcript).not.toContain('質問1');
    expect(transcript).toContain('質問2');
    expect(transcript).toContain('回答4');
    expect(transcript).toContain(`ユーザー: 質問4${'あ'.repeat(597)}…`);
    expect(transcript).toContain(`AI: …${'い'.repeat(1_997)}回答4`);
  });
});

describe('the suggestion in what the model wrote', () => {
  it('is its first line, without labels, quotation marks, or reasoning', () => {
    expect(cleanSuggestion('送れ')).toBe('送れ');
    expect(cleanSuggestion('\n「送れ」\n理由: 確認を求めているため')).toBe('送れ');
    expect(cleanSuggestion('ユーザー: 1だけ送って')).toBe('1だけ送って');
    expect(cleanSuggestion('<think>確認待ちなので承認する</think>\nはい、お願いします')).toBe('はい、お願いします');
  });

  it('is nothing when the model predicts nothing, writes markup, or writes more than a member types as a reply', () => {
    expect(cleanSuggestion('なし')).toBeNull();
    expect(cleanSuggestion('なし。')).toBeNull();
    expect(cleanSuggestion('（なし）')).toBeNull();
    expect(cleanSuggestion('None')).toBeNull();
    expect(cleanSuggestion('<signal type="empty" />')).toBeNull();
    expect(cleanSuggestion('_(no suggestion)_')).toBeNull();
    expect(cleanSuggestion('あ'.repeat(SUGGESTION_CHARACTERS + 1))).toBeNull();
    expect(cleanSuggestion('あ'.repeat(SUGGESTION_CHARACTERS))).toBe('あ'.repeat(SUGGESTION_CHARACTERS));
    expect(cleanSuggestion('')).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
  });

  it('is read from a chat completion or from the older response field', () => {
    expect(answerText(completion('送れ'))).toBe('送れ');
    expect(answerText({ response: '送れ' })).toBe('送れ');
    expect(answerText(completion(null))).toBeNull();
    expect(answerText({ choices: [] })).toBeNull();
    expect(answerText(null)).toBeNull();
  });
});

describe('the suggester that asks Workers AI', () => {
  it('asks GLM-4.7 Flash without reasoning and offers the line it writes', async () => {
    const { ai, calls } = workersAi(completion('送れ'));

    expect(await workersAiSuggester(ai)(exchange)).toBe('送れ');
    expect(calls).toEqual([{
      model: '@cf/zai-org/glm-4.7-flash',
      inputs: expect.objectContaining({ messages: suggestionMessages(exchange), chat_template_kwargs: { enable_thinking: false } }),
    }]);
  });

  it('asks nothing before the conversation has an answer to follow', async () => {
    const { ai, calls } = workersAi(completion('送れ'));

    expect(await workersAiSuggester(ai)([{ role: 'user', content: 'こんにちは' }])).toBeNull();
    expect(calls).toEqual([]);
  });

  it('offers nothing when the model predicts nothing', async () => {
    const { ai } = workersAi(completion('なし'));

    expect(await workersAiSuggester(ai)(exchange)).toBeNull();
  });
});
