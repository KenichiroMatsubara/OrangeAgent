/**
 * Reaching a Contact, or an address, on a Channel.
 *
 * Every surface that speaks to a Contact — the MCP Server an outside agent
 * calls, a scheduled reminder, an Automation run, and the Channel Test an
 * operator runs by hand — passes through here, so none of them can reach LINE by
 * a path the others do not. What a caller states is who, on which Channel, and
 * what to say; resolving the Connection, the handle, how many provider requests
 * that takes, and the Delivery Records is this module's work, and a refusal is
 * reported as the failure it was rather than a synthesised success.
 *
 * Authorization stays outside. Who may be reached is decided by the Access
 * Token's Contact List, an Automation's Contact List, or an authenticated
 * operator's session before anything here is called;
 * this module refuses only what the Channel itself refuses.
 */

import { and, asc, eq, inArray, or } from 'drizzle-orm';

import { decrypt } from './cryptography';
import { conflict, invalid } from './refusal';
import { recordDeliveryAttempt, type DeliveryAttempt } from './delivery';
import { sendDiscordMessage } from './discord';
import { called, repeatDigest, repeatUuid, temporaryAnswer, TemporaryFailure } from './temporary';
import { accountDatabase, contains } from './storage/database';
import {
  channelHandles,
  connections,
  contactLineDestinations,
  contacts,
  lineDestinations,
} from './storage/account-schema';

/** The Channels the product itself carries. A Contact is reachable on those it holds a handle for. */
export const CHANNELS = ['line', 'discord'] as const;
export type ChannelName = (typeof CHANNELS)[number];

export const isChannelName = (value: string): value is ChannelName =>
  (CHANNELS as readonly string[]).includes(value);

/** The Account's Channel credentials, absent where the Account has no Connection. */
export interface ChannelCredentials {
  line: string | null;
  discord: string | null;
}

/** One Contact and the Channels it can actually be reached on. */
export interface ContactReach {
  id: string;
  name: string;
  email: string;
  state: string;
  channels: ChannelName[];
}

/** How many messages one provider request may carry to one LINE destination. */
export const LINE_BATCH_LIMIT = 5;

/**
 * What one address received, or did not.
 *
 * `messages` is what was meant to arrive and `requests` is how many provider
 * calls carried them, so a caller can see the batching happen rather than
 * trust that it did.
 */
export interface ChannelOutcome {
  channel: ChannelName;
  destination: string;
  delivered: boolean;
  messages: number;
  requests: number;
  externalId: string | null;
  error: string | null;
  /**
   * Why it was not delivered when the Channel may deliver it later, so a
   * caller that tries again knows when it may; null when it was delivered, or
   * refused for good.
   */
  temporary: TemporaryFailure | null;
}

/** What one Contact received. A refusal throws rather than returning this. */
export interface ChannelDelivery {
  delivered: true;
  channel: ChannelName;
  contactId: string;
  destination: string;
  messages: number;
  requests: number;
  externalId: string | null;
}

export type ChannelFetch = (url: string, init: RequestInit) => Promise<Response>;

interface StoredCredential {
  channelAccessToken?: string;
  botToken?: string;
}

const connectionContext = (accountId: string, kind: 'line' | 'discord'): string =>
  `organization-connection:${accountId}:${kind}`;

const storedCredential = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
  kind: 'line' | 'discord';
}): Promise<StoredCredential | null> => {
  const row = await accountDatabase(input.database).select().from(connections)
    .where(and(eq(connections.kind, input.kind), eq(connections.status, 'active'))).limit(1).get();
  if (!row) return null;
  return JSON.parse(
    await decrypt(JSON.parse(row.credential), input.accountKey, connectionContext(input.accountId, input.kind)),
  ) as StoredCredential;
};

/**
 * The credentials this Account can reach its Channels with.
 *
 * Read once per run rather than per message, because a caller that resolves them
 * itself is a caller that can resolve them differently.
 */
export const channelCredentials = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
}): Promise<ChannelCredentials> => {
  const [line, discord] = await Promise.all([
    storedCredential({ ...input, kind: 'line' }),
    storedCredential({ ...input, kind: 'discord' }),
  ]);
  return {
    line: line?.channelAccessToken ?? null,
    discord: discord?.botToken ?? null,
  };
};

/** The LINE destination a Contact is reachable at, or null when it holds none. */
const lineDestinationFor = async (database: D1Database, contactId: string): Promise<string | null> => {
  const row = await accountDatabase(database).select({ destinationId: lineDestinations.destinationId })
    .from(contactLineDestinations)
    .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .where(eq(contactLineDestinations.contactId, contactId))
    .get();
  return row?.destinationId ?? null;
};

