import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { EventDetail, EventOverview } from '@mail/domain';

import { now } from '../clock';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { attendance, contacts, eventOverrides, eventRecipients, events, guestRegistrations, sourceMessages } from '../storage/account-schema';
import type { AccountDatabase } from '../storage/database';
import { accountRoute, created } from './account';

export const eventRoutes = resource();

type EventRow = typeof events.$inferSelect;

/** A Scheduled Event's registrations, counted by answer, and its attending guests, for each of several events. */
/** D1 binds at most 100 parameters to one query, so a list of ids is read this many at a time. */
const IDS_PER_QUERY = 90;

const inChunks = (ids: readonly string[]): string[][] =>
  Array.from({ length: Math.ceil(ids.length / IDS_PER_QUERY) }, (_, index) => ids.slice(index * IDS_PER_QUERY, (index + 1) * IDS_PER_QUERY));

const answerCounts = async (db: AccountDatabase, eventIds: readonly string[]) => {
  if (!eventIds.length) return { answered: () => 0, guests: () => 0 };
  const chunks = inChunks(eventIds);
  const [answers, guests] = await Promise.all([
    Promise.all(chunks.map((ids) => db.select({ eventId: attendance.eventId, status: attendance.status, value: count() }).from(attendance)
      .where(inArray(attendance.eventId, ids)).groupBy(attendance.eventId, attendance.status).all())).then((pages) => pages.flat()),
    Promise.all(chunks.map((ids) => db.select({ eventId: guestRegistrations.eventId, value: count() }).from(guestRegistrations)
      .where(and(inArray(guestRegistrations.eventId, ids), eq(guestRegistrations.attending, true))).groupBy(guestRegistrations.eventId).all())).then((pages) => pages.flat()),
  ]);
  return {
    answered: (eventId: string, status: string): number => answers.find((row) => row.eventId === eventId && row.status === status)?.value ?? 0,
    guests: (eventId: string): number => guests.find((row) => row.eventId === eventId)?.value ?? 0,
  };
};

const overview = (row: EventRow, sourceSubject: string | null, counts: Awaited<ReturnType<typeof answerCounts>>): EventOverview => ({
  id: row.id,
  title: row.title,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  location: row.location ?? '',
  status: row.status === 'cancelled' ? 'cancelled' : 'scheduled',
  responseDeadline: row.attendanceDeadline ?? null,
  attending: counts.answered(row.id, 'attending'),
  notAttending: counts.answered(row.id, 'not_attending'),
  unanswered: counts.answered(row.id, 'unanswered'),
  guestsAttending: counts.guests(row.id),
  sourceSubject,
});

/**
 * The Scheduled Events still ahead, soonest first, or those already ended,
 * latest first. Drafts and exceptions are not events anybody was
 * invited to, so only scheduled and cancelled ones are listed. Times are
 * compared by julianday because rows carry different offsets.
 */
eventRoutes.get('/organizations/:accountId/events', accountRoute(async (request): Promise<EventOverview[]> => {
  const past = request.query('view') === 'past';
  const at = now();
  const ending = sql`julianday(${events.endsAt})`;
  const rows = await request.db.select({ event: events, sourceSubject: sourceMessages.subject }).from(events)
    .leftJoin(sourceMessages, eq(sourceMessages.id, events.sourceMessageId))
    .where(and(inArray(events.status, ['scheduled', 'cancelled']), past ? sql`${ending} < julianday(${at})` : sql`${ending} >= julianday(${at})`))
    .orderBy(past ? sql`julianday(${events.startsAt}) desc` : sql`julianday(${events.startsAt})`).all();
  const counts = await answerCounts(request.db, rows.map((row) => row.event.id));
  return rows.map((row) => overview(row.event, row.sourceSubject ?? null, counts));
}));

