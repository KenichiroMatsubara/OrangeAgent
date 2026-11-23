import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import styles from './button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'danger' | 'quiet';

interface Look {
  variant?: ButtonVariant | undefined;
  /** 44px instead of 46px, for buttons inside rows and toolbars. */
  small?: boolean | undefined;
  /** Fills its container's width. */
  block?: boolean | undefined;
  /** Fully rounded, for the floating add button and the AI entry. */
  pill?: boolean | undefined;
  icon?: ReactNode;
}

const classes = ({ variant = 'primary', small, block, pill }: Look, busy = false): string =>
  [styles.button, styles[variant], small && styles.small, block && styles.block, pill && styles.pill, busy && styles.busy]
    .filter(Boolean).join(' ');

export interface ButtonProps extends Look, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** The work this button started is running: it is disabled and spins. Its caller names the work in its label. */
  busy?: boolean;
}

/** A button. It is `type="button"` unless told otherwise, so it never submits a form by accident. */
export const Button = ({ variant, small, block, pill, icon, busy = false, disabled, type = 'button', children, ...rest }: ButtonProps) =>
  <button {...rest} type={type} className={classes({ variant, small, block, pill }, busy)} disabled={disabled || busy} aria-busy={busy || undefined}>
    {busy ? <LoaderCircle className={styles.spin} size={18} aria-hidden="true" /> : icon}
    {children}
  </button>;

/** A link that looks like a button, for an action that is really a move to another screen. */
export const ButtonLink = ({ to, variant, small, block, pill, icon, children }: Look & { to: string; children: ReactNode }) =>
  <Link to={to} className={classes({ variant, small, block, pill })}>{icon}{children}</Link>;

/** A link that looks like a button and opens a page outside the GUI in a new tab, such as a Live View. */
export const ButtonAnchor = ({ href, variant, small, block, pill, icon, children }: Look & { href: string; children: ReactNode }) =>
  <a href={href} target="_blank" rel="noreferrer" className={classes({ variant, small, block, pill })}>{icon}{children}</a>;
