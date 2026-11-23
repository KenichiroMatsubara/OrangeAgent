import { describe, expect, it } from 'vitest';

import { repeatUuid, retryAfterSeconds, temporaryAnswer } from './temporary';

describe('temporary failures', () => {
  it('reads a Retry-After as seconds or as a date, and ignores one it cannot read', () => {
    const at = Date.parse('2026-08-06T02:00:00.000Z');

    expect(retryAfterSeconds('120', at)).toBe(120);
    expect(retryAfterSeconds('Thu, 06 Aug 2026 02:05:00 GMT', at)).toBe(300);
    expect(retryAfterSeconds('Thu, 06 Aug 2026 01:00:00 GMT', at)).toBe(0);
    expect(retryAfterSeconds('soon', at)).toBeNull();
    expect(retryAfterSeconds(null, at)).toBeNull();
  });

  it('counts 408, 429, and 5xx as temporary, and says which the provider refused before performing', () => {
    const answer = (status: number) => temporaryAnswer('LINE', new Response('', { status }));

    expect([408, 429, 503].map((status) => answer(status)?.performed)).toEqual(['no', 'no', 'no']);
    expect([500, 502, 504].map((status) => answer(status)?.performed)).toEqual(['unknown', 'unknown', 'unknown']);
    expect([400, 401, 403, 404, 409].map(answer)).toEqual([null, null, null, null, null]);
  });

  it('names the same call by the same RFC 4122 version 5 UUID every time', async () => {
    // As Python's uuid.uuid5(uuid.NAMESPACE_URL, name) computes it.
    await expect(repeatUuid('https://orangeagent.example/planned-write')).resolves.toBe('d41d35ba-8d30-5228-8b9e-ae28e412e99e');
  });
});
