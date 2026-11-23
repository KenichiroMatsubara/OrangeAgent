import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import { encrypt, masterKey, unwrapAccountKey } from './cryptography';
import { randomToken } from './encoding';
import { GOOGLE_IDENTITY_SCOPES, GOOGLE_SCOPES } from './google';
import { createTestApp, type TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { createTestD1Database, type TestD1Database } from '../test/d1';

let fixture: TestApp | undefined;
let localAccount: TestD1Database | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localAccount?.close();
  localAccount = undefined;
  fixture?.close();
  fixture = undefined;
});

describe('application entry', () => {
  it('reports from health the Control migration the ledger records, beside the one this Worker expects', async () => {
    fixture = createTestApp({ controlMigration: '0000_initial.sql' });

    const health = await app.fetch(fixture.request('/api/health'), fixture.environment);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      data: {
        status: 'ok',
        database: {
          control: {
            currentMigration: '0000_initial.sql',
            expectedMigration: '0006_account_without_inbox.sql',
          },
        },
      },
    });
  });

  it('serves a database a release has already migrated past this Worker, without touching its ledger', async () => {
    fixture = createTestApp();
    fixture.account.execute('INSERT INTO d1_migrations (name) VALUES (?)', '9999_future.sql');

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    expect(bootstrap.status).toBe(200);
    expect(fixture.account.rows<{ name: string }>(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    )).toEqual([{ name: '9999_future.sql' }]);
  });

  it('returns an existing Account to their Account after identity-only Google login', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'identity-access',
          expires_in: 3_600,
          scope: GOOGLE_IDENTITY_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-1',
          email: 'owner@example.com',
          name: 'Owner',
        }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) throw new Error('Ordinary login must not revoke Google grants.');
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'login' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_IDENTITY_SCOPES.join(' '));
    expect(authorization.searchParams.get('access_type')).toBe('online');
    expect(authorization.searchParams.get('prompt')).toBe('select_account');
    expect(callback.headers.get('set-cookie')).not.toContain('mail_setup=');
    expect(callback.headers.get('set-cookie')).toContain('Max-Age=2592000');
    await expect(bootstrap.json()).resolves.toEqual({
      data: {
        kind: 'ready',
        identity: { email: 'owner@example.com', displayName: 'Owner' },
        people: [{
          identityId: 'identity-1',
          email: 'owner@example.com',
          displayName: 'Owner',
          account: { accountId: 'organization-1', name: 'Account One', status: 'active' },
        }],
        account: {
          accountId: 'organization-1',
          name: 'Account One',
          status: 'active',
        },
      },
    });
  });

  it('keeps the Owner session and Membership when the Automation Inbox is disconnected', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET status = 'disconnected', enabled = 0 WHERE kind = 'automation_inbox'",
    );

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);
    const identity = await app.fetch(fixture.request('/api/auth/me'), fixture.environment);

    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        account: { accountId: 'organization-1' },
      },
    });
    await expect(identity.json()).resolves.toMatchObject({
      data: {
        email: 'owner@example.com',
        accounts: [{ accountId: 'organization-1' }],
      },
    });
  });

  it('renews a session in use to thirty days from now on bootstrap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    fixture = createTestApp();

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get('set-cookie')).toBe(
      'mail_session=session-1; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000',
    );
    expect(fixture.control.row<{ expires_at: string; last_seen_at: string }>(
      "SELECT expires_at, last_seen_at FROM sessions WHERE id = 'session-1'",
    )).toEqual({ expires_at: '2026-10-31T00:00:00.000Z', last_seen_at: '2026-10-01T00:00:00.000Z' });
  });

  it('renews a session at most once a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    fixture = createTestApp();
    await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);
    vi.setSystemTime(new Date('2026-10-01T23:00:00.000Z'));

    const again = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    expect(again.status).toBe(200);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(fixture.control.row<{ expires_at: string; last_seen_at: string }>(
      "SELECT expires_at, last_seen_at FROM sessions WHERE id = 'session-1'",
    )).toEqual({ expires_at: '2026-10-31T00:00:00.000Z', last_seen_at: '2026-10-01T00:00:00.000Z' });
  });

  it('does not renew a session that was logged out, and drops it from the browser', async () => {
    fixture = createTestApp();
    fixture.control.execute("UPDATE sessions SET revoked_at = '2026-09-30T00:00:00.000Z' WHERE id = 'session-1'");

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    await expect(bootstrap.json()).resolves.toEqual({ data: { kind: 'signed_out' } });
    expect(bootstrap.headers.get('set-cookie')).toBe('mail_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
    expect(fixture.control.row<{ expires_at: string }>(
      "SELECT expires_at FROM sessions WHERE id = 'session-1'",
    )).toEqual({ expires_at: '2099-01-01T00:00:00.000Z' });
  });

  it('checks an expired Automation Inbox token at login and records a required reauthentication', async () => {
    fixture = await createAutomationTestApp();
    const keyRecord = fixture.control.row<{ master_key_version: string; wrapped_key_envelope: string }>(
      "SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = 'organization-1'",
    );
    const accountKey = await unwrapAccountKey({
      masterKeyVersion: keyRecord?.master_key_version ?? '',
      envelope: JSON.parse(keyRecord?.wrapped_key_envelope ?? '{}'),
    }, await masterKey(fixture.environment.CREDENTIAL_MASTER_KEY), 'organization-1');
    const expiredToken = await encrypt(JSON.stringify({
      accessToken: 'expired-access',
      refreshToken: 'expired-refresh',
      expiresAt: '2000-01-01T00:00:00.000Z',
      scopes: GOOGLE_SCOPES,
      tokenType: 'Bearer',
    }), accountKey, 'google-connection:organization-1:automation-inbox');
    fixture.account.execute(
      "UPDATE google_connections SET token_envelope = ? WHERE id = 'inbox-1'",
      JSON.stringify(expiredToken),
    );
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    expect(bootstrap.status).toBe(200);
    expect(fixture.account.row<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM google_connections WHERE id = 'inbox-1'",
    )).toEqual({ status: 'reauthentication_required', last_error: 'Token has been expired or revoked.' });
  });

  it('reconnects a reauthentication-required Automation Inbox and keeps its Gmail cursor so the outage is processed', async () => {
    fixture = await createAutomationTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET google_subject = 'google-subject-1', status = 'reauthentication_required', last_error = 'Token has been expired or revoked.' WHERE id = 'inbox-1'",
    );
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-1', email: 'owner@example.com', name: 'Owner', historyId: 'history-after-reconnect' }));

    const started = await app.fetch(fixture.request('/api/organizations/organization-1/automation/reauthorize', {
      method: 'POST',
    }), fixture.environment);

    expect(started.status).toBe(201);
    const authorization = await authorizationOf(started);
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '));

    const callback = await app.fetch(fixture.request(callbackPath(authorization)), fixture.environment);
    const redirect = new URL(callback.headers.get('location') ?? 'https://app.example.com');

    expect(redirect.pathname).toBe('/connections');
    expect(redirect.search).toBe('');
    expect(redirect.searchParams.get('error')).toBeNull();
    expect(callback.headers.get('set-cookie')).toBeNull();
    expect(fixture.account.rows<{ status: string; last_error: string | null; gmail_history_id: string }>(
      "SELECT status, last_error, gmail_history_id FROM google_connections WHERE id = 'inbox-1'",
    )).toEqual([{
      status: 'active',
      last_error: null,
      gmail_history_id: 'history-before-connection',
    }]);
  });

  it('signs a new person in by who they are alone, and leaves them unassigned', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-new', email: 'new-owner@example.com', name: 'New Owner', identityOnly: true }));

    const { authorization, session } = await signIn(fixture);
    const bootstrap = await app.fetch(withSession('/api/bootstrap', session), fixture.environment);

    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_IDENTITY_SCOPES.join(' '));
    expect(authorization.searchParams.get('access_type')).toBe('online');
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'unassigned',
        identity: { email: 'new-owner@example.com', displayName: 'New Owner' },
      },
    });
    expect(fixture.control.row<{ count: number }>('SELECT COUNT(*) AS count FROM organization_setups')?.count).toBe(0);
  });

  it('starts an Account named after the person, with no mailbox and its mail Automation waiting as a draft', async () => {
    fixture = createTestApp();
    localAccount = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localAccount.binding;
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-new', email: 'new-owner@example.com', name: 'New Owner', identityOnly: true }));

    const { session } = await signIn(fixture);
    const started = await app.fetch(withSession('/api/onboarding/start', session, { method: 'POST' }), fixture.environment);
    const bootstrap = await app.fetch(withSession('/api/bootstrap', session), fixture.environment);
    const again = await app.fetch(withSession('/api/onboarding/start', session, { method: 'POST' }), fixture.environment);

    expect(started.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        identity: { email: 'new-owner@example.com' },
        account: { name: 'New Owner', status: 'active' },
      },
    });
    expect(again.status).toBe(409);
    expect(localAccount.rows('SELECT id FROM google_connections')).toEqual([]);
    expect(localAccount.rows<{ name: string; enabled: number }>('SELECT name, enabled FROM automations ORDER BY name')).toEqual([
      { name: 'タスクのリマインド', enabled: 0 },
      { name: '毎朝のメール処理', enabled: 0 },
    ]);
  });

  it('connects a mailbox to an Account that has none, and turns its mail Automation on', async () => {
    fixture = createTestApp();
    localAccount = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localAccount.binding;
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-new', email: 'new-owner@example.com', name: 'New Owner', identityOnly: true }));
    const { session } = await signIn(fixture);
    await app.fetch(withSession('/api/onboarding/start', session, { method: 'POST' }), fixture.environment);
    const accountId = fixture.control.row<{ id: string }>("SELECT id FROM organizations WHERE name = 'New Owner'")?.id ?? '';
    // The mailbox may be another Google account than the member's own, such as a group's shared Gmail.
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-group', email: 'group@example.com', name: 'Group', historyId: 'history-group' }));

    const connecting = await app.fetch(withSession(`/api/organizations/${accountId}/automation/reauthorize`, session, { method: 'POST' }), fixture.environment);
    const callback = await app.fetch(withSession(callbackPath(await authorizationOf(connecting)), session), fixture.environment);
    const redirect = new URL(callback.headers.get('location') ?? 'https://app.example.com');

    expect(redirect.pathname).toBe('/connections');
    expect(redirect.searchParams.get('error')).toBeNull();
    expect(localAccount.rows<{ inbox_address: string; gmail_history_id: string; status: string }>(
      'SELECT inbox_address, gmail_history_id, status FROM google_connections',
    )).toEqual([{ inbox_address: 'group@example.com', gmail_history_id: 'history-group', status: 'active' }]);
    expect(fixture.control.rows<{ organization_id: string }>(
      "SELECT organization_id FROM automation_inbox_claims WHERE google_subject = 'google-subject-group'",
    )).toEqual([{ organization_id: accountId }]);
    expect(localAccount.rows<{ name: string; enabled: number; scheduled: number }>(
      'SELECT name, enabled, next_run_at IS NOT NULL AS scheduled FROM automations ORDER BY name',
    )).toEqual([
      { name: 'タスクのリマインド', enabled: 0, scheduled: 0 },
      { name: '毎朝のメール処理', enabled: 1, scheduled: 1 },
    ]);
  });

  it('refuses to connect a mailbox for a browser that is not signed in as a member, and revokes the grant', async () => {
    fixture = await createAutomationTestApp();
    fixture.account.execute("DELETE FROM google_connections WHERE id = 'inbox-1'");
    const revoked = vi.fn();
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-stranger', email: 'stranger@example.com', name: 'Stranger', historyId: 'history-x', onRevoke: revoked }));

    const connecting = await app.fetch(fixture.request('/api/organizations/organization-1/automation/reauthorize', { method: 'POST' }), fixture.environment);
    const callback = await app.fetch(new Request(`https://app.example.com${callbackPath(await authorizationOf(connecting))}`), fixture.environment);
    const redirect = new URL(callback.headers.get('location') ?? 'https://app.example.com');

    expect(redirect.searchParams.get('error')).toContain('このブラウザにログインしてから');
    expect(revoked).toHaveBeenCalled();
    expect(fixture.account.rows('SELECT id FROM google_connections')).toEqual([]);
  });

  it('never revokes the grant of a Google account that is already an Account’s mailbox', async () => {
    fixture = await createAutomationTestApp();
    fixture.account.execute("UPDATE google_connections SET google_subject = 'google-subject-1' WHERE id = 'inbox-1'");
    fixture.control.execute(
      "INSERT INTO automation_inbox_claims (google_subject, inbox_address, organization_id, created_at, updated_at) VALUES ('google-subject-1', 'owner@example.com', 'organization-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    const revoked = vi.fn();
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-1', email: 'owner@example.com', name: 'Owner', scopes: GOOGLE_IDENTITY_SCOPES, onRevoke: revoked }));

    const connecting = await app.fetch(fixture.request('/api/organizations/organization-1/automation/reauthorize', { method: 'POST' }), fixture.environment);
    const callback = await app.fetch(fixture.request(callbackPath(await authorizationOf(connecting))), fixture.environment);
    const redirect = new URL(callback.headers.get('location') ?? 'https://app.example.com');

    expect(redirect.searchParams.get('error')).toContain('Required Google permissions are missing');
    expect(revoked).not.toHaveBeenCalled();
  });

  it('keeps a failed Account provisioning visible and retries it through the session', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', googleStub({ subject: 'google-subject-retry', email: 'retry-owner@example.com', name: 'Retry Owner', identityOnly: true }));

    const { session } = await signIn(fixture);
    await app.fetch(withSession('/api/onboarding/start', session, { method: 'POST' }), fixture.environment);
    const failed = await app.fetch(withSession('/api/bootstrap', session), fixture.environment);

    await expect(failed.json()).resolves.toMatchObject({
      data: {
        kind: 'provisioning_failed',
        account: { name: 'Retry Owner' },
        phase: 'allocating_database',
        error: 'Cloudflare D1 credentials are not configured.',
      },
    });

    localAccount = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localAccount.binding;
    const retried = await app.fetch(withSession('/api/onboarding/retry', session, { method: 'POST' }), fixture.environment);
    const ready = await app.fetch(withSession('/api/bootstrap', session), fixture.environment);

    expect(retried.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        account: { name: 'Retry Owner', status: 'active' },
      },
    });
  });
});

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

