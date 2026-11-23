import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const MCP_PATH = '/api/public/organizations/organization-1/mcp';

const seedContact = (app_: TestApp, input: { id: string; name: string; destination: string }): void => {
  app_.account.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('${input.id}', 'organization-1', '${input.name}', '${input.id}@example.com', 'active', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  app_.account.execute(
    `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
     VALUES ('dest-${input.id}', (SELECT id FROM connections WHERE kind = 'line' LIMIT 1), '${input.destination}', 'user', '${input.name}', 'discovered', 'manual', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  app_.account.execute(
    `INSERT INTO member_line_destinations (member_id, line_destination_id, created_at)
     VALUES ('${input.id}', 'dest-${input.id}', '2026-08-01T00:00:00.000Z')`,
  );
};

const connectLine = async (app_: TestApp): Promise<void> => {
  const response = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/line',
    { channelAccessToken: 'line-token', channelSecret: 'line-secret' },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

const issueToken = async (app_: TestApp, input: { contactIds: string[]; tools?: string[]; window?: string }): Promise<string> => {
  const listed = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/contact-lists/list-1',
    { name: 'reachable', contactIds: input.contactIds },
    'PUT',
  ), app_.environment);
  expect(listed.status).toBe(200);
  const issued = await app.fetch(app_.jsonRequest('/api/organizations/organization-1/access-tokens', {
    name: 'cowork',
    contactListId: 'list-1',
    tools: input.tools ?? ['query_contacts', 'channel.send', 'reminder.schedule'],
    suppressionWindow: input.window ?? 'day',
  }), app_.environment);
  expect(issued.status).toBe(200);
  const body = await issued.json() as { data: { token: string } };
  return body.data.token;
};

const rpc = (app_: TestApp, token: string | null, body: unknown): Request =>
  new Request(`https://orangeagent.example${MCP_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const stubLine = (ok = true): void => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: ok ? 200 : 500, headers: { 'x-line-request-id': 'line-1' } }));
};

describe('MCP Server endpoint', () => {
  it('refuses a caller that presents no Access Token', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(rpc(fixture, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('refuses a token this Account never issued', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(rpc(fixture, 'not-a-real-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('answers a Run Token by the run that issued it: its tools listed, each call put to that run', async () => {
    fixture = await createAutomationTestApp();
    const asked: Array<Record<string, unknown>> = [];
    fixture.environment.RUN_CALLS = {
      idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          asked.push(request);
          if (request.accountId !== 'organization-1') return new Response(null, { status: 404 });
          return request.kind === 'list'
            ? Response.json({ tools: [{ name: 'tasks.search', description: 'List the Tasks.', parameters: { type: 'object', properties: {} } }] })
            : Response.json({ answer: { kind: 'value', value: { lists: [], tasks: [] } } });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const listed = await app.fetch(rpc(fixture, 'run_secret', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);
    const called = await app.fetch(rpc(fixture, 'run_secret', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tasks.search', arguments: { status: 'open' } } }), fixture.environment);
    const other = await app.fetch(rpc(fixture, 'run_secret', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mail.send', arguments: {} } }), fixture.environment);

    expect(((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(['tasks.search']);
    expect((await called.json()) as unknown).toMatchObject({ result: { isError: false, content: [{ type: 'text', text: '{"lists":[],"tasks":[]}' }] } });
    expect((await other.json()) as unknown).toMatchObject({ error: { message: 'This token may not call mail.send.' } });
    expect(asked.filter((request) => request.kind === 'call')).toEqual([{ kind: 'call', accountId: 'organization-1', name: 'tasks.search', arguments: { status: 'open' } }]);
  });

  it('refuses a Run Token whose run has ended as any token it does not recognise', async () => {
    fixture = await createAutomationTestApp();
    fixture.environment.RUN_CALLS = {
      idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
      get: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    } as unknown as DurableObjectNamespace;

    const response = await app.fetch(rpc(fixture, 'run_secret', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('lists only the tools the Token was granted', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'], tools: ['query_contacts'] });

    const response = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['query_contacts']);
  });

  it('grants a Token no Task tool, which reaches Google Tasks through a grant it does not hold, and refuses a call to one', async () => {
    fixture = await createAutomationTestApp();
    fixture.account.execute('UPDATE google_connections SET granted_scopes = ?', JSON.stringify(['https://www.googleapis.com/auth/tasks']));
    const taskOnly = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/access-tokens', {
      name: 'tasks', contactListId: 'list-1', tools: ['tasks.search', 'tasks.create', 'tasks.update'], suppressionWindow: 'day',
    }), fixture.environment);
    const token = await issueToken(fixture, { contactIds: [], tools: ['query_contacts', 'tasks.search', 'tasks.create', 'tasks.update'] });

    const listed = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);
    const called = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tasks.create', arguments: { title: '会費を集める', notes: '外部から頼まれた作業', due: '2099-01-31' } },
    }), fixture.environment);

    // A grant that names only Task tools names nothing a Token can hold.
    expect(taskOnly.status).toBe(400);
    expect((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(['query_contacts']);
    expect((await called.json() as { error: { code: number; message: string } }).error).toMatchObject({ code: -32602, message: 'This token may not call tasks.create.' });
    expect(fixture.account.rows('SELECT tool FROM access_token_tools')).toEqual([{ tool: 'query_contacts' }]);
  });

  it('reaches a Contact inside the bound list and records the delivery', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();

    const response = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: '明日9時です' } },
    }), fixture.environment);

    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]?.text).toContain('"delivered":true');
    expect(fixture.account.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries'))
      .toEqual([{ destination: 'U1', outcome: 'succeeded' }]);
  });

  it('refuses a Contact outside the bound list without reaching LINE', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    seedContact(fixture, { id: 'contact-2', name: '佐藤', destination: 'U2' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();

    const response = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel.send', arguments: { contactId: 'contact-2', channel: 'line', text: 'hi' } },
    }), fixture.environment);

    const body = await response.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 0 }]);
  });

  it('suppresses the same message sent again inside the window', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();
    const send = () => app.fetch(rpc(fixture as TestApp, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: '同じ内容' } },
    }), (fixture as TestApp).environment);

    await send();
    const second = await send();

    const body = await second.json() as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]?.text).toContain('suppressed');
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 1 }]);
  });

  it('suppresses a repeat until the window ends, then lets the same message through again', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'], window: 'hour' });
    stubLine();
    // The clock is frozen, so this is the instant the first send happens at.
    const start = Date.now();
    const sendAt = async (minutes: number): Promise<string> => {
      vi.setSystemTime(start + minutes * 60_000);
      const response = await app.fetch(rpc(fixture as TestApp, token, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: '同じ内容' } },
      }), (fixture as TestApp).environment);
      return (await response.json() as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? '';
    };
    const deliveries = (): number => (fixture as TestApp).account.row<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')?.count ?? 0;

    const first = await sendAt(0);
    const inside = await sendAt(59);
    const insideCount = deliveries();
    const after = await sendAt(60);

    expect(first).toContain('"delivered":true');
    expect(inside).toContain('suppressed');
    expect(insideCount).toBe(1);
    expect(after).toContain('"delivered":true');
    expect(deliveries()).toBe(2);
  });

  it('answers a caller however many calls it makes', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'], tools: ['query_contacts'] });
    const call = () => app.fetch(rpc(fixture as TestApp, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), (fixture as TestApp).environment);

    const answers = [];
    for (let index = 0; index < 120; index += 1) answers.push(await call());

    expect(answers.every((answer) => answer.status === 200)).toBe(true);
  });

  it('schedules a reminder as a due Job rather than sending it now', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();

    const response = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reminder.schedule', arguments: { contactId: 'contact-1', channel: 'line', text: '明日9時', at: '2099-01-01T00:00:00.000Z' } },
    }), fixture.environment);

    expect((await response.json() as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(fixture.account.rows<{ kind: string; available_at: string }>('SELECT kind, available_at FROM jobs'))
      .toEqual([{ kind: 'reminder', available_at: '2099-01-01T00:00:00.000Z' }]);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 0 }]);
  });

  it('never returns the issued credential again after it was shown once', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });

    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/access-tokens'), fixture.environment);

    expect(await listed.text()).not.toContain(token);
  });

  it('connects a stateless client: it discovers the revisions, then lists tools in the one it chose', async () => {
    fixture = await createAutomationTestApp();
    const token = await issueToken(fixture, { contactIds: [], tools: ['query_contacts'] });
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const stateless = (method: string) => new Request(`https://orangeagent.example${MCP_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta } }),
    });

    const discovered = await app.fetch(stateless('server/discover'), fixture.environment);
    const listed = await app.fetch(stateless('tools/list'), fixture.environment);

    expect(discovered.status).toBe(200);
    expect((await discovered.json() as { result: { supportedVersions: string[] } }).result.supportedVersions).toContain('2026-07-28');
    const body = await listed.json() as { result: { resultType: string; tools: Array<{ name: string }> } };
    expect(body.result.resultType).toBe('complete');
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['query_contacts']);
  });

  it('completes an older client’s handshake in the revision it asked for, and accepts its notification with 202', async () => {
    fixture = await createAutomationTestApp();
    const token = await issueToken(fixture, { contactIds: [] });

    const initialized = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } }), fixture.environment);
    const notified = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', method: 'notifications/initialized' }), fixture.environment);

    const opened = (await initialized.json() as { result: { protocolVersion: string; instructions?: string } }).result;
    expect(opened.protocolVersion).toBe('2025-06-18');
    // An outside agent is not a member, so it is told nothing of how a member's runs behave.
    expect(opened.instructions).toBeUndefined();
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');
  });

  it('tells a client that opens a stream or ends a session that the endpoint takes only POST', async () => {
    fixture = await createAutomationTestApp();

    for (const method of ['GET', 'DELETE']) {
      const response = await app.fetch(new Request(`https://orangeagent.example${MCP_PATH}`, { method }), fixture.environment);

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
  });
});
