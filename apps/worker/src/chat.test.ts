import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolRun } from '@mail/domain';

import { runChatTurn } from './chat';
import { resolveTools, ThinkingStopped, type McpServerSource, type ModelPort, type TurnEvent, type TurnMessage } from './turns';
import type { McpFetch } from './mcp';

afterEach(() => {
  vi.restoreAllMocks();
});

const server = (name: string, url: string): McpServerSource => ({ id: `${name}-1`, name, connection: { url } });

const listing = (tools: Array<{ name: string; description?: string }>): McpFetch => async (_url, init) => {
  const body = JSON.parse(String(init.body ?? '{}')) as { id?: string };
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: body.id,
    result: { tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object', properties: {} } })) },
  }), { headers: { 'Content-Type': 'application/json' } });
};

const internalNames = ['query_scheduled_events', 'query_contacts', 'query_attendance', 'channel.send', 'reminder.schedule'];
const readNames = ['query_scheduled_events', 'query_contacts', 'query_attendance'];

describe('tool resolution', () => {
  it('binds no external tool to a run held for approval, whose approval would come after the call', async () => {
    const run: ToolRun = { executionMode: 'approval', writes: 'planned', holds: [] };
    const resolved = await resolveTools({ run, servers: [server('notion', 'https://notion.example.com/mcp')], fetch: listing([{ name: 'search' }]) });

    expect(resolved.tools.map((tool) => tool.name)).toContain('channel.send');
    expect(resolved.tools.map((tool) => tool.name)).not.toContain('notion.search');
  });

  it('gives an unattended chat every internal tool and every connected server tool', async () => {
    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [] },
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'search' }, { name: 'append' }]) });

    expect(resolved.tools.map((tool) => tool.name)).toEqual([...internalNames, 'notion.search', 'notion.append']);
    expect(resolved.failures).toEqual([]);
  });

  it('keeps the product’s own tool when a server registered under a reserved name offers one of the same name, and says so', async () => {
    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: ['memory'] },
      servers: [server('memory', 'https://memory.example.com/mcp')],
      fetch: listing([{ name: 'search' }, { name: 'graph' }]) });

    expect(resolved.tools.filter((tool) => tool.name === 'memory.search').map((tool) => tool.origin.kind)).toEqual(['internal']);
    expect(resolved.tools.map((tool) => tool.name)).toContain('memory.graph');
    expect(resolved.failures).toEqual([{ server: 'memory', error: expect.stringContaining('memory.search is the name of one of FlareChat') }]);
  });

  it('binds no external tool at all in read-only mode', async () => {
    const resolved = await resolveTools({ run: { executionMode: 'read_only', writes: 'performed', holds: [] },
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'search' }]) });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(readNames);
  });

  it('adds the Google tools only to a run that holds the Google grant', async () => {
    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: ['google'] }, servers: [], fetch: listing([]) });

    expect(resolved.tools.map((tool) => tool.name)).toEqual([
      ...readNames, 'mail.search', 'mail.read', 'calendar.search', 'drive.search', 'drive.read', 'meet.search', 'meet.read', 'tasks.search',
      'tasks.create', 'tasks.update', 'channel.send', 'reminder.schedule', 'mail.send', 'mail.draft', 'create_scheduled_event', 'update_scheduled_event', 'cancel_scheduled_event', 'attach_event_files', 'record_event_response',
      'drive.create_folder', 'drive.move', 'drive.rename', 'drive.trash', 'meet.transcribe',
    ]);
  });

  it('admits only the tools a grant names', async () => {
    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [], grant: ['notion.search'] },
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'search' }, { name: 'append' }]) });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(['notion.search']);
  });

  it('lists only the servers a grant names a tool of', async () => {
    let listed = 0;
    const counting: McpFetch = async (url, init) => {
      listed += 1;
      return listing([{ name: 'search' }])(url, init);
    };

    await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [], grant: ['query_contacts'] }, servers: [server('notion', 'https://notion.example.com/mcp')], fetch: counting });

    expect(listed).toBe(0);
  });

  it('reports an unreachable server rather than quietly losing its tools', async () => {
    const failing: McpFetch = async () => new Response('gateway down', { status: 502 });

    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [] },
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: failing });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(internalNames);
    expect(resolved.failures).toEqual([{ server: 'notion', error: expect.stringContaining('502') as unknown as string }]);
  });
});

const model = (turns: Array<{ content: string; toolCalls?: Array<{ name: string; arguments: string }> }>): ModelPort => {
  let index = 0;
  return {
    complete: async () => {
      const turn = turns[index] ?? turns[turns.length - 1];
      index += 1;
      if (!turn) throw new Error('No stubbed chat completion.');
      return {
        model: 'test-model',
        content: turn.content,
        toolCalls: (turn.toolCalls ?? []).map((call, position) => ({ id: `call-${position}`, name: call.name, arguments: call.arguments })),
        usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 0 },
      };
    },
  };
};

const connection = { apiKey: 'key', baseUrl: 'https://ai.example.com', model: 'test-model' };

