import { describe, expect, it } from 'vitest';

import { CallHeld, RunStopped, think, ThinkingFailed, ThinkingPaused, ThinkingStopped, type CallContext, type ModelCompletion, type ModelPort, type ModelRequest, type RunTool, type TurnMessage, type TurnToolCall } from './turns';

const usage = { promptTokens: 10, cachedTokens: 0, completionTokens: 5 };
const connection = { apiKey: 'key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' };

const tool = (name: string): RunTool => ({ name, description: name, parameters: { type: 'object', properties: {} }, origin: { kind: 'internal' } });
const TOOLS = [tool('calendar.search'), tool('mail.send'), tool('channel.send')];

const call = (id: string, name: string, arguments_: unknown = {}): TurnToolCall => ({ id, name, arguments: JSON.stringify(arguments_) });

/** A model that answers each request with the next of `turns`: its calls, or, past the last, its words. */
const scripted = (...turns: TurnToolCall[][]): ModelPort & { requests: ModelRequest[] } => {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request): Promise<ModelCompletion> => {
      requests.push({ ...request, messages: [...request.messages] });
      const calls = turns[requests.length - 1];
      return calls ? { model: 'test-model', content: '', toolCalls: calls, usage } : { model: 'test-model', content: '終わりました。', toolCalls: [], usage };
    },
  };
};

const START: TurnMessage[] = [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'a@example.com に送って' }];

