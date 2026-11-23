/**
 * The one way every run reaches a person with a message: on a Channel, at a
 * stated time, or by email. Each send is read the same way however the run
 * applies it, and performed by the same function whether it is called now or
 * applied later as a Planned Write, and it is sent when it is performed.
 */

import { isChannelName, sendOnChannel, sendOnDestination, type ChannelCredentials, type ChannelFetch, type ChannelName } from './channel';
import { GoogleApiError, type GoogleProvider, type MailFile } from './providers';
import { scheduleReminder } from './reminders';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** What one channel.send call asks for: one text to one Contact, or to one Channel destination itself. */
export interface ChannelSendCall {
  channel: ChannelName;
  text: string;
  contactId: string | null;
  destination: string | null;
}

/** Reads a channel.send call, refusing with a reason the model can correct. */
export const channelSendCall = (input: Record<string, unknown>): ChannelSendCall => {
  const channel = text(input.channel) || 'line';
  if (!isChannelName(channel)) throw new Error(`channel.send cannot reach anyone on ${channel}; name line or discord.`);
  const body = typeof input.text === 'string' ? input.text : '';
  if (!body.trim()) throw new Error('channel.send requires a text.');
  const contactId = text(input.contactId) || null;
  const destination = text(input.destination) || null;
  if (!contactId === !destination) throw new Error('channel.send names exactly one of a contactId or a destination.');
  return { channel, text: body, contactId, destination };
};

/** What one mail.send or mail.draft call asks for. */
export interface MailSendCall {
  to: string;
  subject: string;
  body: string;
  /** The names of files Claude wrote in the conversation, attached to the mail; absent when it carries none. */
  files?: string[];
}

/** Reads a mail.send or mail.draft call, refusing with a reason the model can correct. */
export const mailSendCall = (input: Record<string, unknown>, name: 'mail.send' | 'mail.draft' = 'mail.send'): MailSendCall => {
  const to = text(input.to);
  const subject = text(input.subject);
  const body = typeof input.body === 'string' ? input.body : '';
  if (!/^[^\s@,;]+@[^\s@,;]+$/u.test(to)) throw new Error(`${to || 'An empty address'} is not one email address.`);
  if (!subject || !body.trim()) throw new Error(`${name} requires a subject and a body.`);
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.some((file) => typeof file !== 'string'))) {
    throw new Error(`${name} files must be a list of filenames.`);
  }
  const files = [...new Set((input.files as string[] | undefined ?? []).map((file) => file.trim().split('/').at(-1) ?? '').filter(Boolean))];
  return { to, subject, body, ...(files.length ? { files } : {}) };
};

/** What one reminder.schedule call asks for. */
export interface ReminderCall {
  contactId: string;
  channel: ChannelName;
  text: string;
  /** An ISO instant. */
  at: string;
}

/** Reads a reminder.schedule call, refusing with a reason the model can correct. */
export const reminderCall = (input: Record<string, unknown>): ReminderCall => {
  const contactId = text(input.contactId);
  if (!contactId) throw new Error('reminder.schedule requires a contactId.');
  const channel = text(input.channel) || 'line';
  if (!isChannelName(channel)) throw new Error(`reminder.schedule cannot reach anyone on ${channel}; name line or discord.`);
  const body = typeof input.text === 'string' ? input.text : '';
  if (!body.trim()) throw new Error('reminder.schedule requires a text.');
  const at = text(input.at);
  const when = Date.parse(at);
  if (Number.isNaN(when)) throw new Error(`${at || 'An empty time'} is not an instant this server can read.`);
  return { contactId, channel, text: body, at: new Date(when).toISOString() };
};

/**
 * One send a run makes. A send that names a retry key is one its caller tries
 * again under the same key when the Channel fails temporarily, and is told so
 * by the `TemporaryFailure` it throws.
 */
interface PortSend {
  channel: string;
  text: string;
  sourceMessageId?: string | null;
  retryKey?: string;
}

/** How a run reaches a Channel. */
export interface ChannelPorts {
  sendToContact(input: PortSend & { contactId: string }): Promise<unknown>;
  sendToDestination(input: PortSend & { destination: string }): Promise<unknown>;
}

