/**
 * The one calendar path every run takes: creating a Scheduled Event, changing
 * or cancelling one, adding and replacing its files, and recording the Event
 * Responses that answer it. An Automation plans these as Planned Writes and
 * Operator Chat performs them when called, so an event either of them
 * touches is written to Google Calendar, recorded, attributed, and invited
 * the same way. Whom an event may invite, and which mail its files may come
 * from, is the run's bound, not this path's.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  attributedMessageId,
  calendarTime,
  changedCalendarFields,
  liveEventFields,
  lockedCalendarFields,
  sourceMessageAttribution,
  type CalendarEventFields,
  type CalendarField,
} from './calendar';
import { now } from './clock';
import { activeContactInvitees, invitableEmail, recordEventInvitations, type EventInvitee } from './delivery';
import { driveReachOf, writableFolder } from './drive';
import { calendarEventDescription, type AttachmentLink } from './event-description';
import { guestCountsLine } from './guests';
import type { InboxSession } from './inbox';
import { GoogleApiError, type CalendarEventResource, type GoogleProvider, type PublishedDriveAttachment, type SourceAttachment, type SourceAttachmentContent } from './providers';
import { receivedAtOf, senderOf, sourceAttachments, subjectOf } from './source';
import { accountDatabase } from './storage/database';
import { contacts, deliveries, eventAttachments, events, exceptions, guestRegistrations, sourceMessages } from './storage/account-schema';
import { repeatDigest } from './temporary';

/** What caused a Scheduled Event, which its row and its Calendar description name. */
export interface ScheduledEventOrigin {
  /** The Automation whose run made the write; null for Operator Chat. */
  automationId: string | null;
  sourceMessageId: string | null;
}

/** The Source Message a run read, as the calendar path needs it to attribute an event and publish its files. */
interface SourceRecord {
  id: string;
  gmailMessageId: string;
  subject: string;
  receivedAt: string;
}

const sourceRecord = async (database: D1Database, sourceMessageId: string | null): Promise<SourceRecord | null> => {
  if (!sourceMessageId) return null;
  const row = await accountDatabase(database).select({
    id: sourceMessages.id, gmailMessageId: sourceMessages.gmailMessageId, subject: sourceMessages.subject,
    receivedAt: sourceMessages.receivedAt,
  }).from(sourceMessages).where(eq(sourceMessages.id, sourceMessageId)).get();
  return row ?? null;
};

/** The Source Message a Gmail message was taken in as, when it was. */
const recordOfMessage = async (database: D1Database, gmailMessageId: string): Promise<SourceRecord | null> => {
  const row = await accountDatabase(database).select({
    id: sourceMessages.id, gmailMessageId: sourceMessages.gmailMessageId, subject: sourceMessages.subject,
    receivedAt: sourceMessages.receivedAt,
  }).from(sourceMessages).where(eq(sourceMessages.gmailMessageId, gmailMessageId)).get();
  return row ?? null;
};

/**
 * The Source Message a mail a run names is recorded as, recorded now when it
 * was not yet. An event names the mail it came from, and an Event Response is
 * keyed by the mail that declared it, whichever run read the mail.
 */
export const takeInMail = async (input: { google: GoogleProvider; database: D1Database; accessToken: string; gmailMessageId: string }): Promise<SourceRecord> => {
  const known = await recordOfMessage(input.database, input.gmailMessageId);
  if (known) return known;
  const message = await input.google.gmail.readMessage(input.accessToken, input.gmailMessageId);
  const at = now();
  await accountDatabase(input.database).insert(sourceMessages).values({
    id: crypto.randomUUID(), gmailMessageId: input.gmailMessageId, gmailHistoryId: '',
    sender: senderOf(message.payload), subject: subjectOf(message.payload),
    receivedAt: receivedAtOf(message.internalDate) ?? at, processedAt: at, state: 'processed',
  }).onConflictDoNothing().run();
  const recorded = await recordOfMessage(input.database, input.gmailMessageId);
  if (!recorded) throw new Error(`The mail ${input.gmailMessageId} could not be recorded.`);
  return recorded;
};

/**
 * One file a Scheduled Event carries: an attachment of a mail, named by the
 * mail's Gmail message id. A null message is the Source Message the run read,
 * as a call that named a bare filename meant before files could come from any
 * mail.
 */
export interface FileReference {
  messageId: string | null;
  filename: string;
}