describe('the one loop, paused before a call and resumed', () => {
  it('tells each call its id, and a call the model made from a program is told so', async () => {
    const contexts: Array<{ name: string; context: CallContext }> = [];
    const model = scripted([call('call-1', 'calendar.search')]);

    const thought = await think({ model, connection, messages: START, tools: TOOLS, call: async (name, _arguments, context) => {
      contexts.push({ name, context });
      return { ok: true };
    } });

    expect(thought.output).toBe('終わりました。');
    expect(contexts).toEqual([{ name: 'calendar.search', context: { id: 'call-1', program: false } }]);
  });

  it('pauses at a held call with the answers of the calls before it and the calls still to make, and makes none of them', async () => {
    const made: string[] = [];
    const model = scripted([call('call-1', 'calendar.search'), call('call-2', 'mail.send', { to: 'a@example.com' }), call('call-3', 'channel.send')]);

    const paused = await think({ model, connection, messages: START, tools: TOOLS, call: async (name) => {
      if (name === 'mail.send') throw new CallHeld('確認します。');
      made.push(name);
      return { ok: true };
    } }).catch((error: unknown) => error);

    expect(paused).toBeInstanceOf(ThinkingPaused);
    const { thought, pending, reason } = paused as ThinkingPaused;
    expect(made).toEqual(['calendar.search']);
    expect(reason).toBe('確認します。');
    expect(pending.map((entry) => entry.id)).toEqual(['call-2', 'call-3']);
    expect(thought.messages.slice(START.length).map((message) => [message.role, message.toolCallId ?? null])).toEqual([
      ['assistant', null], ['tool', 'call-1'],
    ]);
    expect(thought.toolCallCount).toBe(3);
    expect(thought.tokens).toBe(15);
    expect(model.requests).toHaveLength(1);
  });

  it('resumed, makes the calls it had still to make, in order, before it asks the model again, and does not count them again', async () => {
    const order: string[] = [];
    const paused: TurnMessage[] = [
      ...START,
      { role: 'assistant', content: '', toolCalls: [call('call-1', 'calendar.search'), call('call-2', 'mail.send'), call('call-3', 'channel.send')] },
      { role: 'tool', name: 'calendar.search', toolCallId: 'call-1', content: '{"ok":true}' },
    ];
    const model: ModelPort & { requests: ModelRequest[] } = {
      requests: [],
      complete: async (request) => {
        order.push('model');
        model.requests.push({ ...request, messages: [...request.messages] });
        return { model: 'test-model', content: '送りました。', toolCalls: [], usage };
      },
    };

    const thought = await think({
      model, connection, messages: paused, tools: TOOLS,
      resume: { calls: [call('call-2', 'mail.send'), call('call-3', 'channel.send')] },
      call: async (name) => {
        order.push(name);
        return { sent: true };
      },
    });

    expect(order).toEqual(['mail.send', 'channel.send', 'model']);
    expect(model.requests[0]?.messages.slice(paused.length).map((message) => [message.role, message.toolCallId])).toEqual([
      ['tool', 'call-2'], ['tool', 'call-3'],
    ]);
    expect(thought.output).toBe('送りました。');
    expect(thought.toolCallCount).toBe(0);
  });

  it('pauses again at the next held call of a resumed message', async () => {
    const paused = await think({
      model: scripted(), connection, messages: START, tools: TOOLS,
      resume: { calls: [call('call-2', 'mail.send'), call('call-3', 'channel.send')] },
      call: async (name) => {
        if (name === 'channel.send') throw new CallHeld('もう一度確認します。');
        return { sent: true };
      },
    }).catch((error: unknown) => error);

    expect(paused).toBeInstanceOf(ThinkingPaused);
    expect((paused as ThinkingPaused).pending.map((entry) => entry.id)).toEqual(['call-3']);
    expect((paused as ThinkingPaused).thought.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call-2' });
  });

  it('thinks as it always did when no call is held: every call made, told, and counted, and the run ends with the model\'s words', async () => {
    const model = scripted([call('call-1', 'calendar.search'), call('call-2', 'mail.send')], [call('call-3', 'channel.send')]);

    const thought = await think({ model, connection, messages: START, tools: TOOLS, call: async (name) => ({ name }) });

    expect(thought.output).toBe('終わりました。');
    expect(thought.toolCallCount).toBe(3);
    expect(thought.messages.slice(START.length).map((message) => message.role)).toEqual(['assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant']);
    expect(model.requests).toHaveLength(3);
  });
});

describe('the one loop, steered while it runs', () => {
  it('hands what the person said to the model before its next request, after the calls it was making', async () => {
    const said: TurnMessage[][] = [[], [{ role: 'user', content: '件名は「定例」にして' }]];
    const order: string[] = [];
    const model = scripted([call('call-1', 'calendar.search')]);

    const thought = await think({
      model, connection, messages: START, tools: TOOLS,
      call: async (name) => {
        order.push(`call ${name}`);
        return { ok: true };
      },
      steer: async () => {
        order.push('steer');
        return said.shift() ?? [];
      },
    });

    expect(thought.output).toBe('終わりました。');
    expect(order).toEqual(['steer', 'call calendar.search', 'steer', 'steer']);
    // The second request ends with the call's answer and then the person's words.
    expect(model.requests[1]?.messages.slice(START.length).map((message) => [message.role, message.content])).toEqual([
      ['assistant', ''], ['tool', '{"ok":true}'], ['user', '件名は「定例」にして'],
    ]);
  });

  it('asks the model again when the person said something during its last request, and ends once nothing more is said', async () => {
    const said: TurnMessage[][] = [[], [{ role: 'user', content: 'やはり来週で' }]];
    const model = scripted();

    const thought = await think({ model, connection, messages: START, tools: TOOLS, call: async () => ({ ok: true }), steer: async () => said.shift() ?? [] });

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages.slice(START.length).map((message) => [message.role, message.content])).toEqual([
      ['assistant', '終わりました。'], ['user', 'やはり来週で'],
    ]);
    expect(thought.output).toBe('終わりました。');
    expect(thought.messages.at(-1)).toMatchObject({ role: 'assistant', content: '終わりました。' });
  });

  it('thinks exactly as before when nothing steers it', async () => {
    const steered = scripted([call('call-1', 'calendar.search')]);
    const plain = scripted([call('call-1', 'calendar.search')]);
    const answer = async () => ({ ok: true });

    const withSteer = await think({ model: steered, connection, messages: START, tools: TOOLS, call: answer, steer: async () => [] });
    const without = await think({ model: plain, connection, messages: START, tools: TOOLS, call: answer });

    expect(withSteer).toEqual(without);
    expect(steered.requests).toEqual(plain.requests);
  });
});

