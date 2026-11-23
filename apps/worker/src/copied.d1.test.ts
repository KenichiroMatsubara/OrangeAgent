/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import controlSchemaMigration from '../migrations/control/0000_initial.sql';
import copyMigration from '../migrations/organization/0061_chat_conversations_copied.sql';
import { ACCOUNT, COPIED_PATHS, COPIED_TITLES, LEGACY_CHAT, LONG_ERROR, TABLE } from '../test/conversations';
import { provisionAccountDatabase } from './account-db';
import { openConversation } from './conversation';
import { encrypt } from './cryptography';
import { appendEvents, listThreads, readEvents, readFile, readThread, readUploads, saveProjection } from './threads';
import { emptyProjection, historyOf, threadOf } from './timeline';
import { decodeEvent, decodeFrame, foldEvent, utcMillis, type Projection, type TurnItem } from '@mail/t3chat/wire';

declare global {
  namespace Cloudflare {
    interface Env {
      CONTROL_DB: D1Database;
      LOCAL_ORGANIZATION_DB_1: D1Database;
      RECOVERY_RECEIPTS: R2Bucket;
    }
  }
}

/** A fresh Account database with every migration applied, 0061 finding nothing to copy yet. */
const migratedAccount = async (): Promise<D1Database> => {
  await env.CONTROL_DB.batch(controlSchemaMigration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => env.CONTROL_DB.prepare(statement)));
  const provisioned = await provisionAccountDatabase({
    CONTROL_DB: env.CONTROL_DB,
    LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
  } as unknown as Parameters<typeof provisionAccountDatabase>[0], {
    accountId: ACCOUNT,
    ownerAddress: 'first@example.com',
    bindingName: 'ORG_ORGANIZATION1',
    databaseId: null,
  });
  await provisioned.initialize();
  return provisioned.database;
};

/** Applies migration 0061 as the Schema Lifecycle does: its statements in one batch. */
const copy = async (database: D1Database): Promise<void> => {
  await database.batch(copyMigration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => database.prepare(statement)));
};

/** The old chat's conversations in every shape production holds, in place before 0061 runs. */
const seeded = async (): Promise<D1Database> => {
  const database = await migratedAccount();
  await database.batch(LEGACY_CHAT.map((statement) => database.prepare(statement)));
  return database;
};

const rows = async (database: D1Database, query: string): Promise<Array<Record<string, unknown>>> =>
  (await database.prepare(query).all<Record<string, unknown>>()).results;

/** A copied conversation folded with t3code's own reducer from its decoded events, as its object opens it. */
const folded = async (database: D1Database, threadId: string): Promise<Projection> => {
  const row = await readThread(database, threadId);
  if (!row) throw new Error(`${threadId} was not copied.`);
  let projection = emptyProjection(threadOf({ id: row.id, title: row.title, createdAt: Date.parse(row.createdAt), updatedAt: Date.parse(row.updatedAt), mode: row.mode }));
  for (const stored of await readEvents(database, threadId, 0)) {
    const event = decodeEvent(stored.payload);
    expect(event.type).toBe(stored.type);
    projection = foldEvent(projection, event);
  }
  return projection;
};

const shown = (projection: Projection): TurnItem[] => projection.visibleTurnItems.map((row) => row.item);
const kinds = (projection: Projection): Array<[string, string]> => shown(projection).map((item) => [item.type, item.status]);
const ofType = <T extends TurnItem['type']>(projection: Projection, type: T): Array<Extract<TurnItem, { type: T }>> =>
  shown(projection).flatMap((item) => item.type === type ? [item as Extract<TurnItem, { type: T }>] : []);

const LEGACY_TABLES = ['chat_conversations', 'chat_turns', 'chat_attachments', 'runs'];

