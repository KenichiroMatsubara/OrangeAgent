import { afterEach, describe, expect, it } from 'vitest';

import type { EventDetail, EventOverview } from '@mail/domain';

import { app } from '../app';
import { createTestApp, type TestApp } from '../../test/app';
import { seedAttendanceRegistration, seedScheduledEvent } from '../../test/seed';

// The suite's clock stands at 2026-08-01T00:00Z.

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const read = async <T>(testApp: TestApp, path: string): Promise<{ status: number; data: T }> => {
  const response = await app.fetch(testApp.request(`/api/organizations/organization-1${path}`), testApp.environment);
  const body = await response.json() as { data: T };
  return { status: response.status, data: body.data };
};

describe('Scheduled Events read for the 予定 tab', () => {
  it('lists the events still ahead soonest first and the ended ones latest first, leaving drafts out', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'later', startsAt: '2026-08-22T19:00:00+09:00', endsAt: '2026-08-22T20:30:00+09:00' });
    seedScheduledEvent(fixture.account, { id: 'sooner', startsAt: '2026-08-20T01:00:00.000Z', endsAt: '2026-08-20T03:00:00.000Z' });
    seedScheduledEvent(fixture.account, { id: 'cancelled', startsAt: '2026-08-05T01:00:00.000Z', endsAt: '2026-08-05T03:00:00.000Z', status: 'cancelled' });
    seedScheduledEvent(fixture.account, { id: 'draft', startsAt: '2026-08-06T01:00:00.000Z', endsAt: '2026-08-06T03:00:00.000Z', status: 'draft' });
    seedScheduledEvent(fixture.account, { id: 'ended-long-ago', startsAt: '2026-06-01T01:00:00.000Z', endsAt: '2026-06-01T03:00:00.000Z' });
    seedScheduledEvent(fixture.account, { id: 'ended-yesterday', startsAt: '2026-07-31T01:00:00.000Z', endsAt: '2026-07-31T03:00:00.000Z' });

    const upcoming = await read<EventOverview[]>(fixture, '/events');
    const past = await read<EventOverview[]>(fixture, '/events?view=past');

    expect(upcoming.data.map((event) => event.id)).toEqual(['cancelled', 'sooner', 'later']);
    expect(upcoming.data[0]?.status).toBe('cancelled');
    expect(past.data.map((event) => event.id)).toEqual(['ended-yesterday', 'ended-long-ago']);
  });

  it('counts each event\'s answers and attending guests', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1', title: '総会', attendanceDeadline: '2099-01-01' });
    seedAttendanceRegistration(fixture.account, { eventId: 'event-1', contactId: 'contact-1', destination: 'U0000000000000000000000000000001', status: 'attending' });
    seedAttendanceRegistration(fixture.account, { eventId: 'event-1', contactId: 'contact-2', destination: 'U0000000000000000000000000000002', status: 'not_attending' });
    seedAttendanceRegistration(fixture.account, { eventId: 'event-1', contactId: 'contact-3', destination: 'U0000000000000000000000000000003' });
    fixture.account.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('response-1', 'gmail-1', 'history-1', 'chair@example.org', 'Re: 総会', '2026-07-30T00:00:00.000Z', 'processed')",
    );
    fixture.account.execute(
      "INSERT INTO guest_registrations (id, event_id, source_message_id, name, affiliation, attending, created_at) VALUES ('guest-1', 'event-1', 'response-1', '山田', '北クラブ', 1, '2026-07-30'), ('guest-2', 'event-1', 'response-1', '鈴木', '北クラブ', 0, '2026-07-30')",
    );

    const { data } = await read<EventOverview[]>(fixture, '/events');

    expect(data).toEqual([expect.objectContaining({
      id: 'event-1', title: '総会', attending: 1, notAttending: 1, unanswered: 1, guestsAttending: 1, responseDeadline: '2099-01-01', sourceSubject: null,
    })]);
  });

  it('shows one event whole: who answered what, its guests, and the mail it came from', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('message-1', 'gmail-9', 'history-9', 'info@example.org', '総会のご案内', '2026-07-20T00:00:00.000Z', 'processed')",
    );
    seedScheduledEvent(fixture.account, { id: 'event-1', title: '総会' });
    fixture.account.execute("UPDATE events SET source_message_id = 'message-1', location = '市民会館' WHERE id = 'event-1'");
    seedAttendanceRegistration(fixture.account, { eventId: 'event-1', contactId: 'contact-2', name: '佐藤', destination: 'U0000000000000000000000000000002', status: 'attending' });
    seedAttendanceRegistration(fixture.account, { eventId: 'event-1', contactId: 'contact-1', name: '伊藤', destination: 'U0000000000000000000000000000001' });

    const { data } = await read<EventDetail>(fixture, '/events/event-1');

    expect(data).toMatchObject({
      title: '総会',
      location: '市民会館',
      sourceSubject: '総会のご案内',
      source: { subject: '総会のご案内', sender: 'info@example.org', receivedAt: '2026-07-20T00:00:00.000Z' },
      guests: [],
    });
    expect(data.registrations.map((registration) => [registration.name, registration.status])).toEqual([['伊藤', 'unanswered'], ['佐藤', 'attending']]);
  });

  it('says an event that does not exist was not found', async () => {
    fixture = createTestApp();

    expect((await read(fixture, '/events/missing')).status).toBe(404);
  });
});
