/**
 * A browser's side of Web Push, for tests: a subscription's key pair and
 * secret, and the decryption of a message sent to it (RFC 8291), so a test
 * reads what the Worker sent as the browser would.
 */

import { fromBase64Url, toBase64Url } from '../src/encoding';

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
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

export interface Receiver {
  p256dh: string;
  auth: string;
  privateKey: CryptoKey;
}

/** A browser's subscription keys, made fresh, or from a known private key and point (RFC 8291's example). */
export const receiver = async (known?: { publicKey: string; privateKey: string; auth: string }): Promise<Receiver> => {
  if (known) {
    const point = decoded(known.publicKey);
    const privateKey = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: known.privateKey, x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33)),
    }, P256, false, ['deriveBits']);
    return { p256dh: known.publicKey, auth: known.auth, privateKey };
  }
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']) as CryptoKeyPair;
  return {
    p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer)),
    auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    privateKey: pair.privateKey,
  };
};

/** The payload of an aes128gcm push message, decrypted as the subscribed browser decrypts it. */
export const decryptPush = async (input: Uint8Array, to: Receiver): Promise<string> => {
  const body = new Uint8Array(input);
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const sender = body.subarray(21, 21 + idLength);
  const senderKey = await crypto.subtle.importKey('raw', sender, P256, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, to.privateKey, 256));
  const ikm = await hkdf(decoded(to.auth), shared, joined(text.encode('WebPush: info\0'), decoded(to.p256dh), sender), 32);
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.subarray(21 + idLength)));
  const end = plain.lastIndexOf(2);
  return new TextDecoder().decode(plain.subarray(0, end));
};

/** A VAPID key pair made fresh, as `.dev.vars.example` says to make one. */
export const vapidKeys = async (): Promise<{ publicKey: string; privateKey: string }> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  return {
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer)),
    privateKey: jwk.d ?? '',
  };
};
