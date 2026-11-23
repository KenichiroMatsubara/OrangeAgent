import { describe, expect, it } from 'vitest';

import { isOpenMessage, noticeOf, openingOf, shownOptions } from './notify';

const ORIGIN = 'https://flarechat.example';
const window = (path: string, focused = false, visible = false) => ({ url: `${ORIGIN}${path}`, focused, visible });

describe('what a push shows', () => {
  it('shows the Worker\'s notification as it is, replacing the conversation\'s last one, and still sounding', () => {
    const notice = noticeOf(JSON.stringify({ title: '承認待ち：スキルを書く', body: '請求書の確認', url: '/chat/thread-1', tag: 'chat-thread-1' }));

    expect(notice).toEqual({ title: '承認待ち：スキルを書く', body: '請求書の確認', url: '/chat/thread-1', tag: 'chat-thread-1' });
    expect(shownOptions(notice)).toMatchObject({ body: '請求書の確認', tag: 'chat-thread-1', renotify: true, icon: '/icon-192.png', data: { url: '/chat/thread-1' } });
  });

  it('shows FlareChat\'s plain notification for a push that does not say what it is, and never opens another site', () => {
    expect(noticeOf(null)).toMatchObject({ title: 'FlareChat', url: '/chat' });
    expect(noticeOf('not json')).toMatchObject({ title: 'FlareChat' });
    expect(noticeOf('[]')).toMatchObject({ title: 'FlareChat' });
    expect(noticeOf(JSON.stringify({ title: '完了', url: 'https://evil.example/' })).url).toBe('/chat');
    expect(noticeOf(JSON.stringify({ title: '完了', url: '//evil.example/' })).url).toBe('/chat');
    expect(noticeOf(JSON.stringify({ title: 'x'.repeat(500) })).title).toHaveLength(200);
  });
});

describe('where tapping a notification goes', () => {
  it('brings forward a window already on the conversation', () => {
    expect(openingOf([window('/chat'), window('/chat/thread-1?x=1')], '/chat/thread-1', ORIGIN)).toEqual({ kind: 'focus', index: 1 });
  });

  it('sends the window looked at last there, and opens one when none is open', () => {
    expect(openingOf([window('/home'), window('/events', false, true), window('/chat', true, true)], '/chat/thread-1', ORIGIN)).toEqual({ kind: 'navigate', index: 2 });
    expect(openingOf([window('/home'), window('/events', false, true)], '/chat/thread-1', ORIGIN)).toEqual({ kind: 'navigate', index: 1 });
    expect(openingOf([window('/home')], '/chat/thread-1', ORIGIN)).toEqual({ kind: 'navigate', index: 0 });
    expect(openingOf([], '/chat/thread-1', ORIGIN)).toEqual({ kind: 'open' });
  });

  it('tells a page to open a path only in the shape the worker sends', () => {
    expect(isOpenMessage({ kind: 'open', url: '/chat/thread-1' })).toBe(true);
    expect(isOpenMessage({ kind: 'open' })).toBe(false);
    expect(isOpenMessage('activate')).toBe(false);
  });
});
