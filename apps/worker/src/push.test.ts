import { describe, expect, it } from 'vitest';

import { fromBase64Url as base64Url, toBase64Url } from './encoding';
import { encryptPayload, pushTopic, senderKeys, sendPush, vapidAuthorization, vapidOf, type Vapid } from './push';
import { decryptPush, receiver, vapidKeys } from '../test/push';

/** RFC 8291, Appendix A. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

const bytes = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(base64Url(value));

const NOW = Date.parse('2026-11-21T01:00:00.000Z');

const vapid = async (): Promise<Vapid> => ({ ...await vapidKeys(), subject: 'mailto:push@example.com' });

describe('Web Push payload encryption (RFC 8291)', () => {
  it('reproduces the test vector of RFC 8291, Appendix A, byte for byte', async () => {
    const body = await encryptPayload({
      payload: new TextEncoder().encode(RFC.plaintext),
      target: { p256dh: RFC.receiverPublic, auth: RFC.auth },
      salt: bytes(RFC.salt),
      sender: await senderKeys(RFC.senderPublic, RFC.senderPrivate),
    });

    expect(toBase64Url(body)).toBe(RFC.body);
    const browser = await receiver({ publicKey: RFC.receiverPublic, privateKey: RFC.receiverPrivate, auth: RFC.auth });
    expect(await decryptPush(body, browser)).toBe(RFC.plaintext);
  });

  it('encrypts each message with a fresh salt and sender key, which only the subscribed browser opens', async () => {
    const browser = await receiver();
    const payload = new TextEncoder().encode('{"title":"承認待ち：スキルを書く"}');
    const first = await encryptPayload({ payload, target: browser });
    const second = await encryptPayload({ payload, target: browser });

    expect(toBase64Url(first.subarray(0, 16))).not.toBe(toBase64Url(second.subarray(0, 16)));
    expect(first[20]).toBe(65);
    expect(new DataView(first.buffer, first.byteOffset).getUint32(16)).toBe(4096);
    expect(await decryptPush(first, browser)).toBe('{"title":"承認待ち：スキルを書く"}');
    await expect(decryptPush(first, await receiver())).rejects.toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT for the push service\'s origin that the public key it names verifies', async () => {
    const keys = await vapid();
    const header = await vapidAuthorization({ endpoint: 'https://push.example.net/send/abc?x=1', vapid: keys, now: NOW });

    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/u.exec(header);
    expect(match).not.toBeNull();
    const [, head = '', claims = '', signature = '', k = ''] = match ?? [];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(bytes(head)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const body = JSON.parse(new TextDecoder().decode(bytes(claims))) as { aud: string; exp: number; sub: string };
    expect(body).toEqual({ aud: 'https://push.example.net', exp: Math.floor(NOW / 1000) + 12 * 3600, sub: 'mailto:push@example.com' });
    expect(body.exp - NOW / 1000).toBeLessThanOrEqual(24 * 3600);

    const publicKey = await crypto.subtle.importKey('raw', bytes(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${head}.${claims}`);
    expect(bytes(signature).byteLength).toBe(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, bytes(signature), signed)).toBe(true);
    const other = await crypto.subtle.importKey('raw', bytes((await vapidKeys()).publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, other, bytes(signature), signed)).toBe(false);
  });

  it('is unavailable unless all three secrets are set', () => {
    expect(vapidOf({})).toBeNull();
    expect(vapidOf({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q' })).toBeNull();
    expect(vapidOf({ VAPID_PUBLIC_KEY: ' p ', VAPID_PRIVATE_KEY: 'q', VAPID_SUBJECT: 'mailto:a@example.com' }))
      .toEqual({ publicKey: 'p', privateKey: 'q', subject: 'mailto:a@example.com' });
  });
});

describe('sending one message', () => {
  it('posts the encrypted payload with its headers, and tells a gone subscription from a failure', async () => {
    const keys = await vapid();
    const browser = await receiver();
    const sent: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];
    let status = 201;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array) });
      return new Response(null, { status });
    }) as typeof fetch;
    const target = { endpoint: 'https://push.example.net/send/abc', p256dh: browser.p256dh, auth: browser.auth };
    const topic = await pushTopic('thread-1:completed');

    expect(await sendPush({ target, payload: '{"title":"完了"}', vapid: keys, ttl: 3600, topic, urgency: 'high', now: NOW, fetch: fetcher })).toBe('sent');
    const [request] = sent;
    expect(request?.url).toBe('https://push.example.net/send/abc');
    expect(request?.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(request?.headers.get('TTL')).toBe('3600');
    expect(request?.headers.get('Urgency')).toBe('high');
    expect(request?.headers.get('Topic')).toBe(topic);
    expect(topic).toMatch(/^[\w-]{32}$/u);
    expect(request?.headers.get('Authorization')).toMatch(/^vapid t=.+, k=/u);
    expect(await decryptPush(request?.body ?? new Uint8Array(), browser)).toBe('{"title":"完了"}');

    status = 410;
    expect(await sendPush({ target, payload: '{}', vapid: keys, ttl: 60, now: NOW, fetch: fetcher })).toBe('gone');
    status = 404;
    expect(await sendPush({ target, payload: '{}', vapid: keys, ttl: 60, now: NOW, fetch: fetcher })).toBe('gone');
    status = 429;
    expect(await sendPush({ target, payload: '{}', vapid: keys, ttl: 60, now: NOW, fetch: fetcher })).toBe('failed');
    const unreachable = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await sendPush({ target, payload: '{}', vapid: keys, ttl: 60, now: NOW, fetch: unreachable })).toBe('failed');
  });
});
