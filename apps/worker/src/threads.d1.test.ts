/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import controlSchemaMigration from '../migrations/control/0000_initial.sql';
import { provisionAccountDatabase } from './account-db';
import type { Pause, Progress } from './pause';
import { allowTool, appendEvents, createThread, dropProgress, dropUploads, isAllowed, keepFile, listFiles, listThreads, putUploads, readEvents, readFile, readPause, readProgress, readThread, readUploads, recordUploads, saveMode, savePause, saveProgress, saveProjection, takePause } from './threads';

declare global {
  namespace Cloudflare {
    interface Env {
      CONTROL_DB: D1Database;
      LOCAL_ORGANIZATION_DB_1: D1Database;
      RECOVERY_RECEIPTS: R2Bucket;
    }
  }
}

/** A fresh Account database with every migration applied, as provisioning applies them. */
const migratedAccount = async (): Promise<D1Database> => {
  await env.CONTROL_DB.batch(controlSchemaMigration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => env.CONTROL_DB.prepare(statement)));
  const provisioned = await provisionAccountDatabase({
    CONTROL_DB: env.CONTROL_DB,
    LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
  } as unknown as Parameters<typeof provisionAccountDatabase>[0], {
    accountId: 'organization-1',
    ownerAddress: 'first@example.com',
    bindingName: 'ORG_ORGANIZATION1',
    databaseId: null,
  });
  await provisioned.initialize();
  return provisioned.database;
};

