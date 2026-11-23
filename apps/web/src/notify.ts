/**
 * What the Service Worker shows for a push from the Worker, and where tapping
 * it goes. The Worker sends a notification already in words (notices.ts);
 * the worker shows it as it is, and one that is not such a notification as a
 * plain one of FlareChat's, since a push must always show something.
 *
 * Tapping a notification opens its conversation: a window already on it is
 * brought forward; otherwise a FlareChat window is brought forward and told to
 * go there; with none open, a new one opens there.
 */

/** A notification as the worker shows it. */
export interface Notice {
  title: string;
  body: string;
  /** The conversation it opens, as a path of this site. */
  url: string;
  tag: string;
}

/** What is shown for a push that does not say what it is. */
const FALLBACK: Notice = { title: 'FlareChat', body: '新しいお知らせがあります。', url: '/chat', tag: 'flarechat' };

const TEXT_CHARACTERS = 200;

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, TEXT_CHARACTERS) : fallback;

/** A path of this site to open, never another site's address. */
const sitePath = (value: unknown): string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : FALLBACK.url;

/** The notification a push's text says, or FlareChat's plain one. */
export const noticeOf = (data: string | null): Notice => {
  if (!data) return FALLBACK;
  try {
    const parsed = JSON.parse(data) as Partial<Record<keyof Notice, unknown>> | null;
    if (!parsed || typeof parsed !== 'object') return FALLBACK;
    return {
      title: text(parsed.title, FALLBACK.title),
      body: text(parsed.body, ''),
      url: sitePath(parsed.url),
      tag: text(parsed.tag, FALLBACK.tag),
    };
  } catch {
    return FALLBACK;
  }
};

/** The options the worker shows a notice with; a new one of the same conversation replaces the last, and still sounds. */
export const shownOptions = (notice: Notice): NotificationOptions & { renotify: boolean } => ({
  body: notice.body,
  tag: notice.tag,
  renotify: true,
  icon: '/icon-192.png',
  badge: '/icon-192.png',
  lang: 'ja',
  data: { url: notice.url },
});

/** A window of the site, as the worker sees it. */
export interface SiteWindow {
  url: string;
  focused: boolean;
  visible: boolean;
}

/** What tapping a notification does: bring a window on the conversation forward, send one there, or open one. */
export type Opening = { kind: 'focus'; index: number } | { kind: 'navigate'; index: number } | { kind: 'open' };

export const openingOf = (windows: readonly SiteWindow[], url: string, origin: string): Opening => {
  const target = new URL(url, origin);
  const at = (window: SiteWindow): boolean => {
    const opened = new URL(window.url);
    return opened.origin === target.origin && opened.pathname === target.pathname;
  };
  const exact = windows.findIndex(at);
  if (exact >= 0) return { kind: 'focus', index: exact };
  const ours = windows.map((window, index) => ({ window, index })).filter(({ window }) => new URL(window.url).origin === target.origin);
  // The window looked at last is the one the person expects to come forward.
  const best = ours.find(({ window }) => window.focused) ?? ours.find(({ window }) => window.visible) ?? ours[0];
  return best ? { kind: 'navigate', index: best.index } : { kind: 'open' };
};

/** What the worker tells a page it brings forward: open this path of the site. */
export interface OpenMessage {
  kind: 'open';
  url: string;
}

export const isOpenMessage = (value: unknown): value is OpenMessage =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'open' && typeof (value as { url?: unknown }).url === 'string';

/** What a page tells a waiting worker: take over now, as the page is about to load anew. */
export const ACTIVATE = 'activate';