/** Reads the files a call names, as `{ messageId, filename }` or, as before, a bare filename of the Source Message. */
const fileReferences = (name: string, field: string, value: unknown): FileReference[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} ${field} must be a list of { messageId, filename }.`);
  const references = value.map((entry: unknown): FileReference => {
    if (typeof entry === 'string') return { messageId: null, filename: entry.trim() };
    const reference = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return { messageId: text(reference.messageId) || null, filename: text(reference.filename) };
  });
  if (references.some((reference) => !reference.filename)) throw new Error(`Every entry of ${name} ${field} names a filename.`);
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.messageId ?? ''}\n${reference.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Whether a filename the model wrote names a mail's file. A file made on a Mac
 * reaches Gmail in decomposed Unicode (カ followed by a combining ゛ for ガ),
 * while the model writes the composed form, and either may carry stray spaces;
 * so both sides are compared composed, with whitespace collapsed.
 */
const sameFilename = (stored: string, named: string): boolean => {
  const key = (filename: string): string => filename.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return key(stored) === key(named);
};

/**
 * The Drive folder a call's files are published in, which the run chooses as
 * its Skills or the administrator say: one within the Drive the run may
 * touch, named by its id and by the name drive.search answered with, and
 * optionally a folder inside it that holds these files alone, made the first
 * time it is named and found again after.
 */
export interface FileFolder {
  folderId: string;
  folderName: string;
  subfolder: string | null;
}

const FOLDER_NAME_REFUSED = /[\u0000-\u001F\u007F/]/u;

/** Reads the folder a call names for its files, or null when it names none. */
const fileFolder = (name: string, input: Record<string, unknown>): FileFolder | null => {
  const folderId = text(input.folderId);
  const folderName = text(input.folderName);
  const subfolder = text(input.subfolder);
  if (!folderId && !folderName && !subfolder) return null;
  if (!folderId || !folderName) throw new Error(`${name} names the Drive folder its files go in by both folderId and folderName, as drive.search returned them.`);
  if (FOLDER_NAME_REFUSED.test(subfolder)) throw new Error(`${name} subfolder is the name of one folder, without "/" or control characters.`);
  return { folderId, folderName, subfolder: subfolder || null };
};

/** The folder a call that carries files must name, refused with what the model has to do. */
const requiredFolder = (name: string, folder: FileFolder | null): FileFolder => {
  if (folder) return folder;
  throw new Error(`${name} publishes its files in a Drive folder you choose: follow what your Skills say about where files go, or find a fitting folder with drive.search, and name it by folderId and folderName. Name a subfolder as well to keep these files in a folder of their own inside it, such as one per mail.`);
};

/** A mail file published to Drive, or the failure that withheld its link. */
interface Publication {
  attachment: SourceAttachment;
  publication: PublishedDriveAttachment;
  /** The Source Message the file came from, when its mail was taken in as one. */
  sourceMessageId: string | null;
}

/** What the calendar path needs of the Automation Inbox: its token, and the mail files it can read. */
export type CalendarSession = Pick<InboxSession, 'accessToken' | 'readAttachments'>;

/** A session for a run that reads no mail files, so it has none to attach. */
export const tokenSession = (accessToken: string): CalendarSession => ({
  accessToken,
  readAttachments: async () => { throw new Error('This run cannot read mail files.'); },
});

const unpublished: PublishedDriveAttachment = { outcome: 'failed', driveFileId: null, publicUrl: null };

/**
 * Publishes the named files of one mail as Public Attachments in the folder
 * the run chose. A file the folder already holds is linked again rather than
 * uploaded twice, so two events that name the same folder share one file. The
 * parts are read from Gmail now, because an attachment id Gmail handed out
 * earlier need not still be valid.
 */
const publishMessageFiles = async (input: {
  google: GoogleProvider;
  database: D1Database;
  session: CalendarSession;
  gmailMessageId: string;
  filenames: readonly string[];
  folderId: string;
}): Promise<Publication[]> => {
  if (!input.filenames.length) return [];
  const { google, folderId } = input;
  const { accessToken } = input.session;
  const message = await google.gmail.readMessage(accessToken, input.gmailMessageId);
  const parts = sourceAttachments(message.payload);
  const chosen = input.filenames.map((filename) => {
    const part = parts.find((entry) => entry.filename === filename)
      ?? parts.find((entry) => sameFilename(entry.filename, filename));
    if (!part) throw new Error(`Mail ${input.gmailMessageId} has no attachment named ${filename}. Its attachments are: ${parts.map((entry) => entry.filename).join(', ') || 'none'}.`);
    return part;
  }).filter((part, index, all) => all.findIndex((entry) => entry.attachmentId === part.attachmentId) === index);
  const sourceMessageId = (await recordOfMessage(input.database, input.gmailMessageId))?.id ?? null;
  const contents: SourceAttachmentContent[] = await input.session.readAttachments(input.gmailMessageId, chosen);
  return Promise.all(contents.map(async (content) => {
    const { bytes: _, ...attachment } = content;
    const reusable = await google.drive.findPublishedAttachment(accessToken, { filename: content.filename, folderId });
    if (reusable) return { attachment, publication: { outcome: 'succeeded' as const, driveFileId: reusable.driveFileId, publicUrl: reusable.publicUrl }, sourceMessageId };
    return { attachment, publication: await google.drive.publishAttachment(accessToken, { attachment: content, parentFolderId: folderId }), sourceMessageId };
  }));
};

/**
 * The id of the folder a call's files go in: the folder it names, checked as
 * every folder a Drive write names is, or the subfolder inside it.
 */
const publicationFolder = async (input: { google: GoogleProvider; database: D1Database; accessToken: string; folder: FileFolder }): Promise<string> => {
  const { folder } = input;
  const refusal = await writableFolder({ google: input.google, accessToken: input.accessToken, reach: await driveReachOf(input.database) }, folder.folderId, folder.folderName);
  if (refusal) throw new Error(refusal.message);
  if (!folder.subfolder) return folder.folderId;
  return input.google.drive.ensureFolderPath(input.accessToken, [folder.subfolder], folder.folderId);
};

/**
 * Publishes every file a call names, mail by mail. A file named without its
 * mail belongs to the Source Message the run read, and a run that read none
 * has to name the mail.
 */
const publishFiles = async (input: {
  google: GoogleProvider;
  database: D1Database;
  session: CalendarSession;
  references: readonly FileReference[];
  /** Where the files go; required whenever there are any. */
  folder: FileFolder | null;
  /** The Gmail message of the Source Message the run read, when it read one. */
  sourceGmailMessageId: string | null;
}): Promise<Publication[]> => {
  if (!input.references.length) return [];
  const byMessage = new Map<string, string[]>();
  for (const reference of input.references) {
    const messageId = reference.messageId ?? input.sourceGmailMessageId;
    if (!messageId) throw new Error(`Name the mail ${reference.filename} comes from by its messageId.`);
    byMessage.set(messageId, [...byMessage.get(messageId) ?? [], reference.filename]);
  }
  const folderId = await publicationFolder({
    google: input.google, database: input.database, accessToken: input.session.accessToken, folder: requiredFolder('A call that carries files', input.folder),
  });
  const published: Publication[] = [];
  for (const [gmailMessageId, filenames] of byMessage) {
    published.push(...await publishMessageFiles({ google: input.google, database: input.database, session: input.session, gmailMessageId, filenames, folderId }));
  }
  return published;
};

const publicationFailed = (publications: readonly Publication[]): boolean =>
  publications.some(({ publication }) => publication.outcome === 'failed');

/** Records each publication on the event it belongs to, with the Drive Delivery Record it left. */
const recordEventAttachments = async (database: D1Database, eventId: string, publications: readonly Publication[]): Promise<void> => {
  const db = accountDatabase(database);
  for (const { attachment, publication } of publications) {
    await db.insert(eventAttachments).values({
      id: crypto.randomUUID(), eventId, gmailAttachmentId: attachment.attachmentId,
      filename: attachment.filename, mimeType: attachment.mimeType, byteSize: attachment.size,
      driveFileId: publication.driveFileId, publicUrl: publication.publicUrl,
      outcome: publication.outcome, createdAt: now(),
    }).run();
    await db.insert(deliveries).values({
      id: crypto.randomUUID(), eventId, channel: 'drive', destination: attachment.filename,
      outcome: publication.outcome, externalId: publication.driveFileId, createdAt: now(),
    }).run();
  }
};

/** Raises one Automation Exception for files that could not be published, on the Source Message they came from when there is one. */
const raisePublicationException = async (database: D1Database, publications: readonly Publication[], fallbackSourceMessageId: string | null): Promise<void> => {
  if (!publicationFailed(publications)) return;
  const failedFrom = publications.find(({ publication }) => publication.outcome === 'failed')?.sourceMessageId ?? null;
  await accountDatabase(database).insert(exceptions).values({
    id: crypto.randomUUID(), sourceMessageId: failedFrom ?? fallbackSourceMessageId, code: 'drive_attachment_publish_failed',
    message: '一部の添付ファイルを公開できませんでした。', state: 'open', createdAt: now(),
  }).run();
};

/** The published files a Scheduled Event links, each once, in the order they were added. */
const eventFiles = async (database: D1Database, eventId: string): Promise<Array<AttachmentLink & { mimeType: string }>> => {
  const rows = await accountDatabase(database).select({
    filename: eventAttachments.filename, publicUrl: eventAttachments.publicUrl, mimeType: eventAttachments.mimeType,
  }).from(eventAttachments).where(eq(eventAttachments.eventId, eventId)).orderBy(asc(eventAttachments.createdAt)).all();
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!row.publicUrl || seen.has(row.publicUrl)) return [];
    seen.add(row.publicUrl);
    return [{ filename: row.filename, url: row.publicUrl, mimeType: row.mimeType }];
  });
};

/** The Guest Registration line for a Scheduled Event, or undefined when nobody outside has registered. */
const guestCountsFor = async (database: D1Database, eventId: string): Promise<string | undefined> => {
  const rows = await accountDatabase(database).select({
    name: guestRegistrations.name, affiliation: guestRegistrations.affiliation, attending: guestRegistrations.attending,
  }).from(guestRegistrations).where(eq(guestRegistrations.eventId, eventId)).all();
  return guestCountsLine(rows) ?? undefined;
};

/** The Calendar description an event's records compose: its Event Summary, guests, files, and Source Attribution. */
const composedDescription = async (database: D1Database, eventId: string, summary: string, attribution: string): Promise<string> => {
  const guestCounts = await guestCountsFor(database, eventId);
  return calendarEventDescription({
    summary,
    ...(guestCounts === undefined ? {} : { guestCounts }),
    attachments: (await eventFiles(database, eventId)).map(({ filename, url }) => ({ filename, url })),
    attribution,
  });
};

/**
 * The Google Calendar event id a Planned Write's event is created under: the
 * same for every attempt of the write, in the lowercase hexadecimal Google
 * accepts for an id a client chooses.
 */
const plannedEventId = (plannedWriteId: string): Promise<string> => repeatDigest(`flarechat:planned-write:${plannedWriteId}:event`);

/**
 * Creates the Google Calendar event, under the id a Planned Write chose when it
 * chose one. Google answers 409 for an id it already holds, which for that id
 * means an earlier attempt of the same write created the event and its answer
 * was lost, so the event it holds is the one created.
 */
const createCalendarEvent = async (google: GoogleProvider, accessToken: string, id: string | null, event: Record<string, unknown>): Promise<CalendarEventResource> => {
  try {
    return await google.calendar.createEvent(accessToken, id ? { id, ...event } : event);
  } catch (error) {
    if (!id || !(error instanceof GoogleApiError) || error.status !== 409) throw error;
    return google.calendar.readEvent(accessToken, id);
  }
};

/**
 * Creates one Scheduled Event in the Automation Inbox's calendar and records it
 * with its Recipient Snapshot and one Delivery Record per invitation. When a
 * file it was to carry could not be published, the event is created as a draft
 * with its invitations pending, because the intended effect is what a retry has
 * to find.
 *
 * A Planned Write creates its event under an id of its own, so applying the
 * same write again creates nothing new: an event already recorded under that
 * id is returned as it is, and one Google holds but this Account never
 * recorded is recorded now.
 */
export const createScheduledEvent = async (input: {
  google: GoogleProvider;
  database: D1Database;
  accessToken: string;
  accountId: string;
  origin: ScheduledEventOrigin;
  gmailMessageId: string | null;
  event: { title: string; startsAt: string; endsAt: string; location: string; summary: string };
  invitees: EventInvitee[];
  publications?: readonly Publication[];
  /** The Planned Write this event is created by, when one is. */
  plannedWriteId?: string;
}): Promise<{ eventId: string; googleEventId: string; draft: boolean }> => {
  const { event, origin } = input;
  const requestedId = input.plannedWriteId ? await plannedEventId(input.plannedWriteId) : null;
  if (requestedId) {
    const recorded = await accountDatabase(input.database).select({ id: events.id, status: events.status })
      .from(events).where(eq(events.googleEventId, requestedId)).get();
    if (recorded) return { eventId: recorded.id, googleEventId: requestedId, draft: recorded.status === 'draft' };
  }
  const publications = input.publications ?? [];
  const withheld = publicationFailed(publications);
  const published = publications.flatMap(({ attachment, publication }) => publication.publicUrl
    ? [{ filename: attachment.filename, url: publication.publicUrl, mimeType: attachment.mimeType }] : []);
  const description = calendarEventDescription({
    summary: event.summary,
    attachments: published.map(({ filename, url }) => ({ filename, url })),
    attribution: input.gmailMessageId ? sourceMessageAttribution(input.gmailMessageId) : '',
  });
  const created = await createCalendarEvent(input.google, input.accessToken, requestedId, {
    summary: event.title,
    description,
    location: event.location,
    start: calendarTime(event.startsAt),
    end: calendarTime(event.endsAt),
    ...(published.length ? { attachments: published.map(({ filename, url, mimeType }) => ({ fileUrl: url, title: filename, mimeType })) } : {}),
    attendees: withheld ? [] : input.invitees.map(({ email }) => ({ email })),
  });
  if (!created.id) throw new Error('Google Calendar did not return an event ID.');
  const eventId = crypto.randomUUID();
  const createdAt = now();
  await accountDatabase(input.database).insert(events).values({
    id: eventId, accountId: input.accountId, automationId: origin.automationId,
    sourceMessageId: origin.sourceMessageId, googleEventId: created.id, title: event.title,
    startsAt: event.startsAt, endsAt: event.endsAt, location: event.location, description: event.summary,
    calendarDescription: description, calendarEtag: created.etag ?? null,
    status: withheld ? 'draft' : 'scheduled', createdAt, updatedAt: createdAt,
  }).run();
  await recordEventAttachments(input.database, eventId, publications);
  await recordEventInvitations({
    database: input.database, eventId, googleEventId: created.id, invitees: input.invitees,
    outcome: withheld ? 'pending' : 'succeeded',
  });
  return { eventId, googleEventId: created.id, draft: withheld };
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(value);

const readableTime = (value: string): boolean => isDay(value) || !Number.isNaN(Date.parse(value));

const stringList = (name: string, field: string, value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${name} ${field} must be a list of strings.`);
  return [...new Set((value as string[]).map((entry) => entry.trim()).filter(Boolean))];
};

