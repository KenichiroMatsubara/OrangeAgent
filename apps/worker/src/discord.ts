/**
 * The Discord Channel.
 *
 * Workers cannot hold the persistent Gateway connection a Discord bot normally
 * reads messages on, so this Channel is reached through the Interactions
 * endpoint: an Account's people invoke a command or press a control, and that
 * arrives here signed. It is narrower than reading every message, and it is the
 * part that carries the structured reply controls every Channel must offer.
 */

import { called, retryAfterSeconds, temporaryAnswer } from './temporary';

const DISCORD_API = 'https://discord.com/api/v10';

export type DiscordFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string | null;
}

export interface DiscordInteraction {
  type: number;
  channel_id?: string;
  guild_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: { name?: string; custom_id?: string; options?: Array<{ name?: string; value?: unknown }> };
}

export interface DiscordHandle {
  externalId: string;
  kind: 'single' | 'shared';
  displayName: string;
  channelId: string;
}

const hexToBytes = (value: string): Uint8Array | null => {
  if (!/^[0-9a-f]*$/iu.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/**
 * Verifies that Discord signed this request. A signature that cannot even be
 * read is refused rather than raised, so an inbound endpoint answers a malformed
 * request the same way it answers a forged one.
 */
export const verifyDiscordSignature = async (input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  body: string;
}): Promise<boolean> => {
  const publicKey = hexToBytes(input.publicKey);
  const signature = hexToBytes(input.signature);
  if (!publicKey || !signature || publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', publicKey.buffer as ArrayBuffer, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature.buffer as ArrayBuffer,
      new TextEncoder().encode(input.timestamp + input.body).buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
};

/** Discord checks a new endpoint with a ping it expects echoed; everything else gets a visible reply. */
export const discordReply = (interaction: DiscordInteraction, content?: string): Record<string, unknown> =>
  interaction.type === 1 ? { type: 1 } : { type: 4, data: { content: content ?? '受け付けました。' } };

/** The Channel Handle an interaction reveals, or null when it names no user. */
export const discordHandleFromInteraction = (interaction: DiscordInteraction): DiscordHandle | null => {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id || !interaction.channel_id) return null;
  return {
    externalId: user.id,
    kind: 'single',
    displayName: user.global_name ?? user.username ?? user.id,
    channelId: interaction.channel_id,
  };
};

/** The seconds Discord asks a rate-limited bot to wait: its Retry-After header, or the `retry_after` its 429 body names. */
const discordRetryAfter = async (response: Response): Promise<number | null> => {
  const header = retryAfterSeconds(response.headers.get('Retry-After'));
  if (header !== null || response.status !== 429) return header;
  const body = await response.clone().json().catch(() => ({})) as { retry_after?: unknown };
  return typeof body.retry_after === 'number' && Number.isFinite(body.retry_after) ? Math.ceil(body.retry_after) : null;
};

/**
 * Posts one message to one Discord channel. A message that names a nonce is
 * one its caller may post again: Discord enforces it, so a repeat within its
 * window of a few minutes answers with the message it already created instead
 * of a second one. A 429 or 5xx, or no answer, throws as a `TemporaryFailure`.
 */
export const sendDiscordMessage = async (input: {
  fetch: DiscordFetch;
  botToken: string;
  channelId: string;
  text: string;
  nonce?: string;
}): Promise<{ delivered: true; externalId: string | null }> => {
  const response = await called('Discord', () => input.fetch(`${DISCORD_API}/channels/${encodeURIComponent(input.channelId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${input.botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: input.text, ...(input.nonce ? { nonce: input.nonce, enforce_nonce: true } : {}) }),
  }));
  if (!response.ok) {
    const temporary = temporaryAnswer('Discord', response, await discordRetryAfter(response));
    if (temporary) throw temporary;
    throw new Error(`Discord refused the message with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json() as { id?: string };
  return { delivered: true, externalId: body.id ?? null };
};
