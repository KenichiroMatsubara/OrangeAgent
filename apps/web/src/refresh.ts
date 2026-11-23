import { useEffect, useRef, useState } from 'react';

/** How often a screen reads again what is still being worked on. */
export const REFRESH_MS = 3_000;

/**
 * A value read once by the screen's loader and read again every few seconds
 * while `working` says something in it is still in progress, such as a
 * recording being transcribed. Reading stops once nothing is, and a read that
 * fails is tried again on the next tick rather than shown.
 */
export const useRefreshed = <T,>(initial: T, read: () => Promise<T>, working: (value: T) => boolean): [T, (value: T) => void] => {
  const [value, setValue] = useState(initial);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => setValue(initial), [initial]);
  const busy = working(value);
  useEffect(() => {
    if (!busy) return undefined;
    let current = true;
    const timer = setInterval(() => {
      void reader.current().then((next) => { if (current) setValue(next); }, () => undefined);
    }, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [busy]);
  return [value, setValue];
};