/** What one create_scheduled_event call asks for, read the same way however the run applies it. */
export interface ScheduledEventCall {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  description: string;
  /** Lower-cased email addresses, each named once. */
  attendees: string[];
  /** Whether every active Contact holding an address is invited as well. */
  inviteRoster: boolean;
  /** The mail files the event carries. */
  attachments: FileReference[];
  /** The Drive folder the run chose for those files; named whenever there are any. */
  folderId: string | null;
  folderName: string | null;
  subfolder: string | null;
  /** The Gmail message id of the mail the event came from, when it came from one. */
  messageId: string | null;
}

/** Reads a create_scheduled_event call, refusing with a reason the model can correct. */
export const scheduledEventCall = (input: Record<string, unknown>): ScheduledEventCall => {
  const title = text(input.title);
  const startsAt = text(input.startsAt);
  const endsAt = text(input.endsAt);
  if (!title || !startsAt || !endsAt) throw new Error('create_scheduled_event requires a title, startsAt, and endsAt.');
  for (const time of [startsAt, endsAt]) {
    if (!readableTime(time)) throw new Error(`${time} is neither an RFC3339 time nor a YYYY-MM-DD day.`);
  }
  if (input.attendees !== undefined && !Array.isArray(input.attendees)) throw new Error('create_scheduled_event attendees must be a list of email addresses.');
  const named: unknown[] = Array.isArray(input.attendees) ? input.attendees : [];
  const attendees = [...new Set(named.map((entry) => text(entry).toLowerCase()))];
  const malformed = attendees.find((email) => !invitableEmail(email));
  if (malformed !== undefined) throw new Error(`${malformed || 'An empty attendee'} is not one email address.`);
  if (input.inviteRoster !== undefined && typeof input.inviteRoster !== 'boolean') throw new Error('create_scheduled_event inviteRoster must be true or false.');
  const attachments = fileReferences('create_scheduled_event', 'attachments', input.attachments);
  const folder = fileFolder('create_scheduled_event', input);
  if (attachments.length) requiredFolder('create_scheduled_event', folder);
  return {
    title, startsAt, endsAt, location: text(input.location),
    description: typeof input.description === 'string' ? input.description : '',
    attendees, inviteRoster: input.inviteRoster === true,
    attachments,
    folderId: folder?.folderId ?? null, folderName: folder?.folderName ?? null, subfolder: folder?.subfolder ?? null,
    messageId: text(input.messageId) || null,
  };
};

