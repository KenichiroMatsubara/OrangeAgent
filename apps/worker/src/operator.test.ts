import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IssuedLoginCode, OperatorToken, OperatorTokenGrant } from '@mail/domain';

import { app } from './app';
import { generateLoginCode } from './operator';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const EXCHANGE_PATH = '/api/public/organizations/organization-1/operator-tokens';
const MCP_PATH = '/api/public/organizations/organization-1/mcp';

/** A request from a CLI: no session cookie, only what it was given. */
const cli = (path: string, body: unknown, token?: string): Request => new Request(`https://app.example.com${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const showCode = async (app_: TestApp): Promise<IssuedLoginCode> => {
  const response = await app.fetch(app_.jsonRequest('/api/organizations/organization-1/login-codes', {}), app_.environment);
  expect(response.status).toBe(200);
  return (await response.json() as { data: IssuedLoginCode }).data;
};

const exchange = (app_: TestApp, code: string): Promise<Response> =>
  Promise.resolve(app.fetch(cli(EXCHANGE_PATH, { code }), app_.environment));

const signIn = async (app_: TestApp): Promise<OperatorTokenGrant> => {
  const { code } = await showCode(app_);
  const response = await exchange(app_, code);
  expect(response.status).toBe(200);
  return (await response.json() as { data: OperatorTokenGrant }).data;
};

const rpc = (app_: TestApp, token: string, method: string, params?: Record<string, unknown>): Promise<Response> =>
  Promise.resolve(app.fetch(cli(MCP_PATH, { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, token), app_.environment));

const listedTools = async (response: Response): Promise<string[]> =>
  ((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);

describe('Login Codes', () => {
  it('are eight unambiguous characters in two groups', () => {
    for (let index = 0; index < 50; index += 1) expect(generateLoginCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/u);
  });

  it('are shown only to a signed-in member', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(cli('/api/organizations/organization-1/login-codes', {}), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('last ten minutes and say where a CLI exchanges them and which MCP Server it then reaches', async () => {
    fixture = await createAutomationTestApp();
    const before = Date.now();

    const issued = await showCode(fixture);

    expect(issued.exchangeUrl).toBe(`https://app.example.com${EXCHANGE_PATH}`);
    expect(issued.serverUrl).toBe(`https://app.example.com${MCP_PATH}`);
    const minutes = (Date.parse(issued.expiresAt) - before) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThanOrEqual(10.1);
    expect(fixture.account.rows<{ code_hash: string }>('SELECT code_hash FROM operator_tokens')[0]?.code_hash).not.toContain(issued.code);
  });
});

