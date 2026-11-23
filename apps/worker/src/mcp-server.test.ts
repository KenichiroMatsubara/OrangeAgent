import { ACCESS_TOKEN_TOOLS, OPERATOR_TOKEN_RUN } from '@mail/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVER_PROTOCOL_VERSIONS, accessTokenRun, grantedServerTools, handleMcpServerRequest, readEra, serveMcpServerRequest, type JsonRpcRequest, type McpServerPrompt } from './mcp-server';
import type { ChannelPorts } from './sending';
import { toolHandlers } from './tools';
import { FileAnswer } from './turns';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const ports = () => ({
  sendToContact: vi.fn<ChannelPorts['sendToContact']>(async () => ({ delivered: true, channel: 'line' })),
  sendToDestination: vi.fn<ChannelPorts['sendToDestination']>(async () => ({ delivered: true, channel: 'line' })),
});

const suppression = (held: Set<string> = new Set()) => ({
  held,
  check: async (key: string) => held.has(key),
  record: async (key: string) => { held.add(key); },
});

const call = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0' as const, id: 1, method, ...(params ? { params } : {}) });

const at = new Date('2026-08-18T09:00:00.000Z');

/** An Account holding one Contact in the Token's list and one outside it. */
const account = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  for (const [id, name] of [['contact-1', '田中'], ['contact-9', '佐藤']]) {
    database.execute(
      `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
       VALUES (?, 'organization-1', ?, '', 'active', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      id, name,
    );
  }
  return database;
};

/** Who the server says it is, at the origin the fixture serves the GUI from. */
const SERVER_INFO = {
  name: 'orangeagent',
  title: 'OrangeAgent',
  version: '1',
  icons: [
    { src: 'https://orangeagent.example/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: 'https://orangeagent.example/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
  ],
};

const base = (overrides: { request?: ReturnType<typeof call>; grant?: string[]; prompts?: McpServerPrompt[]; held?: Set<string> } = {}) => {
  const sending = ports();
  const database = account();
  return {
    sending,
    database,
    input: {
      request: overrides.request ?? call('tools/list'),
      origin: 'https://orangeagent.example/',
      run: accessTokenRun(overrides.grant ?? ACCESS_TOKEN_TOOLS.map((tool) => tool.name)),
      prompts: overrides.prompts ?? [],
      handlers: toolHandlers({
        database: database.binding, accountId: 'organization-1', mail: { kind: 'none' },
        reach: { kind: 'contact_list', holder: 'this Access Token', contactIds: ['contact-1'], emails: [], roster: 'list' },
        ports: sending, origin: { automationId: null, sourceMessageId: null }, at: () => at,
      }, { ...suppression(overrides.held), scope: 'token-1', window: 'day', holder: 'this Access Token' }),
    },
  };
};

const listed = (result: unknown): string[] => (result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
const text = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';

describe('OrangeAgent as an MCP Server', () => {
  it('offers every tool an Access Token can be granted, described as every other run is told it', async () => {
    const response = await handleMcpServerRequest(base().input);

    expect(listed(response.result)).toEqual(ACCESS_TOKEN_TOOLS.map((tool) => tool.name));
    const tools = (response.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }).tools;
    expect(tools.find((tool) => tool.name === 'channel.send')?.inputSchema.required).toEqual(['channel', 'text']);
  });

  it('lists only the tools the Access Token was granted', async () => {
    const response = await handleMcpServerRequest(base({ grant: ['query_contacts'] }).input);

    expect(listed(response.result)).toEqual(['query_contacts']);
  });

  it('never offers the Account’s mailbox, calendar, or Google Tasks, even when a grant names them', async () => {
    const response = await handleMcpServerRequest(base({ grant: ['mail.search', 'mail.read', 'mail.send', 'calendar.search', 'tasks.search', 'tasks.create', 'tasks.update', 'query_contacts'] }).input);

    expect(listed(response.result)).toEqual(['query_contacts']);
  });

  it('refuses a call to a Task tool, which only a run holding the Google grant makes', async () => {
    const { input } = base({ request: call('tools/call', { name: 'tasks.create', arguments: { title: '会費を集める', due: null } }) });

    const response = await handleMcpServerRequest(input);

    expect(response.error).toMatchObject({ code: -32602, message: 'This token may not call tasks.create.' });
  });

  it('refuses a tool outside the grant rather than performing it', async () => {
    const { input, sending } = base({ grant: ['query_contacts'], request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi' } }) });

    const response = await handleMcpServerRequest(input);

    expect(response.error?.message).toContain('channel.send');
    expect(sending.sendToContact).not.toHaveBeenCalled();
  });

  it('refuses to reach a Contact outside the bound Contact List', async () => {
    const { input, sending } = base({ request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-9', channel: 'line', text: 'hi' } }) });

    const response = await handleMcpServerRequest(input);

    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(text(response.result)).toContain('contact-9');
    expect(text(response.result)).toContain('this Access Token');
    expect(sending.sendToContact).not.toHaveBeenCalled();
  });

  it('sends once and holds the repeat for the declared window', async () => {
    const held = new Set<string>();
    const request = call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi' } });
    const first = base({ held, request });
    await handleMcpServerRequest(first.input);
    const second = base({ held, request });

    const response = await handleMcpServerRequest(second.input);

    expect(first.sending.sendToContact).toHaveBeenCalledTimes(1);
    expect(second.sending.sendToContact).not.toHaveBeenCalled();
    expect(text(response.result)).toContain('suppressed');
    expect(text(response.result)).not.toContain('"delivered":true');
  });

  it('does not suppress a different message to the same Contact', async () => {
    const held = new Set<string>();
    await handleMcpServerRequest(base({ held, request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'first' } }) }).input);
    const second = base({ held, request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'second' } }) });

    await handleMcpServerRequest(second.input);

    expect(second.sending.sendToContact).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a read, and reads only the bound Contact List', async () => {
    const held = new Set<string>();
    const request = call('tools/call', { name: 'query_contacts', arguments: {} });
    await handleMcpServerRequest(base({ held, request }).input);

    const response = await handleMcpServerRequest(base({ held, request }).input);

    expect(text(response.result)).toContain('田中');
    expect(text(response.result)).not.toContain('佐藤');
  });

  it('refuses to reach a Channel destination directly instead of a Contact of its list', async () => {
    const { input, sending } = base({ request: call('tools/call', { name: 'channel.send', arguments: { destination: 'line-group-1', channel: 'line', text: 'hi' } }) });

    const response = await handleMcpServerRequest(input);

    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(sending.sendToDestination).not.toHaveBeenCalled();
  });

  it('schedules a reminder rather than sending it now', async () => {
    const { input, sending, database } = base({
      request: call('tools/call', { name: 'reminder.schedule', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi', at: '2026-08-19T00:00:00.000Z' } }),
    });

    await handleMcpServerRequest(input);

    expect(database.rows<{ available_at: string }>('SELECT available_at FROM jobs')).toEqual([{ available_at: '2026-08-19T00:00:00.000Z' }]);
    expect(sending.sendToContact).not.toHaveBeenCalled();
  });

  it('refuses a reminder in the past instead of firing it immediately', async () => {
    const { input, database } = base({
      request: call('tools/call', { name: 'reminder.schedule', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi', at: '2026-08-17T00:00:00.000Z' } }),
    });

    const response = await handleMcpServerRequest(input);

    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(database.rows('SELECT id FROM jobs')).toEqual([]);
  });

  it('tells the caller what a handler refused rather than failing the request', async () => {
    const { input, sending } = base({ request: call('tools/call', { name: 'channel.send', arguments: {} }) });

    const response = await handleMcpServerRequest(input);

    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(text(response.result)).toContain('channel.send requires a text.');
    expect(sending.sendToContact).not.toHaveBeenCalled();
  });

  it('publishes only the Skills an Account marked public as its MCP prompts', async () => {
    const response = await handleMcpServerRequest(base({
      request: call('prompts/list'),
      prompts: [{ name: 'weekly-notice', description: '定例連絡', open: async () => ({ instructions: 'Send the weekly notice.', files: [] }) }],
    }).input);

    expect((response.result as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name)).toEqual(['weekly-notice']);
  });

  it('returns a published Skill in full when it is asked for', async () => {
    const response = await handleMcpServerRequest(base({
      request: call('prompts/get', { name: 'weekly-notice' }),
      prompts: [{ name: 'weekly-notice', description: '定例連絡', open: async () => ({ instructions: 'Send the weekly notice.', files: [] }) }],
    }).input);

    expect(JSON.stringify(response.result)).toContain('Send the weekly notice.');
  });

  it('hands a published Skill’s files with it, each as an embedded resource: text as its words, any other kind as its bytes', async () => {
    const response = await handleMcpServerRequest(base({
      request: call('prompts/get', { name: 'weekly-notice' }),
      prompts: [{
        name: 'weekly-notice', description: '定例連絡',
        open: async () => ({
          instructions: 'Send it as examples/notice.md shows.',
          files: [{ path: 'examples/notice.md', mediaType: 'text/markdown', text: '今週の例会は…' }, { path: 'logo.png', mediaType: 'image/png', blob: 'iVBORw==' }],
        }),
      }],
    }).input);

    expect((response.result as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Send it as examples/notice.md shows.' } },
      { role: 'user', content: { type: 'resource', resource: { uri: 'orangeagent://skills/weekly-notice/examples/notice.md', mimeType: 'text/markdown', text: '今週の例会は…' } } },
      { role: 'user', content: { type: 'resource', resource: { uri: 'orangeagent://skills/weekly-notice/logo.png', mimeType: 'image/png', blob: 'iVBORw==' } } },
    ]);
  });

  it('answers an unknown method as a protocol error', async () => {
    const response = await handleMcpServerRequest(base({ request: call('resources/list') }).input);

    expect(response.error?.code).toBe(-32601);
  });

  it('answers initialize in the revision the client asked for, when it is one a handshake opens', async () => {
    for (const requested of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const response = await handleMcpServerRequest(base({ request: call('initialize', { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'cli', version: '1' } }) }).input);

      expect((response.result as { protocolVersion: string }).protocolVersion).toBe(requested);
    }
  });

  it('names itself OrangeAgent, with the icon its GUI is served with', async () => {
    const response = await handleMcpServerRequest(base({ request: call('initialize', { protocolVersion: '2025-11-25' }) }).input);

    expect((response.result as { serverInfo: unknown }).serverInfo).toEqual(SERVER_INFO);
  });

  it('answers initialize for a revision it does not know with the newest one a handshake opens, never the stateless one', async () => {
    for (const requested of ['2024-10-07', '2026-07-28', undefined]) {
      const response = await handleMcpServerRequest(base({ request: call('initialize', requested ? { protocolVersion: requested } : {}) }).input);

      expect((response.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    }
  });

  it('tells a stateless client every revision it speaks, in a complete result it may cache for this token alone', async () => {
    const response = await handleMcpServerRequest({ ...base({ request: call('server/discover', { _meta: modern() }) }).input, era: { kind: 'stateless', version: '2026-07-28' } });

    expect(response.result).toEqual({
      resultType: 'complete',
      supportedVersions: [...SERVER_PROTOCOL_VERSIONS],
      capabilities: { tools: {}, prompts: {} },
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  });

  it('marks a stateless result complete, and leaves a handshake result as that revision shaped it', async () => {
    const stateless = await handleMcpServerRequest({ ...base({ grant: ['query_contacts'] }).input, era: { kind: 'stateless', version: '2026-07-28' } });
    const handshake = await handleMcpServerRequest(base({ grant: ['query_contacts'] }).input);

    expect(stateless.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    expect(listed(stateless.result)).toEqual(['query_contacts']);
    expect(handshake.result).not.toHaveProperty('resultType');
    expect(listed(handshake.result)).toEqual(['query_contacts']);
  });
});

const modern = (version = '2026-07-28') => ({ 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} });

const modernHeaders = (request: JsonRpcRequest, overrides: Record<string, string> = {}): Headers => new Headers({
  'MCP-Protocol-Version': '2026-07-28',
  'Mcp-Method': request.method,
  ...(typeof request.params?.name === 'string' ? { 'Mcp-Name': request.params.name } : {}),
  ...overrides,
});

describe('which revision a request speaks', () => {
  it('reads a request naming its revision in _meta as stateless, and any other as inside a handshake', () => {
    const discover = call('server/discover', { _meta: modern() });

    expect(readEra(discover, modernHeaders(discover))).toEqual({ kind: 'stateless', version: '2026-07-28' });
    expect(readEra(call('tools/list'), new Headers({ 'MCP-Protocol-Version': '2025-11-25' }))).toEqual({ kind: 'handshake' });
    expect(readEra(call('initialize', { protocolVersion: '2025-11-25', _meta: modern() }), new Headers())).toEqual({ kind: 'handshake' });
  });

  it('refuses a revision it does not speak with 400, naming every revision it does', () => {
    const request = call('tools/list', { _meta: modern('2099-01-01') });

    expect(readEra(request, modernHeaders(request, { 'MCP-Protocol-Version': '2099-01-01' }))).toEqual({
      status: 400,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [...SERVER_PROTOCOL_VERSIONS], requested: '2099-01-01' } } },
    });
  });

  it('refuses with 400 a stateless request whose headers disagree with its body', () => {
    const named = call('tools/call', { name: 'query_contacts', arguments: {}, _meta: modern() });
    const cases: Array<[JsonRpcRequest, Headers]> = [
      [named, modernHeaders(named, { 'MCP-Protocol-Version': '2025-11-25' })],
      [named, modernHeaders(named, { 'Mcp-Method': 'tools/list' })],
      [named, modernHeaders(named, { 'Mcp-Name': 'channel.send' })],
      [named, new Headers({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' })],
    ];

    for (const [request, headers] of cases) {
      const era = readEra(request, headers);
      expect(era).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    }
  });

  it('reads an Mcp-Name sent as base64 as the name it carries', () => {
    const request = call('prompts/get', { name: '週報', _meta: modern() });
    const encoded = `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode('週報')))}?=`;

    expect(readEra(request, modernHeaders(request, { 'Mcp-Name': encoded }))).toEqual({ kind: 'stateless', version: '2026-07-28' });
  });
});

describe('the MCP endpoint’s answer', () => {
  const answered = vi.fn(async (): Promise<{ jsonrpc: '2.0'; id: number; error: { code: number; message: string } }> => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }));

  it('accepts a notification with 202 and no body', async () => {
    const reply = await serveMcpServerRequest({ request: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: new Headers(), answer: answered });

    expect(reply).toEqual({ status: 202, body: null });
  });

  it('answers a stateless request for a method it lacks with 404, and a handshake one with 200', async () => {
    const stateless = call('resources/list', { _meta: modern() });

    expect((await serveMcpServerRequest({ request: stateless, headers: modernHeaders(stateless), answer: answered })).status).toBe(404);
    expect((await serveMcpServerRequest({ request: call('resources/list'), headers: new Headers(), answer: answered })).status).toBe(200);
  });
});

describe('an Operator Token’s run', () => {
  it('hands the files a tool read over as themselves: an image as an image, text as its words, anything else as its bytes', async () => {
    const files = [
      { filename: 'map.png', mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) },
      { filename: 'note.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('持ち物: 上履き') },
      { filename: '案内.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) },
    ];
    const response = await handleMcpServerRequest({
      request: call('tools/call', { name: 'mail.read', arguments: { messageId: 'm1' } }),
      origin: 'https://orangeagent.example',
      run: OPERATOR_TOKEN_RUN,
      prompts: [],
      handlers: { 'mail.read': async () => new FileAnswer({ subject: '遠足' }, files) },
    });

    expect(response.result).toEqual({
      isError: false,
      content: [
        { type: 'text', text: JSON.stringify({ subject: '遠足' }) },
        { type: 'image', data: 'iVBORw==', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'orangeagent://files/note.txt', mimeType: 'text/plain', text: '持ち物: 上履き' } },
        { type: 'resource', resource: { uri: `orangeagent://files/${encodeURIComponent('案内.pdf')}`, mimeType: 'application/pdf', blob: 'JVBERg==' } },
      ],
    });
  });
});

describe('granted server tools', () => {
  it('denies by default when a Token names nothing', () => {
    expect(grantedServerTools([])).toEqual([]);
  });

  it('ignores a name that is not an Access Token’s to call', () => {
    expect(grantedServerTools(['query_contacts', 'contacts.delete', 'mail.read'])).toEqual(['query_contacts']);
  });

  it('reads a grant stored under an old name as the tool that replaced it, once', () => {
    expect(grantedServerTools(['contacts.search', 'query_contacts'])).toEqual(['query_contacts']);
  });
});