/** The Discord channel a Contact is reachable in, or null when it holds no handle. */
const discordTargetFor = async (database: D1Database, contactId: string): Promise<string | null> => {
  const row = await accountDatabase(database).select({ replyTarget: channelHandles.replyTarget })
    .from(channelHandles)
    .where(and(
      eq(channelHandles.contactId, contactId),
      eq(channelHandles.channel, 'discord'),
      eq(channelHandles.isPrimary, true),
    ))
    .get();
  return row?.replyTarget ?? null;
};

/** The address a Contact is reachable at on one Channel, or null when it holds no handle there. */
export const contactDestination = async (input: {
  database: D1Database;
  contactId: string;
  channel: ChannelName;
}): Promise<string | null> => input.channel === 'line'
  ? lineDestinationFor(input.database, input.contactId)
  : discordTargetFor(input.database, input.contactId);

/** Where one Contact can be reached, so a caller never has to guess a Channel. */
export const contactChannels = async (input: {
  database: D1Database;
  contactId: string;
}): Promise<ChannelName[]> => {
  const reachable = await Promise.all(CHANNELS.map(async (channel) =>
    await contactDestination({ ...input, channel }) ? channel : null));
  return reachable.filter((channel): channel is ChannelName => channel !== null);
};

/**
 * The Contacts a caller may reach and the Channels each is reachable on.
 *
 * `contactIds` bounds the answer to a Contact List; an explicit empty list
 * reaches nobody, and omitting it means the whole Account, which only a surface
 * an operator authenticated on may ask for.
 */
export const reachableContacts = async (input: {
  database: D1Database;
  query?: string;
  contactIds?: readonly string[];
}): Promise<ContactReach[]> => {
  if (input.contactIds && !input.contactIds.length) return [];
  const rows = await accountDatabase(input.database).select({
    id: contacts.id,
    name: contacts.name,
    email: contacts.email,
    state: contacts.state,
  }).from(contacts)
    .where(and(
      input.contactIds ? inArray(contacts.id, [...input.contactIds]) : undefined,
      input.query ? or(contains(contacts.name, input.query), contains(contacts.email, input.query)) : undefined,
    ))
    .orderBy(asc(contacts.name)).all();
  return Promise.all(rows.map(async (row) => ({
    ...row,
    channels: await contactChannels({ database: input.database, contactId: row.id }),
  })));
};

const batched = <T>(values: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
};

const stated = (texts: readonly string[]): string[] => {
  const said = texts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (!said.length) throw new Error('A message needs something to say.');
  return said;
};

/**
 * What one Delivery Record names besides its address. A send records one per
 * intended message unless its caller states the records itself, as a Morning
 * Notice does for the Morning Entries its texts carry.
 */
export interface DeliveryRecordTarget {
  eventId?: string | null;
  sourceMessageId?: string | null;
}

const recordTargets = (input: {
  texts: number;
  records?: readonly DeliveryRecordTarget[] | undefined;
  eventId?: string | null | undefined;
  sourceMessageId?: string | null | undefined;
}): DeliveryRecordTarget[] => input.records ? [...input.records] : Array.from({ length: input.texts }, () => ({
  ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
  ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
}));

const recordAll = (
  database: D1Database,
  targets: readonly DeliveryRecordTarget[],
  attempt: { channel: ChannelName; destination: string; outcome: DeliveryAttempt['outcome']; externalId: string | null },
): Promise<DeliveryAttempt[]> => Promise.all(targets.map((target) => recordDeliveryAttempt(database, {
  ...(target.eventId === undefined ? {} : { eventId: target.eventId }),
  ...(target.sourceMessageId === undefined ? {} : { sourceMessageId: target.sourceMessageId }),
  ...attempt,
})));

const failedAt = async (input: {
  database: D1Database;
  channel: ChannelName;
  destination: string;
  messages: number;
  requests: number;
  error: string;
  targets: readonly DeliveryRecordTarget[];
  temporary?: TemporaryFailure | null;
}): Promise<ChannelOutcome> => {
  await recordAll(input.database, input.targets, {
    channel: input.channel, destination: input.destination, outcome: 'failed', externalId: null,
  });
  return {
    channel: input.channel,
    destination: input.destination,
    delivered: false,
    messages: input.messages,
    requests: input.requests,
    externalId: null,
    error: input.error,
    temporary: input.temporary ?? null,
  };
};

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/** What one LINE push did, before anything is recorded about it. */
interface LinePush {
  outcome: DeliveryAttempt['outcome'];
  externalId: string | null;
  /** Why it failed when LINE may take it later; null when it succeeded or was refused for good. */
  temporary: TemporaryFailure | null;
}

