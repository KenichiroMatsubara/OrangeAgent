/**
 * A Scheduled Event as Google Calendar holds it and as OrangeAgent last wrote it:
 * the Source Attribution that names its Source Message, the fields a change may
 * write, and the Manual Overrides a change leaves alone.
 */

import type { CalendarEventResource } from './providers';

const TIME_ZONE = 'Asia/Tokyo';

/**
 * The Source Attribution: the one sentence in a Scheduled Event's Calendar
 * description that names the Gmail message it came from.
 */
export const sourceMessageAttribution = (gmailMessageId: string): string =>
  `OrangeAgent が Gmail メッセージ ${gmailMessageId} から作成しました。`;

/**
 * Reads the Gmail message ID out of every generation of the Source Attribution.
 * The pattern begins after the product name, so an event written under an older
 * name or wording is still read.
 */
export const attributedMessageId = (description: string): string | null =>
  /Gmail\s*メッセージ\s+([A-Za-z0-9_-]{1,200})\s*から作成しました/u.exec(description)?.[1] ?? null;

/** One Google Calendar attendee, kept opaque beyond the fields OrangeAgent reads. */
export interface CalendarAttendee {
  email: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: string;
  comment?: string;
  additionalGuests?: number;
}

/** The fields a change reads from and writes to a Calendar event. A bare day stands for an all-day event. */
export interface CalendarEventFields {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
}

export type CalendarField = keyof CalendarEventFields;

const CALENDAR_FIELDS: readonly CalendarField[] = ['title', 'description', 'location', 'startsAt', 'endsAt'];

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(value);

/** A bare day is an all-day event; anything else is an instant read in Asia/Tokyo. */
export const calendarTime = (value: string): Record<string, string> => isDay(value) ? { date: value } : { dateTime: value, timeZone: TIME_ZONE };

/** The fields of a live Calendar event, or null when Google holds it no longer. */
export const liveEventFields = (event: CalendarEventResource): CalendarEventFields | null => {
  if (event.status === 'cancelled') return null;
  const startsAt = event.start?.dateTime ?? event.start?.date;
  const endsAt = event.end?.dateTime ?? event.end?.date;
  if (!startsAt || !endsAt) return null;
  return {
    title: event.summary ?? '',
    description: event.description ?? '',
    location: event.location ?? '',
    startsAt,
    endsAt,
  };
};

const parsed = (value: string): number | null => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const sameMoment = (left: string, right: string): boolean => {
  const first = parsed(left);
  const second = parsed(right);
  return first === null || second === null ? left.trim() === right.trim() : first === second;
};

const sameValue = (field: CalendarField, left: string, right: string): boolean =>
  field === 'startsAt' || field === 'endsAt' ? sameMoment(left, right) : left.trim() === right.trim();

/**
 * Names the fields a person has taken over. A field whose live Calendar value
 * differs from the value OrangeAgent last wrote was changed by somebody else and is
 * a Manual Override that no automated change may overwrite. A field OrangeAgent
 * never recorded holds nothing to compare, so it is never read as a person's edit.
 */
export const lockedCalendarFields = (current: CalendarEventFields, recorded: CalendarEventFields): CalendarField[] =>
  CALENDAR_FIELDS.filter((field) => recorded[field].trim() !== '' && !sameValue(field, current[field], recorded[field]));

/** The fields whose desired value differs from the live one. */
export const changedCalendarFields = (current: CalendarEventFields, desired: CalendarEventFields): CalendarField[] =>
  CALENDAR_FIELDS.filter((field) => !sameValue(field, current[field], desired[field]));
