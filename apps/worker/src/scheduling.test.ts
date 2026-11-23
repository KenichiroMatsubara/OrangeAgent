import { afterEach, describe, expect, it } from 'vitest';

import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { memoryGoogle, memoryProviders } from '../test/providers';
import type { InboxSession } from './inbox';
import { scheduledEventCall } from './scheduling';
import type { Bindings } from './types';
import { toolHandlers } from './tools';
import { decodePlannedWrite, plannedWritesFor } from './writes';
import { seedAutomation } from '../test/automation';

/** The handlers Operator Chat performs its writes with, over this Account and calendar. */
const chatHandlers = (google: ReturnType<typeof memoryGoogle>, database: D1Database) => toolHandlers({
  database, accountId: 'organization-1', reach: { kind: 'anyone' }, mail: { kind: 'mailbox' },
  google: { provider: google, session: async () => ({ accessToken: 'token', readAttachments: (messageId, parts) => google.gmail.readAttachments('token', messageId, parts) }) },
  origin: { automationId: null, sourceMessageId: null }, at: () => new Date(),
});

const openDatabases: TestD1Database[] = [];

const accountDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  database.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('contact-1', 'organization-1', '田中', 'Tanaka@example.com', 'active', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  return database;
};

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const event = { title: '例会', startsAt: '2026-08-20T19:00:00+09:00', endsAt: '2026-08-20T21:00:00+09:00' };

