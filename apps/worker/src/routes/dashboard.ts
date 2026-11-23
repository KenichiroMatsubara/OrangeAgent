import { asc, eq, gte } from 'drizzle-orm';
import type { Dashboard, GuestRegistrationRoster } from '@mail/domain';

import { now } from '../clock';
import { affiliationCounts } from '../guests';
import { readDashboard } from '../home';
import { resource } from '../response';
import { events, guestRegistrations } from '../storage/account-schema';
import { accountRoute } from './account';

export const dashboardRoutes = resource();

/** What Home shows: this morning's intake, what needs the Account, and what is next. */
dashboardRoutes.get('/organizations/:accountId/dashboard', accountRoute(async ({ db }): Promise<Dashboard> => readDashboard(db, now())));

/**
 * The Guest Registrations on each Scheduled Event still ahead. This is the one
 * place the guests' names are shown: the Calendar description an invited Contact
 * reads carries the counts alone.
 */
dashboardRoutes.get('/organizations/:accountId/guest-registrations', accountRoute(async ({ db }): Promise<GuestRegistrationRoster[]> => {
  const rows = await db.select({
    eventId: events.id,
    title: events.title,
    startsAt: events.startsAt,
    name: guestRegistrations.name,
    affiliation: guestRegistrations.affiliation,
    attending: guestRegistrations.attending,
  }).from(guestRegistrations)
    .innerJoin(events, eq(events.id, guestRegistrations.eventId))
    .where(gte(events.endsAt, now()))
    .orderBy(asc(events.startsAt), asc(guestRegistrations.name)).all();
  const byEvent = new Map<string, {
    eventId: string;
    title: string;
    startsAt: string;
    guests: Array<{ name: string; affiliation: string; attending: boolean }>;
  }>();
  for (const row of rows) {
    const entry = byEvent.get(row.eventId) ?? { eventId: row.eventId, title: row.title, startsAt: row.startsAt, guests: [] };
    entry.guests.push({ name: row.name, affiliation: row.affiliation, attending: row.attending });
    byEvent.set(row.eventId, entry);
  }
  return [...byEvent.values()].map((entry) => ({
    ...entry,
    attendingCount: entry.guests.filter((guest) => guest.attending).length,
    affiliations: affiliationCounts(entry.guests),
  }));
}));