/** The invitees an event's attendees are: each Contact by its address, anyone else by the address alone. */
const attendeeInvitees = async (database: D1Database, attendees: readonly string[]): Promise<EventInvitee[]> => {
  if (!attendees.length) return [];
  const rows = await accountDatabase(database).select({ id: contacts.id, name: contacts.name, email: contacts.email, state: contacts.state })
    .from(contacts).where(inArray(sql`lower(trim(${contacts.email}))`, [...attendees])).all();
  return attendees.map((email) => {
    const contact = rows.find((row) => row.email.trim().toLowerCase() === email && row.state === 'active')
      ?? rows.find((row) => row.email.trim().toLowerCase() === email);
    return contact ? { contactId: contact.id, name: contact.name, email } : { contactId: null, name: email, email };
  });
};

/** The roster and the named attendees together, each address once, a Contact preferred over a bare address. */
const eventInvitees = async (database: D1Database, call: ScheduledEventCall): Promise<EventInvitee[]> => {
  const roster = call.inviteRoster ? await activeContactInvitees(database) : [];
  const named = await attendeeInvitees(database, call.attendees.filter((email) => !roster.some((invitee) => invitee.email === email)));
  return [...roster, ...named];
};

/**
 * Applies one create_scheduled_event call, whether an Automation planned it as
 * a Planned Write or Operator Chat performed it when called.
 * The caller has already bounded its attendees.
 */
