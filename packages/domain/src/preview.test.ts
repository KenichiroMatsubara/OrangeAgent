import { describe, expect, it } from 'vitest';

import { callPreview, eventTimeText, PREVIEW_BODY_CHARACTERS } from './preview';

const WEEKLY = { title: '週次定例', startsAt: '2026-11-28T10:00:00+09:00', endsAt: '2026-11-28T10:30:00+09:00', location: '第2会議室' };

describe('a waiting call in words', () => {
  it('shows a mail by its recipient, subject, and the beginning of its body', () => {
    const body = `皆さま\n\n${'あ'.repeat(PREVIEW_BODY_CHARACTERS * 3)}`;
    const preview = callPreview('mail.send', { to: 'tanaka@example.co.jp', subject: '【変更】定例', body, files: ['議事録.pdf'] }) ?? '';

    expect(preview.split('\n').slice(0, 4)).toEqual(['宛先：tanaka@example.co.jp', '件名：【変更】定例', '添付：議事録.pdf', '本文：']);
    expect(preview).toContain('皆さま');
    expect(preview.endsWith('…（続きは省略）')).toBe(true);
    expect(preview.length).toBeLessThan(body.length);
    expect(callPreview('mail.draft', { to: 'a@example.com', subject: '下書き', body: '短い本文' })).toBe('宛先：a@example.com\n件名：下書き\n本文：\n短い本文');
  });

  it('shows a new event by its name, its time in Tokyo, its place, and whom it invites', () => {
    expect(callPreview('create_scheduled_event', {
      title: '総会', startsAt: '2026-12-05T05:00:00Z', endsAt: '2026-12-05T07:00:00Z', location: '公民館', attendees: ['a@example.com'], inviteRoster: true,
    })).toBe('予定名：総会\n日時：2026年12月5日(土) 14:00〜16:00\n場所：公民館\n参加者：メールアドレスのある連絡先の全員、a@example.com（招待メールは送りません）');
  });

  it('shows a change as before and after, from the event FlareChat recorded', () => {
    expect(callPreview('update_scheduled_event', { eventId: 'event-1', startsAt: '2026-11-27T15:00:00+09:00', endsAt: '2026-11-27T15:30:00+09:00' }, WEEKLY))
      .toBe('予定名：週次定例\n日時：2026年11月28日(土) 10:00〜10:30 → 2026年11月27日(金) 15:00〜15:30\n場所：第2会議室');
    expect(callPreview('update_scheduled_event', { eventId: 'event-1', title: '定例会', location: 'オンライン', description: '新しい案内' }, WEEKLY))
      .toBe('予定名：週次定例 → 定例会\n日時：2026年11月28日(土) 10:00〜10:30\n場所：第2会議室 → オンライン\n案内文：書き換えます');
    // Moving the start alone keeps the end FlareChat recorded.
    expect(callPreview('update_scheduled_event', { eventId: 'event-1', startsAt: '2026-11-28T09:30:00+09:00' }, WEEKLY))
      .toContain('日時：2026年11月28日(土) 10:00〜10:30 → 2026年11月28日(土) 09:30〜10:30');
  });

  it('shows only what changes when the event is not one FlareChat recorded', () => {
    expect(callPreview('update_scheduled_event', { eventId: 'event-9', startsAt: '2026-11-27T15:00:00+09:00' }, null))
      .toBe('予定：event-9（変更前は分かりません）\n新しい開始：2026年11月27日(金) 15:00');
  });

  it('shows a cancellation by the event it cancels', () => {
    expect(callPreview('cancel_scheduled_event', { eventId: 'event-1' }, WEEKLY))
      .toBe('予定名：週次定例\n日時：2026年11月28日(土) 10:00〜10:30\n場所：第2会議室\nGoogle カレンダーから消し、誰にもメールは送りません');
  });

  it('has none for any other tool, which keeps its arguments', () => {
    expect(callPreview('channel.send', { text: 'こんにちは' })).toBeNull();
    expect(callPreview('notion.search', {})).toBeNull();
  });

  it('reads a time without a zone, an instant in UTC, and whole days in Tokyo', () => {
    expect(eventTimeText('2026-11-27T15:00', '2026-11-27T16:00')).toBe('2026年11月27日(金) 15:00〜16:00');
    expect(eventTimeText('2026-11-27T23:00:00Z', '2026-11-28T01:00:00Z')).toBe('2026年11月28日(土) 08:00〜10:00');
    expect(eventTimeText('2026-11-27T22:00:00+09:00', '2026-11-28T01:00:00+09:00')).toBe('2026年11月27日(金) 22:00〜2026年11月28日(土) 01:00');
    // Calendar ends an all-day event on the day after its last.
    expect(eventTimeText('2026-11-27', '2026-11-28')).toBe('2026年11月27日(金) 終日');
    expect(eventTimeText('2026-11-27', '2026-11-30')).toBe('2026年11月27日(金)〜2026年11月29日(日) 終日');
  });
});
