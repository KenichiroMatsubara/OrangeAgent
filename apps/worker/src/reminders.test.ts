import { afterEach, describe, expect, it } from 'vitest';

import { app } from './app';
import { claimDueJobs } from './jobs';
import { reminderJobHandler, scheduleReminder } from './reminders';
import type { ClaimedJob } from './jobs';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { memoryProviders, type MemoryProviders } from '../test/providers';

const openDatabases: TestD1Database[] = [];
let fixture: TestApp | undefined;

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  fixture?.close();
  fixture = undefined;
});

const AT = '2026-08-20T00:00:00.000Z';
const CREATED_AT = '2026-08-01T00:00:00.000Z';

describe('delivering a queued reminder', () => {
  const job: ClaimedJob = { id: 'job-1', kind: 'reminder', payload: '{}', attempts: 1, idempotencyKey: 'reminder-1' };

  const connect = async (kind: 'line' | 'discord'): Promise<void> => {
    const response = await app.fetch(fixture!.jsonRequest(
      `/api/organizations/organization-1/connections/${kind}`,
      kind === 'line' ? { channelAccessToken: 'line-token', channelSecret: 'line-secret' } : { botToken: 'bot-token', applicationPublicKey: 'a'.repeat(64) },
      'PUT',
    ), fixture!.environment);
    expect(response.status).toBe(200);
  };

  const seedLineContact = (): void => {
    fixture!.account.execute(
      `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
       VALUES ('contact-1', 'organization-1', '一郎', 'contact-1@example.com', 'active', '[]', ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    fixture!.account.execute(
      `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
       VALUES ('dest-1', (SELECT id FROM connections WHERE kind = 'line' LIMIT 1), 'Ucontact-1', 'user', '一郎', 'discovered', 'manual', ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    fixture!.account.execute(
      `INSERT INTO member_line_destinations (member_id, line_destination_id, created_at) VALUES ('contact-1', 'dest-1', ?)`,
      CREATED_AT,
    );
  };

  const seedDiscordContact = (): void => {
    fixture!.account.execute(
      `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
       VALUES ('contact-1', 'organization-1', '一郎', 'contact-1@example.com', 'active', '[]', ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    fixture!.account.execute(
      `INSERT INTO channel_handles
        (id, contact_id, channel, connection_id, external_id, reply_target, kind, display_name, source, is_primary, created_at, updated_at)
       VALUES ('handle-1', 'contact-1', 'discord', (SELECT id FROM connections WHERE kind = 'discord' LIMIT 1),
               'user-1', 'channel-9', 'single', '一郎', 'inbound', 1, ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
  };

  const deliver = (providers: MemoryProviders, payload: Record<string, unknown>, at: string): Promise<void> =>
    reminderJobHandler(fixture!.environment, providers)({ database: fixture!.account.binding, accountId: 'organization-1', job, payload, at });

  const lineTexts = (providers: MemoryProviders): string[] => providers.transport.sends
    .filter(({ url }) => url.includes('api.line.me'))
    .flatMap(({ body }) => (body as { messages: Array<{ text: string }> }).messages.map(({ text }) => text));

  it('delivers a reminder scheduled for a stated time on LINE', async () => {
    fixture = await createAutomationTestApp();
    await connect('line');
    seedLineContact();
    const providers = memoryProviders();

    await deliver(providers, { subject: 'scheduled', contactId: 'contact-1', channel: 'line', text: '明日9時です' }, AT);

    expect(lineTexts(providers)).toEqual(['明日9時です']);
  });

  it('sends a reminder tried again under the same key, so LINE and Discord deliver it once', async () => {
    fixture = await createAutomationTestApp();
    await connect('line');
    await connect('discord');
    seedLineContact();
    fixture.account.execute(
      `INSERT INTO channel_handles
        (id, contact_id, channel, connection_id, external_id, reply_target, kind, display_name, source, is_primary, created_at, updated_at)
       VALUES ('handle-1', 'contact-1', 'discord', (SELECT id FROM connections WHERE kind = 'discord' LIMIT 1),
               'user-1', 'channel-9', 'single', '一郎', 'inbound', 1, ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    const providers = memoryProviders();
    const reminder = (channel: string) => ({ subject: 'scheduled', contactId: 'contact-1', channel, text: '明日9時です' });

    // A pass that sent the reminder and ended before it recorded so leaves the Job to be tried again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await deliver(providers, reminder('line'), AT);
      await deliver(providers, reminder('discord'), AT);
    }

    const keys = providers.transport.sends.filter(({ url }) => url.includes('api.line.me')).map(({ headers }) => headers['x-line-retry-key']);
    const nonces = providers.transport.sends.filter(({ url }) => url.includes('discord.com')).map(({ body }) => (body as { nonce?: string }).nonce);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBe(nonces[0]);
  });

  it('sends nothing for a Task or attendance milestone the product queued before it stopped sending reminders of its own', async () => {
    fixture = await createAutomationTestApp();
    await connect('line');
    seedLineContact();
    const providers = memoryProviders();

    await deliver(providers, { subject: 'task', taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, AT);
    await deliver(providers, { subject: 'registration', eventId: 'event-1', contactId: 'contact-1', milestone: 3 }, AT);

    expect(lineTexts(providers)).toEqual([]);
  });

  it('delivers a reminder scheduled from outside on the Channel it named, Discord included', async () => {
    fixture = await createAutomationTestApp();
    await connect('discord');
    seedDiscordContact();
    const providers = memoryProviders();

    await deliver(providers, { subject: 'scheduled', contactId: 'contact-1', channel: 'discord', text: '明日9時です' }, AT);

    expect(providers.transport.sends.filter(({ url }) => url.includes('discord.com')).map(({ body }) => body)).toEqual([{ content: '明日9時です', nonce: expect.any(String), enforce_nonce: true }]);
    expect(fixture.account.rows('SELECT channel, outcome FROM deliveries')).toEqual([{ channel: 'discord', outcome: 'succeeded' }]);
  });

  it('fails loudly when the Contact holds no handle on that Channel, and refuses a payload that names nobody', async () => {
    fixture = await createAutomationTestApp();
    await connect('discord');
    seedDiscordContact();
    const providers = memoryProviders();

    await expect(deliver(providers, { subject: 'scheduled', contactId: 'contact-1', channel: 'line', text: '明日9時です' }, AT)).rejects.toThrow(/LINE/u);
    await expect(deliver(providers, { subject: 'scheduled', text: '明日9時です' }, AT)).rejects.toThrow(/Contact/u);
  });

  it('records a reminder scheduled from outside as a Job due at the stated time', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);

    await expect(scheduleReminder(database.binding, { contactId: 'contact-1', channel: 'line', text: '明日9時', at: '2099-01-01T00:00:00.000Z' }))
      .resolves.toEqual({ scheduled: true, at: '2099-01-01T00:00:00.000Z', contactId: 'contact-1' });
    await expect(scheduleReminder(database.binding, { contactId: 'contact-1', channel: 'fax', text: '明日9時', at: '2099-01-01T00:00:00.000Z' }))
      .rejects.toThrow(/fax/u);

    expect(database.rows('SELECT kind, available_at, idempotency_key FROM jobs')).toEqual([{
      kind: 'reminder',
      available_at: '2099-01-01T00:00:00.000Z',
      idempotency_key: 'reminder:scheduled:contact-1:2099-01-01T00:00:00.000Z:明日9時',
    }]);
    expect(await claimDueJobs(database.binding, '2098-12-31T00:00:00.000Z')).toEqual([]);
  });
});
