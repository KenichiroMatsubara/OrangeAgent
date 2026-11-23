import { describe, expect, it } from 'vitest';

import { fromWire, isRunToken, reachRun, rendezvousName, serveRun, toWire, type EntranceRequest, type ObjectMessage, type OpenRunAccess, type Rendezvous, type RendezvousNamespace, type RunMessage, type RunServing, type RunSocket } from './rendezvous';
import { FileAnswer, RunStopped, think, ThinkingFailed, type ModelPort, type ModelRequest, type RunTool } from './turns';

const connection = { apiKey: 'key', baseUrl: 'https://ai.example.com', model: 'test-model' };
const usage = { promptTokens: 1, cachedTokens: 0, completionTokens: 1 };

const internal = (name: string): RunTool => ({ name, description: `${name}.`, parameters: { type: 'object', properties: {} }, origin: { kind: 'internal' } });
const tools: RunTool[] = [internal('tasks.search'), internal('tasks.create'), internal('run.token')];

/** A rendezvous that hands the test the run's serving, as a program elsewhere would reach it. */
const capturing = () => {
  const held: { serving: RunServing | null; closed: number } = { serving: null, closed: 0 };
  const rendezvous: Rendezvous = {
    open: async (serving): Promise<OpenRunAccess> => {
      held.serving = serving;
      return { url: 'https://flarechat.example/mcp', token: 'run_secret', expiresAt: '2026-11-19T00:15:00.000Z', close: () => { held.closed += 1; } };
    },
  };
  return { held, rendezvous };
};

describe('a Run Token', () => {
  it('is not offered to a run with nowhere to issue one', async () => {
    const offered: string[][] = [];
    const model: ModelPort = { complete: async (request: ModelRequest) => {
      offered.push(request.tools.map((tool) => tool.function.name));
      return { model: 'test-model', content: 'done', toolCalls: [], usage };
    } };

    await think({ model, connection, messages: [{ role: 'user', content: 'go' }], tools, call: async () => null });

    expect(offered).toEqual([['tasks.search', 'tasks.create']]);
  });

  it('lets a program call the run’s tools through the run’s own handlers while the run thinks, and stops working when it ends', async () => {
    const { held, rendezvous } = capturing();
    const performed: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const programAnswers: unknown[] = [];
    let step = 0;
    const model: ModelPort = { complete: async () => {
      step += 1;
      if (step === 1) return { model: 'test-model', content: '', toolCalls: [{ id: 'call-1', name: 'run.token', arguments: '{}' }], usage };
      // While the model waits, the program it handed the token to calls a tool.
      programAnswers.push(await held.serving?.call('tasks.create', { title: '資料' }));
      programAnswers.push(await held.serving?.call('run.token', {}));
      return { model: 'test-model', content: '登録しました。', toolCalls: [], usage };
    } };

    const thought = await think({
      model, connection, messages: [{ role: 'user', content: 'go' }], tools,
      call: async (name, arguments_) => {
        performed.push({ name, arguments: arguments_ });
        return { status: 'planned' };
      },
      rendezvous,
    });

    expect(JSON.parse(thought.messages[2]?.content ?? '{}')).toEqual({ url: 'https://flarechat.example/mcp', token: 'run_secret', expiresAt: '2026-11-19T00:15:00.000Z' });
    expect(held.serving?.tools.map((tool) => tool.name)).toEqual(['tasks.search', 'tasks.create']);
    expect(performed).toEqual([{ name: 'tasks.create', arguments: { title: '資料' } }]);
    expect(programAnswers).toEqual([{ status: 'planned' }, { isError: true, message: 'A Run Token does not issue another.' }]);
    expect(thought.toolCallCount).toBe(2);
    expect(held.closed).toBe(1);
    expect(await held.serving?.call('tasks.search', {})).toEqual({ isError: true, message: 'This run has stopped, so the call was not made.' });
  });

  it('ends the run when a program’s call reaches what the run may not, as the run’s own call would', async () => {
    const { held, rendezvous } = capturing();
    let step = 0;
    const model: ModelPort = { complete: async () => {
      step += 1;
      if (step === 1) return { model: 'test-model', content: '', toolCalls: [{ id: 'call-1', name: 'run.token', arguments: '{}' }], usage };
      await held.serving?.call('tasks.create', {});
      return { model: 'test-model', content: 'done', toolCalls: [], usage };
    } };

    const run = think({
      model, connection, messages: [{ role: 'user', content: 'go' }], tools,
      call: async () => { throw new RunStopped('This Automation may not reach that Contact.'); },
      rendezvous,
    });

    await expect(run).rejects.toBeInstanceOf(ThinkingFailed);
    await expect(run).rejects.toThrow('This Automation may not reach that Contact.');
    expect(held.closed).toBe(1);
  });
});

