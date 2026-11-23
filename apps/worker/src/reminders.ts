/**
 * A reminder: one message to one Contact at a stated time, which a run asked
 * for with `reminder.schedule`. It travels as its own Job, so it arrives at
 * its time whatever run scheduled it.
 *
 * The product sends no reminder of its own. Telling a Task's assignee that its
 * deadline nears is an Automation's work, written in its Skill.
 */

import { channelCredentials, isChannelName, sendOnChannel } from './channel';
import type { JobHandler } from './job-dispatch';
import { enqueueJob } from './jobs';
import { accountKeyFor } from './keys';
import type { Providers } from './providers';
import type { Bindings } from './types';

/** The one Job kind every reminder travels as. */
export const REMINDER_JOB_KIND = 'reminder';

export interface ReminderPayload {
  contactId: string;
  channel: string;
  text: string;
}

/** The key a reminder is kept under, so the same reminder asked twice is queued once. */
export const reminderKey = (payload: ReminderPayload, at: string): string =>
  `reminder:scheduled:${payload.contactId}:${at}:${payload.text}`;

/** Records a reminder for a stated time; the Job row is the whole promise. */
export const scheduleReminder = async (
  database: D1Database,
  input: { contactId: string; channel: string; text: string; at: string },
): Promise<{ scheduled: true; at: string; contactId: string }> => {
  if (!isChannelName(input.channel)) throw new Error(`This server does not reach a Contact on ${input.channel} yet.`);
  const payload: ReminderPayload = { contactId: input.contactId, channel: input.channel, text: input.text };
  await enqueueJob(database, {
    kind: REMINDER_JOB_KIND,
    payload: { subject: 'scheduled', ...payload },
    idempotencyKey: reminderKey(payload, input.at),
    availableAt: input.at,
  });
  return { scheduled: true, at: input.at, contactId: input.contactId };
};

/**
 * The reminder a Job carries, or null for one the product queued itself
 * before migration 0042 — a Task or attendance milestone — which is no longer
 * sent.
 */
const readPayload = (payload: Record<string, unknown>): ReminderPayload | null => {
  if (payload.subject === 'task' || payload.subject === 'registration') return null;
  const contactId = typeof payload.contactId === 'string' ? payload.contactId : null;
  if (!contactId || typeof payload.text !== 'string') throw new Error('A scheduled reminder needs a Contact and something to say.');
  return { contactId, channel: typeof payload.channel === 'string' ? payload.channel : '', text: payload.text };
};

/**
 * Delivers one queued reminder through the one Channel seam, exactly as an
 * immediate message goes, under the Job's own key: a Job tried again after a
 * pass that sent it but ended before recording so is the same send to LINE
 * and Discord, which deliver it once.
 */
export const reminderJobHandler = (env: Bindings, providers: Providers): JobHandler => async ({ database, accountId, job, payload }) => {
  const reminder = readPayload(payload);
  if (!reminder) return;
  const accountKey = await accountKeyFor(env, accountId);
  await sendOnChannel({
    database,
    credentials: await channelCredentials({ database, accountKey, accountId }),
    contactId: reminder.contactId,
    channel: reminder.channel,
    texts: [reminder.text],
    retryKey: job.idempotencyKey,
    fetch: providers.fetch,
  });
};
