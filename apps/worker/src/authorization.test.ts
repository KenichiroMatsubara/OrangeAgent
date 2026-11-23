import { afterEach, describe, expect, it } from 'vitest';

import { app } from './app';
import { ACCESS_TOKEN_SECONDS, exchangeGrant, redirectMatches } from './authorization';
import { encodeText, toArrayBuffer, toBase64Url } from './encoding';
import { returnPath } from './entry';
import { authenticateOperatorToken, listOperatorTokens } from './operator';
import { accountDatabase } from './storage/database';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const ORIGIN = 'https://app.example.com';
const MCP = `${ORIGIN}/api/public/organizations/organization-1/mcp`;
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a-verifier-that-is-long-enough-to-satisfy-pkce-0123456789';

const challengeOf = async (verifier: string): Promise<string> =>
  toBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(encodeText(verifier))));

const post = (path: string, body: unknown): Request => new Request(`${ORIGIN}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const form = (values: Record<string, string>): Request => new Request(`${ORIGIN}/api/public/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values).toString(),
});

const register = async (app_: TestApp, redirectUris: string[] = [CLAUDE]): Promise<string> => {
  const response = await app.fetch(post('/api/public/oauth/register', { client_name: 'Claude', redirect_uris: redirectUris }), app_.environment);
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
};

const authorizationQuery = async (clientId: string, overrides: Record<string, string> = {}): Promise<string> => new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: CLAUDE,
  code_challenge: await challengeOf(VERIFIER),
  code_challenge_method: 'S256',
  state: 'state-1',
  resource: MCP,
  ...overrides,
}).toString();

/** The member approves on the authorization screen; returns where the browser is sent. */
const approve = async (app_: TestApp, query: string, accountId = 'organization-1'): Promise<URL> => {
  const response = await app.fetch(app_.jsonRequest('/api/oauth/authorizations', { query, accountId, approve: true }), app_.environment);
  expect(response.status).toBe(200);
  return new URL((await response.json() as { data: { location: string } }).data.location);
};

const exchange = async (app_: TestApp, clientId: string, code: string, verifier = VERIFIER) => {
  const response = await app.fetch(form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: CLAUDE, resource: MCP }), app_.environment);
  return { status: response.status, body: await response.json() as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
};

const toolsWith = async (app_: TestApp, token: string): Promise<Response> => app.fetch(new Request(MCP, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}), app_.environment);