export const applyScheduledEventCall = async (input: {
  google: GoogleProvider;
  database: D1Database;
  session: CalendarSession;
  accountId: string;
  origin: ScheduledEventOrigin;
  call: ScheduledEventCall;
  /** The Planned Write this call is, when an Automation planned it. */
  plannedWriteId?: string;
}): Promise<{ eventId: string; googleEventId: string; draft: boolean; attendees: string[] }> => {
  const { call } = input;
  const source = call.messageId
    ? await takeInMail({ google: input.google, database: input.database, accessToken: input.session.accessToken, gmailMessageId: call.messageId })
    : await sourceRecord(input.database, input.origin.sourceMessageId);
  const publications = await publishFiles({
    google: input.google, database: input.database, session: input.session, references: call.attachments,
    folder: fileFolder('create_scheduled_event', { ...call }), sourceGmailMessageId: source?.gmailMessageId ?? null,
  });
  const invitees = await eventInvitees(input.database, call);
  const created = await createScheduledEvent({
    google: input.google,
    database: input.database,
    accessToken: input.session.accessToken,
    accountId: input.accountId,
    origin: { ...input.origin, sourceMessageId: source?.id ?? null },
    gmailMessageId: source?.gmailMessageId ?? null,
    event: { title: call.title, startsAt: call.startsAt, endsAt: call.endsAt, location: call.location, summary: call.description },
    invitees,
    publications,
    ...(input.plannedWriteId ? { plannedWriteId: input.plannedWriteId } : {}),
  });
  await raisePublicationException(input.database, publications, source?.id ?? null);
  return { ...created, attendees: invitees.map(({ email }) => email) };
};

/** A Scheduled Event as FlareChat recorded it, read by its id before any change. */
const recordedEvent = async (database: D1Database, eventId: string) => {
  const row = await accountDatabase(database).select({
    id: events.id, googleEventId: events.googleEventId, status: events.status, sourceMessageId: events.sourceMessageId,
    title: events.title, summary: events.description, calendarDescription: events.calendarDescription,
    location: events.location, startsAt: events.startsAt, endsAt: events.endsAt,
  }).from(events).where(eq(events.id, eventId)).get();
  if (!row) throw new Error(`Scheduled Event ${eventId} is not in this Account. Name one by an id query_scheduled_events returned.`);
  return row;
};

