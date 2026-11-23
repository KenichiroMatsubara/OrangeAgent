import { describe, expect, it } from 'vitest';

import { deliverNotice, recipientsOf, shownOf, visibilityOf, type Notice, type NoticePorts } from './notices';
import type { PushResult } from './push';
import type { Subscription } from './subscriptions';

const notice = (overrides: Partial<Notice> = {}): Notice => ({
  kind: 'approval', threadId: 'thread-1', runId: 'run-1', title: '請求書の確認', label: 'スキルを書く', askedBy: [], ...overrides,
});

const device = (identityId: string, endpoint: string): Subscription => ({ identityId, endpoint, p256dh: 'k', auth: 'a' });

/** The notifier's surroundings: who started the conversation, who is looking, and which browsers there are. */
const surroundings = (options: { starter?: string | null; watching?: string[]; devices?: Subscription[]; results?: Record<string, PushResult> } = {}) => {
  const claimed = new Set<string>();
  const pushed: Array<{ endpoint: string; payload: string; ttl: number; topic: string; urgency: string }> = [];
  const forgotten: string[] = [];
  const watching = new Set(options.watching ?? []);
  const ports: NoticePorts = {
    starter: async () => options.starter === undefined ? 'identity-1' : options.starter,
    watching: () => watching,
    claim: async (claimedNotice) => {
      const key = `${claimedNotice.threadId}:${claimedNotice.runId}:${claimedNotice.kind}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    subscriptions: async (members) => (options.devices ?? [device('identity-1', 'https://push.example.net/1')]).filter((entry) => members.includes(entry.identityId)),
    push: async (subscription, payload, sent) => {
      pushed.push({ endpoint: subscription.endpoint, payload, ...sent });
      return options.results?.[subscription.endpoint] ?? 'sent';
    },
    forget: async (endpoint) => {
      forgotten.push(endpoint);
    },
  };
  return { ports, pushed, forgotten, watching, claimed };
};

describe('what a notification says', () => {
  it('names the waiting tool and the conversation in words, and goes to the conversation', () => {
    expect(shownOf(notice())).toEqual({ title: '承認待ち：スキルを書く', body: '請求書の確認', url: '/chat/thread-1', tag: 'chat-thread-1' });
    expect(shownOf(notice({ kind: 'completed', title: '' }))).toMatchObject({ title: '完了：AI が答えました', body: '新しい会話' });
    expect(shownOf(notice({ kind: 'failed' }))).toMatchObject({ title: '失敗：AI の答えが途中で止まりました' });
    expect(shownOf(notice({ kind: 'approval', label: '' })).title).toBe('承認待ち');
    expect(shownOf(notice({ threadId: 'a b/c' })).url).toBe('/chat/a%20b%2Fc');
  });

  it('is for whoever started the conversation and whoever asked, each once', () => {
    expect(recipientsOf('identity-1', { askedBy: ['identity-2', 'identity-1'] })).toEqual(['identity-1', 'identity-2']);
    expect(recipientsOf(null, { askedBy: [] })).toEqual([]);
  });

  it('reads a screen saying whether the conversation is in view, and nothing else', () => {
    expect(visibilityOf('{"kind":"visibility","visible":false}')).toBe(false);
    expect(visibilityOf('{"kind":"visibility","visible":true}')).toBe(true);
    expect(visibilityOf('{"kind":"visibility","visible":"no"}')).toBeNull();
    expect(visibilityOf('{"kind":"other"}')).toBeNull();
    expect(visibilityOf('not json')).toBeNull();
    expect(visibilityOf(new ArrayBuffer(4))).toBeNull();
  });
});

describe('sending a notice', () => {
  it('sends to every browser of the members it is for, urgently for an approval, under one topic per conversation and kind', async () => {
    const { ports, pushed } = surroundings({ devices: [device('identity-1', 'https://push.example.net/1'), device('identity-1', 'https://push.example.net/2'), device('identity-3', 'https://push.example.net/3')] });

    expect(await deliverNotice(notice(), ports)).toEqual({ sent: 2 });
    expect(pushed.map((entry) => entry.endpoint)).toEqual(['https://push.example.net/1', 'https://push.example.net/2']);
    expect(JSON.parse(pushed[0]?.payload ?? '{}')).toEqual({ title: '承認待ち：スキルを書く', body: '請求書の確認', url: '/chat/thread-1', tag: 'chat-thread-1' });
    expect(pushed[0]).toMatchObject({ urgency: 'high', ttl: 86_400 });
    expect(pushed[0]?.topic).toMatch(/^[\w-]{32}$/u);

    const done = surroundings();
    await deliverNotice(notice({ kind: 'completed' }), done.ports);
    expect(done.pushed[0]).toMatchObject({ urgency: 'normal' });
    expect(done.pushed[0]?.topic).not.toBe(pushed[0]?.topic);
  });

  it('tells nobody who has the conversation open and in view', async () => {
    const { ports, pushed, watching, claimed } = surroundings({ devices: [device('identity-1', 'https://push.example.net/1'), device('identity-2', 'https://push.example.net/2')] });
    watching.add('identity-1');

    expect(await deliverNotice(notice({ askedBy: ['identity-2'] }), ports)).toEqual({ sent: 1 });
    expect(pushed.map((entry) => entry.endpoint)).toEqual(['https://push.example.net/2']);

    watching.add('identity-2');
    expect(await deliverNotice(notice({ runId: 'run-2', askedBy: ['identity-2'] }), ports)).toEqual({ skipped: 'watching' });
    // Nothing was sent, so nothing counts as sent: the answer's next approval is free to tell.
    expect(claimed.has('thread-1:run-2:approval')).toBe(false);
    watching.clear();
    expect(await deliverNotice(notice({ runId: 'run-2', askedBy: ['identity-2'] }), ports)).toEqual({ sent: 2 });
  });

  it('sends at most one notice of each kind per answer', async () => {
    const { ports, pushed } = surroundings();

    expect(await deliverNotice(notice(), ports)).toEqual({ sent: 1 });
    expect(await deliverNotice(notice({ label: '予定を作る' }), ports)).toEqual({ skipped: 'sent_before' });
    expect(await deliverNotice(notice({ kind: 'completed' }), ports)).toEqual({ sent: 1 });
    expect(await deliverNotice(notice({ kind: 'completed' }), ports)).toEqual({ skipped: 'sent_before' });
    expect(await deliverNotice(notice({ runId: 'run-2' }), ports)).toEqual({ sent: 1 });
    expect(pushed).toHaveLength(3);
  });

  it('forgets a browser its push service no longer knows, and keeps one that failed for a while', async () => {
    const { ports, forgotten } = surroundings({
      devices: [device('identity-1', 'https://push.example.net/gone'), device('identity-1', 'https://push.example.net/busy'), device('identity-1', 'https://push.example.net/ok')],
      results: { 'https://push.example.net/gone': 'gone', 'https://push.example.net/busy': 'failed' },
    });

    expect(await deliverNotice(notice(), ports)).toEqual({ sent: 1 });
    expect(forgotten).toEqual(['https://push.example.net/gone']);
  });

  it('tells nobody when nobody is named, or nobody it is for has a browser', async () => {
    expect(await deliverNotice(notice(), surroundings({ starter: null }).ports)).toEqual({ skipped: 'nobody' });
    const empty = surroundings({ devices: [] });
    expect(await deliverNotice(notice(), empty.ports)).toEqual({ skipped: 'no_device' });
    expect(empty.claimed.size).toBe(0);
  });
});