describe('discovering the authorization server', () => {
  it('answers an MCP call without a token with a 401 that names its protected resource metadata', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(new Request(MCP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }), fixture.environment);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/public/organizations/organization-1/mcp"`);
  });

  it('serves the protected resource and authorization server metadata a client reads to sign in', async () => {
    fixture = await createAutomationTestApp();

    const resource = await (await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/public/organizations/organization-1/mcp`), fixture.environment)).json();
    const server = await (await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), fixture.environment)).json();

    expect(resource).toMatchObject({ resource: MCP, authorization_servers: [ORIGIN] });
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/api/public/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/public/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

describe('registering a client', () => {
  it('registers a public client without keeping a row, and refuses a redirect that is neither https nor this machine', async () => {
    fixture = await createAutomationTestApp();

    const refused = await app.fetch(post('/api/public/oauth/register', { client_name: 'x', redirect_uris: ['http://evil.example/cb'] }), fixture.environment);
    const registered = await app.fetch(post('/api/public/oauth/register', { client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] }), fixture.environment);

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ client_name: 'Claude Code', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  });

  it('matches a loopback redirect whatever port it names, and anything else exactly', () => {
    expect(redirectMatches(['http://localhost/callback'], 'http://localhost:3118/callback')).toBe(true);
    expect(redirectMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:50211/callback')).toBe(true);
    expect(redirectMatches(['http://localhost/callback'], 'http://localhost:3118/other')).toBe(false);
    expect(redirectMatches([CLAUDE], CLAUDE)).toBe(true);
    expect(redirectMatches([CLAUDE], 'https://claude.ai:444/api/mcp/auth_callback')).toBe(false);
  });
});

describe('the authorization screen', () => {
  it('asks the signed-in member about the client, where it answers, and the Account its MCP Server is', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);

    const response = await app.fetch(fixture.jsonRequest('/api/oauth/authorizations/preview', { query: await authorizationQuery(clientId) }), fixture.environment);

    expect(await response.json()).toMatchObject({ data: { kind: 'ask', client: 'Claude', redirectHost: 'claude.ai', accounts: [{ accountId: 'organization-1' }] } });
  });

  it('stops a client it never registered or a redirect it did not register, since nothing can be sent back', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);

    const unknown = await app.fetch(fixture.jsonRequest('/api/oauth/authorizations/preview', { query: await authorizationQuery('forged.client') }), fixture.environment);
    const elsewhere = await app.fetch(fixture.jsonRequest('/api/oauth/authorizations/preview', { query: await authorizationQuery(clientId, { redirect_uri: 'https://evil.example/cb' }) }), fixture.environment);

    expect(await unknown.json()).toMatchObject({ data: { kind: 'unsafe' } });
    expect(await elsewhere.json()).toMatchObject({ data: { kind: 'unsafe' } });
  });

  it('sends a request without PKCE back to the client as invalid', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);

    const response = await app.fetch(fixture.jsonRequest('/api/oauth/authorizations/preview', { query: await authorizationQuery(clientId, { code_challenge_method: 'plain' }) }), fixture.environment);
    const { data } = await response.json() as { data: { kind: string; location: string } };

    expect(data.kind).toBe('refused');
    expect(new URL(data.location).searchParams.get('error')).toBe('invalid_request');
    expect(new URL(data.location).searchParams.get('state')).toBe('state-1');
  });

  it('tells the client the member declined', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);

    const response = await app.fetch(fixture.jsonRequest('/api/oauth/authorizations', { query: await authorizationQuery(clientId), accountId: 'organization-1', approve: false }), fixture.environment);
    const location = new URL((await response.json() as { data: { location: string } }).data.location);

    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-1');
  });
});

describe('a grant', () => {
  it('turns an approval into an Operator Token the client uses on the MCP Server, listed by the client that holds it', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);

    const location = await approve(fixture, await authorizationQuery(clientId));
    const exchanged = await exchange(fixture, clientId, location.searchParams.get('code') ?? '');

    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE);
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.expires_in).toBe(ACCESS_TOKEN_SECONDS);
    const listed = await toolsWith(fixture, exchanged.body.access_token);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toContain('memory.add');
    const tokens = await listOperatorTokens({ db: accountDatabase(fixture.account.binding), control: fixture.environment.CONTROL_DB, at: new Date() });
    expect(tokens).toMatchObject([{ client: 'Claude' }]);
  });

  it('spends a code once, and only with the verifier its challenge was made from', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);
    const code = (await approve(fixture, await authorizationQuery(clientId))).searchParams.get('code') ?? '';

    const wrong = await exchange(fixture, clientId, code, 'another-verifier-that-is-long-enough-for-pkce-0123456789');
    const first = await exchange(fixture, clientId, code);
    const again = await exchange(fixture, clientId, code);

    expect(wrong.body.error).toBe('invalid_grant');
    expect(first.status).toBe(200);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('replaces the access token and the refresh token on every refresh, so neither old one works again', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);
    const first = (await exchange(fixture, clientId, (await approve(fixture, await authorizationQuery(clientId))).searchParams.get('code') ?? '')).body;

    const refreshed = await app.fetch(form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }), fixture.environment);
    const next = await refreshed.json() as { access_token: string; refresh_token: string };
    const replayed = await app.fetch(form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }), fixture.environment);

    expect(refreshed.status).toBe(200);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect((await toolsWith(fixture, next.access_token)).status).toBe(200);
    expect((await toolsWith(fixture, first.access_token)).status).toBe(401);
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('lets an access token work for its hour, and a refresh only until ninety days after the approval', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);
    const first = (await exchange(fixture, clientId, (await approve(fixture, await authorizationQuery(clientId))).searchParams.get('code') ?? '')).body;
    const db = accountDatabase(fixture.account.binding);
    const hours = (count: number) => new Date(Date.now() + count * 3_600_000);

    expect(await authenticateOperatorToken({ db, presented: first.access_token, at: hours(0.5) })).not.toBeNull();
    expect(await authenticateOperatorToken({ db, presented: first.access_token, at: hours(1.01) })).toBeNull();
    const late = await exchangeGrant(fixture.environment, new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }), hours(90 * 24 + 1));
    expect(late).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const near = await exchangeGrant(fixture.environment, new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }), hours(90 * 24 - 0.5));
    expect(near.status).toBe(200);
    expect((near.body as { expires_in: number }).expires_in).toBeLessThanOrEqual(30 * 60);
  });

  it('ends when the member who approved it leaves the Account', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture);
    const first = (await exchange(fixture, clientId, (await approve(fixture, await authorizationQuery(clientId))).searchParams.get('code') ?? '')).body;

    fixture.control.execute("UPDATE admins SET state = 'removed'");
    const refreshed = await app.fetch(form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }), fixture.environment);

    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await toolsWith(fixture, first.access_token)).status).toBe(403);
  });

  it('refuses a code or a refresh token presented for another Account’s MCP Server, even one the same member owns', async () => {
    fixture = await createAutomationTestApp();
    fixture.addAccount({ id: 'organization-2', bindingName: 'ORG_ORGANIZATION2' });
    const clientId = await register(fixture);
    const code = (await approve(fixture, await authorizationQuery(clientId))).searchParams.get('code') ?? '';
    const elsewhere = `${ORIGIN}/api/public/organizations/organization-2/mcp`;
    const token = (values: Record<string, string>) => app.fetch(form({ client_id: clientId, ...values }), fixture!.environment);

    const misdirected = await token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: CLAUDE, resource: elsewhere });
    const exchanged = await token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: CLAUDE, resource: MCP });
    const first = await exchanged.json() as { refresh_token: string };
    const misrefreshed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, resource: elsewhere });
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, resource: MCP });

    expect(misdirected.status).toBe(400);
    expect(await misdirected.json()).toMatchObject({ error: 'invalid_target' });
    expect(exchanged.status).toBe(200);
    expect(misrefreshed.status).toBe(400);
    expect(await misrefreshed.json()).toMatchObject({ error: 'invalid_target' });
    expect(refreshed.status).toBe(200);
  });

  it('spends a code only at the redirect_uri its authorization request named', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture, [CLAUDE, 'https://claude.ai/api/mcp/other_callback']);
    const code = (await approve(fixture, await authorizationQuery(clientId))).searchParams.get('code') ?? '';
    const exchangeAt = (redirectUri: string) => app.fetch(form({
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: VERIFIER, redirect_uri: redirectUri, resource: MCP,
    }), fixture!.environment);

    const elsewhere = await exchangeAt('https://claude.ai/api/mcp/other_callback');
    const named = await exchangeAt(CLAUDE);

    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.json()).toMatchObject({ error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request.' });
    expect(named.status).toBe(200);
  });

  it('accepts Claude Code’s loopback redirect on the port it picked for this sign-in', async () => {
    fixture = await createAutomationTestApp();
    const clientId = await register(fixture, ['http://localhost/callback']);
    const redirect = 'http://localhost:3118/callback';

    const location = await approve(fixture, await authorizationQuery(clientId, { redirect_uri: redirect }));
    const response = await app.fetch(form({ grant_type: 'authorization_code', client_id: clientId, code: location.searchParams.get('code') ?? '', code_verifier: VERIFIER, redirect_uri: redirect }), fixture.environment);

    expect(`${location.origin}${location.pathname}`).toBe(redirect);
    expect(response.status).toBe(200);
  });
});

describe('returning after sign-in', () => {
  it('returns only to a path of this application', () => {
    expect(returnPath('/authorize?client_id=x&state=y')).toBe('/authorize?client_id=x&state=y');
    expect(returnPath('//evil.example/')).toBeNull();
    expect(returnPath('/\\evil.example')).toBeNull();
    expect(returnPath('https://evil.example/')).toBeNull();
    expect(returnPath(undefined)).toBeNull();
  });
});