/** An event as FlareChat recorded it, for showing a change or cancellation before it is made; null when the Account has none by that id. */
export const eventFacts = async (database: D1Database, eventId: string): Promise<{ title: string; startsAt: string; endsAt: string; location: string } | null> => {
  const row = await accountDatabase(database).select({ title: events.title, startsAt: events.startsAt, endsAt: events.endsAt, location: events.location })
    .from(events).where(eq(events.id, eventId)).get();
  return row ? { title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, location: row.location } : null;
};

/** Refuses a change to an event that no longer stands, with what the model should do instead. */
export const changeableEvent = async (database: D1Database, eventId: string): Promise<void> => {
  const row = await recordedEvent(database, eventId);
  if (row.status === 'cancelled') throw new Error(`Scheduled Event ${eventId} was cancelled. Create a new one if it is held again.`);
  if (row.status === 'exception') throw new Error(`Scheduled Event ${eventId} was deleted from Google Calendar by hand and is never written again.`);
};

/** Marks a Scheduled Event whose Calendar event a person deleted; it is never recreated. */
const recordCalendarDeletion = async (database: D1Database, eventId: string, sourceMessageId: string | null): Promise<void> => {
  const db = accountDatabase(database);
  const at = now();
  await db.batch([
    db.update(events).set({ status: 'exception', updatedAt: at }).where(eq(events.id, eventId)),
    db.insert(exceptions).values({
      id: crypto.randomUUID(), sourceMessageId, code: 'calendar_event_deleted',
      message: 'The Automation Inbox owner deleted this Calendar event; it was not recreated.', state: 'open', createdAt: at,
    }),
  ]);
};

/** The live Calendar event behind a recorded one, or null once a person deleted it, which is then recorded. */
const liveEvent = async (input: { google: GoogleProvider; database: D1Database; accessToken: string; row: Awaited<ReturnType<typeof recordedEvent>> }) => {
  if (!input.row.googleEventId) throw new Error(`Scheduled Event ${input.row.id} has no Google Calendar event.`);
  let resource;
  try {
    resource = await input.google.calendar.readEvent(input.accessToken, input.row.googleEventId);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404 && status !== 410) throw error;
    resource = { status: 'cancelled' };
  }
  const fields = liveEventFields(resource);
  if (!fields) {
    await recordCalendarDeletion(input.database, input.row.id, input.row.sourceMessageId);
    return null;
  }
  return { fields, etag: resource.etag ?? null, googleEventId: input.row.googleEventId };
};

/** What one update_scheduled_event call asks to change; an absent field is left as it stands. */
export interface ScheduledEventChange {
  eventId: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
  description?: string;
}

/** Reads an update_scheduled_event call, refusing with a reason the model can correct. */
export const scheduledEventChange = (input: Record<string, unknown>): ScheduledEventChange => {
  const eventId = text(input.eventId);
  if (!eventId) throw new Error('update_scheduled_event requires an eventId.');
  const change: ScheduledEventChange = { eventId };
  for (const field of ['title', 'startsAt', 'endsAt', 'location', 'description'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`update_scheduled_event ${field} must be a string.`);
    if ((field === 'title' || field === 'startsAt' || field === 'endsAt') && !value.trim()) throw new Error(`update_scheduled_event ${field} cannot be empty.`);
    if ((field === 'startsAt' || field === 'endsAt') && !readableTime(value.trim())) throw new Error(`${value} is neither an RFC3339 time nor a YYYY-MM-DD day.`);
    change[field] = field === 'description' ? value : value.trim();
  }
  if (Object.keys(change).length === 1) throw new Error('update_scheduled_event requires at least one field to change.');
  return change;
};

/** The Source Attribution a changed description carries: the message that changed it, or the one it already names. */
const attributionFor = (gmailMessageId: string | null, currentDescription: string): string => {
  const named = gmailMessageId ?? attributedMessageId(currentDescription);
  return named ? sourceMessageAttribution(named) : '';
};

/**
 * Changes one Scheduled Event field by field. A field a person changed in
 * Google Calendar since FlareChat last wrote it is a Manual Override and keeps
 * its value while the other fields still change; the write names the revision
 * it read, so it never overwrites a newer one.
 */
