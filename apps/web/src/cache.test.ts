import { describe, expect, it } from 'vitest';

import { answerOf, cacheName, keepable, previousCache, staleCaches } from './cache';

const ORIGIN = 'https://orangeagent.example';
const get = (path: string, mode = 'cors') => ({ method: 'GET', url: `${ORIGIN}${path}`, mode });

describe('how the Service Worker answers a request', () => {
  it('never answers the Worker\'s own paths, another site, or a write from a cache', () => {
    expect(answerOf(get('/api/organizations/org-1/chat-threads'), ORIGIN)).toBe('network');
    expect(answerOf(get('/api/bootstrap', 'navigate'), ORIGIN)).toBe('network');
    expect(answerOf(get('/oauth/google/callback?code=1', 'navigate'), ORIGIN)).toBe('network');
    expect(answerOf(get('/attendance/abc', 'navigate'), ORIGIN)).toBe('network');
    expect(answerOf(get('/.well-known/oauth-authorization-server'), ORIGIN)).toBe('network');
    expect(answerOf({ method: 'POST', url: `${ORIGIN}/assets/index-1.js`, mode: 'cors' }, ORIGIN)).toBe('network');
    expect(answerOf({ method: 'GET', url: 'https://fonts.example/a.woff2', mode: 'cors' }, ORIGIN)).toBe('network');
    expect(answerOf(get('/sw.js'), ORIGIN)).toBe('network');
  });

  it('answers a page with the app shell, a built file from the caches, and the rest of the site from the release', () => {
    expect(answerOf(get('/chat/thread-1', 'navigate'), ORIGIN)).toBe('page');
    expect(answerOf(get('/', 'navigate'), ORIGIN)).toBe('page');
    // A page path that only starts like the Worker's is still a page.
    expect(answerOf(get('/apiary', 'navigate'), ORIGIN)).toBe('page');
    expect(answerOf(get('/assets/surface-C1VlmGfW.js'), ORIGIN)).toBe('built');
    expect(answerOf(get('/icon-192.png', 'no-cors'), ORIGIN)).toBe('site');
    expect(answerOf(get('/manifest.webmanifest'), ORIGIN)).toBe('site');
  });

  it('keeps only whole answers of the site itself', () => {
    expect(keepable({ ok: true, status: 200, type: 'basic' })).toBe(true);
    expect(keepable({ ok: true, status: 206, type: 'basic' })).toBe(false);
    expect(keepable({ ok: false, status: 404, type: 'basic' })).toBe(false);
    expect(keepable({ ok: false, status: 0, type: 'opaque' })).toBe(false);
  });
});

describe('the caches a release keeps', () => {
  it('keeps its own and the one it replaced, and deletes every older release\'s and nothing else', () => {
    const current = cacheName('c');
    const names = [cacheName('a'), cacheName('b'), current, 'someone-else'];
    const previous = previousCache([{ name: cacheName('a'), at: 1 }, { name: cacheName('b'), at: 2 }, { name: current, at: 3 }, { name: 'someone-else', at: 9 }], current);

    expect(previous).toBe(cacheName('b'));
    expect(staleCaches(names, current, previous)).toEqual([cacheName('a')]);
    expect(previousCache([{ name: current, at: 3 }], current)).toBeNull();
    expect(staleCaches([current], current, null)).toEqual([]);
  });
});
