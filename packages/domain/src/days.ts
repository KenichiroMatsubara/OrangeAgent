/**
 * Days on the Asia/Tokyo calendar, which every Account the product serves
 * keeps, as every Calendar write already does. Japan keeps no daylight saving,
 * so a day is a fixed offset from UTC rather than a zone lookup.
 */

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The Asia/Tokyo calendar day an instant falls on, as `YYYY-MM-DD`. */
export const tokyoDay = (instant: number): string => new Date(instant + TOKYO_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Whole Asia/Tokyo calendar days from the day `from` falls on to the day `to`
 * falls on, or NaN when either is not an instant.
 */
export const tokyoDaysBetween = (from: number, to: number): number => {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((Date.parse(tokyoDay(to)) - Date.parse(tokyoDay(from))) / DAY_MS);
};