export const changeScheduledEvent = async (input: {
  google: GoogleProvider;
  database: D1Database;
  accessToken: string;
  change: ScheduledEventChange;
  /** The Gmail message of the Source Message that asked for the change, when there is one. */
  gmailMessageId: string | null;
}): Promise<{ eventId: string; changed: CalendarField[]; keptOverrides: CalendarField[]; deleted: boolean }> => {
  const { change } = input;
  await changeableEvent(input.database, change.eventId);
  const row = await recordedEvent(input.database, change.eventId);
  const live = await liveEvent({ ...input, row });
  if (!live) return { eventId: row.id, changed: [], keptOverrides: [], deleted: true };
  const recorded: CalendarEventFields = { title: row.title, description: row.calendarDescription, location: row.location, startsAt: row.startsAt, endsAt: row.endsAt };
  const locked = new Set(lockedCalendarFields(live.fields, recorded));
  const summary = change.description ?? row.summary;
  const desired: CalendarEventFields = {
    title: change.title ?? live.fields.title,
    location: change.location ?? live.fields.location,
    startsAt: change.startsAt ?? live.fields.startsAt,
    endsAt: change.endsAt ?? live.fields.endsAt,
    description: await composedDescription(input.database, row.id, summary, attributionFor(input.gmailMessageId, live.fields.description)),
  };
  const asked: CalendarField[] = (['title', 'location', 'startsAt', 'endsAt'] as const).filter((field) => change[field] !== undefined);
  if (change.description !== undefined) asked.push('description');
  const keptOverrides = asked.filter((field) => locked.has(field));
  const merged: CalendarEventFields = {
    title: locked.has('title') ? live.fields.title : desired.title,
    description: locked.has('description') ? live.fields.description : desired.description,
    location: locked.has('location') ? live.fields.location : desired.location,
    startsAt: locked.has('startsAt') ? live.fields.startsAt : desired.startsAt,
    endsAt: locked.has('endsAt') ? live.fields.endsAt : desired.endsAt,
  };
  const changed = changedCalendarFields(live.fields, merged);
  if (changed.length) {
    const updated = await input.google.calendar.patchEvent(input.accessToken, live.googleEventId, {
      summary: merged.title,
      description: merged.description,
      location: merged.location,
      start: calendarTime(merged.startsAt),
      end: calendarTime(merged.endsAt),
    }, { etag: live.etag });
    await accountDatabase(input.database).update(events).set({
      title: merged.title, startsAt: merged.startsAt, endsAt: merged.endsAt, location: merged.location,
      description: locked.has('description') ? row.summary : summary,
      calendarDescription: merged.description, calendarEtag: updated.etag ?? null, updatedAt: now(),
    }).where(eq(events.id, row.id)).run();
  }
  return { eventId: row.id, changed, keptOverrides, deleted: false };
};

/** Reads a cancel_scheduled_event call. */
export const scheduledEventCancellation = (input: Record<string, unknown>): { eventId: string } => {
  const eventId = text(input.eventId);
  if (!eventId) throw new Error('cancel_scheduled_event requires an eventId.');
  return { eventId };
};

/**
 * Cancels one Scheduled Event: Google Calendar removes it from every
 * attendee's calendar without mailing them, and FlareChat keeps it as
 * cancelled, so its attendance and history stay readable and no reminder
 * speaks of it again.
 */
export const cancelScheduledEvent = async (input: {
  google: GoogleProvider;
  database: D1Database;
  accessToken: string;
  eventId: string;
}): Promise<{ eventId: string; cancelled: boolean }> => {
  const row = await recordedEvent(input.database, input.eventId);
  if (row.status === 'cancelled') return { eventId: row.id, cancelled: true };
  await changeableEvent(input.database, input.eventId);
  const live = await liveEvent({ ...input, row });
  if (live) await input.google.calendar.patchEvent(input.accessToken, live.googleEventId, { status: 'cancelled' }, { etag: live.etag });
  if (live) {
    await accountDatabase(input.database).update(events).set({ status: 'cancelled', updatedAt: now() }).where(eq(events.id, row.id)).run();
  }
  return { eventId: row.id, cancelled: live !== null };
};

/**
 * Rewrites a Scheduled Event's description, and the file chips beside it,
 * from what FlareChat holds about it. Neither moves the meeting, so this never
 * changes a time; a description a person rewrote by hand keeps their words.
 */
const rewriteEventRecords = async (input: { google: GoogleProvider; database: D1Database; accessToken: string; eventId: string }): Promise<{ deleted: boolean; descriptionKept: boolean }> => {
  const row = await recordedEvent(input.database, input.eventId);
  const live = await liveEvent({ ...input, row });
  if (!live) return { deleted: true, descriptionKept: false };
  const recorded: CalendarEventFields = { title: row.title, description: row.calendarDescription, location: row.location, startsAt: row.startsAt, endsAt: row.endsAt };
  const descriptionKept = lockedCalendarFields(live.fields, recorded).includes('description');
  const description = await composedDescription(input.database, row.id, row.summary, attributionFor(null, live.fields.description));
  const files = await eventFiles(input.database, row.id);
  const updated = await input.google.calendar.patchEvent(input.accessToken, live.googleEventId, {
    ...(descriptionKept ? {} : { description }),
    attachments: files.map(({ filename, url, mimeType }) => ({ fileUrl: url, title: filename, mimeType })),
  }, { etag: live.etag });
  await accountDatabase(input.database).update(events).set({
    ...(descriptionKept ? {} : { calendarDescription: description }),
    calendarEtag: updated.etag ?? null, updatedAt: now(),
  }).where(eq(events.id, row.id)).run();
  return { deleted: false, descriptionKept };
};

/** What one attach_event_files call asks for. */
export interface EventFilesCall extends FileFolder {
  eventId: string;
  attachments: FileReference[];
  replaces: string[];
}

/** Reads an attach_event_files call, refusing with a reason the model can correct. */
export const eventFilesCall = (input: Record<string, unknown>): EventFilesCall => {
  const eventId = text(input.eventId);
  if (!eventId) throw new Error('attach_event_files requires an eventId.');
  const attachments = fileReferences('attach_event_files', 'attachments', input.attachments);
  if (!attachments.length) throw new Error('attach_event_files requires at least one { messageId, filename } of a mail attachment.');
  const folder = requiredFolder('attach_event_files', fileFolder('attach_event_files', input));
  return { eventId, attachments, ...folder, replaces: stringList('attach_event_files', 'replaces', input.replaces) };
};