describe('the one loop, on Pi', () => {
  it('ends the run with the model\'s failure, keeping what it did until then', async () => {
    let asked = 0;
    const model: ModelPort = { complete: async () => {
      asked += 1;
      if (asked === 1) return { model: 'test-model', content: '', toolCalls: [call('call-1', 'calendar.search')], usage };
      throw new Error('quota exceeded');
    } };

    const failed = await think({ model, connection, messages: START, tools: TOOLS, call: async () => ({ ok: true }) }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(ThinkingFailed);
    expect((failed as ThinkingFailed).message).toBe('quota exceeded');
    expect((failed as ThinkingFailed).thought.messages.slice(2).map((message) => message.role)).toEqual(['assistant', 'tool']);
  });

  it('ends a run a call stopped there, without making the calls after it', async () => {
    const made: string[] = [];
    const model = scripted([call('call-1', 'mail.send'), call('call-2', 'channel.send')]);

    const failed = await think({ model, connection, messages: START, tools: TOOLS, call: async (name) => {
      made.push(name);
      throw new RunStopped('mail.send reaches no one this run may reach.');
    } }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(ThinkingFailed);
    expect(made).toEqual(['mail.send']);
    expect(model.requests).toHaveLength(1);
  });

  it('tells the model a call whose arguments are not JSON, without making it', async () => {
    const made: string[] = [];
    const model = scripted([{ id: 'call-1', name: 'calendar.search', arguments: '{"days": 3' }]);

    const thought = await think({ model, connection, messages: START, tools: TOOLS, call: async (name) => {
      made.push(name);
      return { ok: true };
    } });

    expect(made).toEqual([]);
    const told = thought.messages.find((message) => message.role === 'tool');
    expect(told?.toolCallId).toBe('call-1');
    expect(JSON.parse(told?.content ?? '{}')).toMatchObject({ isError: true, message: expect.stringContaining('not JSON') });
    expect(thought.output).toBe('終わりました。');
  });

  it('stops where it was when its signal is aborted', async () => {
    const stop = new AbortController();
    const model = scripted([call('call-1', 'calendar.search')], [call('call-2', 'calendar.search')]);

    const stopped = await think({ model, connection, messages: START, tools: TOOLS, signal: stop.signal, call: async () => {
      stop.abort();
      return { ok: true };
    } }).catch((error: unknown) => error);

    expect(stopped).toBeInstanceOf(ThinkingStopped);
    expect(model.requests).toHaveLength(1);
  });
});

describe('the one loop, keeping how far it has got', () => {
  it('keeps its messages before each request to the model and each call, so a run whose object goes away knows what it was about to do', async () => {
    const kept: Array<Array<[string, string | null]>> = [];
    const made: string[] = [];
    const model = scripted([call('call-1', 'calendar.search'), call('call-2', 'mail.send')]);

    await think({
      model, connection, messages: START, tools: TOOLS,
      call: async (name) => {
        made.push(name);
        return { ok: true };
      },
      checkpoint: async (thought) => {
        kept.push(thought.messages.slice(START.length).map((message) => [message.role, message.toolCallId ?? null]));
      },
    });

    expect(made).toEqual(['calendar.search', 'mail.send']);
    expect(kept).toEqual([
      [],
      [['assistant', null]],
      [['assistant', null], ['tool', 'call-1']],
      [['assistant', null], ['tool', 'call-1'], ['tool', 'call-2']],
    ]);
  });

  it('goes on when its progress cannot be kept', async () => {
    const thought = await think({
      model: scripted([call('call-1', 'calendar.search')]), connection, messages: START, tools: TOOLS,
      call: async () => ({ ok: true }),
      checkpoint: async () => {
        throw new Error('R2 is unavailable.');
      },
    });

    expect(thought.output).toBe('終わりました。');
  });
});
