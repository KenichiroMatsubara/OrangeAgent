/**
 * What a call that waits for a person's approval will do, read from its
 * arguments in the words a person checks it by: the mail it sends or saves,
 * and the event it puts in the calendar, changes, or cancels, with every time
 * on the Asia/Tokyo calendar. A tool without one is shown by its arguments.
 */

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** How much of a mail's body the preview shows. */
export const PREVIEW_BODY_CHARACTERS = 400;

/** An event as OrangeAgent recorded it, before a change or cancellation. */
export interface PreviewEvent {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/iu;

/** A calendar day (`YYYY-MM-DD`) is a whole day; a time without a zone is Tokyo's, as Calendar takes it. */
const instantOf = (value: string): number => Date.parse(ZONED.test(value) ? value : `${value}+09:00`);

/** The Tokyo calendar fields of an instant, read at a fixed offset since Japan keeps no daylight saving. */
const tokyo = (instant: number): { year: number; month: number; day: number; weekday: string; time: string } => {
  const shifted = new Date(instant + TOKYO_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: WEEKDAYS[shifted.getUTCDay()] ?? '',
    time: `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`,
  };
};

const dateOf = (parts: { year: number; month: number; day: number; weekday: string }): string =>
  `${parts.year}年${parts.month}月${parts.day}日(${parts.weekday})`;

/** One moment in Tokyo: a calendar day by its date, a time by its date and time. */
const momentText = (value: string): string => {
  const instant = DAY.test(value) ? Date.parse(`${value}T00:00:00+09:00`) : instantOf(value);
  if (!Number.isFinite(instant)) return value;
  const parts = tokyo(instant);
  return DAY.test(value) ? dateOf(parts) : `${dateOf(parts)} ${parts.time}`;
};

/** A calendar day's instant at Tokyo midnight. */
const dayInstant = (day: string): number => Date.parse(`${day}T00:00:00+09:00`);

/**
 * When an event happens, in Tokyo: a timed event by its day and times, and
 * an all-day event by its days, its end being the day after its last as
 * Calendar keeps it. A value that is not a time is shown as it is.
 */
export const eventTimeText = (startsAt: string, endsAt: string): string => {
  if (DAY.test(startsAt)) {
    const first = dayInstant(startsAt);
    const after = DAY.test(endsAt) ? dayInstant(endsAt) : Number.NaN;
    if (!Number.isFinite(first)) return `${startsAt}〜${endsAt}`;
    const last = Number.isFinite(after) && after - first > DAY_MS ? after - DAY_MS : first;
    const start = dateOf(tokyo(first));
    return last === first ? `${start} 終日` : `${start}〜${dateOf(tokyo(last))} 終日`;
  }
  const start = instantOf(startsAt);
  const end = instantOf(endsAt);
  if (!Number.isFinite(start)) return `${startsAt}〜${endsAt}`;
  const from = tokyo(start);
  if (!Number.isFinite(end)) return `${dateOf(from)} ${from.time}〜`;
  const to = tokyo(end);
  const sameDay = from.year === to.year && from.month === to.month && from.day === to.day;
  return sameDay ? `${dateOf(from)} ${from.time}〜${to.time}` : `${dateOf(from)} ${from.time}〜${dateOf(to)} ${to.time}`;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const texts = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((entry) => text(entry) ? [text(entry)] : []) : [];

/** The beginning of a mail's body, cut where the preview stops. */
const bodyHead = (body: string): string => {
  const trimmed = body.replace(/\r\n/gu, '\n').trim();
  return trimmed.length > PREVIEW_BODY_CHARACTERS ? `${trimmed.slice(0, PREVIEW_BODY_CHARACTERS)}…（続きは省略）` : trimmed;
};

const mailPreview = (args: Readonly<Record<string, unknown>>): string => {
  const files = texts(args.files);
  return [
    `宛先：${text(args.to) || '（なし）'}`,
    `件名：${text(args.subject) || '（なし）'}`,
    ...(files.length ? [`添付：${files.join('、')}`] : []),
    '本文：',
    bodyHead(typeof args.body === 'string' ? args.body : '') || '（なし）',
  ].join('\n');
};

/** Who an event invites, in words. */
const guests = (args: Readonly<Record<string, unknown>>): string[] => {
  const attendees = texts(args.attendees);
  const roster = args.inviteRoster === true ? ['メールアドレスのある連絡先の全員'] : [];
  const named = [...roster, ...attendees];
  return named.length ? [`参加者：${named.join('、')}（招待メールは送りません）`] : [];
};

const createPreview = (args: Readonly<Record<string, unknown>>): string => {
  const attachments = Array.isArray(args.attachments) ? args.attachments.length : 0;
  return [
    `予定名：${text(args.title) || '（なし）'}`,
    `日時：${eventTimeText(text(args.startsAt), text(args.endsAt))}`,
    ...(text(args.location) ? [`場所：${text(args.location)}`] : []),
    ...guests(args),
    ...(attachments ? [`資料：${attachments} 件を Drive に置いて予定に付けます`] : []),
  ].join('\n');
};

/** One field before and after the change, or as it stays. */
const field = (label: string, before: string, after: string | null): string =>
  after === null || after === before ? `${label}：${before || '（なし）'}` : `${label}：${before || '（なし）'} → ${after || '（なし）'}`;

const updatePreview = (args: Readonly<Record<string, unknown>>, before: PreviewEvent | null): string => {
  const title = typeof args.title === 'string' ? args.title.trim() : null;
  const startsAt = typeof args.startsAt === 'string' ? args.startsAt.trim() : null;
  const endsAt = typeof args.endsAt === 'string' ? args.endsAt.trim() : null;
  const location = typeof args.location === 'string' ? args.location.trim() : null;
  const summary = typeof args.description === 'string' ? ['案内文：書き換えます'] : [];
  if (before === null) {
    // The event is not one OrangeAgent recorded: only what changes can be told.
    return [
      `予定：${text(args.eventId) || '（不明）'}（変更前は分かりません）`,
      ...(title === null ? [] : [`新しい予定名：${title}`]),
      ...(startsAt === null ? [] : [`新しい開始：${momentText(startsAt)}`]),
      ...(endsAt === null ? [] : [`新しい終了：${momentText(endsAt)}`]),
      ...(location === null ? [] : [`新しい場所：${location || '（なし）'}`]),
      ...summary,
    ].join('\n');
  }
  const was = eventTimeText(before.startsAt, before.endsAt);
  const timeChanges = startsAt !== null || endsAt !== null;
  const will = eventTimeText(startsAt ?? before.startsAt, endsAt ?? before.endsAt);
  return [
    field('予定名', before.title, title),
    field('日時', was, timeChanges ? will : null),
    ...(location !== null || before.location ? [field('場所', before.location, location)] : []),
    ...summary,
  ].join('\n');
};

const cancelPreview = (args: Readonly<Record<string, unknown>>, before: PreviewEvent | null): string => before === null
  ? `予定：${text(args.eventId) || '（不明）'}（OrangeAgent に記録がありません）`
  : [
    `予定名：${before.title || '（なし）'}`,
    `日時：${eventTimeText(before.startsAt, before.endsAt)}`,
    ...(before.location ? [`場所：${before.location}`] : []),
    'Google カレンダーから消し、誰にもメールは送りません',
  ].join('\n');

/** The tools whose calls a preview shows, and those of them that name an event OrangeAgent recorded. */
export const PREVIEWED_TOOLS: readonly string[] = ['mail.send', 'mail.draft', 'create_scheduled_event', 'update_scheduled_event', 'cancel_scheduled_event'];
export const EVENT_TOOLS: readonly string[] = ['update_scheduled_event', 'cancel_scheduled_event'];

/**
 * What a call will do, in lines a person reads, or null for a tool without a
 * preview. `before` is the event a change or cancellation names, as OrangeAgent
 * recorded it, or null when it is not known.
 */
export const callPreview = (name: string, args: Readonly<Record<string, unknown>>, before: PreviewEvent | null = null): string | null => {
  switch (name) {
    case 'mail.send':
    case 'mail.draft':
      return mailPreview(args);
    case 'create_scheduled_event':
      return createPreview(args);
    case 'update_scheduled_event':
      return updatePreview(args, before);
    case 'cancel_scheduled_event':
      return cancelPreview(args, before);
    default:
      return null;
  }
};
