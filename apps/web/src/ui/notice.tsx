import type { ReactNode } from 'react';

import { dateParts } from '../time';

import styles from './notice.module.css';

/**
 * What a state means to the reader. Each tone differs from the others in
 * lightness as well as hue, so it reads without colour vision.
 */
export type Tone = 'brand' | 'neutral' | 'muted' | 'warn' | 'danger' | 'info';

/** A short state, such as 承認待ち or 失敗. */
export const Chip = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) =>
  <span className={`${styles.chip} ${styles[tone]}`}>{children}</span>;

/**
 * A sentence the screen says about itself, with the action that resolves it.
 * A danger banner is announced at once; the others wait their turn.
 */
export const Banner = ({ tone = 'info', icon, action, children }: {
  tone?: Tone;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) => <div className={`${styles.banner} ${styles[tone]}`} role={tone === 'danger' ? 'alert' : 'status'}>
  {icon}
  <span className={styles.bannerText}>{children}</span>
  {action && <span className={styles.bannerAction}>{action}</span>}
</div>;

/** What an empty list says instead of nothing: what would be here, and how it gets here. */
export const Empty = ({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) =>
  <div className={styles.empty}>
    {icon}
    <p className={styles.emptyTitle}>{title}</p>
    {text && <p className={styles.emptyText}>{text}</p>}
    {action}
  </div>;

/** A round icon on a tinted ground, leading a row that needs the Account. */
export const Mark = ({ tone, children }: { tone: Tone; children: ReactNode }) =>
  <span className={`${styles.mark} ${styles[tone]}`} aria-hidden="true">{children}</span>;

/** A small round state light, such as whether an intake finished. */
export const Dot = ({ tone }: { tone: Tone | 'success' }) =>
  <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />;

/** The first letter of a name in a round mark, so a long list can be scanned by eye. */
export const Avatar = ({ name, size = 42 }: { name: string; size?: 36 | 42 | 60 }) =>
  <span className={`${styles.avatar} ${styles[`avatar${size}`]}`} aria-hidden="true">{name.trim().slice(0, 1) || '?'}</span>;

/** Chips side by side, wrapping. */
export const Chips = ({ children }: { children: ReactNode }) => <span className={styles.chips}>{children}</span>;

/** A small calendar leaf: the month, the day, and the weekday an event falls on. */
export const DateBadge = ({ value }: { value: string }) => {
  const { month, day, weekday } = dateParts(value);
  return <span className={styles.date} aria-hidden="true">
    <small>{month}月</small>
    <strong>{day}</strong>
    <small>{weekday}</small>
  </span>;
};