describe('the Operator Chat conversations in D1', () => {
  it('applies migration 0058 and keeps the events of a conversation in order, after any sequence', async () => {
    const database = await migratedAccount();
    const applied = await database.prepare("SELECT name FROM d1_migrations WHERE name = '0058_chat_threads.sql'").all<{ name: string }>();
    expect(applied.results).toHaveLength(1);

    const thread = await createThread({ database, accountId: 'organization-1', createdBy: { identityId: 'identity-1', name: '山田' }, timestamp: '2026-11-21T00:00:00.000Z' });
    const events = [1, 2, 4].map((sequence) => ({
      sequence, type: 'turn-item.updated', payload: JSON.stringify({ type: 'turn-item.updated', sequence, text: `第${sequence}` }), createdAt: '2026-11-21T00:00:01.000Z',
    }));
    await appendEvents({ database, threadId: thread.id, events: events.slice(0, 2), title: '今日の予定', timestamp: '2026-11-21T00:00:01.000Z' });
    await appendEvents({ database, threadId: thread.id, events: events.slice(2), timestamp: '2026-11-21T00:00:02.000Z' });

    expect(await readEvents(database, thread.id, 0)).toEqual(events);
    expect(await readEvents(database, thread.id, 2)).toEqual(events.slice(2));
    expect(await readThread(database, thread.id)).toMatchObject({ title: '今日の予定', lastSequence: 4, projection: null, projectionSequence: 0, updatedAt: '2026-11-21T00:00:02.000Z' });

    await saveProjection({ database, threadId: thread.id, projection: '{"thread":{}}', sequence: 4 });
    expect(await readThread(database, thread.id)).toMatchObject({ projection: '{"thread":{}}', projectionSequence: 4 });
    expect(await listThreads(database)).toEqual([{ id: thread.id, title: '今日の予定', createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:02.000Z' }]);
  });

  it('refuses a sequence the conversation already holds, so no event is kept twice', async () => {
    const database = await migratedAccount();
    const thread = await createThread({ database, accountId: 'organization-1', createdBy: { identityId: null, name: '' }, timestamp: '2026-11-21T00:00:00.000Z' });
    const event = { sequence: 1, type: 'run.created', payload: '{}', createdAt: '2026-11-21T00:00:01.000Z' };
    await appendEvents({ database, threadId: thread.id, events: [event], timestamp: event.createdAt });

    await expect(appendEvents({ database, threadId: thread.id, events: [event], timestamp: event.createdAt })).rejects.toThrow();
    expect(await readThread(database, thread.id)).toMatchObject({ lastSequence: 1 });
  });

  it('applies migration 0059 and starts a member\'s first conversation in unrestricted, then each in the mode of their latest', async () => {
    const database = await migratedAccount();
    const applied = await database.prepare("SELECT name FROM d1_migrations WHERE name = '0059_chat_approvals.sql'").all<{ name: string }>();
    expect(applied.results).toHaveLength(1);
    const yamada = { identityId: 'identity-1', name: '山田' };
    const sato = { identityId: 'identity-2', name: '佐藤' };

    const first = await createThread({ database, accountId: 'organization-1', createdBy: yamada, timestamp: '2026-11-21T00:00:00.000Z' });
    expect(await readThread(database, first.id)).toMatchObject({ mode: 'unrestricted' });

    await saveMode({ database, threadId: first.id, mode: 'ask', by: yamada, timestamp: '2026-11-21T00:01:00.000Z' });
    const second = await createThread({ database, accountId: 'organization-1', createdBy: yamada, timestamp: '2026-11-21T00:02:00.000Z' });
    expect(await readThread(database, second.id)).toMatchObject({ mode: 'ask' });
    // A conversation they created, inheriting its mode, is as latest as one they changed.
    const third = await createThread({ database, accountId: 'organization-1', createdBy: yamada, timestamp: '2026-11-21T00:03:00.000Z' });
    expect(await readThread(database, third.id)).toMatchObject({ mode: 'ask' });
    // Another member's choice is theirs.
    const others = await createThread({ database, accountId: 'organization-1', createdBy: sato, timestamp: '2026-11-21T00:04:00.000Z' });
    expect(await readThread(database, others.id)).toMatchObject({ mode: 'unrestricted' });

    await saveMode({ database, threadId: first.id, mode: 'read_only', by: yamada, timestamp: '2026-11-21T00:05:00.000Z' });
    const fourth = await createThread({ database, accountId: 'organization-1', createdBy: yamada, timestamp: '2026-11-21T00:06:00.000Z' });
    expect(await readThread(database, fourth.id)).toMatchObject({ mode: 'read_only' });
    expect((await database.prepare('SELECT mode, changed_by_identity FROM chat_thread_modes WHERE thread_id = ?').bind(fourth.id).first())).toEqual({ mode: 'read_only', changed_by_identity: null });
    // A conversation kept in auto is kept so, whether or not the Worker can ask a Decider now.
    await saveMode({ database, threadId: fourth.id, mode: 'auto', by: sato, timestamp: '2026-11-21T00:07:00.000Z' });
    const fifth = await createThread({ database, accountId: 'organization-1', createdBy: sato, timestamp: '2026-11-21T00:08:00.000Z' });
    expect(await readThread(database, fifth.id)).toMatchObject({ mode: 'auto' });
  });

  it('keeps an answer waiting for approval in D1 and R2, hands it out once, and removes what it kept', async () => {
    const database = await migratedAccount();
    const bucket = env.RECOVERY_RECEIPTS;
    const thread = await createThread({ database, accountId: 'organization-1', createdBy: { identityId: null, name: '' }, timestamp: '2026-11-21T00:00:00.000Z' });
    const pause: Pause = {
      id: 'request-1', runId: 'run-1', request: '送って', model: 'm', itemId: 'item-1', createdAt: '2026-11-21T00:00:01.000Z',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'mail.read', arguments: '{}' }, { id: 'call-2', name: 'mail.send', arguments: '{"to":"a@example.com"}' }] },
        { role: 'tool', name: 'mail.read', toolCallId: 'call-1', content: '{}', attachments: [{ filename: 'a.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }] },
      ],
      calls: [{ id: 'call-2', name: 'mail.send', arguments: '{"to":"a@example.com"}' }],
      reason: '確認します。', label: 'メールを送る', description: 'メールを送る\nto: a@example.com', preview: null,
      spent: { model: 'm', tokens: 30, toolCalls: 2, output: '' },
    };

    await savePause({ database, bucket, accountId: 'organization-1', threadId: thread.id, pause });

    expect(await database.prepare('SELECT id, run_id, call_id, tool, arguments, item_id FROM chat_pauses').first()).toEqual({
      id: 'request-1', run_id: 'run-1', call_id: 'call-2', tool: 'mail.send', arguments: '{"to":"a@example.com"}', item_id: 'item-1',
    });
    expect(await readPause({ database, bucket, threadId: thread.id })).toEqual(pause);
    expect(await takePause({ database, bucket, threadId: thread.id, pauseId: 'other' })).toBeNull();
    expect(await takePause({ database, bucket, threadId: thread.id, pauseId: 'request-1' })).toEqual(pause);
    expect(await takePause({ database, bucket, threadId: thread.id, pauseId: 'request-1' })).toBeNull();
    expect(await readPause({ database, bucket, threadId: thread.id })).toBeNull();
    expect((await bucket.list({ prefix: 'chat-pauses/' })).objects).toEqual([]);

    // A pause left by an answer that ended is replaced, since a conversation waits on one call at a time.
    await savePause({ database, bucket, accountId: 'organization-1', threadId: thread.id, pause });
    await savePause({ database, bucket, accountId: 'organization-1', threadId: thread.id, pause: { ...pause, id: 'request-2' } });
    expect((await readPause({ database, bucket, threadId: thread.id }))?.id).toBe('request-2');
    expect((await bucket.list({ prefix: 'chat-pauses/organization-1/request-1/' })).objects).toEqual([]);
  });

  it('keeps how far an answer has got in R2, each file once, and forgets it', async () => {
    const bucket = env.RECOVERY_RECEIPTS;
    const target = { bucket, accountId: 'organization-1', threadId: 'thread-1' };
    const read: Progress['messages'][number] = { role: 'tool', name: 'mail.read', toolCallId: 'call-1', content: '{}', attachments: [{ filename: 'a.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }] };
    const progress: Progress = {
      runId: 'run-1', request: '読んで', model: 'm', effort: 'high', restarts: 0,
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'mail.read', arguments: '{}' }] }, read],
      spent: { model: 'm', tokens: 30, toolCalls: 1, output: '' },
    };

    expect(await readProgress({ ...target, runId: 'run-1' })).toBeNull();
    expect(await saveProgress({ ...target, progress, kept: 0 })).toBe(1);
    expect(await readProgress({ ...target, runId: 'run-1' })).toEqual(progress);

    // A file kept already is not written again.
    await bucket.put('chat-progress/organization-1/thread-1/run-1/files/0', new Uint8Array([9]));
    const further: Progress = { ...progress, messages: [...progress.messages, { ...read, toolCallId: 'call-2', attachments: [{ filename: 'b.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([4]) }] }] };
    expect(await saveProgress({ ...target, progress: further, kept: 1 })).toBe(2);
    const reread = await readProgress({ ...target, runId: 'run-1' });
    expect(reread?.messages.map((message) => [...message.attachments?.[0]?.bytes ?? []])).toEqual([[], [9], [4]]);

    await dropProgress({ ...target, runId: 'run-1' });
    expect(await readProgress({ ...target, runId: 'run-1' })).toBeNull();
    expect((await bucket.list({ prefix: 'chat-progress/' })).objects).toEqual([]);
  });

  it('allows a tool always for the Account, keeping who allowed it first', async () => {
    const database = await migratedAccount();
    expect(await isAllowed(database, 'mail.send')).toBe(false);

    await allowTool({ database, tool: 'mail.send', by: { identityId: 'identity-1', name: '山田' }, timestamp: '2026-11-21T00:00:00.000Z' });
    await allowTool({ database, tool: 'mail.send', by: { identityId: 'identity-2', name: '佐藤' }, timestamp: '2026-11-21T00:01:00.000Z' });

    expect(await isAllowed(database, 'mail.send')).toBe(true);
    expect(await isAllowed(database, 'channel.send')).toBe(false);
    expect(await database.prepare('SELECT tool, allowed_by_name FROM chat_tool_allowances').all()).toMatchObject({ results: [{ tool: 'mail.send', allowed_by_name: '山田' }] });
  });

  it('applies migration 0060 and keeps the files a member sends apart from those answers kept, in the order sent', async () => {
    const database = await migratedAccount();
    const bucket = env.RECOVERY_RECEIPTS;
    const applied = await database.prepare("SELECT name FROM d1_migrations WHERE name = '0060_chat_message_files.sql'").all<{ name: string }>();
    expect(applied.results).toHaveLength(1);
    const thread = await createThread({ database, accountId: 'organization-1', createdBy: { identityId: null, name: '' }, timestamp: '2026-11-21T00:00:00.000Z' });
    const written = await keepFile({ database, bucket, accountId: 'organization-1', threadId: thread.id, runId: 'run-1', file: { filename: 'report.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1]) }, timestamp: '2026-11-21T00:00:01.000Z' });

    // Twelve files, more than one statement binds.
    const sent = await putUploads({ bucket, accountId: 'organization-1', files: Array.from({ length: 12 }, (_, index) => ({ filename: `photo-${index}.png`, mediaType: 'image/png', bytes: new Uint8Array([index]) })) });
    await recordUploads({ database, threadId: thread.id, runId: 'run-2', files: sent, timestamp: '2026-11-21T00:00:02.000Z' });

    // An answer's sandbox and Drive reach only what answers kept.
    expect((await listFiles(database, thread.id)).map((file) => file.id)).toEqual([written.id]);
    const read = await readUploads({ database, bucket, threadId: thread.id, ids: [sent[3]?.id ?? '', 'missing', sent[0]?.id ?? ''] });
    expect(read).toEqual([
      { filename: 'photo-3.png', mediaType: 'image/png', bytes: new Uint8Array([3]) },
      { filename: 'photo-0.png', mediaType: 'image/png', bytes: new Uint8Array([0]) },
    ]);
    // The conversation's file route serves them as it serves an answer's.
    expect(await readFile({ database, bucket, threadId: thread.id, fileId: sent[11]?.id ?? '' })).toMatchObject({ filename: 'photo-11.png', runId: 'run-2' });
    expect(await database.prepare("SELECT origin, position FROM chat_files WHERE run_id = 'run-2' ORDER BY position").all()).toMatchObject({
      results: Array.from({ length: 12 }, (_, position) => ({ origin: 'request', position })),
    });

    const unsent = await putUploads({ bucket, accountId: 'organization-1', files: [{ filename: 'x.png', mediaType: 'image/png', bytes: new Uint8Array([9]) }] });
    await dropUploads(bucket, unsent);
    expect(await bucket.get(unsent[0]?.objectKey ?? '')).toBeNull();
  });
});
