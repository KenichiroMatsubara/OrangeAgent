/**
 * What an Automation's run is told about the Account it acts for, besides its
 * Skills: whose mailbox it is, which Contacts there are, how the records it
 * reads are identified, and when it last ran. Nothing here says how to judge a
 * mail or whom to tell; that is its Skills'.
 */

import { asc, desc, eq, and, ne } from 'drizzle-orm';

import { activeAutomationInbox } from './inbox';
import { accounts } from './storage/control-schema';
import { contacts, runs } from './storage/account-schema';
import { accountDatabase, controlDatabase } from './storage/database';
import type { Bindings } from './types';

/** One Contact as a run is told about it: who it is, and what the Account says it is. */
export interface ContactDescription {
  id: string;
  name: string;
  description: string;
}

/** Who a run acts for. */
export interface RunAccount {
  name: string;
  /** The Automation Inbox address, which is also where this Account sends its own mail from; null when none is connected. */
  inboxAddress: string | null;
  contacts: ContactDescription[];
}

/** How the records a run reads are identified. */
export const RECORDS_FACTS = [
  'Records:',
  '- A Scheduled Event is identified by its id alone, and a Task by its id and the listId of the Google Tasks list it is in. Find them with query_scheduled_events and tasks.search, and change an existing one by what they returned; a create call always makes another.',
  '- A mail is named by its Gmail message id, as mail.search returns it. Name it as messageId when an event comes from it, when its files are attached, or when it is recorded as an Event Response.',
].join('\n');

/** States who the run works for: the Account's own mailbox, so a mail it sent can be told apart, and its active Contacts. */
export const accountFacts = (account: RunAccount): string => {
  const listed = account.contacts.length
    ? account.contacts.map((contact) => `- ${contact.id}: ${contact.name}${contact.description ? ` — ${contact.description}` : ''}`).join('\n')
    : '- (none)';
  return [
    account.inboxAddress
      ? `You act for the Account ${JSON.stringify(account.name)}. Its own mailbox is ${account.inboxAddress}; a mail sent from that address was written by this Account.`
      : `You act for the Account ${JSON.stringify(account.name)}. It has no mailbox connected.`,
    'Its active Contacts, by contactId:',
    listed,
  ].join('\n');
};

/** The Account a run acts for, read now. */
export const runAccount = async (env: Bindings, input: { database: D1Database; accountId: string }): Promise<RunAccount> => {
  const [named, inbox, active] = await Promise.all([
    controlDatabase(env.CONTROL_DB).select({ name: accounts.name }).from(accounts).where(eq(accounts.id, input.accountId)).get(),
    activeAutomationInbox(input.database).catch(() => null),
    accountDatabase(input.database).select({ id: contacts.id, name: contacts.name, description: contacts.description })
      .from(contacts).where(eq(contacts.state, 'active')).orderBy(asc(contacts.name)).all(),
  ]);
  return { name: named?.name ?? input.accountId, inboxAddress: inbox?.inboxAddress ?? null, contacts: active };
};

/** When this Automation's latest run that did not fail began, or null when none has. */
export const previousRunAt = async (database: D1Database, automationId: string): Promise<string | null> =>
  (await accountDatabase(database).select({ startedAt: runs.startedAt }).from(runs)
    .where(and(eq(runs.automationId, automationId), ne(runs.status, 'failed')))
    .orderBy(desc(runs.startedAt)).limit(1).get())?.startedAt ?? null;

const tokyo = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * What a run is asked when its Trigger Time arrives: to run now, with when it
 * is and when this Automation last ran, so a Skill can ask for what arrived
 * since without the run remembering anything.
 */
export const timedRequest = (input: { at: Date; previous: string | null }): string => [
  `Run now. It is ${input.at.toISOString()} (${tokyo.format(input.at)} Asia/Tokyo).`,
  input.previous
    ? `This Automation last ran at ${input.previous} (${tokyo.format(new Date(input.previous))} Asia/Tokyo); mail that arrived since then is found with the mail.search query after:${Math.floor(Date.parse(input.previous) / 1_000)}.`
    : 'This Automation has not run before.',
  'You remember nothing from previous runs; use your tools to find whatever you need.',
].join('\n');