/** Grants the Automation Inbox the whole Drive, which holds one folder a run may choose for a mail's files. */
const grantDrive = (database: TestD1Database, google: ReturnType<typeof memoryGoogle>): void => {
  database.execute(
    `INSERT INTO google_connections (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
     VALUES ('google-1', 'automation_inbox', 'subject-1', 'owner@example.com', ?, '{}', 'history-1', 1, 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    JSON.stringify(['https://www.googleapis.com/auth/drive']),
  );
  google.drive.held.push({ id: 'folder-reikai', name: '例会資料', mimeType: 'application/vnd.google-apps.folder' });
};

describe('reading a create_scheduled_event call', () => {
  it('names each attendee once, in lower case', () => {
    expect(scheduledEventCall({ ...event, attendees: ['Tanaka@example.com', 'tanaka@example.com'] }))
      .toEqual({
        ...event, location: '', description: '', attendees: ['tanaka@example.com'], inviteRoster: false, attachments: [],
        folderId: null, folderName: null, subfolder: null, messageId: null,
      });
  });

  it('asks the model to choose the Drive folder the files it carries go in', () => {
    const attachments = [{ messageId: 'gmail-1', filename: '案内.pdf' }];
    expect(() => scheduledEventCall({ ...event, attachments })).toThrow('in a Drive folder you choose');
    expect(() => scheduledEventCall({ ...event, attachments, folderId: 'folder-1' })).toThrow('by both folderId and folderName');
    expect(() => scheduledEventCall({ ...event, attachments, folderId: 'folder-1', folderName: '例会', subfolder: '2026/11' })).toThrow('without "/"');
    expect(scheduledEventCall({ ...event, attachments, folderId: 'folder-1', folderName: '例会', subfolder: ' 2026-11-07 総会 ' }))
      .toMatchObject({ attachments, folderId: 'folder-1', folderName: '例会', subfolder: '2026-11-07 総会' });
  });

  it('refuses what it cannot read, with a reason the model can correct', () => {
    expect(() => scheduledEventCall({ title: '例会' })).toThrow('requires a title, startsAt, and endsAt');
    expect(() => scheduledEventCall({ ...event, startsAt: '来週の水曜' })).toThrow('neither an RFC3339 time nor a YYYY-MM-DD day');
    expect(() => scheduledEventCall({ ...event, attendees: ['田中さん'] })).toThrow('is not one email address');
    expect(() => scheduledEventCall({ ...event, attendees: 'tanaka@example.com' })).toThrow('must be a list of email addresses');
  });
});

describe('creating a Scheduled Event when the call is performed', () => {
  it('records the event, its Contact in the Recipient Snapshot, and every invitation', async () => {
    const database = accountDatabase();
    const google = memoryGoogle();
    const handlers = chatHandlers(google, database.binding);

    const result = await handlers.create_scheduled_event?.({ ...event, description: '持ち物なし', attendees: ['tanaka@example.com', 'guest@example.com'] });

    expect(result).toMatchObject({ created: true, attendees: ['tanaka@example.com', 'guest@example.com'] });
    expect(google.eventWrites).toMatchObject([{
      operation: 'create',
      body: {
        summary: '例会',
        description: '持ち物なし',
        start: { dateTime: event.startsAt, timeZone: 'Asia/Tokyo' },
        attendees: [{ email: 'tanaka@example.com' }, { email: 'guest@example.com' }],
      },
    }]);
    expect(database.rows('SELECT title, status, automation_id, source_message_id, calendar_description FROM events'))
      .toEqual([{ title: '例会', status: 'scheduled', automation_id: null, source_message_id: null, calendar_description: '持ち物なし' }]);
    expect(database.rows('SELECT member_id, email_snapshot FROM event_recipients')).toEqual([{ member_id: 'contact-1', email_snapshot: 'tanaka@example.com' }]);
    expect(database.rows('SELECT destination, channel, outcome FROM deliveries ORDER BY destination')).toEqual([
      { destination: 'guest@example.com', channel: 'calendar', outcome: 'succeeded' },
      { destination: 'tanaka@example.com', channel: 'calendar', outcome: 'succeeded' },
    ]);
  });

  it('creates an all-day event from bare days', async () => {
    const database = accountDatabase();
    const google = memoryGoogle();
    const handlers = chatHandlers(google, database.binding);

    await handlers.create_scheduled_event?.({ title: '合宿', startsAt: '2026-08-20', endsAt: '2026-08-22' });

    expect(google.eventWrites[0]?.body).toMatchObject({ start: { date: '2026-08-20' }, end: { date: '2026-08-22' }, attendees: [] });
  });

  it('answers a call it cannot read without touching the calendar', async () => {
    const database = accountDatabase();
    const google = memoryGoogle();
    const handlers = chatHandlers(google, database.binding);

    await expect(handlers.create_scheduled_event?.({ title: '例会' })).rejects.toThrow('create_scheduled_event requires');
    expect(google.eventWrites).toEqual([]);
  });
});

interface RecordedEvent {
  id: string;
  google_event_id: string;
  title: string;
  location: string;
  starts_at: string;
  ends_at: string;
  status: string;
  calendar_description: string;
  calendar_etag: string | null;
}

/** Operator Chat creates one Scheduled Event; returns its handlers, its row, and the Calendar event behind it. */
const scheduled = async () => {
  const database = accountDatabase();
  const google = memoryGoogle();
  const handlers = chatHandlers(google, database.binding);
  await handlers.create_scheduled_event?.({ ...event, location: '公民館', description: '持ち物なし' });
  const recorded = (): RecordedEvent => {
    const row = database.row<RecordedEvent>('SELECT id, google_event_id, title, location, starts_at, ends_at, status, calendar_description, calendar_etag FROM events');
    if (!row) throw new Error('No Scheduled Event was recorded.');
    return row;
  };
  const calendarEvent = () => google.events.get(recorded().google_event_id);
  /** A person edits the event in Google Calendar, which gives it a new revision. */
  const editByHand = (fields: { location?: string; description?: string }, etag = 'etag-edited-by-hand'): void => {
    const current = calendarEvent();
    if (!current) throw new Error('The Calendar event is gone.');
    google.addEvent({ ...current, ...fields, etag });
  };
  return { database, google, handlers, recorded, calendarEvent, editByHand };
};

describe('changing a Scheduled Event when the call is performed', () => {
  it('writes the fields asked for to Google Calendar against the revision it read, and records the new revision', async () => {
    const { google, handlers, recorded, calendarEvent } = await scheduled();
    const before = recorded();

    const result = await handlers.update_scheduled_event?.({
      eventId: before.id, startsAt: '2026-08-21T19:00:00+09:00', endsAt: '2026-08-21T21:00:00+09:00', location: '市民会館',
    });

    expect(result).toEqual({ eventId: before.id, changed: ['location', 'startsAt', 'endsAt'], keptOverrides: [], deleted: false });
    expect(google.eventWrites.at(-1)).toMatchObject({
      operation: 'patch',
      id: before.google_event_id,
      etag: before.calendar_etag,
      body: { summary: '例会', location: '市民会館', start: { dateTime: '2026-08-21T19:00:00+09:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-08-21T21:00:00+09:00', timeZone: 'Asia/Tokyo' } },
    });
    expect(calendarEvent()).toMatchObject({ summary: '例会', location: '市民会館', description: '持ち物なし' });
    expect(recorded()).toMatchObject({
      title: '例会', location: '市民会館', starts_at: '2026-08-21T19:00:00+09:00', ends_at: '2026-08-21T21:00:00+09:00',
      status: 'scheduled', calendar_etag: calendarEvent()?.etag,
    });
    expect(recorded().calendar_etag).not.toBe(before.calendar_etag);
  });

  it('keeps a field a person changed in Google Calendar as their Manual Override while the other fields still change', async () => {
    const { google, handlers, recorded, calendarEvent, editByHand } = await scheduled();
    editByHand({ location: '公民館 2階' });

    const result = await handlers.update_scheduled_event?.({ eventId: recorded().id, title: '定例会', location: '市民会館' });

    expect(result).toMatchObject({ changed: ['title'], keptOverrides: ['location'], deleted: false });
    expect(google.eventWrites.at(-1)).toMatchObject({ operation: 'patch', etag: 'etag-edited-by-hand', body: { summary: '定例会', location: '公民館 2階' } });
    expect(calendarEvent()).toMatchObject({ summary: '定例会', location: '公民館 2階' });
    expect(recorded()).toMatchObject({ title: '定例会', location: '公民館 2階', calendar_etag: calendarEvent()?.etag });
  });

  it('writes nothing when every field asked for is a Manual Override', async () => {
    const { google, handlers, recorded, editByHand } = await scheduled();
    editByHand({ location: '公民館 2階' });
    const writes = google.eventWrites.length;

    const result = await handlers.update_scheduled_event?.({ eventId: recorded().id, location: '市民会館' });

    expect(result).toMatchObject({ changed: [], keptOverrides: ['location'] });
    expect(google.eventWrites).toHaveLength(writes);
    expect(recorded()).toMatchObject({ location: '公民館' });
  });

  it('fails, and records nothing, when a person edits the event between OrangeAgent reading it and writing it', async () => {
    const { google, handlers, recorded, calendarEvent, editByHand } = await scheduled();
    const before = recorded();
    const read = google.calendar.readEvent;
    google.calendar.readEvent = async (token, eventId) => {
      const seen = await read(token, eventId);
      editByHand({ location: '公民館 2階' }, 'etag-newer');
      return seen;
    };

    await expect(handlers.update_scheduled_event?.({ eventId: before.id, title: '定例会' }))
      .rejects.toMatchObject({ name: 'GoogleApiError', status: 412 });
    expect(calendarEvent()).toMatchObject({ summary: '例会', location: '公民館 2階', etag: 'etag-newer' });
    expect(recorded()).toEqual(before);
  });

  it('records an event a person deleted from Google Calendar as an exception and never writes it again', async () => {
    const { database, google, handlers, recorded } = await scheduled();
    google.events.delete(recorded().google_event_id);
    const writes = google.eventWrites.length;

    const result = await handlers.update_scheduled_event?.({ eventId: recorded().id, title: '定例会' });

    expect(result).toMatchObject({ changed: [], deleted: true });
    expect(google.eventWrites).toHaveLength(writes);
    expect(recorded()).toMatchObject({ title: '例会', status: 'exception' });
    expect(database.rows('SELECT code, state FROM exceptions')).toEqual([{ code: 'calendar_event_deleted', state: 'open' }]);
    await expect(handlers.update_scheduled_event?.({ eventId: recorded().id, title: '定例会' })).rejects.toThrow('deleted from Google Calendar by hand');
  });

  it('refuses an event id this Account does not hold, without touching the calendar', async () => {
    const { google, handlers } = await scheduled();
    const writes = google.eventWrites.length;

    await expect(handlers.update_scheduled_event?.({ eventId: 'event-unknown', title: '定例会' })).rejects.toThrow('Scheduled Event event-unknown is not in this Account');
    await expect(handlers.cancel_scheduled_event?.({ eventId: 'event-unknown' })).rejects.toThrow('Scheduled Event event-unknown is not in this Account');
    expect(google.eventWrites).toHaveLength(writes);
  });
});

describe('cancelling a Scheduled Event when the call is performed', () => {
  it('cancels the Calendar event against the revision it read, and keeps the event as cancelled', async () => {
    const { google, handlers, recorded, calendarEvent } = await scheduled();
    const before = recorded();

    const result = await handlers.cancel_scheduled_event?.({ eventId: before.id });

    // The event's Tasks are in Google Tasks, which the run searches itself; the answer names none.
    expect(result).toEqual({ eventId: before.id, cancelled: true });
    expect(google.eventWrites.at(-1)).toEqual({ operation: 'patch', id: before.google_event_id, body: { status: 'cancelled' }, etag: before.calendar_etag });
    expect(calendarEvent()).toMatchObject({ status: 'cancelled' });
    expect(recorded()).toMatchObject({ status: 'cancelled', title: '例会' });
  });

  it('answers a second cancellation without writing again, and refuses to change a cancelled event', async () => {
    const { google, handlers, recorded } = await scheduled();
    await handlers.cancel_scheduled_event?.({ eventId: recorded().id });
    const writes = google.eventWrites.length;

    const again = await handlers.cancel_scheduled_event?.({ eventId: recorded().id });

    expect(again).toMatchObject({ cancelled: true });
    expect(google.eventWrites).toHaveLength(writes);
    await expect(handlers.update_scheduled_event?.({ eventId: recorded().id, title: '定例会' })).rejects.toThrow('was cancelled');
  });
});

describe('rewriting a Scheduled Event’s description from what OrangeAgent holds', () => {
  const respond = async (setup: Awaited<ReturnType<typeof scheduled>>) => {
    setup.google.addMessage({ id: 'gmail-reply', subject: 'Re: 例会', sender: '他クラブ <club@example.org>', body: '2名で参加します。' });
    return setup.handlers.record_event_response?.({
      messageId: 'gmail-reply', eventId: setup.recorded().id,
      guests: [{ name: '佐藤', affiliation: '他クラブ', attending: true }, { name: '鈴木', affiliation: '他クラブ', attending: true }],
    });
  };

  it('writes the guest counts an Event Response adds into the description, and never moves the meeting', async () => {
    const setup = await scheduled();
    const before = setup.recorded();

    const result = await respond(setup);

    expect(result).toMatchObject({ guests: 2, descriptionKept: false });
    const patch = setup.google.eventWrites.at(-1);
    expect(patch).toMatchObject({ operation: 'patch', etag: before.calendar_etag });
    expect(patch?.body).not.toHaveProperty('start');
    expect(patch?.body).not.toHaveProperty('end');
    expect(setup.calendarEvent()?.description).toContain('外部からの参加登録: 1団体 2名（他クラブ 2名）');
    expect(setup.recorded()).toMatchObject({ calendar_description: setup.calendarEvent()?.description, calendar_etag: setup.calendarEvent()?.etag, starts_at: before.starts_at });
  });

  it('keeps a description a person rewrote in Google Calendar', async () => {
    const setup = await scheduled();
    const before = setup.recorded();
    setup.editByHand({ description: '持ち物: 名札' });

    const result = await respond(setup);

    expect(result).toMatchObject({ guests: 2, descriptionKept: true });
    expect(setup.google.eventWrites.at(-1)?.body).not.toHaveProperty('description');
    expect(setup.calendarEvent()?.description).toBe('持ち物: 名札');
    expect(setup.recorded().calendar_description).toBe(before.calendar_description);
  });
});

describe('creating a Scheduled Event an Automation planned', () => {
  it('applies the planned call, names the Automation as the event’s owner, and records the mail it came from', async () => {
    const database = accountDatabase();
    seedAutomation(database);
    const providers = memoryProviders();
    providers.google.addMessage({ id: 'gmail-1', subject: '例会のご案内', sender: '事務局 <office@example.com>', body: '8月20日に例会を開きます。' });
    const writes = plannedWritesFor({
      env: {} as Bindings, database: database.binding, accountId: 'organization-1', providers,
      inbox: { accessToken: 'token' } as InboxSession,
    });

    await writes.apply(
      { id: 'run-1', writeId: 'write-1', automationId: 'automation-1', automationRevision: 1, sourceMessageId: null },
      decodePlannedWrite('create_scheduled_event', JSON.stringify({ attendees: ['tanaka@example.com'], messageId: 'gmail-1', ...event })),
    );

    expect(providers.google.eventWrites).toMatchObject([{ operation: 'create', body: { attendees: [{ email: 'tanaka@example.com' }] } }]);
    expect(providers.google.eventWrites[0]?.body.description).toBe('OrangeAgent が Gmail メッセージ gmail-1 から作成しました。');
    expect(database.rows('SELECT gmail_message_id, subject, state FROM source_messages')).toEqual([{ gmail_message_id: 'gmail-1', subject: '例会のご案内', state: 'processed' }]);
    expect(database.rows('SELECT e.automation_id, s.gmail_message_id, e.status FROM events e JOIN source_messages s ON s.id = e.source_message_id'))
      .toEqual([{ automation_id: 'automation-1', gmail_message_id: 'gmail-1', status: 'scheduled' }]);
    expect(database.rows('SELECT member_id FROM event_recipients')).toEqual([{ member_id: 'contact-1' }]);
  });

  it('attaches a file Gmail names in decomposed Unicode when the call names it composed', async () => {
    const database = accountDatabase();
    seedAutomation(database);
    const providers = memoryProviders();
    grantDrive(database, providers.google);
    const stored = '友好地区向け_ガバナー公式訪問案内文書.pdf'.normalize('NFD');
    providers.google.addMessage({
      id: 'gmail-1', subject: 'ガバナー公式訪問のご案内', body: '添付をご確認ください。',
      attachments: [{ filename: stored, mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4') }],
    });
    const writes = plannedWritesFor({
      env: {} as Bindings, database: database.binding, accountId: 'organization-1', providers,
      inbox: { accessToken: 'token', readAttachments: (messageId, parts) => providers.google.gmail.readAttachments('token', messageId, parts) } as InboxSession,
    });
    const named = '友好地区向け_ガバナー公式訪問案内文書.pdf'.normalize('NFC');

    await writes.apply(
      { id: 'run-1', writeId: 'write-1', automationId: 'automation-1', automationRevision: 1, sourceMessageId: null },
      decodePlannedWrite('create_scheduled_event', JSON.stringify({
        ...event, messageId: 'gmail-1', attachments: [{ messageId: 'gmail-1', filename: named }, { messageId: 'gmail-1', filename: stored }],
        folderId: 'folder-reikai', folderName: '例会資料', subfolder: '2026-08-01 ガバナー公式訪問のご案内',
      })),
    );

    expect(database.rows('SELECT filename, outcome FROM event_attachments')).toEqual([{ filename: stored, outcome: 'succeeded' }]);
    expect(providers.google.drive.files.map(({ filename, folderId }) => ({ filename, folderId }))).toEqual([{ filename: stored, folderId: 'folder-reikai/2026-08-01 ガバナー公式訪問のご案内' }]);
  });

  it('publishes a mail\'s files in the folder the run chose, sharing one file between two events that name it', async () => {
    const database = accountDatabase();
    const google = memoryGoogle();
    grantDrive(database, google);
    google.addMessage({ id: 'gmail-1', subject: '例会のご案内', attachments: [{ filename: '次第.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4') }] });
    const handlers = chatHandlers(google, database.binding);
    const files = { attachments: [{ messageId: 'gmail-1', filename: '次第.pdf' }], folderId: 'folder-reikai', folderName: '例会資料' };

    await handlers.create_scheduled_event?.({ ...event, ...files });
    await handlers.create_scheduled_event?.({ ...event, title: '懇親会', ...files });

    expect(google.drive.files.map(({ filename, folderId }) => ({ filename, folderId }))).toEqual([{ filename: '次第.pdf', folderId: 'folder-reikai' }]);
    expect(database.rows('SELECT filename, outcome FROM event_attachments')).toEqual([{ filename: '次第.pdf', outcome: 'succeeded' }, { filename: '次第.pdf', outcome: 'succeeded' }]);
  });

  it('refuses a folder outside the Drive the run may touch, so the model chooses another', async () => {
    const database = accountDatabase();
    const google = memoryGoogle();
    grantDrive(database, google);
    google.drive.held.push({ id: 'folder-private', name: '私物', mimeType: 'application/vnd.google-apps.folder' });
    database.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('drive_folders', ?, '2026-08-01T00:00:00.000Z')",
      JSON.stringify([{ id: 'folder-reikai', name: '例会資料', url: 'https://drive.example/folder-reikai' }]),
    );
    google.addMessage({ id: 'gmail-1', subject: '例会のご案内', attachments: [{ filename: '次第.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4') }] });
    const handlers = chatHandlers(google, database.binding);

    await expect(handlers.create_scheduled_event?.({ ...event, attachments: [{ messageId: 'gmail-1', filename: '次第.pdf' }], folderId: 'folder-private', folderName: '私物' }))
      .rejects.toThrow('outside the Drive folders this Account lets you reach: 例会資料 (folder-reikai)');
    expect(google.drive.files).toEqual([]);
    expect(database.rows('SELECT id FROM events')).toEqual([]);
  });

  it('records an Event Response against the mail that declared it, replacing what the same mail declared before', async () => {
    const database = accountDatabase();
    seedAutomation(database);
    const providers = memoryProviders();
    providers.google.addMessage({ id: 'gmail-reply', subject: 'Re: 例会のご案内', sender: '他クラブ <club@example.org>', body: '2名で参加します。' });
    const writes = plannedWritesFor({
      env: {} as Bindings, database: database.binding, accountId: 'organization-1', providers,
      inbox: { accessToken: 'token' } as InboxSession,
    });
    const run = { id: 'run-1', writeId: 'write-1', automationId: 'automation-1', automationRevision: 1, sourceMessageId: null };
    await writes.apply(run, decodePlannedWrite('create_scheduled_event', JSON.stringify(event)));
    const eventId = database.row<{ id: string }>('SELECT id FROM events')?.id ?? '';
    const respond = (guests: Array<{ name: string; affiliation: string; attending: boolean }>) =>
      writes.apply({ ...run, writeId: crypto.randomUUID() }, decodePlannedWrite('record_event_response', JSON.stringify({ messageId: 'gmail-reply', eventId, guests })));

    await respond([{ name: '佐藤', affiliation: '他クラブ', attending: true }, { name: '鈴木', affiliation: '他クラブ', attending: true }]);
    await respond([{ name: '佐藤', affiliation: '他クラブ', attending: true }]);

    expect(database.rows('SELECT g.name, s.gmail_message_id FROM guest_registrations g JOIN source_messages s ON s.id = g.source_message_id'))
      .toEqual([{ name: '佐藤', gmail_message_id: 'gmail-reply' }]);
  });
});
