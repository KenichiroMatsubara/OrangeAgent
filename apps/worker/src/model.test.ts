import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetOpenRouterModels } from './effort';
import { completeTurn } from './model';
import type { ModelRequest } from './turns';

const OPENROUTER = { apiKey: 'key', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-3-flash' };

const sse = (chunks: readonly unknown[]): Response => new Response(
  [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''),
  { headers: { 'Content-Type': 'text/event-stream' } },
);
const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: OPENROUTER.model, choices: [{ index: 0, delta, finish_reason: finish }] });
const said = (text: string) => sse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop')]);

/** Answers Chat Completions with `answer`, and OpenRouter's model list with `listed`. */
const provider = (answer: () => Response, listed: unknown[] = []) => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/models')
    ? new Response(JSON.stringify({ data: listed }), { headers: { 'Content-Type': 'application/json' } })
    : answer());
  vi.stubGlobal('fetch', fetchMock);
  const bodies = () => (fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>)
    .filter(([url]) => String(url).endsWith('/chat/completions'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  return { bodies };
};

const MAIL_SEARCH: ModelRequest['tools'][number] = { type: 'function', function: { name: 'mail.search', description: 'Search mail.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } };
const CODE_RUN: ModelRequest['tools'][number] = { type: 'function', function: { name: 'code.run', description: 'Run code.', parameters: { type: 'object', properties: {} } } };

afterEach(() => {
  forgetOpenRouterModels();
  vi.unstubAllGlobals();
});

describe('a turn through Pi', () => {
  it('sends every tool under a name the provider takes, and reads its calls back under the product\'s own name, keeping Pi\'s record of the turn', async () => {
    const sent = provider(() => sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-9', type: 'function', function: { name: 'mail_search', arguments: '{"query":"名簿"}' } }] }), chunk({}, 'tool_calls')]));

    const completion = await completeTurn({ ...OPENROUTER, tools: [MAIL_SEARCH], messages: [{ role: 'system', content: '指示' }, { role: 'user', content: '名簿を探して' }] });

    expect((sent.bodies()[0]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(['mail_search']);
    expect(completion.toolCalls).toEqual([{ id: 'call-9', name: 'mail.search', arguments: '{"query":"名簿"}' }]);
    expect(completion.replay).toMatchObject({ kind: 'pi', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'mail.search', arguments: { query: '名簿' } }] } });
  });

  it('hands a tool\'s text file as its words, and any file it cannot read as one to open with code.run, or as one it cannot open without it', async () => {
    const messages: ModelRequest['messages'] = [
      { role: 'user', content: '名簿を確認して' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'mail.read', arguments: '{}' }] },
      { role: 'tool', name: 'mail.read', toolCallId: 'call-1', content: '{"subject":"名簿"}', attachments: [
        { filename: '案内.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1]) },
        { filename: 'memo.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('19:00 開始') },
      ] },
    ];
    const sent = provider(() => said('読みました。'));

    await completeTurn({ ...OPENROUTER, tools: [MAIL_SEARCH], messages });
    await completeTurn({ ...OPENROUTER, tools: [MAIL_SEARCH, CODE_RUN], messages });

    const tool = (body: Record<string, unknown> | undefined) => (body?.messages as Array<{ role: string; content: string; tool_call_id?: string }>).find((message) => message.role === 'tool');
    expect(tool(sent.bodies()[0])).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"subject":"名簿"}\n案内.pdf (application/pdf) cannot be opened here, because this Worker lends no environment to run code in. Say so rather than guessing its contents.\nmemo.txt:\n19:00 開始' });
    expect(tool(sent.bodies()[1])?.content).toContain('You hold 案内.pdf (application/pdf). Open it with code.run, naming 案内.pdf in files');
    // A turn kept before Pi is sent as its words and calls, under the names the provider takes.
    expect((sent.bodies()[0]?.messages as Array<{ role: string; tool_calls?: Array<{ function: { name: string } }> }>).find((message) => message.role === 'assistant')?.tool_calls?.[0]?.function.name).toBe('mail_read');
  });

  it('sends an OpenRouter model that reasons the level it is asked, and neither one that does not nor a level OpenRouter does not offer', async () => {
    const sent = provider(() => said('はい。'), [{ id: OPENROUTER.model, supported_parameters: ['reasoning'] }]);

    await completeTurn({ ...OPENROUTER, tools: [], messages: [{ role: 'user', content: 'よく考えて' }], effort: 'high' });
    await completeTurn({ ...OPENROUTER, model: 'openai/gpt-4o-mini', tools: [], messages: [{ role: 'user', content: 'よく考えて' }], effort: 'high' });
    await completeTurn({ ...OPENROUTER, tools: [], messages: [{ role: 'user', content: 'よく考えて' }], effort: 'max' });

    const [high, none, max] = sent.bodies();
    expect(JSON.stringify(high)).toContain('high');
    expect(JSON.stringify(none)).not.toContain('reasoning');
    expect(JSON.stringify(max)).not.toContain('"max"');
  });

  it('fails a turn the provider fails, in the provider\'s words', async () => {
    provider(() => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429, headers: { 'Content-Type': 'application/json' } }));

    await expect(completeTurn({ ...OPENROUTER, tools: [], messages: [{ role: 'user', content: 'こんにちは' }] })).rejects.toThrow(/quota exceeded/u);
  });
});

describe('what a request cost', () => {
  const ASK: ModelRequest = { ...OPENROUTER, tools: [], messages: [{ role: 'user', content: 'こんにちは' }] };

  it('is what OpenRouter billed, when it reports its bill', async () => {
    provider(() => sse([
      chunk({ role: 'assistant', content: 'はい' }),
      { ...chunk({}, 'stop'), usage: { prompt_tokens: 1_000, completion_tokens: 20, total_tokens: 1_020, cost: 0.0021, is_byok: false } },
    ]));

    const completion = await completeTurn(ASK);

    expect(completion.usage).toMatchObject({ promptTokens: 1_000, completionTokens: 20, costUsd: 0.0021, costBilled: true });
  });

  it('is unknown, rather than free, for a model no catalog prices and no bill reports', async () => {
    provider(() => sse([
      chunk({ role: 'assistant', content: 'はい' }),
      { ...chunk({}, 'stop'), usage: { prompt_tokens: 1_000, completion_tokens: 20, total_tokens: 1_020 } },
    ]));

    const completion = await completeTurn(ASK);

    expect(completion.usage.costUsd).toBeUndefined();
    expect(completion.usage.costBilled).toBeUndefined();
  });
});
