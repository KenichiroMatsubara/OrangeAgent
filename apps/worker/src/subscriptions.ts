/**
 * The browsers each member turned Operator Chat's notifications on in
 * (migration 0062), and the notifications each answer has sent, so none is
 * sent twice. A browser is one push address: handed to another member, it is
 * theirs from then on.
 */

import { and, eq, inArray } from 'drizzle-orm';

import { accountDatabase } from './storage/database';
import { chatNotices, chatThreads, pushSubscriptions } from './storage/account-schema';
import type { PushTarget } from './push';

/** What a conversation's answer notifies about: a call waiting for approval, a question, the answer done, or failed. */
export type NoticeKind = 'approval' | 'question' | 'completed' | 'failed';

/** A browser to notify, and whose it is. */
export interface Subscription extends PushTarget {
  identityId: string;
}

/** Keeps a browser's subscription for the member, replacing whatever the same push address held. */
export const saveSubscription = async (input: {
  database: D1Database;
  identityId: string;
  target: PushTarget;
  label: string;
  timestamp: string;
}): Promise<void> => {
  const values = { identityId: input.identityId, p256dh: input.target.p256dh, auth: input.target.auth, label: input.label };
  await accountDatabase(input.database).insert(pushSubscriptions)
    .values({ id: crypto.randomUUID(), endpoint: input.target.endpoint, createdAt: input.timestamp, ...values })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values }).run();
};

/** Stops notifying the member's browser at `endpoint`; another member's browser is left as it is. */
export const removeSubscription = async (input: { database: D1Database; identityId: string; endpoint: string }): Promise<void> => {
  await accountDatabase(input.database).delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, input.endpoint), eq(pushSubscriptions.identityId, input.identityId))).run();
};

/** Forgets a push address its push service no longer knows, whoever it was for. */
export const forgetEndpoint = async (database: D1Database, endpoint: string): Promise<void> => {
  await accountDatabase(database).delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
};

/** Every browser of these members. */
export const subscriptionsOf = async (database: D1Database, identityIds: readonly string[]): Promise<Subscription[]> => {
  if (!identityIds.length) return [];
  return accountDatabase(database).select({
    identityId: pushSubscriptions.identityId, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth,
  }).from(pushSubscriptions).where(inArray(pushSubscriptions.identityId, [...identityIds])).all();
};

/** The member who started the conversation, or null for one nobody is named as starting. */
export const threadStarter = async (database: D1Database, threadId: string): Promise<string | null> =>
  (await accountDatabase(database).select({ identityId: chatThreads.createdByIdentity }).from(chatThreads).where(eq(chatThreads.id, threadId)).get())?.identityId ?? null;

/**
 * Records that the answer sent a notification of this kind; false when it
 * already had, so each answer sends at most one of each kind, whichever
 * object of the conversation sends it.
 */
export const claimNotice = async (input: { database: D1Database; threadId: string; runId: string; kind: NoticeKind; timestamp: string }): Promise<boolean> => {
  const result = await accountDatabase(input.database).insert(chatNotices)
    .values({ threadId: input.threadId, runId: input.runId, kind: input.kind, createdAt: input.timestamp })
    .onConflictDoNothing().run();
  return result.meta.changes > 0;
};
