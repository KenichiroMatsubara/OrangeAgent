/**
 * How the GUI says when something happens. OrangeAgent counts its days in
 * Asia/Tokyo, so every instant is read on that calendar whatever
 * zone the browser is in, and a nearby day is named rather than dated.
 */

const ZONE = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
const DAY_MS = 86_400_000;

interface TokyoParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
  hour: string;
  minute: string;
}

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A calendar date (`2026-08-10`) is that day in Tokyo; anything else is an instant. */
const instant = (value: string | Date): Date => value instanceof Date
  ? value
  : new Date(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00+09:00` : value);

const parts = (value: string | Date): TokyoParts => {
  const date = instant(value);
  const found = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number(found.year);
  const month = Number(found.month);
  const day = Number(found.day);
  return {
    year,
    month,
    day,
    weekday: WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '',
    hour: found.hour ?? '00',
    minute: found.minute ?? '00',
  };
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** The Tokyo calendar day an instant falls on, as `YYYY-MM-DD`. */
export const tokyoDay = (value: string | Date): string => {
  const { year, month, day } = parts(value);
  return `${year}-${pad(month)}-${pad(day)}`;
};

/** Whole Tokyo calendar days from `now` to `value`: 0 today, 1 tomorrow, -1 yesterday. */
export const daysFrom = (value: string | Date, now: Date = new Date()): number =>
  Math.round((Date.parse(`${tokyoDay(value)}T00:00:00Z`) - Date.parse(`${tokyoDay(now)}T00:00:00Z`)) / DAY_MS);

/** The month, day and weekday an instant falls on in Tokyo, for a calendar mark. */
export const dateParts = (value: string | Date): { month: number; day: number; weekday: string } => {
  const { month, day, weekday } = parts(value);
  return { month, day, weekday };
};

/** `8月1日（土）` */
export const dateLabel = (value: string | Date): string => {
  const { month, day, weekday } = parts(value);
  return `${month}月${day}日（${weekday}）`;
};

/** `05:05` */
export const timeLabel = (value: string | Date): string => {
  const { hour, minute } = parts(value);
  return `${hour}:${minute}`;
};

/** `10月20日（火）10:00` */
export const dateTimeLabel = (value: string | Date): string => `${dateLabel(value)}${timeLabel(value)}`;

/** An instant, with yesterday, today, and tomorrow named and another year stated. */
export const momentLabel = (value: string | Date, now: Date = new Date()): string => {
  const days = daysFrom(value, now);
  if (days === 0) return `今日 ${timeLabel(value)}`;
  if (days === -1) return `昨日 ${timeLabel(value)}`;
  if (days === 1) return `明日 ${timeLabel(value)}`;
  const year = parts(value).year;
  return year === parts(now).year ? dateTimeLabel(value) : `${year}年${dateTimeLabel(value)}`;
};

/** Something that already happened: minutes or hours ago while it is recent, otherwise when. */
export const sinceLabel = (value: string | Date, now: Date = new Date()): string => {
  const elapsed = now.getTime() - instant(value).getTime();
  if (elapsed < 60_000) return 'たった今';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分前`;
  if (elapsed < 6 * 3_600_000) return `${Math.floor(elapsed / 3_600_000)}時間前`;
  return momentLabel(value, now);
};

/**
 * The IANA zone this browser's clock is in: the Browser's zone until one is
 * chosen on the ブラウザ screen.
 */
export const browserZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

/** Every IANA zone this browser knows, with `including` among them whatever it is. */
export const zones = (including: readonly string[] = []): string[] => {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf('timeZone');
  } catch {
    known = [];
  }
  return [...new Set([...known, 'UTC', ...including])].sort((left, right) => left.localeCompare(right));
};

/** A zone as a person reads it: its name in Japanese, with the zone it is to tell like-named ones apart. */
export const zoneLabel = (zone: string): string => {
  try {
    const name = new Intl.DateTimeFormat('ja-JP', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    const place = zone.replaceAll('_', ' ');
    return name && name !== place ? `${name}（${place}）` : place;
  } catch {
    return zone;
  }
};
