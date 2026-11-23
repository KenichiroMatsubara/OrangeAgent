/**
 * Temporary failures, and the keys that make trying a call again safe.
 *
 * A provider call fails temporarily when the same call may succeed later: the
 * provider answered 408, 429, or a 5xx, said it was over its rate limit, or
 * could not be reached at all. Each adapter that speaks to a provider — LINE,
 * Discord, and Google — throws a `TemporaryFailure` for those and nothing else,
 * so the one caller that tries a write again, Execution, never reads a status
 * or a message to decide whether it may.
 */

/**
 * Whether the provider may have performed the call before it failed: `no` when
 * it answered that it would not (408, 429, 503, a rate limit), `unknown` when
 * the answer was lost or the provider failed partway (a 500, 502, or 504, or
 * no answer at all). A call that carries no key of its own is tried again only
 * when the answer is `no`.
 */
export type Performed = 'no' | 'unknown';

export class TemporaryFailure extends Error {
  constructor(
    message: string,
    /** The HTTP status the provider answered with, or null when it gave no answer. */
    readonly status: number | null,
    /** How long the provider asked to be left alone, in seconds, or null when it named no time. */
    readonly retryAfterSeconds: number | null,
    readonly performed: Performed,
  ) {
    super(message);
    this.name = 'TemporaryFailure';
  }
}

/** The statuses a provider answers when the same call may succeed later. */
export const isTemporaryStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** Whether a provider answering this temporary status had already refused the call rather than failed partway through it. */
const refusedBeforePerforming = (status: number): boolean => status === 408 || status === 429 || status === 503;

/** A Retry-After header, as seconds from now: delta-seconds or an HTTP date. */
export const retryAfterSeconds = (value: string | null, at: number = Date.now()): number | null => {
  const stated = value?.trim();
  if (!stated) return null;
  if (/^\d+$/u.test(stated)) return Number(stated);
  const date = Date.parse(stated);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - at) / 1_000));
};

/** The temporary failure one provider answer was, or null when it was not one. */
export const temporaryAnswer = (provider: string, response: Response, retryAfter: number | null = retryAfterSeconds(response.headers.get('Retry-After'))): TemporaryFailure | null =>
  isTemporaryStatus(response.status)
    ? new TemporaryFailure(`${provider} could not take the request now (HTTP ${response.status}).`, response.status, retryAfter, refusedBeforePerforming(response.status) ? 'no' : 'unknown')
    : null;

/** A rate limit a provider answered with a status that is not itself temporary, such as Google's 403 rateLimitExceeded. */
export const rateLimited = (provider: string, status: number, retryAfter: number | null): TemporaryFailure =>
  new TemporaryFailure(`${provider} is over its rate limit (HTTP ${status}).`, status, retryAfter, 'no');

/** A request that got no answer: the network failed or the connection was lost, so whether it arrived is unknown. */
export const unanswered = (provider: string, error: unknown): TemporaryFailure =>
  new TemporaryFailure(`${provider} did not answer: ${error instanceof Error ? error.message : String(error)}`, null, null, 'unknown');

/** Speaks to a provider once, turning a request that got no answer into the temporary failure it is. */
export const called = async (provider: string, request: () => Promise<Response>): Promise<Response> => {
  try {
    return await request();
  } catch (error) {
    throw unanswered(provider, error);
  }
};

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The RFC 4122 URL namespace, under which a repeat key's name-based UUID is made. */
const URL_NAMESPACE = new Uint8Array([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);

/**
 * The same UUID for the same name, every time (RFC 4122 version 5), so a call
 * tried again names itself as its first attempt did and the provider can tell
 * the repeat from a second call.
 */
export const repeatUuid = async (name: string): Promise<string> => {
  const encoded = new TextEncoder().encode(name);
  const input = new Uint8Array(URL_NAMESPACE.length + encoded.length);
  input.set(URL_NAMESPACE);
  input.set(encoded, URL_NAMESPACE.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const digits = hex(bytes.buffer);
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
};

/** The same lowercase hexadecimal digest for the same name: a key a provider stores in place of a UUID. */
export const repeatDigest = async (name: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)));