describe('migration 0061 copies the chat before ADR 0201 into the chat that replaced it', () => {
  it('makes one conversation per path of each tree, the path changed last keeping its id and title, and an empty one for none', async () => {
    const database = await seeded();
    await copy(database);

    const threads = await rows(database, 'SELECT id, account_id, title, last_sequence, projection, projection_sequence, created_by_identity, created_by_name, created_at, updated_at FROM chat_threads ORDER BY id');
    expect(Object.fromEntries(threads.map((row) => [row.id, row.title]))).toEqual(COPIED_TITLES);
    expect(threads.find((row) => row.id === 'talk')).toEqual({
      id: 'talk', account_id: ACCOUNT, title: '週末の予定', last_sequence: 10, projection: null, projection_sequence: 0,
      created_by_identity: 'identity-1', created_by_name: '山田', created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:05:00.000Z',
    });
    expect(threads.find((row) => row.id === 'talk-2')).toMatchObject({ created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:03:00.000Z' });
    expect(threads.find((row) => row.id === 'quiet')).toMatchObject({ last_sequence: 0, created_at: '2026-10-30T00:00:00.000Z' });
    // The list shows them the conversation changed last first, each path by when its own exchanges last changed.
    expect((await listThreads(database)).map((thread) => thread.id)).toEqual(['misc', 'misc-2', 'talk', 'talk-2', 'talk-5', 'talk-3', 'talk-4', 'quiet']);

    for (const [threadId, path] of Object.entries(COPIED_PATHS)) {
      const events = await readEvents(database, threadId, 0);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(threads.find((row) => row.id === threadId)?.last_sequence).toBe(events.length);
      const projection = await folded(database, threadId);
      expect(projection.runs.map((run) => run.id)).toEqual(path.map((turnId) => `run-${turnId}`));
      expect(projection.runs.map((run) => run.ordinal)).toEqual(path.map((_, index) => index + 1));
      // Nothing is left being answered, so opening it ends nothing.
      expect(projection.runs.every((run) => ['completed', 'failed', 'interrupted'].includes(run.status))).toBe(true);
      expect(projection.visibleTurnItems.length).toBe(projection.turnItems.length);
    }
  });

  it('shows each exchange as its message, its tools, its words with its files, and why it failed', async () => {
    const database = await seeded();
    await copy(database);

    const main = await folded(database, 'talk');
    expect(kinds(main)).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'],
      ['user_message', 'completed'], ['dynamic_tool', 'failed'], ['dynamic_tool', 'failed'], ['error', 'failed'],
    ]);
    const [first, second] = ofType(main, 'user_message');
    // A member's picture is shown inline; a file of a kind the chat before ADR 0201 no longer shows is not there either.
    expect(first).toMatchObject({ text: '来週の予定を表にして', inputIntent: 'turn_start', attachments: [{ type: 'image', id: 'att-photo', name: '写真.png', mimeType: 'image/png', sizeBytes: 4 }] });
    // A file whose id is no attachment id t3code takes is named by its row instead.
    expect(second).toMatchObject({ text: 'メールを調べて', attachments: [{ type: 'file', id: expect.stringMatching(/^legacy-\d+$/u), name: '請求書.pdf', sizeBytes: 9 }] });
    expect(ofType(main, 'assistant_message')[0]).toMatchObject({ text: TABLE, streaming: false });
    expect(ofType(main, 'assistant_message')[0]).not.toHaveProperty('attachments');
    expect(ofType(main, 'dynamic_tool').map((item) => [item.toolName, item.title, item.input, item.output])).toEqual([
      ['mail.search', 'メールを検索する', {}, 'GoogleApiError 429: Too many concurrent requests for user.'],
      ['mail.read', 'メールを読む', {}, '回答が終わる前にこのツールは終わりませんでした。'],
    ]);
    expect(ofType(main, 'error')[0]?.failure).toEqual({ class: 'provider_error', message: 'Gmail が混み合っています（429）。', code: null, retryable: null });
    expect(main.runs.map((run) => [run.status, run.modelSelection.model])).toEqual([['completed', 'claude-sonnet-4-5'], ['failed', 'flarechat']]);
    // Every time is the exchange's own.
    expect(main.runs.map((run) => [run.startedAt ? utcMillis(run.startedAt) : null, run.completedAt ? utcMillis(run.completedAt) : null])).toEqual([
      [Date.parse('2026-11-01T10:00:00.000Z'), Date.parse('2026-11-01T10:00:40.000Z')],
      [Date.parse('2026-11-01T10:04:00.000Z'), Date.parse('2026-11-01T10:05:00.000Z')],
    ]);

    const branch = await folded(database, 'talk-2');
    expect(kinds(branch)).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'],
      ['user_message', 'completed'], ['dynamic_tool', 'completed'], ['dynamic_tool', 'failed'], ['dynamic_tool', 'failed'], ['assistant_message', 'completed'],
      ['user_message', 'completed'], ['dynamic_tool', 'completed'], ['assistant_message', 'interrupted'], ['run_interrupt_result', 'completed'],
    ]);
    // Only entries shaped as a call are shown; a finished one has no answer to show, a failed one says why or that it failed.
    const tools = ofType(branch, 'dynamic_tool');
    expect(tools.map((item) => [item.toolName, item.status, item.output])).toEqual([
      ['mail.search', 'completed', undefined], ['drive.read', 'failed', 'GoogleApiError 403: 権限がありません'], ['acme.lookup', 'failed', 'acme.lookup が失敗しました。'],
      ['mail.read', 'completed', undefined],
    ]);
    expect(tools[0]).not.toHaveProperty('output');
    expect(tools[2]?.title).toBeNull();
    expect(ofType(branch, 'assistant_message')[1]).toMatchObject({
      text: '2通ありました。表を作りました。',
      attachments: [{ type: 'file', id: 'att-sheet-2', name: '予定.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 5 }],
    });
    expect(branch.runs.map((run) => run.status)).toEqual(['completed', 'completed', 'interrupted']);

    // An exchange left running, and one the chat before ADR 0201 failed as abandoned, end failed with why.
    expect(ofType(await folded(database, 'talk-5'), 'error')[0]?.failure.message).toBe('答えを書き終える前に処理が止まりました。もう一度送ってください。');
    expect((await folded(database, 'talk-5')).runs[0]?.status).toBe('failed');
    expect(ofType(await folded(database, 'talk-3'), 'error')[0]?.failure.message).toBe('答えを書き終える前に処理が止まりました。「やり直す」でもう一度聞けます。');

    // A stopped transcription wrote nothing: its message, its failed step, and that it was stopped.
    expect(kinds(await folded(database, 'misc'))).toEqual([['user_message', 'completed'], ['dynamic_tool', 'failed'], ['run_interrupt_result', 'completed']]);
    expect(ofType(await folded(database, 'misc'), 'dynamic_tool')[0]).toMatchObject({ toolName: 'audio.transcribe', title: '音声を文字起こしする' });
    // Its PDF, carried over from the message asked before it, names the same bytes.
    expect(ofType(await folded(database, 'misc'), 'user_message')[0]?.attachments).toEqual([{ type: 'file', id: 'att-pdf-again', name: '資料.pdf', mimeType: 'application/pdf', sizeBytes: 3 }]);

    const misc = await folded(database, 'misc-2');
    expect(ofType(misc, 'assistant_message')[0]?.attachments).toEqual([
      { type: 'file', id: 'att-blank-2', name: 'file', mimeType: 'application/octet-stream', sizeBytes: 1 },
      { type: 'file', id: 'att-video-2', name: '会議.mp4', mimeType: 'video/mp4', sizeBytes: 50 * 1024 * 1024 },
      { type: 'file', id: 'att-poster-2', name: 'ポスター.png', mimeType: 'image/png', sizeBytes: 11 * 1024 * 1024 },
      { type: 'file', id: 'att-letter-2', name: '案内.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 6 },
    ]);
    // A failure longer than an error item carries is cut, never past what it may hold in UTF-16.
    const message = ofType(misc, 'error')[0]?.failure.message ?? '';
    expect(message.length).toBeLessThanOrEqual(4_096);
    expect(LONG_ERROR.startsWith(message)).toBe(true);
    expect(ofType(misc, 'dynamic_tool')).toEqual([]);
  });

  it('names the same R2 objects, opening an envelope the chat before ADR 0201 kept with the Account\'s key', async () => {
    const database = await seeded();
    await copy(database);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const envelope = await encrypt(btoa(String.fromCharCode(...photo)), key, `chat-attachment:${ACCOUNT}:att-photo`);
    await env.RECOVERY_RECEIPTS.put(`chat-attachments/${ACCOUNT}/att-photo.json`, JSON.stringify(envelope));
    await env.RECOVERY_RECEIPTS.put(`chat-attachments/${ACCOUNT}/att-sheet`, new Uint8Array([1, 2, 3, 4, 5]));

    const files = await rows(database, "SELECT id, thread_id, run_id, filename, media_type, size, object_key, origin, position FROM chat_files WHERE thread_id IN ('talk', 'talk-2') AND id LIKE 'att-%' ORDER BY thread_id, id");
    expect(files).toEqual([
      { id: 'att-photo', thread_id: 'talk', run_id: 'run-a1', filename: '写真.png', media_type: 'image/png', size: 4, object_key: `chat-attachments/${ACCOUNT}/att-photo.json`, origin: 'request', position: 1 },
      { id: 'att-photo-2', thread_id: 'talk-2', run_id: 'run-a1', filename: '写真.png', media_type: 'image/png', size: 4, object_key: `chat-attachments/${ACCOUNT}/att-photo.json`, origin: 'request', position: 1 },
      { id: 'att-sheet-2', thread_id: 'talk-2', run_id: 'run-a2', filename: '予定.xlsx', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 5, object_key: `chat-attachments/${ACCOUNT}/att-sheet`, origin: 'response', position: 1 },
    ]);

    // The file route and the model read both the same way, whichever path names them.
    for (const [threadId, fileId] of [['talk', 'att-photo'], ['talk-2', 'att-photo-2']] as const) {
      expect((await readFile({ database, bucket: env.RECOVERY_RECEIPTS, key: () => Promise.resolve(key), threadId, fileId }))?.bytes).toEqual(photo);
    }
    expect((await readFile({ database, bucket: env.RECOVERY_RECEIPTS, threadId: 'talk-2', fileId: 'att-sheet-2' }))?.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    // Without the key an envelope is not there, rather than handed over sealed.
    expect(await readFile({ database, bucket: env.RECOVERY_RECEIPTS, threadId: 'talk', fileId: 'att-photo' })).toBeNull();
    expect(await readUploads({ database, bucket: env.RECOVERY_RECEIPTS, key: () => Promise.resolve(key), threadId: 'talk', ids: ['att-photo', 'att-missing'] }))
      .toEqual([{ filename: '写真.png', mediaType: 'image/png', bytes: photo }]);

  });

  it('opens a copied conversation as its object does, ending nothing and telling the model what was said', async () => {
    const database = await seeded();
    await copy(database);
    const abandoned: string[] = [];
    const conversation = openConversation({
      store: {
        readThread: () => readThread(database, 'talk-2'),
        readEvents: (after) => readEvents(database, 'talk-2', after),
        appendEvents: (events, title) => appendEvents({ database, threadId: 'talk-2', events, ...(title === undefined ? {} : { title }), timestamp: '2026-11-21T00:00:00.000Z' }),
        saveProjection: (projection, sequence) => saveProjection({ database, threadId: 'talk-2', projection, sequence }),
        saveMode: async () => undefined,
        savePause: async () => undefined,
        readPause: async () => null,
        takePause: async () => null,
        saveProgress: async () => 0,
        readProgress: async () => null,
        dropProgress: async () => undefined,
        allowTool: async () => undefined,
        recordUploads: async () => undefined,
        readUploads: async () => [],
      },
      answering: {
        openRun: async () => 'run-new',
        answer: async () => ({ kind: 'completed' }),
        abandonRun: async (runId) => { abandoned.push(runId); },
      },
      followers: () => [],
      now: () => Date.parse('2026-11-21T00:00:00.000Z'),
      later: () => undefined,
      decides: false,
    });
    await conversation.load();

    expect(abandoned).toEqual([]);
    expect(conversation.sequence()).toBe(17);
    expect((await readThread(database, 'talk-2'))?.lastSequence).toBe(17);
    const [snapshot] = conversation.frames(0).map((frame) => decodeFrame(frame));
    if (snapshot?.kind !== 'snapshot') throw new Error('The conversation was not sent whole.');
    expect(snapshot.projection.thread).toMatchObject({ id: 'talk-2', title: '週末の予定（別の枝 2）' });
    expect(historyOf(snapshot.projection).map((recalled) => [recalled.message.role, recalled.message.content, recalled.files])).toEqual([
      ['user', '来週の予定を表にして', ['att-photo-2']],
      ['assistant', TABLE, []],
      ['user', 'メールも見て', []],
      ['assistant', expect.stringContaining('2通ありました。表を作りました。\n\n[OrangeAgent: this answer wrote 予定.xlsx (5 bytes)'), []],
      ['user', '続けて', []],
      ['assistant', '途中まで書きました\n\n[OrangeAgent: the administrator stopped this answer before it was finished.]', []],
    ]);
  });

  it('copies nothing twice, rewrites none of the chat before ADR 0201, and leaves a conversation that already holds events as it is', async () => {
    const database = await seeded();
    const before = await Promise.all(LEGACY_TABLES.map((table) => rows(database, `SELECT * FROM ${table} ORDER BY id`)));
    await copy(database);
    const copied = await Promise.all(['chat_threads', 'chat_events', 'chat_files'].map((table) => rows(database, `SELECT * FROM ${table} ORDER BY 1, 2`)));

    await copy(database);
    expect(await Promise.all(['chat_threads', 'chat_events', 'chat_files'].map((table) => rows(database, `SELECT * FROM ${table} ORDER BY 1, 2`)))).toEqual(copied);
    expect(await Promise.all(LEGACY_TABLES.map((table) => rows(database, `SELECT * FROM ${table} ORDER BY id`)))).toEqual(before);
    expect(await rows(database, "SELECT name FROM sqlite_master WHERE name = 'chat_import_turns'")).toEqual([]);

    // A copied conversation answered since is given nothing again, and keeps its latest sequence.
    await database.prepare("INSERT INTO chat_events (thread_id, sequence, type, payload, created_at) VALUES ('talk', 11, 'run.created', '{}', '2026-11-21T00:00:00.000Z')").run();
    await database.prepare("UPDATE chat_threads SET last_sequence = 11 WHERE id = 'talk'").run();
    await copy(database);
    expect((await readThread(database, 'talk'))?.lastSequence).toBe(11);
    expect(await rows(database, "SELECT count(*) AS events FROM chat_events WHERE thread_id = 'talk'")).toEqual([{ events: 11 }]);
  });
});
