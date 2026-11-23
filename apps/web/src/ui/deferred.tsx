import { CircleAlert } from 'lucide-react';
import { Suspense, type ReactNode } from 'react';
import { Await, useAsyncError, useRevalidator } from 'react-router-dom';

import { Button } from './button';
import { Banner } from './notice';

const DeferredError = () => {
  const error = useAsyncError();
  const revalidator = useRevalidator();
  const message = error instanceof Error && error.message ? error.message : '読み込めませんでした。';
  return <Banner
    tone="danger"
    icon={<CircleAlert size={18} aria-hidden="true" />}
    action={<Button variant="secondary" small busy={revalidator.state !== 'idle'} onClick={() => void revalidator.revalidate()}>
      {revalidator.state !== 'idle' ? '再試行中…' : '再試行'}
    </Button>}
  >{message}</Banner>;
};

/**
 * A request a loader hands to the screen without awaiting it. Its failure is
 * reported where the screen renders it (see Deferred); until then it is marked
 * as handled, so a part the screen never shows cannot surface as an unhandled
 * rejection. The promise returned still rejects for whoever awaits it.
 */
export const later = <T,>(promise: Promise<T>): Promise<T> => {
  promise.catch(() => undefined);
  return promise;
};

/**
 * A part of a screen that fills in when its data arrives. The loader
 * returns the promise without awaiting it, so the screen is shown at once with
 * `fallback` in this place; a failure is reported here, with a retry, and the
 * rest of the screen stays usable.
 */
export const Deferred = <T,>({ value, fallback, children }: {
  value: Promise<T> | T;
  fallback: ReactNode;
  children: (data: T) => ReactNode;
}) => <Suspense fallback={fallback}>
  <Await resolve={value} errorElement={<DeferredError />}>{(data: T) => children(data)}</Await>
</Suspense>;
