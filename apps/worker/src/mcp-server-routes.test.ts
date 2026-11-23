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

const issueToken = async (app_: TestApp, input: { tools?: string[] } = {}): Promise<string> => {
  const issued = await app.fetch(app_.jsonRequest('/api/organizations/organization-1/access-tokens', {
    name: 'cowork',
    tools: input.tools ?? ['query_contacts', 'channel.send', 'reminder.schedule'],
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
    const token = await issueToken(fixture, { tools: ['query_contacts'] });

    const response = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    // Opening the Account's Skills is offered whatever the grant, as in every run that holds them.
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['query_contacts', 'activate_skill', 'read_skill_resource']);
  });

  it('grants a Token the Task tools Operator Chat has, which reach Google Tasks through the Automation Inbox’s grant', async () => {
    fixture = await createAutomationTestApp();
    fixture.account.execute('UPDATE google_connections SET granted_scopes = ?', JSON.stringify(['https://www.googleapis.com/auth/tasks']));
    const token = await issueToken(fixture, { tools: ['tasks.search', 'tasks.create', 'tasks.update'] });

    const listed = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    expect((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['tasks.search', 'tasks.create', 'tasks.update']));
    expect(fixture.account.rows('SELECT tool FROM access_token_tools ORDER BY tool')).toEqual([{ tool: 'tasks.create' }, { tool: 'tasks.search' }, { tool: 'tasks.update' }]);
  });

  it('reaches any Contact of the Account, as Operator Chat does, and records the delivery', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture);
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

  it('sends the same message again when asked, as Operator Chat does', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture);
    stubLine();
    const send = async (): Promise<string> => {
      const response = await app.fetch(rpc(fixture as TestApp, token, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: '同じ内容' } },
      }), (fixture as TestApp).environment);
      return (await response.json() as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? '';
    };

    expect(await send()).toContain('"delivered":true');
    expect(await send()).toContain('"delivered":true');
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 2 }]);
  });

  it('answers a caller however many calls it makes', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { tools: ['query_contacts'] });
    const call = () => app.fetch(rpc(fixture as TestApp, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), (fixture as TestApp).environment);

    const answers = [];
    for (let index = 0; index < 120; index += 1) answers.push(await call());

    expect(answers.every((answer) => answer.status === 200)).toBe(true);
  });

  it('schedules a reminder as a due Job rather than sending it now', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture);
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
    const token = await issueToken(fixture);

    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/access-tokens'), fixture.environment);

    expect(await listed.text()).not.toContain(token);
  });

  it('connects a stateless client: it discovers the revisions, then lists tools in the one it chose', async () => {
    fixture = await createAutomationTestApp();
    const token = await issueToken(fixture, { tools: ['query_contacts'] });
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
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['query_contacts', 'activate_skill', 'read_skill_resource']);
  });

  it('completes an older client’s handshake in the revision it asked for, and accepts its notification with 202', async () => {
    fixture = await createAutomationTestApp();
    const token = await issueToken(fixture);

    const initialized = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } }), fixture.environment);
    const notified = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', method: 'notifications/initialized' }), fixture.environment);

    const opened = (await initialized.json() as { result: { protocolVersion: string; instructions?: string } }).result;
    expect(opened.protocolVersion).toBe('2025-06-18');
    // An outside agent is told what Operator Chat is told, so it uses the same tools the same way.
    expect(opened.instructions).toEqual(expect.any(String));
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
