import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from '../app';
import { randomToken } from '../encoding';
import { GOOGLE_IDENTITY_SCOPES } from '../google';
import { createTestApp, type TestApp } from '../../test/app';
import { createMigratedTestD1, type TestD1Database } from '../../test/d1';
import { seedAccountContact, seedAccountRoute } from '../../test/seed';

let fixture: TestApp | undefined;
let second: TestD1Database | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  second?.close();
  second = undefined;
  fixture?.close();
  fixture = undefined;
});

/** The fixture's owner, signed in as session-1, and a second person with an Account of their own, signed in as session-2. */
const twoPeople = (): TestApp => {
  const created = createTestApp();
  second = createMigratedTestD1('organization');
  seedAccountRoute(created.control, { id: 'organization-2', bindingName: 'ORG_TWO', name: 'Account Two' });
  seedAccountContact(created.control, { accountId: 'organization-2', identityId: 'identity-2', email: 'second@example.com', sessionId: 'session-2' });
  (created.environment as unknown as Record<string, unknown>).ORG_TWO = second.binding;
  created.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
  created.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
  return created;
};

const asBrowser = (cookie: string, path: string, init: RequestInit = {}): Request =>
  new Request(`https://app.example.com${path}`, { ...init, headers: { Cookie: `mail_session=${cookie}`, 'Content-Type': 'application/json', ...init.headers } });

const cookieOf = (response: Response): string | undefined =>
  response.headers.get('set-cookie')?.match(/mail_session=([^;]*)/u)?.[1];

const revoked = (environment: TestApp, id: string): boolean =>
  environment.control.row<{ revoked_at: string | null }>('SELECT revoked_at FROM sessions WHERE id = ?', id)?.revoked_at !== null;

const signInAs = async (environment: TestApp, cookie: string, person: { subject: string; email: string }): Promise<Response> => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access', expires_in: 3_600, scope: GOOGLE_IDENTITY_SCOPES.join(' '), token_type: 'Bearer' }));
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return new Response(JSON.stringify({ sub: person.subject, email: person.email, name: person.email }));
    throw new Error(`Unexpected request: ${url}`);
  }));
  const started = await app.fetch(asBrowser(cookie, '/api/entry/google', { method: 'POST', body: '{}' }), environment.environment);
  const authorization = new URL((await started.json() as { data: { authorizationUrl: string } }).data.authorizationUrl);
  return await app.fetch(asBrowser(cookie, `/oauth/google/callback?code=code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`), environment.environment);
};

describe('a browser signed in to several Google accounts', () => {
  it('is the first person its cookie lists, and lists everyone it is signed in as', async () => {
    fixture = twoPeople();

    const bootstrap = await app.fetch(asBrowser('session-2.session-1', '/api/bootstrap'), fixture.environment);

    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        identity: { email: 'second@example.com' },
        account: { accountId: 'organization-2', name: 'Account Two' },
        people: [
          { identityId: 'identity-2', email: 'second@example.com', account: { accountId: 'organization-2', name: 'Account Two' } },
          { identityId: 'identity-1', email: 'owner@example.com', account: { accountId: 'organization-1', name: 'Account One' } },
        ],
      },
    });
  });

  it('serves each Account to whichever person signed in here owns it, and no Account of anyone else', async () => {
    fixture = twoPeople();
    seedAccountRoute(fixture.control, { id: 'organization-3', bindingName: 'ORG_THREE' });
    seedAccountContact(fixture.control, { accountId: 'organization-3', identityId: 'identity-3', email: 'third@example.com', sessionId: 'session-3' });

    const own = await app.fetch(asBrowser('session-2.session-1', '/api/organizations/organization-1/members'), fixture.environment);
    const current = await app.fetch(asBrowser('session-2.session-1', '/api/organizations/organization-2/members'), fixture.environment);
    const stranger = await app.fetch(asBrowser('session-2.session-1', '/api/organizations/organization-3/members'), fixture.environment);

    expect(own.status).toBe(200);
    expect(current.status).toBe(200);
    expect(stranger.status).toBe(403);
  });

  it('switches to another person signed in here, and refuses one who is not', async () => {
    fixture = twoPeople();

    const switched = await app.fetch(asBrowser('session-1.session-2', '/api/auth/switch', { method: 'POST', body: JSON.stringify({ identityId: 'identity-2' }) }), fixture.environment);
    const refused = await app.fetch(asBrowser('session-1', '/api/auth/switch', { method: 'POST', body: JSON.stringify({ identityId: 'identity-2' }) }), fixture.environment);

    expect(switched.status).toBe(200);
    expect(cookieOf(switched)).toBe('session-2.session-1');
    expect(refused.status).toBe(403);
  });

  it('signs out only the current person by default, leaving the next one current', async () => {
    fixture = twoPeople();

    const loggedOut = await app.fetch(asBrowser('session-1.session-2', '/api/auth/logout', { method: 'POST', body: '{}' }), fixture.environment);
    const bootstrap = await app.fetch(asBrowser(cookieOf(loggedOut) ?? '', '/api/bootstrap'), fixture.environment);

    await expect(loggedOut.json()).resolves.toEqual({ data: { loggedOut: true, remaining: 1 } });
    expect(cookieOf(loggedOut)).toBe('session-2');
    expect(revoked(fixture, 'session-1')).toBe(true);
    expect(revoked(fixture, 'session-2')).toBe(false);
    await expect(bootstrap.json()).resolves.toMatchObject({ data: { kind: 'ready', identity: { email: 'second@example.com' } } });
  });

  it('signs out the person a tab names, or everyone at once', async () => {
    fixture = twoPeople();

    const named = await app.fetch(asBrowser('session-1.session-2', '/api/auth/logout', { method: 'POST', body: JSON.stringify({ identityId: 'identity-2' }) }), fixture.environment);
    expect(cookieOf(named)).toBe('session-1');
    expect(revoked(fixture, 'session-2')).toBe(true);
    expect(revoked(fixture, 'session-1')).toBe(false);

    const everyone = await app.fetch(asBrowser('session-1', '/api/auth/logout', { method: 'POST', body: JSON.stringify({ everyone: true }) }), fixture.environment);
    expect(cookieOf(everyone)).toBe('');
    expect(everyone.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(revoked(fixture, 'session-1')).toBe(true);
  });

  it('adds a sign-in as the current person, replacing a session the same Google account held here', async () => {
    fixture = twoPeople();

    const added = await signInAs(fixture, 'session-1', { subject: 'google-identity-2', email: 'second@example.com' });
    const ids = cookieOf(added)?.split('.') ?? [];

    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe('session-1');
    expect(ids[0]).not.toBe('session-2');
    const again = await signInAs(fixture, cookieOf(added) ?? '', { subject: 'google-identity-2', email: 'second@example.com' });
    const replaced = cookieOf(again)?.split('.') ?? [];
    expect(replaced).toHaveLength(2);
    expect(replaced[1]).toBe('session-1');
    expect(revoked(fixture, ids[0] ?? '')).toBe(true);
  });

  it('stays signed in to ten Google accounts at most, signing out the one least recently used', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    const sessions = ['session-1'];
    for (let index = 2; index <= 10; index += 1) {
      seedAccountContact(fixture.control, { accountId: 'organization-1', identityId: `identity-${index}`, email: `person-${index}@example.com`, sessionId: `session-${index}` });
      sessions.push(`session-${index}`);
    }

    const added = await signInAs(fixture, sessions.join('.'), { subject: 'google-subject-new', email: 'new@example.com' });
    const ids = cookieOf(added)?.split('.') ?? [];

    expect(ids).toHaveLength(10);
    expect(ids.slice(1)).toEqual(sessions.slice(0, 9));
    expect(revoked(fixture, 'session-10')).toBe(true);
  });
});

