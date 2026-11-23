import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import styles from './disclosure.module.css';

/**
 * A row that opens in place to show what it holds, such as one Run and
 * the writes it planned. The whole summary is the control.
 */
export const Disclosure = ({ title, sub, aside, open = false, children }: {
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) => <details className={styles.disclosure} open={open}>
  <summary className={styles.summary}>
    <span className={styles.text}>
      <span className={styles.title}>{title}</span>
      {sub && <span className={styles.sub}>{sub}</span>}
    </span>
    {aside && <span className={styles.aside}>{aside}</span>}
    <ChevronRight className={styles.chevron} size={18} aria-hidden="true" />
  </summary>
  <div className={styles.body}>{children}</div>
</details>;