/**
 * Speaks the LINE Messaging API once: one push of at most five message objects.
 *
 * A push that names a retry key is one its caller tries again under the same
 * key, and LINE delivers a key once: a repeat of a push it already accepted is
 * answered 409 with the id of the request that delivered it, which is that
 * push's success rather than a refusal.
 */
const pushLineBatch = async (input: {
  request: ChannelFetch;
  accessToken: string;
  destinationId: string;
  messages: string[];
  retryKey: string | null;
}): Promise<LinePush> => {
  if (!input.messages.length || input.messages.length > LINE_BATCH_LIMIT) throw new Error('A LINE batch must contain between one and five messages.');
  try {
    const response = await called('LINE', () => input.request(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        ...(input.retryKey ? { 'X-Line-Retry-Key': input.retryKey } : {}),
      },
      body: JSON.stringify({ to: input.destinationId, messages: input.messages.map((text) => ({ type: 'text', text })) }),
    }));
    if (response.ok) return { outcome: 'succeeded', externalId: response.headers.get('x-line-request-id'), temporary: null };
    if (input.retryKey && response.status === 409 && response.headers.has('x-line-accepted-request-id')) {
      return { outcome: 'succeeded', externalId: response.headers.get('x-line-accepted-request-id'), temporary: null };
    }
    return { outcome: 'failed', externalId: null, temporary: temporaryAnswer('LINE', response) };
  } catch (error) {
    // The failed intended messages still receive their retryable records from the caller.
    return { outcome: 'failed', externalId: null, temporary: error instanceof TemporaryFailure ? error : null };
  }
};

/**
 * Sends to one address on one Channel, batching what the provider lets us batch.
 *
 * LINE carries up to five message objects in one push, so five messages for one
 * destination cost one request rather than five, and a longer run is split into
 * as few requests as the limit allows. Discord has no such call, so it is one
 * request per message and the difference stays here rather than in every caller.
 *
 * A provider refusal is returned as `delivered: false` with its reason and
 * leaves a failed Delivery Record per intended message, because a broadcast must
 * not lose the rest of its addresses to one refusal. Only a caller error — an
 * unknown Channel, nothing to say — throws.
 *
 * A send that names a retry key is one its caller will try again when it fails
 * temporarily, so each provider request it makes carries a key derived from it
 * — LINE's `X-Line-Retry-Key`, Discord's enforced nonce — and the same send
 * tried again is delivered once.
 */
export const sendOnDestination = async (input: {
  database: D1Database;
  credentials: ChannelCredentials;
  channel: string;
  destination: string;
  texts: readonly string[];
  eventId?: string | null;
  sourceMessageId?: string | null;
  /**
   * The Delivery Records this send leaves, each with the send's one outcome, in
   * place of one per text. A Morning Notice states one per Morning Entry.
   */
  records?: readonly DeliveryRecordTarget[];
  /** Names this send the same way each time its caller tries it again. */
  retryKey?: string;
  fetch?: ChannelFetch;
}): Promise<ChannelOutcome> => {
  if (!isChannelName(input.channel)) throw new Error(`This product does not reach an address on ${input.channel} yet.`);
  const channel = input.channel;
  const texts = stated(input.texts);
  const perText = !input.records;
  const targets = recordTargets({ texts: texts.length, records: input.records, eventId: input.eventId, sourceMessageId: input.sourceMessageId });
  const credential = input.credentials[channel];
  if (!credential) {
    return failedAt({
      database: input.database,
      channel,
      destination: input.destination,
      messages: texts.length,
      requests: 0,
      error: `This Account has no ${channel === 'line' ? 'LINE' : 'Discord'} Connection to send through.`,
      targets,
    });
  }
  const request = input.fetch ?? ((url, init) => fetch(url, init));

  if (channel === 'line') {
    const batches = batched(texts, LINE_BATCH_LIMIT);
    const pushes = await Promise.all(batches.map(async (messages, index) => pushLineBatch({
      request,
      accessToken: credential,
      destinationId: input.destination,
      messages,
      retryKey: input.retryKey ? await repeatUuid(`${input.retryKey}:line:${input.destination}:${index}`) : null,
    })));
    const delivered = pushes.every((push) => push.outcome === 'succeeded');
    const failed = pushes.filter((push) => push.outcome !== 'succeeded');
    // Trying again can deliver the rest only when every push that failed failed temporarily.
    const temporary = failed.length && failed.every((push) => push.temporary) ? failed[0]!.temporary : null;
    const externalId = pushes.find((push) => push.externalId)?.externalId ?? null;
    if (perText) {
      // One record per intended message, carrying the outcome of the push that carried it.
      await Promise.all(batches.map((messages, index) => recordAll(
        input.database, targets.slice(index * LINE_BATCH_LIMIT, index * LINE_BATCH_LIMIT + messages.length),
        { channel, destination: input.destination, outcome: pushes[index]!.outcome, externalId: pushes[index]!.externalId },
      )));
    } else {
      await recordAll(input.database, targets, {
        channel, destination: input.destination, outcome: delivered ? 'succeeded' : 'failed', externalId: delivered ? externalId : null,
      });
    }
    return {
      channel,
      destination: input.destination,
      delivered,
      messages: texts.length,
      requests: batches.length,
      externalId,
      error: delivered ? null : temporary?.message ?? 'LINE refused the message.',
      temporary,
    };
  }

  let externalId: string | null = null;
  for (const [index, text] of texts.entries()) {
    try {
      const nonce = input.retryKey ? (await repeatDigest(`${input.retryKey}:discord:${input.destination}:${index}`)).slice(0, 25) : null;
      const sent = await sendDiscordMessage({ fetch: request, botToken: credential, channelId: input.destination, text, ...(nonce ? { nonce } : {}) });
      externalId = externalId ?? sent.externalId;
      if (perText) {
        await recordAll(input.database, [targets[index]!], {
          channel, destination: input.destination, outcome: 'succeeded', externalId: sent.externalId,
        });
      }
    } catch (error) {
      const failure = await failedAt({
        database: input.database,
        channel,
        destination: input.destination,
        messages: texts.length - index,
        requests: index,
        error: error instanceof Error ? error.message : 'Discord refused the message.',
        targets: perText ? targets.slice(index) : targets,
        temporary: error instanceof TemporaryFailure ? error : null,
      });
      return { ...failure, messages: texts.length, externalId };
    }
  }
  if (!perText) {
    await recordAll(input.database, targets, { channel, destination: input.destination, outcome: 'succeeded', externalId });
  }
  return {
    channel,
    destination: input.destination,
    delivered: true,
    messages: texts.length,
    requests: texts.length,
    externalId,
    error: null,
    temporary: null,
  };
};

