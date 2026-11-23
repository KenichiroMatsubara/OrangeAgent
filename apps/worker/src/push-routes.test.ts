import { afterEach, describe, expect, it } from 'vitest';

import type { PushDeviceState, PushSettings } from '@mail/domain';

import { app } from './app';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { receiver } from '../test/push';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const base = '/api/organizations/organization-1/push';

const withKeys = (app_: TestApp): void => {
  Object.assign(app_.environment, { VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:push@example.com' });
};

const device = async (endpoint = 'https://push.example.net/send/abc') => {
  const browser = await receiver();
  return { endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth }, label: '  Android の Chrome  ' };
};

describe('the push routes', () => {
  it('says push is unavailable without VAPID keys, and refuses a browser then', async () => {
    fixture = await createAutomationTestApp();

    const settings = await app.fetch(fixture.request(base), fixture.environment);
    expect((await settings.json() as { data: PushSettings }).data).toEqual({ publicKey: null });

    const refused = await app.fetch(fixture.jsonRequest(`${base}/devices`, await device()), fixture.environment);
    expect(refused.status).toBe(400);
    expect(fixture.account.rows('SELECT * FROM push_subscriptions')).toEqual([]);
  });

  it('hands out the public key, keeps a member\'s browser once per address, and removes it for that member only', async () => {
    fixture = await createAutomationTestApp();
    withKeys(fixture);

    const settings = await app.fetch(fixture.request(base), fixture.environment);
    expect((await settings.json() as { data: PushSettings }).data).toEqual({ publicKey: 'BPublic' });

    const first = await device();
    const saved = await app.fetch(fixture.jsonRequest(`${base}/devices`, first), fixture.environment);
    expect(saved.status).toBe(200);
    expect((await saved.json() as { data: PushDeviceState }).data).toEqual({ subscribed: true });
    // Subscribing again with new keys replaces the row the address had.
    const again = { ...await device(), label: 'Android の Chrome' };
    await app.fetch(fixture.jsonRequest(`${base}/devices`, again), fixture.environment);
    expect(fixture.account.rows('SELECT identity_id, endpoint, p256dh, auth, label FROM push_subscriptions')).toEqual([
      { identity_id: 'identity-1', endpoint: first.endpoint, p256dh: again.keys.p256dh, auth: again.keys.auth, label: 'Android の Chrome' },
    ]);

    fixture.account.execute("INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at) VALUES ('other', 'identity-2', 'https://push.example.net/other', 'k', 'a', '2026-11-21T00:00:00.000Z')");
    const removed = await app.fetch(fixture.jsonRequest(`${base}/devices`, { endpoint: first.endpoint }, 'DELETE'), fixture.environment);
    expect((await removed.json() as { data: PushDeviceState }).data).toEqual({ subscribed: false });
    // Another member's address is not this member's to remove.
    await app.fetch(fixture.jsonRequest(`${base}/devices`, { endpoint: 'https://push.example.net/other' }, 'DELETE'), fixture.environment);
    expect(fixture.account.rows('SELECT id FROM push_subscriptions')).toEqual([{ id: 'other' }]);
  });

  it('refuses an address that is not a push service\'s, and keys that are not a browser\'s', async () => {
    fixture = await createAutomationTestApp();
    withKeys(fixture);
    const good = await device();

    for (const body of [
      { ...good, endpoint: 'http://push.example.net/send' },
      { ...good, endpoint: 'http://127.0.0.1:9999/push' },
      { ...good, endpoint: 'not a url' },
      { ...good, keys: { p256dh: good.keys.auth, auth: good.keys.auth } },
      { ...good, keys: { p256dh: good.keys.p256dh, auth: good.keys.p256dh } },
      { endpoint: good.endpoint },
    ]) {
      const response = await app.fetch(fixture.jsonRequest(`${base}/devices`, body), fixture.environment);
      expect(response.status).toBe(400);
    }
    expect(fixture.account.rows('SELECT * FROM push_subscriptions')).toEqual([]);
  });

  it('takes a local address only where the Worker itself runs locally', async () => {
    fixture = await createAutomationTestApp();
    withKeys(fixture);
    Object.assign(fixture.environment, { APP_URL: 'http://localhost:8787' });

    const response = await app.fetch(fixture.jsonRequest(`${base}/devices`, await device('http://127.0.0.1:9999/push/1')), fixture.environment);

    expect(response.status).toBe(200);
    expect(fixture.account.rows('SELECT endpoint FROM push_subscriptions')).toEqual([{ endpoint: 'http://127.0.0.1:9999/push/1' }]);
  });
});
