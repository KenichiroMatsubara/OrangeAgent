/**
 * The Account's Google mailbox and calendar as every run reads them: the same
 * Automation Inbox grant the intake reads with. A mail is read one way,
 * whoever reads it — its body, and every attachment as the file itself — and a
 * run differs only in which mail it may read: a run holding the Google grant
 * reads any, and a run a mail started reads the Source Message it was started for.
 */

import { inArray } from 'drizzle-orm';

import { meetingCodeOf } from './meet';
import type { CalendarSession } from './scheduling';
import type { GmailMessage, GmailPart, GoogleProvider } from './providers';
import { decodedBody, receivedAtOf, senderOf, sourceAttachments, subjectOf } from './source';
import { accountDatabase } from './storage/database';
import { events } from './storage/account-schema';
import { FileAnswer, type TurnFile } from './turns';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(value);

/** A bound the Calendar API accepts: a bare day starts at midnight in Asia/Tokyo. */
const instant = (value: string): string => isDay(value) ? `${value}T00:00:00+09:00` : value;

const header = (part: GmailPart | undefined, name: string): string =>
  part?.headers?.find((entry) => entry.name?.toLowerCase() === name)?.value?.trim() ?? '';

/** One attachment of a mail: the file as Gmail holds it. */
export interface MailFile extends TurnFile {
  size: number;
}

/** One mail as every run reads it. */
export interface Mail {
  /** The Gmail message id, by which a run names the mail and its files. */
  messageId: string;
  sender: string;
  to?: string;
  cc?: string;
  subject: string;
  /** When the message arrived, as an offset-bearing instant: a Verified Delivery Fact. */
  receivedAt?: string;
  body: string;
  attachments: MailFile[];
  /** Why the attachments could not be read, when they could not; their names are still listed. */
  attachmentError?: { reason: string; files: Array<{ filename: string; mimeType: string }> };
}

/** Attachments that could not be read, with the code an Automation Exception records. */
export class MailAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MailAttachmentError';
  }
}

/** What reading attachments needs of the Automation Inbox. */
export type AttachmentReader = Pick<CalendarSession, 'readAttachments'>;

/**
 * Reads every attachment of one message as it is, the one way any run reads
 * them: every file, each whole, however many and however large.
 */
export const mailAttachments = async (input: { message: GmailMessage; session: AttachmentReader }): Promise<MailFile[]> => {
  try {
    const contents = await input.session.readAttachments(input.message.id ?? '', sourceAttachments(input.message.payload));
    return contents.map((content) => ({ filename: content.filename, mediaType: content.mimeType, bytes: content.bytes, size: content.size }));
  } catch (error) {
    throw new MailAttachmentError('gmail_attachment_download_failed', error instanceof Error ? error.message : 'Gmail attachment download failed.');
  }
};

/** A Gmail message and its attachments as one Mail. */
export const mailOf = (message: GmailMessage, attachments: MailFile[]): Mail => {
  const receivedAt = receivedAtOf(message.internalDate);
  return {
    messageId: message.id ?? '',
    sender: senderOf(message.payload),
    to: header(message.payload, 'to'),
    cc: header(message.payload, 'cc'),
    subject: subjectOf(message.payload),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    body: decodedBody(message.payload) || (message.snippet ?? ''),
    attachments,
  };
};

/** Reads one mail of the mailbox. Attachments that cannot be read leave the mail readable and say why. */
export const readMail = async (input: { google: GoogleProvider; session: CalendarSession; messageId: string }): Promise<Mail> => {
  const message = await input.google.gmail.readMessage(input.session.accessToken, input.messageId);
  try {
    return mailOf(message, await mailAttachments({ message, session: input.session }));
  } catch (error) {
    if (!(error instanceof MailAttachmentError)) throw error;
    return {
      ...mailOf(message, []),
      attachmentError: {
        reason: error.message,
        files: sourceAttachments(message.payload).map(({ filename, mimeType }) => ({ filename, mimeType })),
      },
    };
  }
};

/**
 * What mail.read answers: the mail, with each attachment named in the answer
 * and handed to the model beside it as the file itself.
 */
export const mailView = (mail: Mail): FileAnswer => new FileAnswer({
  id: mail.messageId,
  from: mail.sender,
  to: mail.to ?? '',
  cc: mail.cc ?? '',
  subject: mail.subject,
  receivedAt: mail.receivedAt ?? null,
  body: mail.body,
  attachments: mail.attachments.map((attachment) => ({ filename: attachment.filename, mimeType: attachment.mediaType, size: attachment.size })),
  ...(mail.attachmentError ? { unreadAttachments: mail.attachmentError.files, attachmentError: mail.attachmentError.reason } : {}),
}, mail.attachments.map(({ filename, mediaType, bytes }) => ({ filename, mediaType, bytes })));