/** The Channel seam a run sends through, with the Account's credentials. */
export const channelPorts = (input: { database: D1Database; credentials: ChannelCredentials; fetch?: ChannelFetch }): ChannelPorts => ({
  sendToContact: async ({ contactId, channel, text: body, sourceMessageId, retryKey }) => {
    const delivery = await sendOnChannel({ ...input, contactId, channel, texts: [body], sourceMessageId: sourceMessageId ?? null, ...(retryKey ? { retryKey } : {}) });
    return { delivered: delivery.delivered, channel: delivery.channel, contactId: delivery.contactId };
  },
  sendToDestination: async ({ destination, channel, text: body, sourceMessageId, retryKey }) => {
    const outcome = await sendOnDestination({ ...input, channel, destination, texts: [body], sourceMessageId: sourceMessageId ?? null, ...(retryKey ? { retryKey } : {}) });
    if (!outcome.delivered) throw retryKey && outcome.temporary ? outcome.temporary : new Error(outcome.error ?? `${channel} refused the message.`);
    return { delivered: true, channel: outcome.channel, destination };
  },
});

/** What a send needs of the run it belongs to. */
export interface SendContext {
  database: D1Database;
  ports?: ChannelPorts;
  google?: GoogleProvider;
  accessToken?: () => Promise<string>;
}

/**
 * Sends one channel.send call. A Planned Write names itself as the retry key,
 * so the same write applied again is delivered once.
 */
export const sendChannelMessage = async (context: SendContext, call: ChannelSendCall, retryKey?: string): Promise<unknown> => {
  if (!context.ports) throw new Error('This run cannot reach a Channel.');
  const send = { channel: call.channel, text: call.text, ...(retryKey ? { retryKey } : {}) };
  return call.contactId
    ? context.ports.sendToContact({ ...send, contactId: call.contactId })
    : context.ports.sendToDestination({ ...send, destination: call.destination! });
};

/** Sends one mail.send call through the Automation Inbox. */
export const sendMail = async (context: SendContext, call: MailSendCall, files: readonly MailFile[] = []): Promise<unknown> => {
  if (!context.google || !context.accessToken) throw new Error('This run holds no mailbox to send from.');
  const sent = await context.google.gmail.sendMail(await context.accessToken(), {
    destination: call.to, subject: call.subject, body: call.body, ...(files.length ? { files } : {}),
  });
  return { sent: true, to: call.to, id: sent.id, ...(files.length ? { attached: files.map((file) => file.filename) } : {}) };
};

/**
 * Saves one mail.draft call as a Gmail draft, sent by nobody. A grant given
 * before drafts existed lacks the whole-mailbox scope, so Google refuses it as holding
 * insufficient scopes until the Inbox is reconnected; that is told to the run
 * rather than thrown.
 */
export const draftMail = async (context: SendContext, call: MailSendCall, files: readonly MailFile[] = []): Promise<unknown> => {
  if (!context.google || !context.accessToken) throw new Error('This run holds no mailbox to save a draft in.');
  try {
    const draft = await context.google.gmail.createDraft(await context.accessToken(), {
      destination: call.to, subject: call.subject, body: call.body, ...(files.length ? { files } : {}),
    });
    return { drafted: true, sent: false, to: call.to, id: draft.id, ...(files.length ? { attached: files.map((file) => file.filename) } : {}) };
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 403 || !/scope/iu.test(error.message)) throw error;
    return {
      isError: true,
      message: 'Google has not granted FlareChat permission to save drafts in this mailbox. The administrator reconnects the mail inbox on the 接続 (Connections) screen to grant it; nothing was saved or sent.',
    };
  }
};

/** Schedules one reminder.schedule call as its own Job, which arrives at its stated time whatever run asked for it. */
export const scheduleReminderCall = async (context: Pick<SendContext, 'database'>, call: ReminderCall, at: Date): Promise<unknown> => {
  if (Date.parse(call.at) <= at.getTime()) return { isError: true, message: `${call.at} has already passed; a reminder is not a way to send now.` };
  return scheduleReminder(context.database, { contactId: call.contactId, channel: call.channel, text: call.text, at: call.at });
};
