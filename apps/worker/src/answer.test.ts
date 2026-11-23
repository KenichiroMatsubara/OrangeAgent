import { afterEach, describe, expect, it, vi } from 'vitest';

import { answerThread, openThreadRun } from './answer';
import { EffortRefused } from './effort';
import { productionProviders } from './providers';
import type { ModelCompletion, ModelRequest } from './turns';
import { usageOf } from './usage';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

describe('an answer of Operator Chat', () => {
  it('goes on at the model\'s default when the provider refuses the level of effort, and says so once', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const asked: ModelRequest[] = [];
    const answered: ModelCompletion = { model: 'test-model', content: 'はい。', toolCalls: [], usage: usageOf(undefined) };
    const completeTurn = vi.fn(async (request: ModelRequest): Promise<ModelCompletion> => {
      asked.push(request);
      if (request.effort) throw new EffortRefused('OpenAI 互換 API: reasoning is not supported');
      return answered;
    });
    const providers = { ...productionProviders(), ai: { completeTurn } };
    const database = fixture.account.binding;
    const notices: string[] = [];
    const runId = await openThreadRun({ env: fixture.environment, providers, database, accountId: 'organization-1' });

    const ended = await answerThread({
      env: fixture.environment, providers, database,
      answer: {
        accountId: 'organization-1', threadId: 'thread-1', runId, request: 'よく考えて', model: '', effort: 'xhigh', history: [], files: [],
        signal: new AbortController().signal, mode: () => 'unrestricted', steer: async () => [],
      },
      sink: { event: () => undefined, file: () => undefined, notice: (message) => notices.push(message), usage: () => undefined },
    });

    expect(ended).toEqual({ kind: 'completed' });
    expect(asked.map((request) => request.effort)).toEqual(['xhigh', undefined]);
    expect(notices).toEqual(['test-model が考える深さ「とても高い」を受け付けなかったため、既定の深さで答えます。']);
  });

  it('taken up again after its object went away, tells the model the call it was making has an unknown result, and keeps how far it gets', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const asked: ModelRequest[] = [];
    const completeTurn = vi.fn(async (request: ModelRequest): Promise<ModelCompletion> => {
      asked.push({ ...request, messages: [...request.messages] });
      return { model: 'test-model', content: '確かめて続けます。', toolCalls: [], usage: usageOf(undefined) };
    });
    const providers = { ...productionProviders(), ai: { completeTurn } };
    const database = fixture.account.binding;
    const runId = await openThreadRun({ env: fixture.environment, providers, database, accountId: 'organization-1' });
    const kept: number[] = [];

    const ended = await answerThread({
      env: fixture.environment, providers, database,
      answer: {
        accountId: 'organization-1', threadId: 'thread-1', runId, request: '記憶して', model: '', history: [], files: [],
        signal: new AbortController().signal, mode: () => 'unrestricted', steer: async () => [],
        restart: {
          runId, request: '記憶して', model: '', restarts: 1,
          messages: [{ role: 'assistant', content: '記憶します。', toolCalls: [{ id: 'call-1', name: 'memory.add', arguments: '{"content":"x"}' }] }],
          spent: { model: 'test-model', tokens: 40, toolCalls: 1, output: '記憶します。' },
        },
      },
      sink: {
        event: () => undefined, file: () => undefined, notice: () => undefined, usage: () => undefined,
        checkpoint: async ({ messages }) => {
          kept.push(messages.length);
        },
      },
    });

    expect(ended).toEqual({ kind: 'completed' });
    expect(asked[0]?.messages.slice(-3).map((message) => [message.role, message.toolCallId ?? null])).toEqual([
      ['user', null], ['assistant', null], ['tool', 'call-1'],
    ]);
    expect(asked[0]?.messages.at(-1)?.content).toContain('whether it took effect is unknown');
    expect(kept).toEqual([2]);
  });
});