/** How a run reads a mail of the mailbox, or why it may not. */
export type MailReader = (messageId: string) => Promise<Mail | { refused: string }>;

/** A reader of the whole mailbox, for a run holding the Automation Inbox's Google grant. */
export const mailboxReader = (input: { google: GoogleProvider; session: () => Promise<CalendarSession> }): MailReader =>
  async (messageId) => readMail({ google: input.google, session: await input.session(), messageId });

const summary = (message: GmailMessage) => ({
  id: message.id ?? '',
  from: senderOf(message.payload),
  subject: subjectOf(message.payload),
  receivedAt: receivedAtOf(message.internalDate) ?? null,
  snippet: message.snippet ?? '',
});

/**
 * How many summaries mail.search reads from Gmail at once. Gmail refuses a
 * user who asks too much at once (429), so a page is read a few at a time.
 */
const SUMMARY_READS = 4;

/**
 * How many matches one mail.search returns: 50 unless the run asks for fewer
 * or more, and never more than 100. A broad query can match a whole mailbox,
 * and reading all of it in one call met Gmail's per-user limits and could
 * meet the Worker's own, so the rest is read page by page with `pageToken`.
 */
export const MAIL_SEARCH_PAGE = 50;
export const MAIL_SEARCH_MOST = 100;

/**
 * mail.search: one page of the mailbox, newest first, each message as a
 * summary to read in full with mail.read — only its headers and snippet are
 * read, never its body — and where the next page starts, when there is one.
 */
export const searchMail = async (input: { google: GoogleProvider; accessToken: string; query: string; maxResults: unknown; pageToken?: unknown }) => {
  const requested = Number(input.maxResults);
  const maxResults = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAIL_SEARCH_MOST) : MAIL_SEARCH_PAGE;
  const pageToken = typeof input.pageToken === 'string' ? input.pageToken.trim() : '';
  const page = await input.google.gmail.searchMessages(input.accessToken, { query: input.query, maxResults, ...(pageToken ? { pageToken } : {}) });
  const messages: GmailMessage[] = new Array<GmailMessage>(page.ids.length);
  let next = 0;
  const reader = async (): Promise<void> => {
    while (next < page.ids.length) {
      const at = next;
      next += 1;
      messages[at] = await input.google.gmail.readMessage(input.accessToken, page.ids[at] ?? '', 'summary');
    }
  };
  await Promise.all(Array.from({ length: Math.min(SUMMARY_READS, page.ids.length) }, reader));
  return { messages: messages.map(summary), nextPageToken: page.nextPageToken };
};

/**
 * calendar.search: the Google Calendar itself, including events OrangeAgent did
 * not create. An event OrangeAgent records carries its Scheduled Event id, the
 * only id the event writes accept.
 */
export const searchCalendar = async (input: { google: GoogleProvider; database: D1Database; accessToken: string; arguments: Record<string, unknown> }) => {
  const from = text(input.arguments.from);
  const to = text(input.arguments.to);
  if (!from || !to) return { isError: true, message: 'calendar.search requires from and to.' };
  const query = text(input.arguments.query);
  const found = await input.google.calendar.listEvents(input.accessToken, {
    timeMin: instant(from),
    timeMax: instant(to),
    ...(query ? { query } : {}),
  });
  const googleIds = found.flatMap((event) => event.id ? [event.id] : []);
  const recorded = googleIds.length
    ? await accountDatabase(input.database).select({ id: events.id, googleEventId: events.googleEventId }).from(events).where(inArray(events.googleEventId, googleIds)).all()
    : [];
  return {
    events: found.map((event) => ({
      id: event.id ?? '',
      scheduledEventId: recorded.find((row) => row.googleEventId === event.id)?.id ?? null,
      title: event.summary ?? '',
      start: event.start?.dateTime ?? event.start?.date ?? '',
      end: event.end?.dateTime ?? event.end?.date ?? '',
      location: event.location ?? '',
      description: event.description ?? '',
      attendees: (event.attendees ?? []).map((attendee) => attendee.email ?? '').filter(Boolean),
      meetingCode: meetingCodeOf(event.hangoutLink),
    })),
  };
};
