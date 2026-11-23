import { afterEach, describe, expect, it } from 'vitest';

import { createSkill, type SkillStore } from './skills';
import { runSubagent, type SubagentContext } from './subagent';
import { accountDatabase } from './storage/database';
import type { ModelCompletion, ModelPort, ModelRequest, RunTool, TurnToolCall } from './turns';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2 } from '../test/seed';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const usage = { promptTokens: 10, cachedTokens: 0, completionTokens: 5 };
const connection = { apiKey: 'key', baseUrl: 'https://ai.example.com/v1', model: 'model-a' };
const tool = (name: string): RunTool => ({ name, description: name, parameters: { type: 'object', properties: {} }, origin: { kind: 'internal' } });
const call = (id: string, name: string, arguments_: unknown = {}): TurnToolCall => ({ id, name, arguments: JSON.stringify(arguments_) });

/** A model that answers each request with the next of `turns`: its calls, or, past the last, its words. */
const scripted = (...turns: TurnToolCall[][]): ModelPort & { requests: ModelRequest[] } => {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request): Promise<ModelCompletion> => {
      requests.push({ ...request, messages: [...request.messages] });
      const calls = turns[requests.length - 1];
      return calls ? { model: request.model, content: '', toolCalls: calls, usage } : { model: request.model, content: '山田さんに送る通知を作りました。', toolCalls: [], usage };
    },
  };
};

const storeOf = (): SkillStore => {
  database = createMigratedTestD1('organization');
  return { db: accountDatabase(database.binding), bucket: createMemoryR2().bucket, accountId: 'organization-1' };
};

const contextOf = (skills: SkillStore, model: ModelPort, made: string[]): SubagentContext => ({
  model,
  connection,
  models: ['model-a', 'model-b'],
  instructions: (catalog) => `You are the assistant.\n\n${catalog}`,
  skills,
  tools: [tool('tasks.search'), tool('channel.send'), tool('agent.run'), tool('browser.click'), tool('memory.add')],
  handlers: {
    'tasks.search': async () => {
      made.push('tasks.search');
      return { tasks: [{ title: '熱田の招待行事', status: 'completed' }] };
    },
    'channel.send': async () => {
      made.push('channel.send');
      return { sent: true };
    },
  },
  fetch: async () => new Response(null, { status: 404 }),
});

describe('a subagent', () => {
  it('knows only its task and the Skill catalog, reads with the run\'s tools, and plans every write without making it', async () => {
    const skills = storeOf();
    await createSkill(skills, new TextEncoder().encode('---\nname: task-reminder\ndescription: 担当者にタスクを知らせるとき。\n---\n\nreminder_text で通知を作る。\n'));
    const model = scripted([call('call-1', 'tasks.search')], [call('call-2', 'channel.send', { contactId: 'tanaka', text: '通知' })]);
    const made: string[] = [];

    const answer = await runSubagent(contextOf(skills, model, made), { task: '熱田の招待行事の参加者を幹事と会計に通知して', model: 'model-b' }) as Record<string, unknown>;

    expect(answer).toMatchObject({
      model: 'model-b',
      answer: '山田さんに送る通知を作りました。',
      planned: [{ tool: 'channel.send', arguments: { contactId: 'tanaka', text: '通知' } }],
      toolCalls: 2,
    });
    // Its read was made; its write was only planned.
    expect(made).toEqual(['tasks.search']);
    const first = model.requests[0]!;
    expect(first.model).toBe('model-b');
    // It is told the task and the catalog, and nothing of the conversation that started it.
    expect(first.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(first.messages[0]?.content).toContain('<name>task-reminder</name>');
    expect(first.messages[1]?.content).toBe('熱田の招待行事の参加者を幹事と会計に通知して');
    // Neither another subagent nor a tool that acts at once is offered it.
    expect(first.tools.map((offered) => offered.function.name)).toEqual(['tasks.search', 'channel.send']);
  });

  it('starts with the Skills it is named, and refuses a task, a Skill, or a model the Account does not have', async () => {
    const skills = storeOf();
    await createSkill(skills, new TextEncoder().encode('---\nname: task-reminder\ndescription: 担当者にタスクを知らせるとき。\n---\n\nreminder_text で通知を作る。\n'));
    const model = scripted();
    const context = contextOf(skills, model, []);

    await runSubagent(context, { task: '通知して', skills: ['task-reminder'] });

    expect(model.requests[0]?.messages[0]?.content).toContain('reminder_text で通知を作る。');
    await expect(runSubagent(context, { task: '' })).resolves.toMatchObject({ isError: true });
    await expect(runSubagent(context, { task: '通知して', skills: ['no-such-skill'] })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('no-such-skill') });
    await expect(runSubagent(context, { task: '通知して', model: 'model-z' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('model-a, model-b') });
  });
});
