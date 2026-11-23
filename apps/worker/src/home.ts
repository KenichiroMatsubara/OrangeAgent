import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { type Attention, type AutomationGlance, type Dashboard, type UpcomingEvent } from '@mail/domain';

import { activeConnection } from './connections';
import { listAutomations } from './automations';
import {
  attendance,
  automations,
  automationWarnings,
  contactLineDestinations,
  events,
  exceptions,
  googleConnections,
  jobs,
  lineDestinations,
  runs,
} from './storage/account-schema';
import type { AccountDatabase } from './storage/database';

const DAY_MS = 86_400_000;

/** How many Scheduled Events Home shows ahead. */
const UPCOMING_EVENTS = 3;

/**
 * Whether a stored instant is at or after another. Instants are compared by
 * julianday rather than as text, because rows written by different paths carry
 * different offsets (`Z`, `+09:00`) and text ordering would mix them up. A value
 * julianday cannot read is never counted.
 */
const atOrAfter = (column: unknown, instant: string) => sql`julianday(${column}) >= julianday(${instant})`;

const tally = async (query: Promise<{ value: number } | undefined>): Promise<number> => (await query)?.value ?? 0;

/** Every Automation, the next to run first and those with no next run after. */
const automationGlances = async (db: AccountDatabase): Promise<AutomationGlance[]> =>
  (await listAutomations(db))
    .sort((left, right) => (left.nextRunAt ?? '\uffff').localeCompare(right.nextRunAt ?? '\uffff'))
    .map(({ id, name, enabled, schedule, nextRunAt, lastRun }) => ({ id, name, enabled, schedule, nextRunAt, lastRun }));

/** How many of an Account's Automations' runs failed in the last day. */
const RECENT_FAILURES_MS = DAY_MS;

/**
 * Each condition that leaves something undelivered or undone until the Account
 * acts. Conditions with nothing in them are left out.
 */
const attentionOf = async (db: AccountDatabase, at: string): Promise<Attention[]> => {
  const since = new Date(Date.parse(at) - RECENT_FAILURES_MS).toISOString();
  const [approvals, latestApproval, open, latestException, revoked, ai, unlinked, stuck, warnings, failedRuns, latestFailure] = await Promise.all([
    tally(db.select({ value: count() }).from(runs).where(eq(runs.status, 'pending_approval')).get()),
    db.select({ automation: automations.name }).from(runs)
      .leftJoin(automations, eq(automations.id, runs.automationId))
      .where(eq(runs.status, 'pending_approval')).orderBy(desc(runs.startedAt)).limit(1).get(),
    tally(db.select({ value: count() }).from(exceptions).where(eq(exceptions.state, 'open')).get()),
    db.select({ message: exceptions.message }).from(exceptions).where(eq(exceptions.state, 'open')).orderBy(desc(exceptions.createdAt)).limit(1).get(),
    db.select({ address: googleConnections.inboxAddress }).from(googleConnections).where(eq(googleConnections.status, 'reauthentication_required')).all(),
    activeConnection(db, 'ai'),
    db.select({ name: lineDestinations.displayName, destinationId: lineDestinations.destinationId }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.status, 'discovered'), isNull(contactLineDestinations.lineDestinationId)))
      .orderBy(asc(lineDestinations.discoveredAt)).all(),
    tally(db.select({ value: count() }).from(jobs).where(eq(jobs.state, 'failed')).get()),
    tally(db.select({ value: count() }).from(automationWarnings).where(atOrAfter(automationWarnings.createdAt, since)).get()),
    tally(db.select({ value: count() }).from(runs).where(and(eq(runs.status, 'failed'), ne(runs.trigger, 'chat'), atOrAfter(runs.startedAt, since))).get()),
    db.select({ automation: automations.name }).from(runs).innerJoin(automations, eq(automations.id, runs.automationId))
      .where(and(eq(runs.status, 'failed'), atOrAfter(runs.startedAt, since))).orderBy(desc(runs.startedAt)).limit(1).get(),
  ]);
  const conditions: Attention[] = [
    { kind: 'reauthentication', count: revoked.length, detail: revoked.map((inbox) => inbox.address).join('、') },
    { kind: 'ai_missing', count: ai ? 0 : 1, detail: '' },
    { kind: 'pending_approval', count: approvals, detail: latestApproval?.automation ?? '' },
    { kind: 'failed_run', count: failedRuns, detail: latestFailure?.automation ?? '' },
    { kind: 'exception', count: open, detail: latestException?.message ?? '' },
    { kind: 'unlinked_line', count: unlinked.length, detail: unlinked.map((handle) => handle.name || handle.destinationId.slice(0, 5)).join('、') },
    { kind: 'stuck_job', count: stuck, detail: '' },
    { kind: 'warning', count: warnings, detail: '' },
  ];
  return conditions.filter((condition) => condition.count > 0);
};

/** The next Scheduled Events, with how their Eligible Recipients have answered. */
const upcomingEvents = async (db: AccountDatabase, at: string): Promise<UpcomingEvent[]> => {
  const ahead = await db.select({
    id: events.id,
    title: events.title,
    startsAt: events.startsAt,
    endsAt: events.endsAt,
    location: events.location,
    responseDeadline: events.attendanceDeadline,
  }).from(events)
    .where(and(eq(events.status, 'scheduled'), atOrAfter(events.endsAt, at)))
    .orderBy(sql`julianday(${events.startsAt})`).limit(UPCOMING_EVENTS).all();
  if (!ahead.length) return [];
  const answers = await db.select({ eventId: attendance.eventId, status: attendance.status, value: count() }).from(attendance)
    .where(inArray(attendance.eventId, ahead.map((event) => event.id)))
    .groupBy(attendance.eventId, attendance.status).all();
  const answered = (eventId: string, status: string): number =>
    answers.find((row) => row.eventId === eventId && row.status === status)?.value ?? 0;
  return ahead.map((event) => ({
    ...event,
    location: event.location ?? '',
    responseDeadline: event.responseDeadline ?? null,
    attending: answered(event.id, 'attending'),
    notAttending: answered(event.id, 'not_attending'),
    unanswered: answered(event.id, 'unanswered'),
  }));
};

/** What Home shows, read at one instant so every part agrees on what is ahead. */
export const readDashboard = async (db: AccountDatabase, at: string): Promise<Dashboard> => {
  const [glances, attention, upcoming] = await Promise.all([
    automationGlances(db),
    attentionOf(db, at),
    upcomingEvents(db, at),
  ]);
  return {
    automations: glances,
    attention,
    upcomingEvents: upcoming,
  };
};
