/**
 * What the Service Worker keeps, and how it answers each request. Its rules
 * are here, apart from the worker's events, so they are tested as they are.
 *
 * Each release has a cache of its own, filled when the worker is installed
 * with the release's app shell and Operator Chat's chunks (precache.ts),
 * and with any other built chunk the first time a page asks for it. Built
 * files never change under a name, so they are answered from any release's
 * cache first. A page is answered with the release's own index.html, so the
 * installed app opens without waiting for the network, and with the network's
 * when the release has none. The Worker's own paths (`/api`, OAuth,
 * attendance, `.well-known`, and the public pages `/about` and `/privacy`) are never answered from a cache nor kept in
 * one: an answer there is the signed-in member's.
 *
 * Activating a release keeps its own cache and the one it replaced, so a page
 * still open on the release before goes on loading that release's chunks;
 * every older cache is deleted.
 */

/** What every release cache is named after. */
export const CACHE_PREFIX = 'orangeagent-';

/** The release a worker serves: its version, and the files it fetches when installed. */
export interface Release {
  version: string;
  precache: readonly string[];
}

export const cacheName = (version: string): string => `${CACHE_PREFIX}${version}`;

/** Paths the Worker answers itself, which no cache answers or keeps. */
const WORKER_PATHS = ['/api/', '/oauth/', '/attendance/', '/.well-known/', '/about/', '/privacy/'] as const;

/** How the worker answers a request. */
export type Answer =
  /** Left to the browser and the network, untouched. */
  | 'network'
  /** A page: the release's app shell, or the network when it has none. */
  | 'page'
  /** A built file: from any release's cache, or fetched and kept in this release's. */
  | 'built'
  /** Anything else of the site (an icon, the manifest): from this release's cache, or the network. */
  | 'site';

export const answerOf = (request: { method: string; url: string; mode: string }, origin: string): Answer => {
  if (request.method !== 'GET') return 'network';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'network';
  if (WORKER_PATHS.some((prefix) => url.pathname.startsWith(prefix) || `${url.pathname}/` === prefix)) return 'network';
  if (request.mode === 'navigate') return 'page';
  if (url.pathname.startsWith('/assets/')) return 'built';
  if (url.pathname === '/sw.js') return 'network';
  return 'site';
};

/** The caches activating `current` deletes: every release's but its own and the one it replaced. */
export const staleCaches = (names: readonly string[], current: string, previous: string | null): string[] =>
  names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current && name !== previous);

/** The release cache a worker that activates replaces: the newest other release's, by when each was filled. */
export const previousCache = (filled: ReadonlyArray<{ name: string; at: number }>, current: string): string | null =>
  filled.filter((entry) => entry.name !== current && entry.name.startsWith(CACHE_PREFIX))
    .reduce<{ name: string; at: number } | null>((newest, entry) => newest === null || entry.at > newest.at ? entry : newest, null)?.name ?? null;

/** Whether a fetched built file may be kept: a whole answer of the site itself. */
export const keepable = (response: { ok: boolean; status: number; type: string }): boolean =>
  response.ok && response.status === 200 && response.type === 'basic';
