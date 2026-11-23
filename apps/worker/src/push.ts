/**
 * Web Push from the Worker with WebCrypto alone: a message's payload
 * encrypted for one browser's subscription as RFC 8291 says (aes128gcm,
 * RFC 8188), and the request signed for its push service with a VAPID JWT
 * as RFC 8292 says. Nothing here knows what a notification says or whom it
 * is for; `notices.ts` does.
 *
 * The VAPID key pair is the deployment's, kept as the Worker secrets
 * `VAPID_PUBLIC_KEY` (the uncompressed P-256 point, base64url) and
 * `VAPID_PRIVATE_KEY` (its private scalar, base64url), with `VAPID_SUBJECT`,
 * the `mailto:` or `https:` address a push service may write to. Without all
 * three, push is unavailable.
 */

import { fromBase64Url, toBase64Url } from './encoding';
import type { Bindings } from './types';

/** The deployment's VAPID key pair and the address push services may reach it at. */
export interface Vapid {
  /** The uncompressed P-256 public key, base64url, which browsers subscribe with. */
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** What one browser handed over when it subscribed: where to send, and the keys its messages are encrypted for. */
export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** Its 16-byte authentication secret, base64url. */
  auth: string;
}

/** How a push service answered one message. */
export type PushResult = 'sent' | 'gone' | 'failed';

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', namedCurve: 'P-256' } as const;
/** The record size the one record of a message is declared with; any size above the record works. */
const RECORD_SIZE = 4096;
/** How long a VAPID JWT is good for; RFC 8292 allows at most 24 hours. */
const JWT_SECONDS = 12 * 60 * 60;

const text = new TextEncoder();

/** Bytes WebCrypto takes: never a view of shared memory. */
type Bytes = Uint8Array<ArrayBuffer>;

const decoded = (value: string): Bytes => new Uint8Array(fromBase64Url(value));

const joined = (...parts: readonly Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

const hkdf = async (salt: Bytes, secret: Bytes, info: Bytes, bytes: number): Promise<Bytes> => {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
};

/** A P-256 key pair from its uncompressed public point and private scalar, for `usage`. */
const privateKeyOf = (publicKey: Bytes, privateKey: string, algorithm: typeof P256 | typeof SIGNING, usage: KeyUsage): Promise<CryptoKey> => {
  if (publicKey.byteLength !== 65 || publicKey[0] !== 4) throw new Error('A P-256 public key is 65 bytes, starting with 4.');
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: privateKey,
    x: toBase64Url(publicKey.subarray(1, 33)), y: toBase64Url(publicKey.subarray(33)),
  }, algorithm, false, [usage]);
};

/** The deployment's VAPID keys, or null when any of the three secrets is missing, which leaves push unavailable. */
export const vapidOf = (env: Pick<Bindings, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>): Vapid | null => {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
};

/** A sender's one-off key pair, as RFC 8291 has the application server make one per message. */
export interface SenderKeys {
  publicKey: Bytes;
  privateKey: CryptoKey;
}

const freshSender = async (): Promise<SenderKeys> => {
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']) as CryptoKeyPair;
  return { publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer), privateKey: pair.privateKey };
};

/** The sender keys of RFC 8291's example, so its test vector can be reproduced. */
export const senderKeys = async (publicKey: string, privateKey: string): Promise<SenderKeys> => {
  const point = decoded(publicKey);
  return { publicKey: point, privateKey: await privateKeyOf(point, privateKey, P256, 'deriveBits') };
};

/**
 * The body of one push message: `payload` encrypted for the subscription as
 * a single aes128gcm record, behind the header that names the salt, the
 * record size, and the sender's public key. `salt` and `sender` are fresh
 * for every message unless a test hands them in.
 */
export const encryptPayload = async (input: {
  payload: Bytes;
  target: Pick<PushTarget, 'p256dh' | 'auth'>;
  salt?: Bytes;
  sender?: SenderKeys;
}): Promise<Bytes> => {
  const receiver = decoded(input.target.p256dh);
  const auth = decoded(input.target.auth);
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const sender = input.sender ?? await freshSender();
  const receiverKey = await crypto.subtle.importKey('raw', receiver, P256, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, sender.privateKey, 256));
  const ikm = await hkdf(auth, shared, joined(text.encode('WebPush: info\0'), receiver, sender.publicKey), 32);
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // The last (and only) record ends with the delimiter 2 and no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, joined(input.payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicKey.byteLength;
  return joined(header, sender.publicKey, sealed);
};

/**
 * The Authorization header of a request to `endpoint`'s push service: a
 * VAPID JWT for its origin, signed ES256 with the deployment's key, and the
 * public key it is checked with.
 */
export const vapidAuthorization = async (input: { endpoint: string; vapid: Vapid; now: number }): Promise<string> => {
  const header = toBase64Url(text.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(text.encode(JSON.stringify({
    aud: new URL(input.endpoint).origin,
    exp: Math.floor(input.now / 1000) + JWT_SECONDS,
    sub: input.vapid.subject,
  })));
  const key = await privateKeyOf(decoded(input.vapid.publicKey), input.vapid.privateKey, SIGNING, 'sign');
  // WebCrypto signs ECDSA as r and s side by side, which is what JWS's ES256 is.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, text.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${input.vapid.publicKey}`;
};

/** A push service's Topic: 32 base64url characters at most, so a message replaces an undelivered one of the same topic. */
export const pushTopic = async (key: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(key))).subarray(0, 24));

/**
 * Sends one message to one subscription. `gone` means the push service no
 * longer knows the subscription (404 or 410), which its owner then forgets;
 * any other refusal is `failed` and the subscription is kept.
 */
export const sendPush = async (input: {
  target: PushTarget;
  payload: string;
  vapid: Vapid;
  /** Seconds the push service keeps the message for a browser that is offline. */
  ttl: number;
  topic?: string;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  now: number;
  fetch?: typeof fetch;
}): Promise<PushResult> => {
  const send = input.fetch ?? fetch;
  const body = await encryptPayload({ payload: text.encode(input.payload), target: input.target });
  const response = await send(input.target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization({ endpoint: input.target.endpoint, vapid: input.vapid, now: input.now }),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(input.ttl),
      Urgency: input.urgency ?? 'normal',
      ...(input.topic ? { Topic: input.topic } : {}),
    },
    body,
  }).catch(() => null);
  if (!response) return 'failed';
  // The body is never read; it is drained so the connection is released.
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404 || response.status === 410) return 'gone';
  return response.ok ? 'sent' : 'failed';
};