describe('Operator Chat turn', () => {
  it('answers without calling a tool', async () => {
    const result = await runChatTurn({
      model: model([{ content: 'Nothing is scheduled.' }]),
      connection,
      instructions: '',
      request: 'What is scheduled?',
      history: [],
      tools: [],
      fetch: listing([]),
      handlers: { query_scheduled_events: async () => [] },
    });

    expect(result.output).toBe('Nothing is scheduled.');
    expect(result.toolCallCount).toBe(0);
  });

  it('writes what FlareChat says after the member\'s words into their message, leaving the instructions as they are', async () => {
    const asked: TurnMessage[][] = [];
    const recording: ModelPort = { complete: async (request) => {
      asked.push(request.messages);
      return { model: 'test-model', content: 'はい', toolCalls: [], usage: { promptTokens: 1, cachedTokens: 0, completionTokens: 1 } };
    } };

    await runChatTurn({
      model: recording, connection, instructions: '案内', postscript: '[FlareChat: it is now 正午 in Asia/Tokyo.]',
      request: '予定は？', history: [{ role: 'user', content: '前の質問' }, { role: 'assistant', content: '前の答え' }], tools: [], fetch: listing([]), handlers: {},
    });

    expect(asked[0]).toEqual([
      { role: 'system', content: '案内' },
      { role: 'user', content: '前の質問' },
      { role: 'assistant', content: '前の答え' },
      { role: 'user', content: '予定は？\n\n[FlareChat: it is now 正午 in Asia/Tokyo.]' },
    ]);
  });

  it('stops where it is when its signal is aborted: the model is handed the signal, and no tool it asked for is called', async () => {
    const stop = new AbortController();
    const called: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const asking: ModelPort = { complete: async (request) => {
      signals.push(request.signal);
      // The administrator stops the answer while the model is asking for a tool.
      stop.abort();
      return { model: 'test-model', content: '', toolCalls: [{ id: 'call-1', name: 'query_contacts', arguments: '{}' }], usage: { promptTokens: 1, cachedTokens: 0, completionTokens: 1 } };
    } };

    const stopped = runChatTurn({
      model: asking, connection, instructions: '', request: 'Write a long report.', history: [], tools: [], fetch: listing([]),
      handlers: { query_contacts: async () => { called.push('query_contacts'); return []; } },
      signal: stop.signal,
    });

    await expect(stopped).rejects.toBeInstanceOf(ThinkingStopped);
    expect(signals).toEqual([stop.signal]);
    expect(called).toEqual([]);
  });

  it('calls an MCP tool and hands the model its real result', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { id?: string; params?: Record<string, unknown> };
      calls.push(body.params ?? {});
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'page created' }] },
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [], grant: ['notion.append'] },
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'append' }]) });

    const result = await runChatTurn({
      model: model([
        { content: '', toolCalls: [{ name: 'notion.append', arguments: '{"text":"hello"}' }] },
        { content: 'Added it.' },
      ]),
      connection,
      instructions: '',
      request: 'Append hello to Notion.',
      history: [],
      tools: resolved.tools,
      fetch,
      handlers: {},
    });

    expect(result.output).toBe('Added it.');
    expect(calls[0]).toMatchObject({ name: 'append', arguments: { text: 'hello' } });
    expect(result.messages.some((message) => message.role === 'tool' && message.content.includes('page created'))).toBe(true);
  });

  it('shows the model a failed tool call as a failure', async () => {
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { id?: string };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { isError: true, content: [{ type: 'text', text: 'permission denied' }] },
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const resolved = await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [] },
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'append' }]) });

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events: TurnEvent[] = [];
    const result = await runChatTurn({
      model: model([
        { content: '', toolCalls: [{ name: 'notion.append', arguments: '{}' }] },
        { content: 'It refused.' },
      ]),
      connection,
      instructions: '',
      request: 'Append.',
      history: [],
      tools: resolved.tools,
      fetch,
      handlers: {},
      onEvent: (event) => events.push(event),
      trace: { runId: 'run-1' },
    });

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('permission denied');
    expect(toolMessage?.content).toContain('"isError":true');
    // A server's refusal is a failure, shown and logged with its words.
    expect(events).toContainEqual({ type: 'tool', name: 'notion.append', state: 'failed', error: 'permission denied', id: 'call-0' });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ event: 'tool_failed', runId: 'run-1', tool: 'notion.append', arguments: '{}', error: 'permission denied' });
  });

  it('shows a product tool that refused or threw as failed, saying why', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events: TurnEvent[] = [];
    const tools = [
      { name: 'mail.read', description: '', parameters: {}, origin: { kind: 'internal' as const } },
      { name: 'mail.search', description: '', parameters: {}, origin: { kind: 'internal' as const } },
    ];
    const throttled = Object.assign(new Error('Too many concurrent requests for user.'), { name: 'GoogleApiError', status: 429 });

    await runChatTurn({
      model: model([
        { content: '', toolCalls: [{ name: 'mail.read', arguments: '{}' }, { name: 'mail.search', arguments: '{"query":"zoom"}' }] },
        { content: 'Gmail refused.' },
      ]),
      connection,
      instructions: '',
      request: 'Search.',
      history: [],
      tools,
      fetch: listing([]),
      handlers: {
        'mail.read': async () => ({ isError: true, message: 'mail.read requires a messageId from mail.search.' }),
        'mail.search': async () => { throw throttled; },
      },
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type === 'tool' && event.state !== 'started')).toEqual([
      { type: 'tool', name: 'mail.read', state: 'failed', error: 'mail.read requires a messageId from mail.search.', id: 'call-0' },
      { type: 'tool', name: 'mail.search', state: 'failed', error: 'GoogleApiError 429: Too many concurrent requests for user.', id: 'call-1' },
    ]);
  });

  it('names each tool call by its id, with what it was asked on its start and what it answered on its end', async () => {
    const events: TurnEvent[] = [];
    const tools = [{ name: 'tasks.search', description: '', parameters: {}, origin: { kind: 'internal' as const } }];

    await runChatTurn({
      model: model([
        { content: '', toolCalls: [{ name: 'tasks.search', arguments: '{"query":"請求"}' }] },
        { content: '1件です。' },
      ]),
      connection,
      instructions: '',
      request: '請求のタスクは？',
      history: [],
      tools,
      fetch: listing([]),
      handlers: { 'tasks.search': async () => ({ tasks: [{ title: '請求書を送る' }] }) },
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', name: 'tasks.search', state: 'started', id: 'call-0', arguments: '{"query":"請求"}' },
      { type: 'tool', name: 'tasks.search', state: 'finished', id: 'call-0', result: { tasks: [{ title: '請求書を送る' }] } },
    ]);
  });

  it('does not show what run.token issued, which is a credential', async () => {
    const events: TurnEvent[] = [];
    const tools = [{ name: 'run.token', description: '', parameters: {}, origin: { kind: 'internal' as const } }];

    await runChatTurn({
      model: model([{ content: '', toolCalls: [{ name: 'run.token', arguments: '{}' }] }, { content: 'ok' }]),
      connection,
      instructions: '',
      request: 'token',
      history: [],
      tools,
      fetch: listing([]),
      handlers: {},
      onEvent: (event) => events.push(event),
      rendezvous: { open: async () => ({ url: 'https://example.com/mcp', token: 'secret-token', expiresAt: '2026-11-21T00:00:00Z', close: () => undefined }) },
    });

    const finished = events.find((event) => event.type === 'tool' && event.state === 'finished');
    expect(finished).toEqual({ type: 'tool', name: 'run.token', state: 'finished', id: 'call-0' });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('tells the model a tool the resolved set does not contain is not one of its tools', async () => {
    const result = await runChatTurn({
      model: model([{ content: '', toolCalls: [{ name: 'notion.delete', arguments: '{}' }] }, { content: 'I cannot.' }]),
      connection,
      instructions: '',
      request: 'Delete everything.',
      history: [],
      tools: [],
      fetch: listing([]),
      handlers: {},
    });

    expect(result.output).toBe('I cannot.');
    expect(result.messages.find((message) => message.role === 'tool')?.content).toContain('notion.delete is not one of the tools you were given');
  });

  it('goes on with a conversation larger than the context every model accepts', async () => {
    let turn = 0;
    const large: ModelPort = {
      complete: async () => ++turn === 1
        ? { model: 'test-model', content: '', toolCalls: [{ id: 'call-1', name: 'query_contacts', arguments: '{}' }], usage: { promptTokens: 180_000, cachedTokens: 0, completionTokens: 0 } }
        : { model: 'test-model', content: 'Done.', toolCalls: [], usage: { promptTokens: 180_000, cachedTokens: 170_000, completionTokens: 0 } },
    };
    const tools = (await resolveTools({ run: { executionMode: 'unattended', writes: 'performed', holds: [] }, servers: [], fetch: listing([]) })).tools;

    const result = await runChatTurn({
      model: large,
      connection,
      instructions: '',
      request: 'Make it like the reference.',
      history: [],
      tools,
      fetch: listing([]),
      handlers: { query_contacts: async () => [] },
    });

    expect(result.output).toBe('Done.');
  });

  it('carries earlier exchanges into the next turn', async () => {
    let seen: string[] = [];
    const recording: ModelPort = {
      complete: async (request) => {
        seen = request.messages.map((message) => message.content);
        return { model: 'test-model', content: 'ok', toolCalls: [], usage: { promptTokens: 1, cachedTokens: 0, completionTokens: 0 } };
      },
    };

    await runChatTurn({
      model: recording,
      connection,
      instructions: '',
      request: 'And the one after that?',
      history: [{ role: 'user', content: 'What is next?' }, { role: 'assistant', content: 'The AGM.' }],
      tools: [],
      fetch: listing([]),
      handlers: {},
    });

    expect(seen).toContain('What is next?');
    expect(seen).toContain('The AGM.');
    expect(seen.at(-1)).toBe('And the one after that?');
  });
});
