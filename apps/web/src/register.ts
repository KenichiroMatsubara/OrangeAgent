/**
 * The page's side of the Service Worker (sw.ts): it is registered once the
 * page has loaded, checked for a new release whenever the page comes back
 * into view (at most hourly), and a new release that has installed takes
 * over only when the page is about to change screens: that navigation then
 * loads the page anew under the new release, so a screen open on the old one
 * is never changed under the person. A notification tapped while a window is
 * open sends that window to its conversation.
 */

import { ACTIVATE, isOpenMessage } from './notify';

interface Place {
  pathname: string;
  search: string;
  hash: string;
}

/** The router's part the worker needs: to see a navigation begin or land, and to go somewhere. */
export interface Navigator {
  state: { location: Place };
  subscribe: (listener: (state: { location: Place; navigation: { state: string; location?: Place | undefined } }) => void) => () => void;
  navigate: (to: string) => unknown;
}

const CHECK_MS = 60 * 60 * 1000;
/** How long a navigation waits for a new release to take over before it goes on under the old one. */
const TAKEOVER_MS = 2_000;

/** Where a navigation that begins while a release waits goes: the same address, loaded anew. */
export const reloadTarget = (location: Place): string =>
  `${location.pathname}${location.search}${location.hash}`;

/**
 * Where the person is going when the router changes: the screen a navigation
 * is loading, or the one it landed on without loading anything; null when
 * the screen stays the same.
 */
export const destinationOf = (state: { location: Place; navigation: { state: string; location?: Place | undefined } }, from: string): string | null => {
  if (state.navigation.state === 'loading' && state.navigation.location) return reloadTarget(state.navigation.location);
  const landed = reloadTarget(state.location);
  return landed !== from ? landed : null;
};

export const startWorker = (router: Navigator): void => {
  if (!('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  let registration: ServiceWorkerRegistration | null = null;
  let checked = Date.now();
  let leaving = false;

  container.addEventListener('message', (event: MessageEvent) => {
    if (isOpenMessage(event.data)) void router.navigate(event.data.url);
  });

  let shown = reloadTarget(router.state.location);
  router.subscribe((state) => {
    const target = destinationOf(state, shown);
    shown = reloadTarget(state.location);
    const waiting = registration?.waiting;
    if (leaving || !waiting || target === null) return;
    leaving = true;
    // Loaded anew once the new release serves the page, which is at once; a release that has not
    // taken over by the time the screen has changed leaves it be, and the next navigation asks again.
    const reload = (): void => window.location.assign(target);
    container.addEventListener('controllerchange', reload, { once: true });
    window.setTimeout(() => {
      container.removeEventListener('controllerchange', reload);
      leaving = false;
    }, TAKEOVER_MS);
    waiting.postMessage(ACTIVATE);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !registration || Date.now() - checked < CHECK_MS) return;
    checked = Date.now();
    void registration.update().catch(() => undefined);
  });

  const register = (): void => {
    container.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((registered) => {
      registration = registered;
    }, (error: unknown) => {
      console.warn('The Service Worker was not registered.', error);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
};
