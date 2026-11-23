import { ChevronLeft } from 'lucide-react';
import { useId, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import styles from './page.module.css';

export interface Destination {
  to: string;
  label: string;
}

/**
 * One screen: its title, what it is for in a line, the actions that belong to
 * the whole screen, and its sections. A screen reached from another one names
 * that screen in `back`.
 */
export const Page = ({ title, lead, actions, back, narrow = false, children }: {
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
  back?: Destination;
  /** Keeps a form or a document to a readable measure on a wide screen. */
  narrow?: boolean;
  children: ReactNode;
}) => <div className={narrow ? `${styles.page} ${styles.narrow}` : styles.page}>
  <header className={styles.header}>
    <div className={styles.heading}>
      {back && <Link className={styles.back} to={back.to}><ChevronLeft size={18} aria-hidden="true" />{back.label}</Link>}
      <h1 className={styles.title}>{title}</h1>
      {lead && <p className={styles.lead}>{lead}</p>}
    </div>
    {actions && <div className={styles.actions}>{actions}</div>}
  </header>
  {children}
</div>;

/** A titled part of a screen. `count` is a number that needs the Account, shown as a red badge. */
export const Section = ({ title, count, link, lead, children }: {
  title: string;
  count?: number;
  link?: Destination;
  lead?: ReactNode;
  children: ReactNode;
}) => {
  const id = useId();
  return <section className={styles.section} aria-labelledby={id}>
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle} id={id}>
        {title}
        {count !== undefined && count > 0 && <span className={styles.count} aria-label={`${count}件`}>{count}</span>}
      </h2>
      {link && <Link className={styles.sectionLink} to={link.to}>{link.label}</Link>}
    </div>
    {lead && <p className={styles.sectionLead}>{lead}</p>}
    {children}
  </section>;
};

/** A white card holding a form or a summary. */
export const Card = ({ children }: { children: ReactNode }) => <div className={styles.card}>{children}</div>;

/** A card that is itself a form, submitted by its submit button or the Enter key. */
export const FormCard = ({ onSubmit, children }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode }) =>
  <form className={styles.card} onSubmit={onSubmit}>{children}</form>;

/** Sections side by side on a wide screen, one above the other on a phone. */
export const Columns = ({ children }: { children: ReactNode }) => <div className={styles.columns}>{children}</div>;

/** A column of sections inside Columns. */
export const Stack = ({ children }: { children: ReactNode }) => <div className={styles.stack}>{children}</div>;

/** A row of figures, each a number with what it counts. */
export const Stats = ({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode }> }) =>
  <dl className={styles.stats}>
    {items.map((item) => <div key={item.label} className={styles.stat}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
  </dl>;

/** A muted sentence that explains the part of the screen it sits in. */
export const Note = ({ children }: { children: ReactNode }) => <p className={styles.note}>{children}</p>;

/** A row of buttons that wraps on a narrow screen. */
export const Toolbar = ({ children }: { children: ReactNode }) => <div className={styles.toolbar}>{children}</div>;
