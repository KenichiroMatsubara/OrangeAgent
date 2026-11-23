import { describe, expect, it } from 'vitest';

import { tokyoDay, tokyoDaysBetween } from './days';

describe('days', () => {
  it('counts days on the Asia/Tokyo calendar rather than in elapsed hours', () => {
    expect(tokyoDay(Date.parse('2026-07-31T15:00:00.000Z'))).toBe('2026-08-01');
    expect(tokyoDay(Date.parse('2026-07-31T14:59:59.999Z'))).toBe('2026-07-31');
    // 05:00 on the 1st to 03:00 on the 4th is under three days elapsed but three calendar days.
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('2026-08-03T18:00:00.000Z'))).toBe(3);
    // A date-only deadline reads as UTC midnight, 09:00 the same day in Tokyo.
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('2026-08-01'))).toBe(0);
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('2026-07-31'))).toBe(-1);
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('未定'))).toBeNaN();
  });
});