describe('approving an app for a browser signed in to several Google accounts', () => {
  const register = async (environment: TestApp): Promise<string> => {
    const registered = await app.fetch(new Request('https://app.example.com/api/public/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    }), environment.environment);
    return (await registered.json() as { client_id: string }).client_id;
  };
  const query = (clientId: string, resource: string | null): string => new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'state-1',
    ...(resource ? { resource } : {}),
  }).toString();
  const preview = async (environment: TestApp, cookie: string, value: string): Promise<Response> =>
    await app.fetch(asBrowser(cookie, '/api/oauth/authorizations/preview', { method: 'POST', body: JSON.stringify({ query: value }) }), environment.environment);

  it('asks only the person who owns the MCP Server the app named, whoever the browser is now', async () => {
    fixture = twoPeople();
    const clientId = await register(fixture);

    const answer = await preview(fixture, 'session-2.session-1', query(clientId, 'https://app.example.com/api/public/organizations/organization-1/mcp'));

    await expect(answer.json()).resolves.toMatchObject({
      data: { kind: 'ask', accounts: [{ accountId: 'organization-1', name: 'Account One', email: 'owner@example.com' }] },
    });
  });

  it('offers everyone signed in here who owns an Account when the app names no MCP Server', async () => {
    fixture = twoPeople();
    const clientId = await register(fixture);

    const answer = await preview(fixture, 'session-2.session-1', query(clientId, null));

    await expect(answer.json()).resolves.toMatchObject({
      data: { kind: 'ask', accounts: [{ accountId: 'organization-2' }, { accountId: 'organization-1' }] },
    });
  });

  it('asks the browser to sign in the owner when they are not signed in here', async () => {
    fixture = twoPeople();
    const clientId = await register(fixture);

    const answer = await preview(fixture, 'session-2', query(clientId, 'https://app.example.com/api/public/organizations/organization-1/mcp'));

    await expect(answer.json()).resolves.toEqual({ data: { kind: 'sign_in', client: 'Claude' } });
  });

  it('records the approval for the owner of the Account approved, not the current person', async () => {
    fixture = twoPeople();
    const clientId = await register(fixture);

    const decided = await app.fetch(asBrowser('session-2.session-1', '/api/oauth/authorizations', {
      method: 'POST',
      body: JSON.stringify({ query: query(clientId, 'https://app.example.com/api/public/organizations/organization-1/mcp'), accountId: 'organization-1', approve: true }),
    }), fixture.environment);

    expect(decided.status).toBe(200);
    expect(fixture.account.rows<{ identity_id: string }>('SELECT identity_id FROM operator_tokens')).toEqual([{ identity_id: 'identity-1' }]);
  });
});
