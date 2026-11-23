import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import { GOOGLE_IDENTITY_SCOPES } from './google';
import { randomToken } from './encoding';
import type { Bindings } from './types';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

let control: TestD1Database | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  control?.close();
  control = undefined;
});

describe('signing in without a Google grant', () => {
  it('asks Google only who the person is, and creates no Account or mailbox setup', async () => {
    control = createMigratedTestD1('control');
    const environment = {
      CONTROL_DB: control.binding,
      ASSETS: {} as Fetcher,
      APP_URL: 'https://app.example.com',
      WEB_ORIGIN: 'https://app.example.com',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      CREDENTIAL_MASTER_KEY: randomToken(32),
      CREDENTIAL_MASTER_KEY_VERSION: 'test-v1',
    } as unknown as Bindings;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'access-1',
          expires_in: 3_600,
          scope: GOOGLE_IDENTITY_SCOPES.join(' '),
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-1',
          email: 'owner@example.com',
          name: 'Example Owner',
        }), { status: 200 });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), environment);

    expect(started.status).toBe(201);
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_IDENTITY_SCOPES.join(' '));
    expect(callback.status).toBe(302);
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: { kind: 'unassigned', identity: { email: 'owner@example.com', displayName: 'Example Owner' } },
    });
    expect(control.row<{ count: number }>('SELECT COUNT(*) AS count FROM organizations')?.count).toBe(0);
    expect(control.row<{ count: number }>('SELECT COUNT(*) AS count FROM automation_inbox_claims')?.count).toBe(0);
  });
});