/** One Scheduled Event in full: each Eligible Recipient's registration, its guests, and where it came from. */
eventRoutes.get('/organizations/:accountId/events/:eventId', accountRoute(async ({ db, params }): Promise<EventDetail> => {
  const eventId = params.eventId ?? '';
  const row = await db.select({ event: events, source: sourceMessages }).from(events)
    .leftJoin(sourceMessages, eq(sourceMessages.id, events.sourceMessageId))
    .where(eq(events.id, eventId)).get();
  if (!row) throw notFound('Event was not found.');
  const [counts, registrations, guests] = await Promise.all([
    answerCounts(db, [eventId]),
    db.select({ contactId: attendance.contactId, name: contacts.name, status: attendance.status, comment: attendance.comment, updatedAt: attendance.updatedAt })
      .from(attendance).innerJoin(contacts, eq(contacts.id, attendance.contactId))
      .where(eq(attendance.eventId, eventId)).orderBy(asc(contacts.name)).all(),
    db.select({ name: guestRegistrations.name, affiliation: guestRegistrations.affiliation, attending: guestRegistrations.attending })
      .from(guestRegistrations).where(eq(guestRegistrations.eventId, eventId))
      .orderBy(asc(guestRegistrations.affiliation), asc(guestRegistrations.name)).all(),
  ]);
  return {
    ...overview(row.event, row.source?.subject ?? null, counts),
    description: row.event.description ?? '',
    registrations,
    guests,
    source: row.source ? { subject: row.source.subject, sender: row.source.sender, receivedAt: row.source.receivedAt } : null,
  };
}));

type EventStatus = 'draft' | 'scheduled' | 'cancelled' | 'exception';
const EVENT_STATUSES: readonly EventStatus[] = ['draft', 'scheduled', 'cancelled', 'exception'];

interface EventInput {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
  description?: string;
  status?: string;
  reason?: string;
}

eventRoutes.patch('/organizations/:accountId/events/:eventId', accountRoute<EventInput>(async ({ db, session, body, params }) => {
  const changeSet = {
    ...(body.title === undefined ? {} : { title: body.title.trim() }),
    ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt.trim() }),
    ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt.trim() }),
    ...(body.location === undefined ? {} : { location: body.location.trim() }),
    ...(body.description === undefined ? {} : { description: body.description.trim() }),
    ...(body.status === undefined ? {} : { status: body.status.trim() }),
  };
  if (!Object.keys(changeSet).length || Object.values(changeSet).some((value) => value === '')) throw invalid('At least one non-empty Event field is required.');
  const status = changeSet.status;
  if (status && !EVENT_STATUSES.includes(status as EventStatus)) throw invalid('Unsupported Event status.');
  const updates: Partial<typeof events.$inferInsert> = {};
  if (changeSet.title !== undefined) updates.title = changeSet.title;
  if (changeSet.startsAt !== undefined) updates.startsAt = changeSet.startsAt;
  if (changeSet.endsAt !== undefined) updates.endsAt = changeSet.endsAt;
  if (changeSet.location !== undefined) updates.location = changeSet.location;
  if (changeSet.description !== undefined) updates.description = changeSet.description;
  if (status !== undefined) updates.status = status as EventStatus;
  const eventId = params.eventId ?? '';
  const timestamp = now();
  const updated = await db.update(events).set({ ...updates, updatedAt: timestamp }).where(eq(events.id, eventId)).returning({ id: events.id }).get();
  if (!updated) throw notFound('Event was not found.');
  await db.insert(eventOverrides).values({
    id: crypto.randomUUID(),
    eventId,
    actorIdentityId: session.identity_id,
    changesJson: JSON.stringify(changeSet),
    reason: body.reason?.trim() ?? '',
    createdAt: timestamp,
  }).run();
  return { id: eventId, updatedFields: Object.keys(changeSet) };
}));

eventRoutes.post('/organizations/:accountId/events/:eventId/recipient-snapshots', accountRoute<{ contactIds?: unknown }>(async ({ db, body, params }) => {
  if (!Array.isArray(body.contactIds) || !body.contactIds.length || body.contactIds.some((id) => typeof id !== 'string' || !id.trim())) throw invalid('At least one Contact is required.');
  const contactIds = [...new Set((body.contactIds as string[]).map((id) => id.trim()))];
  const eventId = params.eventId ?? '';
  const recipients = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
    .where(and(inArray(contacts.id, contactIds), eq(contacts.state, 'active'))).all();
  if (recipients.length !== contactIds.length) throw notFound('One or more active Contacts were not found.');
  const timestamp = now();
  await Promise.all(recipients.map((recipient) => db.insert(attendance).values({
    eventId, contactId: recipient.id, status: 'unanswered', comment: '', updatedAt: timestamp,
  }).onConflictDoNothing().run()));
  await Promise.all(recipients.map((recipient) => db.insert(eventRecipients).values({
    eventId, contactId: recipient.id, nameSnapshot: recipient.name, emailSnapshot: recipient.email, createdAt: timestamp,
  }).onConflictDoNothing().run()));
  return created({ eventId, snapshotted: recipients.length });
}));
