import { LoaderCircle } from 'lucide-react';

import { operationLabel } from './pending';
import styles from './progress.module.css';

/**
 * The screen-level answer to "is anything happening?". A control reports its own
 * work in place, but that report can be scrolled out of view or below the fold,
 * so the running operations are also named once in a status line at the bottom
 * of the screen, which covers nothing and takes no clicks.
 */
export const PendingOverlay = ({ running }: { running: readonly string[] }) => {
  const [first, ...rest] = running;
  if (!first) return null;
  return <div className={styles.line} role="status" aria-live="polite" data-testid="pending-overlay">
    <div className={styles.card}>
      <LoaderCircle className={styles.spin} size={16} aria-hidden="true" />
      <strong>{operationLabel(first)}</strong>
      {rest.length > 0 && <small>ほか{rest.length}件</small>}
    </div>
  </div>;
};
