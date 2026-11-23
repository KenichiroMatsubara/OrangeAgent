/**
 * Operator Chat's notifications (ADR 0201): what an answer of a
 * conversation tells the people waiting on it when they are not looking.
 *
 * An answer notifies when a call waits for approval, when it asks a question
 * (the chat has no such item yet, so it never does), when it completes, and
 * when it fails; a stopped answer was stopped by someone looking, and says
 * nothing. It notifies the member who started the conversation and every
 * member who sent the answer a message or answered its approval, except a
 * member who has the conversation open and in view on any screen at that
 * moment. Each answer sends at most one notification of each kind, and only
 * one that reaches somebody counts: a waiting call nobody was told about
 * because everyone was looking leaves the next one free to tell.
 */

import { pushTopic, type PushResult } from './push';
import type { NoticeKind, Subscription } from './subscriptions';

/** What a screen says over its socket: whether the conversation is in view; anything else is ignored. */
export const visibilityOf = (message: string | ArrayBuffer): boolean | null => {
  if (typeof message !== 'string' || message.length > 200) return null;
  try {
    const parsed = JSON.parse(message) as { kind?: unknown; visible?: unknown };
    return parsed.kind === 'visibility' && typeof parsed.visible === 'boolean' ? parsed.visible : null;
  } catch {
    return null;
  }
};

/** Something an answer did that the people waiting on it are told. */
export interface Notice {
  kind: NoticeKind;
  threadId: string;
  runId: string;
  /** The conversation's title as its list shows it. */
  title: string;
  /** The waiting call's tool in words, for an approval. */
  label?: string;
  /** The members who sent the answer a message or answered it, besides whoever started the conversation. */
  askedBy: readonly string[];
}

/** A notification as the Service Worker shows it. */
export interface Shown {
  title: string;
  body: string;
  /** Where tapping it goes: the conversation. */
  url: string;
  /** Notifications of one conversation replace one another on a device. */
  tag: string;
}

/** What a conversation is called until its first message names it, as its list says. */
const UNTITLED = '新しい会話';

const HEADLINES: Readonly<Record<NoticeKind, string>> = {
  approval: '承認待ち',
  question: '質問：AI が答えを待っています',
  completed: '完了：AI が答えました',
  failed: '失敗：AI の答えが途中で止まりました',
};

/** How long a push service keeps a notification for a device that is offline, in seconds. */
const TTL: Readonly<Record<NoticeKind, number>> = { approval: 86_400, question: 86_400, completed: 21_600, failed: 21_600 };

/** The notification a notice shows, in words, naming no internal id. */
export const shownOf = (notice: Notice): Shown => ({
  title: notice.kind === 'approval' && notice.label ? `${HEADLINES.approval}：${notice.label}` : HEADLINES[notice.kind],
  body: notice.title.trim() || UNTITLED,
  url: `/chat/${encodeURIComponent(notice.threadId)}`,
  tag: `chat-${notice.threadId}`,
});

/** The members a notice is for: whoever started the conversation and whoever asked, each once. */
export const recipientsOf = (starter: string | null, notice: Pick<Notice, 'askedBy'>): string[] =>
  [...new Set([starter, ...notice.askedBy].filter((identity): identity is string => typeof identity === 'string' && identity !== ''))];

export interface NoticePorts {
  /** The member who started the conversation. */
  starter: () => Promise<string | null>;
  /** The members who have the conversation open and in view right now. */
  watching: () => ReadonlySet<string>;
  /** Records the notice as sent; false when the answer already sent one of its kind. */
  claim: (notice: Notice) => Promise<boolean>;
  subscriptions: (identityIds: readonly string[]) => Promise<Subscription[]>;
  push: (subscription: Subscription, payload: string, options: { ttl: number; topic: string; urgency: 'high' | 'normal' }) => Promise<PushResult>;
  /** Forgets a browser its push service no longer knows. */
  forget: (endpoint: string) => Promise<void>;
}

/** Why a notice reached nobody, or how many browsers it was sent to. */
export type Delivery = { sent: number } | { skipped: 'nobody' | 'watching' | 'sent_before' | 'no_device' };

/** Sends a notice to the browsers of every member it is for who is not looking at the conversation. */
export const deliverNotice = async (notice: Notice, ports: NoticePorts): Promise<Delivery> => {
  const recipients = recipientsOf(await ports.starter(), notice);
  if (!recipients.length) return { skipped: 'nobody' };
  // Read as late as possible: a member who opened the conversation meanwhile is not told.
  const watching = ports.watching();
  const away = recipients.filter((identity) => !watching.has(identity));
  if (!away.length) return { skipped: 'watching' };
  const subscriptions = await ports.subscriptions(away);
  if (!subscriptions.length) return { skipped: 'no_device' };
  if (!await ports.claim(notice)) return { skipped: 'sent_before' };
  const payload = JSON.stringify(shownOf(notice));
  const topic = await pushTopic(`${notice.threadId}:${notice.kind}`);
  const urgency = notice.kind === 'approval' || notice.kind === 'question' ? 'high' : 'normal';
  const results = await Promise.all(subscriptions.map(async (subscription) => {
    const result = await ports.push(subscription, payload, { ttl: TTL[notice.kind], topic, urgency });
    if (result === 'gone') await ports.forget(subscription.endpoint).catch(() => undefined);
    return result;
  }));
  return { sent: results.filter((result) => result === 'sent').length };
};