/** Google as one person answers it: their identity, and the grant they gave. */
const googleStub = (person: {
  subject: string;
  email: string;
  name: string;
  historyId?: string;
  identityOnly?: boolean;
  scopes?: readonly string[];
  onRevoke?: () => void;
}) => vi.fn(async (input: string | URL | Request) => {
  const url = urlOf(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({
      access_token: 'access',
      ...(person.identityOnly ? {} : { refresh_token: 'refresh' }),
      expires_in: 3_600,
      scope: (person.scopes ?? (person.identityOnly ? GOOGLE_IDENTITY_SCOPES : GOOGLE_SCOPES)).join(' '),
      token_type: 'Bearer',
    }));
  }
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
    return new Response(JSON.stringify({ sub: person.subject, email: person.email, name: person.name }));
  }
  if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile' && person.historyId) {
    return new Response(JSON.stringify({ historyId: person.historyId }));
  }
  if (url.startsWith('https://oauth2.googleapis.com/revoke?')) {
    person.onRevoke?.();
    return new Response(null);
  }
  throw new Error(`Unavailable external dependency: ${url}`);
});

const authorizationOf = async (started: Response): Promise<URL> =>
  new URL((await started.json() as { data: { authorizationUrl: string } }).data.authorizationUrl);

const callbackPath = (authorization: URL): string =>
  `/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`;

const withSession = (path: string, session: string, init: RequestInit = {}): Request =>
  new Request(`https://app.example.com${path}`, { ...init, headers: { Cookie: `mail_session=${session}`, ...init.headers } });

const signIn = async (app_: TestApp): Promise<{ authorization: URL; session: string }> => {
  const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }), app_.environment);
  const authorization = await authorizationOf(started);
  const callback = await app.fetch(new Request(`https://app.example.com${callbackPath(authorization)}`), app_.environment);
  const session = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1] ?? '';
  return { authorization, session };
};
