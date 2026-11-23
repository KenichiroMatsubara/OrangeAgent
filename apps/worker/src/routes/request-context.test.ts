import { afterEach, describe, expect, it } from 'vitest';

import { app } from '../app';
import { createTestApp, type TestApp } from '../../test/app';
import { createMigratedTestD1, type TestD1Database } from '../../test/d1';
import { seedAccountContact, seedAccountRoute } from '../../test/seed';
import type { Bindings } from '../types';
import { createRequestContext } from './request-context';

const openDatabases: TestD1Database[] = [];
const fixtures: TestApp[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const opened = (): TestApp => {
  const fixture = createTestApp();
  fixtures.push(fixture);
  return fixture;
};

const refusalCode = async (response: Response): Promise<string | undefined> =>
  ((await response.json()) as { error?: { code?: string } }).error?.code;

describe('Request Context database access', () => {
  it('opens the Account database its membership routes to', async () => {
    const control = createMigratedTestD1('control');
    const account = createMigratedTestD1('organization');
    openDatabases.push(control, account);
    seedAccountRoute(control, {
      id: 'organization-1',
      bindingName: 'ORG_ONE',
      databaseId: 'database-one',
    });
    seedAccountContact(control, {
      accountId: 'organization-1',
      identityId: 'identity-1',
      email: 'owner@example.com',
      sessionId: 'session-1',
    });
    const context = createRequestContext(new Request('https://example.test', {
      headers: { Cookie: 'mail_session=session-1' },
    }), {
      CONTROL_DB: control.binding,
      ORG_ONE: account.binding,
    } as unknown as Bindings);

    const access = await context.account('organization-1');

    expect(access.database).toBe(account.binding);
  });
});

describe('who a browser is signed in as', () => {
  const expiring = (fixture: TestApp, expiresAt: string): void => {
    fixture.control.execute('UPDATE sessions SET expires_at = ? WHERE id = ?', expiresAt, 'session-1');
  };

  it('is nobody once its session has expired, though the cookie still names it', async () => {
    const fixture = opened();
    // TEST_NOW is 2026-08-01T00:00:00Z, so this session ended a second ago.
    expiring(fixture, '2026-07-31T23:59:59.000Z');

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);
    const contacts = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);

    await expect(bootstrap.json()).resolves.toEqual({ data: { kind: 'signed_out' } });
    expect(contacts.status).toBe(401);
    await expect(refusalCode(contacts)).resolves.toBe('unauthenticated');
  });

  it('is still the person whose session ends a second from now', async () => {
    const fixture = opened();
    expiring(fixture, '2026-08-01T00:00:01.000Z');

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);
    const contacts = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);

    await expect(bootstrap.json()).resolves.toMatchObject({ data: { kind: 'ready', identity: { email: 'owner@example.com' } } });
    expect(contacts.status).toBe(200);
  });
});

describe('the Accounts a signed-in person reaches', () => {
  it.each(['suspended', 'removed'] as const)('refuses an Account whose membership is %s, and serves it while the membership is active', async (state) => {
    const fixture = opened();

    const active = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);
    // No product path writes these states yet, so the membership is set as Control D1 would hold it.
    fixture.control.execute('UPDATE admins SET state = ? WHERE organization_id = ? AND identity_id = ?', state, 'organization-1', 'identity-1');
    const refused = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);

    expect(active.status).toBe(200);
    expect(refused.status).toBe(403);
    await expect(refusalCode(refused)).resolves.toBe('no_access');
  });
});