/**
 * Publishes mail files in the folder the run chose and adds them to an existing Scheduled Event, first
 * taking the files they replace off it. A file taken off stays in Drive, as
 * every Public Attachment does, and its Delivery Record stays in the history.
 */
export const attachEventFiles = async (input: {
  google: GoogleProvider;
  database: D1Database;
  session: CalendarSession;
  /** The Source Message the run read, whose files a bare filename names. */
  sourceMessageId: string | null;
  call: EventFilesCall;
}): Promise<{ eventId: string; attached: string[]; failed: string[]; replaced: string[]; descriptionKept: boolean }> => {
  await changeableEvent(input.database, input.call.eventId);
  const source = await sourceRecord(input.database, input.sourceMessageId);
  const { folderId, folderName, subfolder } = input.call;
  const publications = await publishFiles({
    google: input.google, database: input.database, session: input.session, references: input.call.attachments,
    folder: { folderId, folderName, subfolder }, sourceGmailMessageId: source?.gmailMessageId ?? null,
  });
  const db = accountDatabase(input.database);
  const replaced = input.call.replaces.length
    ? (await db.select({ id: eventAttachments.id, filename: eventAttachments.filename }).from(eventAttachments)
      .where(and(eq(eventAttachments.eventId, input.call.eventId), inArray(eventAttachments.filename, input.call.replaces))).all())
    : [];
  if (replaced.length) await db.delete(eventAttachments).where(inArray(eventAttachments.id, replaced.map(({ id }) => id))).run();
  await recordEventAttachments(input.database, input.call.eventId, publications);
  const rewritten = await rewriteEventRecords({ google: input.google, database: input.database, accessToken: input.session.accessToken, eventId: input.call.eventId });
  await raisePublicationException(input.database, publications, source?.id ?? null);
  return {
    eventId: input.call.eventId,
    attached: publications.flatMap(({ attachment, publication }) => publication.outcome === 'succeeded' ? [attachment.filename] : []),
    failed: publications.flatMap(({ attachment, publication }) => publication.outcome === 'failed' ? [attachment.filename] : []),
    replaced: [...new Set(replaced.map(({ filename }) => filename))],
    descriptionKept: rewritten.descriptionKept,
  };
};

export interface GuestCall {
  name: string;
  affiliation: string;
  attending: boolean;
}

/** What one record_event_response call asks for. */
export interface EventResponseCall {
  /** The Gmail message id of the mail that is the response. */
  messageId: string;
  eventId: string;
  guests: GuestCall[];
}

/** Reads a record_event_response call, refusing with a reason the model can correct. */
export const eventResponseCall = (input: Record<string, unknown>): EventResponseCall => {
  const eventId = text(input.eventId);
  const messageId = text(input.messageId);
  if (!messageId) throw new Error('record_event_response requires the messageId of the mail that is the response.');
  if (!eventId) throw new Error('record_event_response requires an eventId.');
  if (input.guests !== undefined && !Array.isArray(input.guests)) throw new Error('record_event_response guests must be a list.');
  const guests = (Array.isArray(input.guests) ? input.guests : []).map((entry: unknown): GuestCall => {
    const guest = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const name = text(guest.name);
    if (!name) throw new Error('Every guest of record_event_response needs a name.');
    if (guest.attending !== undefined && typeof guest.attending !== 'boolean') throw new Error('A guest\'s attending must be true or false.');
    return { name, affiliation: text(guest.affiliation), attending: guest.attending !== false };
  });
  return { messageId, eventId, guests };
};

/**
 * Records the Guest Registrations one Event Response declares for the
 * Scheduled Event it answers. They are keyed by the mail that declared them,
 * so a correction or a rerun replaces its rows instead of adding beside them,
 * and the event's description states the new counts.
 */
export const recordEventResponse = async (input: {
  google: GoogleProvider;
  database: D1Database;
  accessToken: string;
  call: EventResponseCall;
}): Promise<{ eventId: string; guests: number; descriptionKept: boolean }> => {
  await changeableEvent(input.database, input.call.eventId);
  const { id: sourceMessageId } = await takeInMail({ google: input.google, database: input.database, accessToken: input.accessToken, gmailMessageId: input.call.messageId });
  const db = accountDatabase(input.database);
  await db.delete(guestRegistrations).where(and(
    eq(guestRegistrations.eventId, input.call.eventId), eq(guestRegistrations.sourceMessageId, sourceMessageId),
  )).run();
  if (input.call.guests.length) {
    await db.insert(guestRegistrations).values(input.call.guests.map((guest) => ({
      id: crypto.randomUUID(), eventId: input.call.eventId, sourceMessageId,
      name: guest.name, affiliation: guest.affiliation, attending: guest.attending, createdAt: now(),
    }))).run();
  }
  const rewritten = await rewriteEventRecords({ google: input.google, database: input.database, accessToken: input.accessToken, eventId: input.call.eventId });
  return { eventId: input.call.eventId, guests: input.call.guests.length, descriptionKept: rewritten.descriptionKept };
};
