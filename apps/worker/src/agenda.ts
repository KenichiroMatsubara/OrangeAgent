import { and, asc, gte, lte, or, sql, type SQL } from 'drizzle-orm';

import { contains, type AccountDatabase } from './storage/database';
import { eventAttachments, events, guestRegistrations } from './storage/account-schema';
import { TASK_WINDOW_DAYS } from './tasks';

export interface ScheduledEventQuery {
  /** The earliest start to include, as an ISO instant or YYYY-MM-DD. */
  from?: string;
  /** The latest start to include, as an ISO instant or YYYY-MM-DD. */
  to?: string;
  /** A phrase the title, location, or description contains. */
  text?: string;
}

export interface ScheduledEventRow {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  status: string;
  /** The Event Summary written first in its Calendar description. */
  summary: string;
  /** The filenames of the Public Attachments it links. */
  files: string[];
  /** How many people from outside the Account registered for it. */
  guests: number;
}

export interface ScheduledEventPage {
  events: ScheduledEventRow[];
}

const isInstant = (value: string): boolean => /^\d{4}-\d{2}-\d{2}/u.test(value) && !Number.isNaN(Date.parse(value));

/** Reads the query arguments a tool supplied, refusing any it cannot read. */
export const scheduledEventQuery = (input: Record<string, unknown>): ScheduledEventQuery => {
  const query: ScheduledEventQuery = {};
  for (const field of ['from', 'to'] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !isInstant(value)) throw new Error(`${field} must be a date written as YYYY-MM-DD or an ISO 8601 instant.`);
    query[field] = value;
  }
  if (typeof input.text === 'string' && input.text.trim()) query.text = input.text.trim();
  return query;
};

/** The query_scheduled_events contract every caller offers. */
export const SCHEDULED_EVENT_QUERY_TOOL = {
  description: 'List this Account’s Scheduled Events, the events OrangeAgent records, with the ids every event write takes. With no arguments it returns every event starting on or after sixty days ago. Name a range or a phrase to find others.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Earliest start, YYYY-MM-DD (Asia/Tokyo) or an ISO 8601 instant.' },
      to: { type: 'string', description: 'Latest start, YYYY-MM-DD (Asia/Tokyo) or an ISO 8601 instant.' },
      text: { type: 'string', description: 'A phrase the title, location, or description contains.' },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Every Scheduled Event one query matches. A query that names neither a range
 * nor a phrase sees every event starting on or after sixty days ago, the same
 * window Tasks are read in. Nothing is cut silently.
 */
export const queryScheduledEvents = async (database: AccountDatabase, query: ScheduledEventQuery = {}, at = Date.now()): Promise<ScheduledEventPage> => {
  // Starts are stored with their offset, so every bound is compared on the UTC
  // instant SQLite reads from each, not on the text.
  const conditions: Array<SQL | undefined> = [];
  if (query.from === undefined && query.to === undefined && query.text === undefined) {
    conditions.push(gte(sql`datetime(${events.startsAt})`, sql`datetime(${new Date(at - TASK_WINDOW_DAYS * 86_400_000).toISOString()})`));
  }
  if (query.from !== undefined) {
    const from = /^\d{4}-\d{2}-\d{2}$/u.test(query.from) ? `${query.from}T00:00:00+09:00` : query.from;
    conditions.push(gte(sql`datetime(${events.startsAt})`, sql`datetime(${from})`));
  }
  if (query.to !== undefined) {
    const to = /^\d{4}-\d{2}-\d{2}$/u.test(query.to) ? `${query.to}T23:59:59+09:00` : query.to;
    conditions.push(lte(sql`datetime(${events.startsAt})`, sql`datetime(${to})`));
  }
  if (query.text !== undefined) {
    conditions.push(or(
      contains(events.title, query.text),
      contains(events.location, query.text),
      contains(events.description, query.text),
    ));
  }
  const rows = await database.select({
    id: events.id, title: events.title, startsAt: events.startsAt, endsAt: events.endsAt,
    location: events.location, status: events.status, summary: events.description,
    files: sql<string>`(select json_group_array(${eventAttachments.filename}) from ${eventAttachments} where ${eventAttachments.eventId} = ${events.id} and ${eventAttachments.publicUrl} is not null)`,
    guests: sql<number>`(select count(*) from ${guestRegistrations} where ${guestRegistrations.eventId} = ${events.id})`,
  }).from(events).where(and(...conditions)).orderBy(asc(events.startsAt)).all();
  const list = (value: string): string[] => [...new Set(JSON.parse(value || '[]') as string[])];
  return {
    events: rows.map((row) => ({ ...row, files: list(row.files), guests: Number(row.guests) })),
  };
};
