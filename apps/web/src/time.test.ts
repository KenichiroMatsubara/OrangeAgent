// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { dateLabel, dateTimeLabel, momentLabel, sinceLabel, timeLabel, tokyoDay } from './time';

// The suite's clock stands at 2026-08-01T00:00Z, which is 09:00 on Saturday 1 August in Tokyo.

describe('times shown in the GUI', () => {
  it('reads every instant on the Asia/Tokyo calendar, whatever zone the browser is in', () => {
    expect(tokyoDay('2026-07-31T15:30:00.000Z')).toBe('2026-08-01');
    expect(dateLabel('2026-07-31T15:30:00.000Z')).toBe('8月1日（土）');
    expect(timeLabel('2026-07-31T20:05:00.000Z')).toBe('05:05');
    expect(dateTimeLabel('2026-10-20T01:00:00.000Z')).toBe('10月20日（火）10:00');
  });

  it('reads a calendar date as that day in Tokyo', () => {
    expect(dateLabel('2026-08-10')).toBe('8月10日（月）');
  });

  it('names a nearby day instead of its date', () => {
    expect(momentLabel('2026-08-01T05:00:00.000Z')).toBe('今日 14:00');
    expect(momentLabel('2026-07-31T05:00:00.000Z')).toBe('昨日 14:00');
    expect(momentLabel('2026-08-02T01:00:00.000Z')).toBe('明日 10:00');
    expect(momentLabel('2026-09-03T01:00:00.000Z')).toBe('9月3日（木）10:00');
    expect(momentLabel('2025-12-24T01:00:00.000Z')).toBe('2025年12月24日（水）10:00');
  });

  it('counts back from now for what just happened', () => {
    expect(sinceLabel('2026-07-31T23:59:30.000Z')).toBe('たった今');
    expect(sinceLabel('2026-07-31T23:48:00.000Z')).toBe('12分前');
    expect(sinceLabel('2026-07-31T21:00:00.000Z')).toBe('3時間前');
    expect(sinceLabel('2026-07-30T21:00:00.000Z')).toBe('昨日 06:00');
  });
});
