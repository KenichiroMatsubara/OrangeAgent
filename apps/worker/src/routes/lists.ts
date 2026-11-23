import { asc, eq, inArray } from 'drizzle-orm';
import type { ContactList } from '@mail/domain';

import { now } from '../clock';
import { invalid } from '../refusal';
import { resource } from '../response';
import { contactListMembers, contactLists } from '../storage/account-schema';
import { accountRoute } from './account';

/** Contact Lists: the Contacts an Automation or an Access Token may reach. */
export const listRoutes = resource();

listRoutes.get('/organizations/:accountId/contact-lists', accountRoute(async ({ db }): Promise<ContactList[]> => {
  const rows = await db.select().from(contactLists).orderBy(asc(contactLists.name)).all();
  const memberships = rows.length
    ? await db.select().from(contactListMembers).where(inArray(contactListMembers.listId, rows.map(({ id }) => id))).all()
    : [];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    contactIds: memberships.flatMap((entry) => entry.listId === row.id ? [entry.contactId] : []),
  }));
}));

listRoutes.put('/organizations/:accountId/contact-lists/:listId', accountRoute<{ name?: string; description?: string; contactIds?: unknown }>(async ({ db, accountId, body, params }) => {
  const listId = params.listId ?? '';
  const name = body.name?.trim() ?? '';
  if (!name) throw invalid('Contact List 名を入力してください。');
  const contactIds = Array.isArray(body.contactIds) ? body.contactIds.filter((id): id is string => typeof id === 'string') : [];
  const description = body.description?.trim() ?? '';
  const timestamp = now();
  await db.insert(contactLists).values({ id: listId, accountId, name, description, createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoUpdate({ target: contactLists.id, set: { name, description, updatedAt: timestamp } }).run();
  await db.delete(contactListMembers).where(eq(contactListMembers.listId, listId)).run();
  for (const contactId of contactIds) {
    await db.insert(contactListMembers).values({ listId, contactId }).onConflictDoNothing().run();
  }
  return { id: listId, name, contactIds };
}));
