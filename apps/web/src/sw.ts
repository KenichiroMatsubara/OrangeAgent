/**
 * FlareChat's Service Worker, served as `/sw.js` (precache.ts builds it):
 * it keeps each release's app shell and chat chunks so the installed app
 * opens at once and downloads the chat once per release (cache.ts), and it
 * shows Operator Chat's notifications and opens their conversations
 * (notify.ts).
 *
 * A new release installs beside the one serving the open pages and waits;
 * a page asks it to take over when it is about to load anew (register.ts),
 * so no open page is changed under it. With no page open, it takes over the
 * next time the app opens.
 */

import { answerOf, cacheName, keepable, previousCache, staleCaches, type Release } from './cache';
import { ACTIVATE, noticeOf, openingOf, shownOptions, type OpenMessage } from './notify';

declare const self: ServiceWorkerGlobalScope;
/** The release, written in by the build (precache.ts). */
declare const __FLARECHAT_RELEASE__: Release;

const RELEASE: Release = __FLARECHAT_RELEASE__;
const CACHE = cacheName(RELEASE.version);
/** Where each release cache notes when it was filled, so the next release knows which it replaced. */
const FILLED = '/__flarechat-filled';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Fetched past the HTTP cache, so the release is the files as they are now.
    await cache.addAll(RELEASE.precache.map((file) => new Request(file, { cache: 'reload' })));
    await cache.put(FILLED, new Response(String(Date.now())));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const filled = await Promise.all(names.map(async (name) => {
      const marker = await (await caches.open(name)).match(FILLED);
      return { name, at: Number(await marker?.text() ?? 0) };
    }));
    const previous = previousCache(filled, CACHE);
    await Promise.all(staleCaches(names, CACHE, previous).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Kept alive until it has taken over, so a worker woken only for this message is not stopped first.
  if (event.data === ACTIVATE) event.waitUntil(self.skipWaiting());
});

/** The app shell, without the redirect it may have been fetched through, which a page may not be answered with. */
const shell = async (): Promise<Response | null> => {
  const cached = await (await caches.open(CACHE)).match(SHELL);
  // Read whole rather than streamed, so the page's answer holds no stream open on this release.
  return cached ? new Response(await cached.blob(), { status: cached.status, statusText: cached.statusText, headers: cached.headers }) : null;
};

const built = async (request: Request): Promise<Response> => {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (keepable(response)) {
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
  }
  return response;
};

self.addEventListener('fetch', (event) => {
  const answer = answerOf(event.request, self.location.origin);
  if (answer === 'network') return;
  if (answer === 'page') {
    event.respondWith(shell().then((cached) => cached ?? fetch(event.request)));
    return;
  }
  if (answer === 'built') {
    event.respondWith(built(event.request));
    return;
  }
  event.respondWith((async () => await (await caches.open(CACHE)).match(event.request) ?? fetch(event.request))());
});

self.addEventListener('push', (event) => {
  const notice = noticeOf(event.data?.text() ?? null);
  event.waitUntil(self.registration.showNotification(notice.title, shownOptions(notice)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const url = typeof data?.url === 'string' ? data.url : '/chat';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const opening = openingOf(windows.map((client) => ({ url: client.url, focused: client.focused, visible: client.visibilityState === 'visible' })), url, self.location.origin);
    if (opening.kind === 'open') {
      await self.clients.openWindow(url);
      return;
    }
    const client = windows[opening.index];
    if (!client) return;
    if (opening.kind === 'navigate') client.postMessage({ kind: 'open', url } satisfies OpenMessage);
    await client.focus();
  })());
});