/**
 * Sends the same messages to several addresses, each address once.
 *
 * Two Contacts sharing one group destination, or a Channel Handle List naming
 * the same room twice, must not make the same message arrive twice; deduplicating
 * here means no caller has to remember to.
 */
export const sendToDestinations = async (input: {
  database: D1Database;
  credentials: ChannelCredentials;
  channel: string;
  destinations: readonly string[];
  texts: readonly string[];
  eventId?: string | null;
  sourceMessageId?: string | null;
  fetch?: ChannelFetch;
}): Promise<ChannelOutcome[]> => Promise.all(
  [...new Set(input.destinations)].map((destination) => sendOnDestination({ ...input, destination })),
);

/**
 * Sends to one Contact on one Channel, and leaves a Delivery Record either way.
 *
 * A refusal throws, because the surfaces that reach a single Contact — the MCP
 * Server, a scheduled reminder, a Channel Test — each have to report the failure
 * to whoever asked rather than absorb it. A send that names a retry key throws a
 * temporary failure as the `TemporaryFailure` it was, so its caller can try it
 * again under the same key.
 *
 * Suppression is not consulted here: what a repeat means differs between an
 * Access Token, an Automation and a Channel Test, so the caller that knows the
 * scope decides, and this seam only ever performs the send it was given.
 */
export const sendOnChannel = async (input: {
  database: D1Database;
  credentials: ChannelCredentials;
  contactId: string;
  channel: string;
  texts: readonly string[];
  /** The Source Message this send answers, so its Delivery Record names it. */
  sourceMessageId?: string | null;
  /** Names this send the same way each time its caller tries it again. */
  retryKey?: string;
  fetch?: ChannelFetch;
}): Promise<ChannelDelivery> => {
  if (!isChannelName(input.channel)) throw invalid(`This product does not reach a Contact on ${input.channel} yet.`);
  const channel = input.channel;
  const texts = stated(input.texts);
  const destination = await contactDestination({ database: input.database, contactId: input.contactId, channel });
  if (!destination) throw conflict(`Contact ${input.contactId} has no ${channel === 'line' ? 'LINE' : 'Discord'} handle to reach.`);
  const outcome = await sendOnDestination({ ...input, channel, destination, texts });
  if (!outcome.delivered) throw input.retryKey && outcome.temporary ? outcome.temporary : conflict(outcome.error ?? `${channel} refused the message.`);
  return {
    delivered: true,
    channel,
    contactId: input.contactId,
    destination,
    messages: outcome.messages,
    requests: outcome.requests,
    externalId: outcome.externalId,
  };
};
