import styles from './skeleton.module.css';

const WIDTHS: ReadonlyArray<readonly [string, string]> = [['72%', '44%'], ['58%', '36%'], ['66%', '40%'], ['48%', '30%'], ['64%', '44%']];

/** The outline of a list whose rows are on their way. Assistive technology hears only that it is loading. */
export const SkeletonRows = ({ count = 3 }: { count?: number }) => <div role="status">
  <span className="fc-sr-only">読み込み中…</span>
  <div className={styles.rows} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => {
      const [first, second] = WIDTHS[index % WIDTHS.length] ?? ['60%', '40%'];
      return <div key={index} className={styles.row}>
        <span className={styles.line} style={{ width: first }} />
        <span className={styles.line} style={{ width: second }} />
      </div>;
    })}
  </div>
</div>;

/** The outline of a card whose content is on its way. */
export const SkeletonBlock = ({ height = 120 }: { height?: number }) => <div role="status">
  <span className="fc-sr-only">読み込み中…</span>
  <div className={styles.block} style={{ height }} aria-hidden="true" />
</div>;
