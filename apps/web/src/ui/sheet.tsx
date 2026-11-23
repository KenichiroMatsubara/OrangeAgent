import { X } from 'lucide-react';
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';

import styles from './sheet.module.css';

/**
 * A form that rises from the bottom of a phone, or opens in the middle of a
 * wide screen, over the screen that opened it. Escape, the scrim, and on a
 * phone a swipe down from its top close it, and focus returns to whatever
 * opened it.
 */
export const Sheet = ({ title, onClose, onSubmit, children }: {
  title: string;
  onClose: () => void;
  /** Makes the sheet a form, submitted by its submit button or the Enter key. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) => {
  const id = useId();
  const sheet = useRef<HTMLDivElement>(null);
  // Read through a ref so a parent that renders a new callback does not reopen the sheet.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = sheet.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus();
    const scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', closeOnEscape);
    const stopSwipe = sheet.current ? swipeDownToClose(sheet.current, () => close.current()) : () => {};
    return () => {
      stopSwipe();
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = scrollLock;
      opener?.focus();
    };
  }, []);

  return <div className={styles.scrim} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={sheet} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={id}>
      <span className={styles.grip} aria-hidden="true" />
      <div className={styles.header}>
        <h2 className={styles.title} id={id}>{title}</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="閉じる" data-close><X size={20} aria-hidden="true" /></button>
      </div>
      {onSubmit ? <form className={styles.form} onSubmit={onSubmit}>{children}</form> : children}
    </div>
  </div>;
};

/** How far, or how fast in pixels per millisecond, a finger must pull the sheet down to close it. */
const SWIPE_DISTANCE = 96;
const SWIPE_SPEED = 0.5;
const SWIPE_SETTLE_MS = 180;

/**
 * Lets a finger drag a phone's sheet down from its top and let it go: far or
 * fast enough closes it, otherwise it settles back. A drag that starts while
 * the sheet is scrolled down scrolls it instead. Returns what stops listening.
 */
const swipeDownToClose = (node: HTMLElement, onClose: () => void): (() => void) => {
  let start: { y: number; at: number } | null = null;
  let pulled = 0;
  let closing: number | undefined;

  const phone = (): boolean => window.matchMedia('(max-width: 1023px)').matches;
  const move = (offset: number, settle: boolean): void => {
    node.style.transition = settle ? `transform ${SWIPE_SETTLE_MS}ms ease-out` : 'none';
    node.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
  };

  const onStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    start = touch && event.touches.length === 1 && phone() && node.scrollTop <= 0 ? { y: touch.clientY, at: event.timeStamp } : null;
    pulled = 0;
  };
  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!start || !touch) return;
    const offset = touch.clientY - start.y;
    if (pulled === 0 && offset <= 0) { start = null; return; }
    event.preventDefault();
    pulled = Math.max(0, offset);
    move(pulled, false);
  };
  const onEnd = (event: TouchEvent): void => {
    if (!start) return;
    const speed = pulled / Math.max(1, event.timeStamp - start.at);
    start = null;
    if (pulled < SWIPE_DISTANCE && !(speed > SWIPE_SPEED && pulled > 24)) { move(0, true); return; }
    move(node.offsetHeight, true);
    closing = window.setTimeout(onClose, SWIPE_SETTLE_MS);
  };

  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: false });
  node.addEventListener('touchend', onEnd);
  node.addEventListener('touchcancel', onEnd);
  return () => {
    window.clearTimeout(closing);
    node.removeEventListener('touchstart', onStart);
    node.removeEventListener('touchmove', onMove);
    node.removeEventListener('touchend', onEnd);
    node.removeEventListener('touchcancel', onEnd);
  };
};
