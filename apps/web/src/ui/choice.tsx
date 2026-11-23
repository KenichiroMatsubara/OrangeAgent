import styles from './choice.module.css';

export interface Option<T extends string> {
  value: T;
  label: string;
}

interface ChoiceProps<T extends string> {
  /** What is being chosen, for assistive technology. */
  label: string;
  /** The option chosen, or null while none is. */
  value: T | null;
  options: ReadonlyArray<Option<T>>;
  onChange: (value: T) => void;
}

const Choice = <T extends string>({ label, value, options, onChange, group, item }: ChoiceProps<T> & { group: string; item: string }) =>
  <div className={group} role="radiogroup" aria-label={label}>
    {options.map((option) => <button
      key={option.value}
      type="button"
      role="radio"
      className={item}
      aria-checked={option.value === value}
      onClick={() => onChange(option.value)}
    >{option.label}</button>)}
  </div>;

/** Two or three views of the same list, side by side as one control. */
export const Segmented = <T extends string>(props: ChoiceProps<T>) =>
  <Choice {...props} group={styles.segmented ?? ''} item={styles.segment ?? ''} />;

/** A row of filters that scrolls sideways on a phone. */
export const Filters = <T extends string>(props: ChoiceProps<T>) =>
  <Choice {...props} group={styles.chips ?? ''} item={styles.filter ?? ''} />;