describe('Operator Tokens', () => {
  it('are handed to a CLI for its Login Code, for ninety days, with the MCP Server to present them to', async () => {
    fixture = await createAutomationTestApp();
    const before = Date.now();

    const grant = await signIn(fixture);

    expect(grant.url).toBe(`https://app.example.com${MCP_PATH}`);
    const days = (Date.parse(grant.expiresAt) - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.99);
    expect(days).toBeLessThanOrEqual(90.01);
    expect(fixture.account.rows<{ token_hash: string }>('SELECT token_hash FROM operator_tokens')[0]?.token_hash).not.toBe(grant.token);
  });

  it('read a code as it is typed, in any case and without its hyphen', async () => {
    fixture = await createAutomationTestApp();
    const { code } = await showCode(fixture);

    const response = await exchange(fixture, ` ${code.replace('-', '').toLowerCase()} `);

    expect(response.status).toBe(200);
  });

  it('are handed out once for each code', async () => {
    fixture = await createAutomationTestApp();
    const { code } = await showCode(fixture);
    expect((await exchange(fixture, code)).status).toBe(200);

    const again = await exchange(fixture, code);

    expect(again.status).toBe(410);
    expect(fixture.account.rows('SELECT id FROM operator_tokens')).toHaveLength(1);
  });

  it('are not handed out for a code that has expired', async () => {
    fixture = await createAutomationTestApp();
    const { code } = await showCode(fixture);
    fixture.account.execute("UPDATE operator_tokens SET code_expires_at = '2026-01-01T00:00:00.000Z'");

    const response = await exchange(fixture, code);

    expect(response.status).toBe(410);
  });

  it('are not handed out for a code the Account never showed', async () => {
    fixture = await createAutomationTestApp();

    const response = await exchange(fixture, 'ABCD-EFGH');

    expect(response.status).toBe(410);
  });

  it('are not handed out once the member who was shown the code has left the Account', async () => {
    fixture = await createAutomationTestApp();
    const { code } = await showCode(fixture);
    fixture.control.execute("UPDATE admins SET state = 'removed'");

    const response = await exchange(fixture, code);

    expect(response.status).toBe(403);
    expect(fixture.account.rows('SELECT id FROM operator_tokens')).toEqual([]);
  });

  it('offer the CLI what Operator Chat holds: the mailbox, the calendar, and the Account’s Skills, but neither the web nor the files a conversation wrote', async () => {
    fixture = await createAutomationTestApp();
    const { token } = await signIn(fixture);

    const tools = await listedTools(await rpc(fixture, token, 'tools/list'));

    expect(tools).toEqual(expect.arrayContaining(['mail.search', 'mail.read', 'mail.send', 'mail.draft', 'calendar.search', 'create_scheduled_event', 'channel.send', 'activate_skill', 'read_skill_resource']));
    expect(tools).not.toContain('drive.save_file');
    expect(tools).not.toContain('web.search');
  });

  it('read mail through the Automation Inbox’s own Google grant, which the CLI never holds', async () => {
    fixture = await createAutomationTestApp();
    const { token } = await signIn(fixture);
    const seen: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push({ url, authorization: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('Authorization') });
      return Response.json({ resultSizeEstimate: 0 });
    }));

    const response = await rpc(fixture, token, 'tools/call', { name: 'mail.search', arguments: { query: 'newer_than:1d' } });

    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toEqual({ messages: [], nextPageToken: null });
    expect(seen.some((call) => call.url.startsWith('https://gmail.googleapis.com/') && call.authorization === 'Bearer access-token')).toBe(true);
  });

  it('are listed by the Google account of the member they act as, and record when they were last used', async () => {
    fixture = await createAutomationTestApp();
    const { token } = await signIn(fixture);
    await rpc(fixture, token, 'tools/list');

    const response = await app.fetch(fixture.request('/api/organizations/organization-1/operator-tokens'), fixture.environment);

    const listed = (await response.json() as { data: OperatorToken[] }).data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ email: 'owner@example.com' });
    expect(listed[0]?.lastUsedAt).not.toBeNull();
  });

  it('are refused once revoked', async () => {
    fixture = await createAutomationTestApp();
    const { token } = await signIn(fixture);
    const id = fixture.account.rows<{ id: string }>('SELECT id FROM operator_tokens')[0]?.id ?? '';

    const revoked = await app.fetch(fixture.request(`/api/organizations/organization-1/operator-tokens/${id}`, { method: 'DELETE' }), fixture.environment);

    expect(revoked.status).toBe(200);
    expect((await rpc(fixture, token, 'tools/list')).status).toBe(401);
  });

  it('are refused once their ninety days have passed', async () => {
    fixture = await createAutomationTestApp();
    const { token } = await signIn(fixture);
    fixture.account.execute("UPDATE operator_tokens SET expires_at = '2026-01-01T00:00:00.000Z'");

    expect((await rpc(fixture, token, 'tools/list')).status).toBe(401);
  });

  it('are refused once the member they act as leaves the Account', async () => {
    fixture = await createAutomationTestApp();
    const { token } = await signIn(fixture);
    fixture.control.execute("UPDATE admins SET state = 'removed'");

    expect((await rpc(fixture, token, 'tools/list')).status).toBe(403);
  });
});
