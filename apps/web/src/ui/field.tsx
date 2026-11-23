import { Eye, EyeOff, Search as SearchIcon } from 'lucide-react';
import { useId, useState, type ChangeEvent, type ReactNode } from 'react';

import styles from './field.module.css';

/** What a control inside a Field must spread on itself to be labelled and described. */
export interface ControlProps {
  id: string;
  className: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/**
 * A labelled form control. The control is the caller's own `<input>`,
 * `<select>` or `<textarea>`, given the props that tie it to its label, its
 * hint and its error:
 *
 *     <Field label="名前">{(control) => <input {...control} value={name} onChange={…} />}</Field>
 */
export const Field = ({ label, hint, error, children }: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (control: ControlProps) => ReactNode;
}) => {
  const id = useId();
  const hintId = hint ? `${id}-hint` : '';
  const errorId = error ? `${id}-error` : '';
  const describedBy = [errorId, hintId].filter(Boolean).join(' ');
  const control: ControlProps = {
    id,
    className: styles.control ?? '',
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true as const } : {}),
  };
  return <div className={styles.field}>
    <label className={styles.label} htmlFor={id}>{label}</label>
    {children(control)}
    {error && <p className={styles.error} id={errorId}>{error}</p>}
    {hint && <p className={styles.hint} id={hintId}>{hint}</p>}
  </div>;
};

/** A checkbox with its label and an optional second line. */
export const Check = ({ label, sub, checked, disabled = false, onChange }: {
  label: ReactNode;
  sub?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => <label className={styles.check}>
  <input type="checkbox" checked={checked} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} />
  <span className={styles.checkText}>
    <span className={styles.checkLabel}>{label}</span>
    {sub && <span className={styles.checkSub}>{sub}</span>}
  </span>
</label>;

/** An on/off setting that takes effect when it is flipped. */
export const Switch = ({ label, sub, checked, disabled = false, onChange }: {
  label: ReactNode;
  sub?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => <label className={styles.switch}>
  <span className={styles.checkText}>
    <span className={styles.checkLabel}>{label}</span>
    {sub && <span className={styles.checkSub}>{sub}</span>}
  </span>
  <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} />
  <span className={styles.track} aria-hidden="true" />
</label>;

/** A search box whose label is read but not shown, because the magnifier says it. */
export const Search = ({ label, placeholder, value, onChange }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) => <label className={styles.search}>
  <SearchIcon size={18} aria-hidden="true" />
  <span className="fc-sr-only">{label}</span>
  <input type="search" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
</label>;

/** Checkboxes that answer one question together, named by the question. */
export const CheckGroup = ({ legend, showLegend = false, children }: { legend: string; showLegend?: boolean; children: ReactNode }) =>
  <fieldset className={styles.group}>
    <legend className={showLegend ? styles.label : 'fc-sr-only'}>{legend}</legend>
    {children}
  </fieldset>;

/**
 * A credential typed once and never shown back. It is masked by default and
 * kept away from password managers, which would otherwise offer to save an API
 * key as the Account's own password.
 */
export const Secret = ({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) => {
  const [revealed, setRevealed] = useState(false);
  return <Field label={label}>{(control) => <div className={styles.secret}>
    <input
      {...control}
      type="text"
      className={revealed ? control.className : `${control.className} ${styles.masked}`}
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      data-1p-ignore="true"
      data-bwignore="true"
      data-lpignore="true"
      data-protonpass-ignore="true"
      onChange={(event) => onChange(event.target.value)}
    />
    <button type="button" className={styles.reveal} onClick={() => setRevealed((current) => !current)} aria-label={revealed ? `${label}を隠す` : `${label}を表示`}>{revealed ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
  </div>}</Field>;
};
