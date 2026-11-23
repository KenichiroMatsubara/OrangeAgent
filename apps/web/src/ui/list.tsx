import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import styles from './list.module.css';

/** A card of rows, divided by lines. */
export const List = ({ label, children }: { label?: string; children: ReactNode }) =>
  <ul className={styles.list} aria-label={label}>{children}</ul>;

interface RowContent {
  title: ReactNode;
  /** One line under the title. It is cut short with an ellipsis unless `wrap` is set. */
  sub?: ReactNode;
  /** An icon or a mark before the text. */
  leading?: ReactNode;
  /** A value, a chip or a control after the text. */
  aside?: ReactNode;
  wrap?: boolean;
}

const Content = ({ title, sub, leading, aside }: RowContent) => <>
  {leading && <span className={styles.leading}>{leading}</span>}
  <span className={styles.text}>
    <span className={styles.title}>{title}</span>
    {sub && <span className={styles.sub}>{sub}</span>}
  </span>
  {aside && <span className={styles.aside}>{aside}</span>}
</>;

const rowClass = (wrap: boolean | undefined): string => [styles.row, wrap && styles.wrap].filter(Boolean).join(' ');

/**
 * One row of a List. With `to` it moves to another screen, and with `onClick`
 * it opens something in place; either way it ends in an arrow. Otherwise it
 * only shows.
 */
export const Row = ({ to, onClick, label, ...content }: RowContent & { to?: string; onClick?: () => void; label?: string }) =>
  <li className={styles.item}>
    {to
      ? <Link className={rowClass(content.wrap)} to={to} aria-label={label}><Content {...content} /><ChevronRight className={styles.chevron} size={18} aria-hidden="true" /></Link>
      : onClick
        ? <button type="button" className={rowClass(content.wrap)} onClick={onClick} aria-label={label}><Content {...content} /><ChevronRight className={styles.chevron} size={18} aria-hidden="true" /></button>
        : <div className={rowClass(content.wrap)}><Content {...content} /></div>}
  </li>;

/** A row whose whole width toggles a checkbox. */
export const CheckRow = ({ label, checked, disabled = false, onChange, ...content }: RowContent & {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => <li className={`${styles.item} ${styles.check}`}>
  <label className={rowClass(content.wrap)}>
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <Content {...content} />
  </label>
</li>;

/** A row that links to its item and carries one more action of its own at the end, such as deleting it. */
export const ActionRow = ({ to, onClick, label, action, ...content }: RowContent & { to: string; onClick?: () => void; label?: string; action: ReactNode }) =>
  <li className={styles.item}>
    <div className={styles.actionRow}>
      <Link className={styles.controlLink} to={to} onClick={onClick} aria-label={label}><Content {...content} /><ChevronRight className={styles.chevron} size={18} aria-hidden="true" /></Link>
      <span className={styles.trailing}>{action}</span>
    </div>
  </li>;
