import { describe, expect, it } from 'vitest';

import { memoryGoogle } from '../test/providers';
import { GoogleApiError } from './providers';
import { searchMail } from './workspace';
import { toolHandlers } from './tools';
import type { FileAnswer } from './turns';

const handlers = (google = memoryGoogle()) => ({
  google,
  tools: toolHandlers({
    database: {} as D1Database,
    accountId: 'organization-1',
    reach: { kind: 'anyone' },
    mail: { kind: 'mailbox' },
    google: { provider: google, session: async () => ({ accessToken: 'token', readAttachments: async () => [] }) },
    origin: { automationId: null, sourceMessageId: null },
    at: () => new Date(),
  }),
});

describe('workspace tools', () => {
  it('finds mail with its sender, subject, and the time it arrived in Asia/Tokyo', async () => {
    const google = memoryGoogle();
    google.addMessage({ id: 'message-1', subject: '秋季総会のご案内', sender: '事務局 <office@example.com>', body: '10月20日に開催します。', internalDate: '1789000000000', snippet: '10月20日に開催します。' });

    const found = await searchMail({ google, accessToken: 'token', query: 'newer_than:30d', maxResults: undefined });

    expect(found).toEqual({ messages: [{
      id: 'message-1',
      from: '事務局 <office@example.com>',
      subject: '秋季総会のご案内',
      receivedAt: '2026-09-10T09:26:40+09:00',
      snippet: '10月20日に開催します。',
    }], nextPageToken: null });
  });

  it('returns one page of 50 matches as summaries, read a few at a time, and where the next page starts', async () => {
    const google = memoryGoogle();
    for (let index = 0; index < 120; index += 1) google.addMessage({ id: `message-${index}`, subject: `請求 ${index}`, sender: 'billing@example.com', body: '本文' });
    let reading = 0;
    let most = 0;
    const views: Array<string | undefined> = [];
    const read = google.gmail.readMessage;
    google.gmail.readMessage = async (token, messageId, view) => {
      views.push(view);
      reading += 1;
      most = Math.max(most, reading);
      await new Promise((resolve) => setTimeout(resolve, 1));
      reading -= 1;
      return read(token, messageId, view);
    };

    const first = await searchMail({ google, accessToken: 'token', query: '請求', maxResults: undefined });

    expect(first.messages.map((message) => message.id)).toEqual(Array.from({ length: 50 }, (_, index) => `message-${index}`));
    expect(first.nextPageToken).not.toBeNull();
    expect(most).toBeLessThanOrEqual(4);
    expect(new Set(views)).toEqual(new Set(['summary']));

    const next = await searchMail({ google, accessToken: 'token', query: '請求', maxResults: 1_000, pageToken: first.nextPageToken });

    expect(next.messages.map((message) => message.id)).toEqual(Array.from({ length: 70 }, (_, index) => `message-${index + 50}`));
    expect(next.nextPageToken).toBeNull();
  });

  it('never returns more than 100 matches from one search', async () => {
    const google = memoryGoogle();
    for (let index = 0; index < 150; index += 1) google.addMessage({ id: `message-${index}`, subject: `請求 ${index}`, sender: 'billing@example.com', body: '本文' });

    const found = await searchMail({ google, accessToken: 'token', query: '請求', maxResults: 1_000 });

    expect(found.messages).toHaveLength(100);
    expect(found.nextPageToken).toBe('100');
  });

  it('reads one message in full', async () => {
    const { google, tools } = handlers();
    google.addMessage({ id: 'message-1', subject: '会費のお願い', sender: 'office@example.com', body: '今月末までにお振り込みください。' });

    const read = (await tools['mail.read']?.({ messageId: 'message-1' }) as FileAnswer).answer as { subject: string; body: string };

    expect(read.subject).toBe('会費のお願い');
    expect(read.body).toContain('今月末までにお振り込みください。');
  });

  it('sends to one address and refuses anything else', async () => {
    const { google, tools } = handlers();

    await expect(tools['mail.send']?.({ to: 'a@example.com, b@example.com', subject: '件名', body: '本文' })).rejects.toThrow('is not one email address');
    await expect(tools['mail.send']?.({ to: 'member@example.com', subject: '件名', body: '本文' })).resolves.toMatchObject({ sent: true });
    expect(google.mailbox.sent).toEqual([{ destination: 'member@example.com', subject: '件名', body: '本文' }]);
  });

  it('saves a draft that nobody is sent', async () => {
    const { google, tools } = handlers();

    await expect(tools['mail.draft']?.({ to: 'member@example.com', subject: '件名', body: '本文' })).resolves.toMatchObject({ drafted: true, sent: false, id: 'draft-1' });
    expect(google.mailbox.drafts).toEqual([{ destination: 'member@example.com', subject: '件名', body: '本文' }]);
    expect(google.mailbox.sent).toEqual([]);
  });

  it('tells the run to have the Inbox reconnected when its grant predates drafts', async () => {
    const { google, tools } = handlers();
    google.failNext('createDraft', new GoogleApiError('Request had insufficient authentication scopes.', 403, '/drafts'));

    await expect(tools['mail.draft']?.({ to: 'member@example.com', subject: '件名', body: '本文' }))
      .resolves.toMatchObject({ isError: true, message: expect.stringContaining('reconnects the mail inbox') });
    expect(google.mailbox.drafts).toEqual([]);
  });
});