/** One end of a socket, recording what it sends and letting the test deliver what the object says. */
const socketOf = () => {
  const sent: RunMessage[] = [];
  let listener: ((event: { data: unknown }) => void) | null = null;
  const socket: RunSocket = {
    send: (data) => { sent.push(JSON.parse(data) as RunMessage); },
    addEventListener: (_type, handler) => { listener = handler; },
  };
  const deliver = (message: ObjectMessage) => listener?.({ data: JSON.stringify(message) });
  return { sent, socket, deliver };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a run serving its calls', () => {
  it('says who it is and what it offers, then answers each call with its handler, a failure as why', async () => {
    const { sent, socket, deliver } = socketOf();
    const serving: RunServing = {
      tools: [{ name: 'tasks.search', description: 'List.', parameters: { type: 'object' } }],
      call: async (name) => {
        if (name === 'tasks.search') return { tasks: [] };
        throw new Error('No handler performs mail.send.');
      },
    };

    const ready = serveRun(socket, serving, { accountId: 'organization-1', expiresAt: '2026-11-19T00:15:00.000Z' });
    expect(sent).toEqual([{ type: 'hello', accountId: 'organization-1', expiresAt: '2026-11-19T00:15:00.000Z', tools: serving.tools }]);
    deliver({ type: 'ready' });
    await ready;
    deliver({ type: 'call', id: 'a', name: 'tasks.search', arguments: {} });
    deliver({ type: 'call', id: 'b', name: 'mail.send', arguments: {} });
    await settle();

    expect(sent.slice(1)).toEqual([
      { type: 'answer', id: 'a', answer: { kind: 'value', value: { tasks: [] } } },
      { type: 'answer', id: 'b', answer: { kind: 'error', message: 'No handler performs mail.send.' } },
    ]);
  });

  it('hands over a file a tool read as the file itself', () => {
    const read = new FileAnswer({ subject: '資料' }, [{ filename: 'a.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1, 2, 255]) }]);

    const crossed = fromWire(JSON.parse(JSON.stringify(toWire(read))) as ReturnType<typeof toWire>);

    expect(crossed).toBeInstanceOf(FileAnswer);
    expect((crossed as FileAnswer).answer).toEqual({ subject: '資料' });
    expect((crossed as FileAnswer).files).toEqual([{ filename: 'a.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1, 2, 255]) }]);
  });
});

/** A namespace whose one object answers as the test says, recording what it was asked and by which name. */
const namespaceOf = (answer: (request: EntranceRequest) => Response) => {
  const asked: Array<{ name: string; request: EntranceRequest }> = [];
  const namespace: RendezvousNamespace = {
    idFromName: (name) => ({ name, toString: () => name, equals: () => false }) as DurableObjectId,
    get: (id) => ({
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as EntranceRequest;
        asked.push({ name: id.toString(), request });
        return answer(request);
      },
    }),
  };
  return { asked, namespace };
};

describe('the MCP Server reaching a run', () => {
  it('tells a Run Token from any other token by its prefix', () => {
    expect(isRunToken('run_abc')).toBe(true);
    expect(isRunToken('abc')).toBe(false);
  });

  it('reaches no run when the object holds none for this Account', async () => {
    const { namespace } = namespaceOf(() => new Response(null, { status: 404 }));

    expect(await reachRun({ namespace, presented: 'run_abc', accountId: 'organization-1' })).toBeNull();
  });

  it('lists the run’s tools and puts each call to the object named by the token’s hash, never the token itself', async () => {
    const { asked, namespace } = namespaceOf((request) => request.kind === 'list'
      ? Response.json({ tools: [{ name: 'tasks.search', description: 'List.', parameters: {} }] })
      : Response.json({ answer: { kind: 'value', value: { tasks: [] } } }));

    const run = await reachRun({ namespace, presented: 'run_abc', accountId: 'organization-1' });

    expect(run?.tools.map((tool) => tool.name)).toEqual(['tasks.search']);
    expect(await run?.call('tasks.search', { status: 'open' })).toEqual({ tasks: [] });
    expect(asked.map(({ name }) => name)).toEqual([await rendezvousName('run_abc'), await rendezvousName('run_abc')]);
    expect(asked.map(({ name }) => name)).not.toContain('run_abc');
    expect(asked[1]?.request).toEqual({ kind: 'call', accountId: 'organization-1', name: 'tasks.search', arguments: { status: 'open' } });
  });

  it('refuses a call whose run ended in the meantime, and warns that one it timed out on may still be made', async () => {
    let status = 404;
    const { namespace } = namespaceOf((request) => request.kind === 'list' ? Response.json({ tools: [] }) : new Response(null, { status }));
    const run = await reachRun({ namespace, presented: 'run_abc', accountId: 'organization-1' });

    expect(await run?.call('tasks.create', {})).toEqual({ isError: true, message: expect.stringContaining('has ended') });
    status = 504;
    expect(await run?.call('tasks.create', {})).toEqual({ isError: true, message: expect.stringContaining('may still make it') });
  });
});
