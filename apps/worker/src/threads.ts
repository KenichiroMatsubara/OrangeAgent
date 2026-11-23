/**
 * Persistence for Operator Chat (ADR 0201).
 *
 * A conversation is a log of events numbered per conversation. The log is the
 * record: each event is kept as its JSON encoding in `chat_events`, and the
 * conversation as it stood when an answer last ended is kept beside it on its
 * row, so the Durable Object that serves it replays only what came after.
 * What an event says is the wire module's concern; this module keeps text.
 */

import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';

import { CONVERSATION_TITLE_LENGTH, DEFAULT_CHAT_MODE, type ChatMode, type ChatThread } from '@mail/domain';

import { envelopeContext, openEnvelope } from './chat-store';
import { decodePause, encodePause, pauseFileCount, type Pause, type Progress } from './pause';
import { accountDatabase } from './storage/database';
import { chatAttachments, chatEvents, chatFiles, chatNotices, chatPauses, chatThreadModes, chatThreads, chatToolAllowances } from './storage/account-schema';
import type { GeneratedFile, TurnFile } from './turns';

/** Which conversation a Durable Object serves, as the route that reaches it names it. */
export interface ThreadTarget {
  accountId: string;
  threadId: string;
}

export const THREAD_ACCOUNT_HEADER = 'X-FlareChat-Account';
export const THREAD_HEADER = 'X-FlareChat-Thread';
/** The member whose screen opens a conversation's socket, as the route that checked them names them. */
export const THREAD_MEMBER_HEADER = 'X-FlareChat-Member';

/** The name a conversation's Durable Object is reached by. */
export const threadObjectName = (target: ThreadTarget): string => `${target.accountId}:${target.threadId}`;

/** One event of a conversation as it is kept. */
export interface StoredEvent {
  sequence: number;
  type: string;
  /** The event's JSON encoding. */
  payload: string;
  createdAt: string;
}

/** A conversation as its Durable Object reads it. */
export interface StoredThread {
  id: string;
  accountId: string;
  title: string;
  lastSequence: number;
  projection: string | null;
  projectionSequence: number;
  /** Its approval mode; auto for a conversation that has none kept. */
  mode: ChatMode;
  createdAt: string;
  updatedAt: string;
}

/** Who did something to a conversation: a member by their Identity, and the name they had then. */
export interface ThreadActor {
  identityId: string | null;
  name: string;
}

/** A file an answer kept, without its bytes. */
export interface StoredFile {
  id: string;
  runId: string;
  filename: string;
  mediaType: string;
  size: number;
  objectKey: string;
  createdAt: string;
}

const viewOf = (row: { id: string; title: string; createdAt: string; updatedAt: string }): ChatThread =>
  ({ id: row.id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt });

/** A conversation's title from its first message: one line, cut at the length a title keeps. */
export const threadTitle = (text: string): string =>
  text.replace(/\s+/gu, ' ').trim().slice(0, CONVERSATION_TITLE_LENGTH);

/**
 * The mode a member's new conversation starts in: the mode of the latest
 * conversation they created or changed, and unrestricted when there is none.
 */
export const startingMode = async (database: D1Database, identityId: string | null): Promise<ChatMode> => {
  if (identityId === null) return DEFAULT_CHAT_MODE;
  const latest = await accountDatabase(database).select({ mode: chatThreadModes.mode }).from(chatThreadModes)
    .innerJoin(chatThreads, eq(chatThreads.id, chatThreadModes.threadId))
    .where(or(eq(chatThreadModes.changedByIdentity, identityId), eq(chatThreads.createdByIdentity, identityId)))
    .orderBy(desc(sql`CASE WHEN ${chatThreadModes.changedByIdentity} = ${identityId} THEN ${chatThreadModes.changedAt} ELSE ${chatThreads.createdAt} END`))
    .limit(1).get();
  return latest?.mode ?? DEFAULT_CHAT_MODE;
};

export const createThread = async (input: {
  database: D1Database;
  accountId: string;
  createdBy: ThreadActor;
  timestamp: string;
}): Promise<ChatThread> => {
  const row = {
    id: crypto.randomUUID(),
    accountId: input.accountId,
    title: '',
    createdByIdentity: input.createdBy.identityId,
    createdByName: input.createdBy.name,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  const mode = await startingMode(input.database, input.createdBy.identityId);
  const db = accountDatabase(input.database);
  // The mode is inherited, not chosen, so it names nobody as having chosen it.
  await db.batch([
    db.insert(chatThreads).values(row),
    db.insert(chatThreadModes).values({ threadId: row.id, mode, changedByIdentity: null, changedByName: '', changedAt: input.timestamp }),
  ]);
  return viewOf(row);
};

/** Keeps the mode a member chose for a conversation, and who chose it when. */
export const saveMode = async (input: { database: D1Database; threadId: string; mode: ChatMode; by: ThreadActor; timestamp: string }): Promise<void> => {
  const values = { mode: input.mode, changedByIdentity: input.by.identityId, changedByName: input.by.name, changedAt: input.timestamp };
  await accountDatabase(input.database).insert(chatThreadModes).values({ threadId: input.threadId, ...values })
    .onConflictDoUpdate({ target: chatThreadModes.threadId, set: values }).run();
};

/** Whether a member allowed the tool always for the Account. */
export const isAllowed = async (database: D1Database, tool: string): Promise<boolean> =>
  (await accountDatabase(database).select({ tool: chatToolAllowances.tool }).from(chatToolAllowances).where(eq(chatToolAllowances.tool, tool)).get()) !== undefined;

/** Allows the tool always for the Account; allowing it again keeps who allowed it first. */
export const allowTool = async (input: { database: D1Database; tool: string; by: ThreadActor; timestamp: string }): Promise<void> => {
  await accountDatabase(input.database).insert(chatToolAllowances)
    .values({ tool: input.tool, allowedByIdentity: input.by.identityId, allowedByName: input.by.name, createdAt: input.timestamp })
    .onConflictDoNothing().run();
};

const pauseKey = (accountId: string, pauseId: string): string => `chat-pauses/${accountId}/${pauseId}`;

/**
 * Keeps an answer waiting for approval: its state and each file it holds in
 * R2 as they are, then its row, so a row always names a state that is there.
 */
export const savePause = async (input: { database: D1Database; bucket: R2Bucket; accountId: string; threadId: string; pause: Pause }): Promise<void> => {
  const { pause } = input;
  const key = pauseKey(input.accountId, pause.id);
  const { state, files } = encodePause(pause);
  await Promise.all(files.map((bytes, index) => input.bucket.put(`${key}/files/${index}`, bytes)));
  await input.bucket.put(`${key}/state.json`, state, { httpMetadata: { contentType: 'application/json' } });
  const call = pause.calls[0];
  const db = accountDatabase(input.database);
  const left = await db.select({ stateKey: chatPauses.stateKey }).from(chatPauses).where(eq(chatPauses.threadId, input.threadId)).get();
  // A conversation waits on one call at a time, so a row left by an answer that has ended is replaced.
  await db.batch([
    db.delete(chatPauses).where(eq(chatPauses.threadId, input.threadId)),
    db.insert(chatPauses).values({
      id: pause.id, threadId: input.threadId, runId: pause.runId, callId: call?.id ?? '', tool: call?.name ?? '',
      arguments: call?.arguments ?? '{}', itemId: pause.itemId, stateKey: key, createdAt: pause.createdAt,
    }),
  ]);
  if (left && left.stateKey !== key) await removeObjects(input.bucket, left.stateKey);
};

/** Removes every object kept under a pause's key; one that stays behind names nothing and is harmless. */
const removeObjects = async (bucket: R2Bucket, stateKey: string): Promise<void> => {
  const listed = await bucket.list({ prefix: `${stateKey}/` });
  await Promise.all(listed.objects.map((object) => bucket.delete(object.key))).catch(() => undefined);
};

/** The answer the conversation keeps waiting for approval, with everything it did, or null when none waits. */
export const readPause = async (input: { database: D1Database; bucket: R2Bucket; threadId: string }): Promise<Pause | null> => {
  const row = await accountDatabase(input.database).select({ stateKey: chatPauses.stateKey }).from(chatPauses)
    .where(eq(chatPauses.threadId, input.threadId)).get();
  if (!row) return null;
  const object = await input.bucket.get(`${row.stateKey}/state.json`);
  if (!object) throw new Error('The state of the answer waiting for approval is missing.');
  const state = await object.text();
  const files = await Promise.all(Array.from({ length: pauseFileCount(state) }, async (_, index) => {
    const file = await input.bucket.get(`${row.stateKey}/files/${index}`);
    if (!file) throw new Error('A file of the answer waiting for approval is missing.');
    return new Uint8Array(await file.arrayBuffer());
  }));
  return decodePause(state, files);
};

/**
 * Takes the answer waiting for approval so it is resumed once: the row is
 * removed, and only the caller that removed it is handed the pause. Its state
 * is removed from R2 once read.
 */
export const takePause = async (input: { database: D1Database; bucket: R2Bucket; threadId: string; pauseId: string }): Promise<Pause | null> => {
  const pause = await readPause(input).catch(() => null);
  const db = accountDatabase(input.database);
  const row = await db.select({ stateKey: chatPauses.stateKey }).from(chatPauses)
    .where(and(eq(chatPauses.threadId, input.threadId), eq(chatPauses.id, input.pauseId))).get();
  if (!row) return null;
  const removed = await db.delete(chatPauses).where(and(eq(chatPauses.threadId, input.threadId), eq(chatPauses.id, input.pauseId))).run();
  if (removed.meta.changes === 0) return null;
  await removeObjects(input.bucket, row.stateKey);
  return pause?.id === input.pauseId ? pause : null;
};

const progressKey = (accountId: string, threadId: string, runId: string): string => `chat-progress/${accountId}/${threadId}/${runId}`;

/**
 * Keeps how far an answer has got, in R2 alone: its state, and each file its
 * messages hold from the `kept`th on, since an answer's messages only grow and
 * the files before were kept already. Returns how many files it then holds.
 */
export const saveProgress = async (input: { bucket: R2Bucket; accountId: string; threadId: string; progress: Progress; kept: number }): Promise<number> => {
  const key = progressKey(input.accountId, input.threadId, input.progress.runId);
  const { state, files } = encodePause(input.progress);
  await Promise.all(files.slice(input.kept).map((bytes, index) => input.bucket.put(`${key}/files/${input.kept + index}`, bytes)));
  await input.bucket.put(`${key}/state.json`, state, { httpMetadata: { contentType: 'application/json' } });
  return files.length;
};

/** How far the answer `runId` had got, or null when nothing of it was kept. */
export const readProgress = async (input: { bucket: R2Bucket; accountId: string; threadId: string; runId: string }): Promise<Progress | null> => {
  const key = progressKey(input.accountId, input.threadId, input.runId);
  const object = await input.bucket.get(`${key}/state.json`);
  if (!object) return null;
  const state = await object.text();
  const files = await Promise.all(Array.from({ length: pauseFileCount(state) }, async (_, index) => {
    const file = await input.bucket.get(`${key}/files/${index}`);
    if (!file) throw new Error('A file of the answer being written is missing.');
    return new Uint8Array(await file.arrayBuffer());
  }));
  return decodePause<Progress>(state, files);
};

/** Forgets how far an answer had got, once it has ended or waits for approval. */
export const dropProgress = (input: { bucket: R2Bucket; accountId: string; threadId: string; runId: string }): Promise<void> =>
  removeObjects(input.bucket, progressKey(input.accountId, input.threadId, input.runId));

/** Every conversation, the one changed last first. */
export const listThreads = async (database: D1Database): Promise<ChatThread[]> =>
  (await accountDatabase(database).select({ id: chatThreads.id, title: chatThreads.title, createdAt: chatThreads.createdAt, updatedAt: chatThreads.updatedAt })
    .from(chatThreads).orderBy(desc(chatThreads.updatedAt), desc(chatThreads.createdAt)).all()).map(viewOf);

export const readThread = async (database: D1Database, threadId: string): Promise<StoredThread | null> =>
  await accountDatabase(database).select({
    id: chatThreads.id,
    accountId: chatThreads.accountId,
    title: chatThreads.title,
    lastSequence: chatThreads.lastSequence,
    projection: chatThreads.projection,
    projectionSequence: chatThreads.projectionSequence,
    mode: sql<ChatMode>`coalesce(${chatThreadModes.mode}, ${DEFAULT_CHAT_MODE})`,
    createdAt: chatThreads.createdAt,
    updatedAt: chatThreads.updatedAt,
  }).from(chatThreads).leftJoin(chatThreadModes, eq(chatThreadModes.threadId, chatThreads.id))
    .where(eq(chatThreads.id, threadId)).get() ?? null;

/**
 * Keeps events in one batch with the conversation's latest sequence, and its
 * new title when one is given, so the log and its row never disagree.
 */
export const appendEvents = async (input: {
  database: D1Database;
  threadId: string;
  events: readonly StoredEvent[];
  title?: string;
  /** Leaves when the conversation last changed as it was, as a rename does, so its place in the list stays. */
  keepsPlace?: boolean;
  timestamp: string;
}): Promise<void> => {
  const last = input.events.at(-1);
  if (!last) return;
  const db = accountDatabase(input.database);
  await db.batch([
    db.update(chatThreads).set({
      lastSequence: last.sequence,
      ...(input.keepsPlace ? {} : { updatedAt: input.timestamp }),
      ...(input.title === undefined ? {} : { title: input.title }),
    }).where(eq(chatThreads.id, input.threadId)),
    ...eventInserts(db, input.threadId, input.events),
  ]);
};

/** The statements that keep a conversation's events: D1 binds at most 100 values to one statement, and each row binds five. */
const eventInserts = (db: ReturnType<typeof accountDatabase>, threadId: string, events: readonly StoredEvent[]) => {
  const rows = events.map((event) => ({ threadId, ...event }));
  return Array.from({ length: Math.ceil(rows.length / EVENTS_PER_STATEMENT) }, (_, index) =>
    db.insert(chatEvents).values(rows.slice(index * EVENTS_PER_STATEMENT, (index + 1) * EVENTS_PER_STATEMENT)));
};

/** How many events one insert keeps. */
const EVENTS_PER_STATEMENT = 15;

/** The events after `afterSequence`, in order. */
export const readEvents = async (database: D1Database, threadId: string, afterSequence: number): Promise<StoredEvent[]> =>
  accountDatabase(database).select({ sequence: chatEvents.sequence, type: chatEvents.type, payload: chatEvents.payload, createdAt: chatEvents.createdAt })
    .from(chatEvents).where(and(eq(chatEvents.threadId, threadId), gt(chatEvents.sequence, afterSequence)))
    .orderBy(asc(chatEvents.sequence)).all();

/** Keeps the conversation as it stood at `sequence`, so it is opened from there. */
export const saveProjection = async (input: { database: D1Database; threadId: string; projection: string; sequence: number }): Promise<void> => {
  await accountDatabase(input.database).update(chatThreads)
    .set({ projection: input.projection, projectionSequence: input.sequence })
    .where(eq(chatThreads.id, input.threadId)).run();
};

const fileKey = (accountId: string, fileId: string): string => `chat-files/${accountId}/${fileId}`;

/** Keeps one file an answer wrote or handed on: its bytes in R2 as they are, its row here. */
export const keepFile = async (input: {
  database: D1Database;
  bucket: R2Bucket;
  accountId: string;
  threadId: string;
  runId: string;
  file: GeneratedFile;
  timestamp: string;
}): Promise<StoredFile> => {
  const id = crypto.randomUUID();
  const objectKey = fileKey(input.accountId, id);
  await input.bucket.put(objectKey, input.file.bytes, { httpMetadata: { contentType: input.file.mediaType } });
  const row: StoredFile = {
    id, runId: input.runId, filename: input.file.filename, mediaType: input.file.mediaType,
    size: input.file.bytes.byteLength, objectKey, createdAt: input.timestamp,
  };
  await accountDatabase(input.database).insert(chatFiles).values({ ...row, threadId: input.threadId }).run();
  return row;
};

const fileColumns = {
  id: chatFiles.id, runId: chatFiles.runId, filename: chatFiles.filename, mediaType: chatFiles.mediaType,
  size: chatFiles.size, objectKey: chatFiles.objectKey, createdAt: chatFiles.createdAt,
};

/**
 * Every file the conversation's answers kept, oldest first; the files members
 * sent are not among them, nor those of the answers `except` names, which a
 * rewind took back.
 */
export const listFiles = async (database: D1Database, threadId: string, except: ReadonlySet<string> = new Set()): Promise<StoredFile[]> =>
  (await accountDatabase(database).select(fileColumns).from(chatFiles).where(and(eq(chatFiles.threadId, threadId), eq(chatFiles.origin, 'response')))
    .orderBy(asc(chatFiles.createdAt)).all()).filter((file) => !except.has(file.runId));

/** A file a member sent with a message, its bytes kept, not yet named as sent to any answer. */
export interface Upload {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  objectKey: string;
}

/**
 * Keeps the bytes of the files a member sends with one message, as they
 * are, before the message is handed to its conversation, which names the
 * answer they were sent to (`recordUploads`).
 */
export const putUploads = async (input: { bucket: R2Bucket; accountId: string; files: readonly GeneratedFile[] }): Promise<Upload[]> =>
  Promise.all(input.files.map(async (file) => {
    const id = crypto.randomUUID();
    const objectKey = fileKey(input.accountId, id);
    await input.bucket.put(objectKey, file.bytes, { httpMetadata: { contentType: file.mediaType } });
    return { id, filename: file.filename, mediaType: file.mediaType, size: file.bytes.byteLength, objectKey };
  }));

/** Removes the bytes of files a message that was not taken carried; one that stays behind names nothing and is harmless. */
export const dropUploads = async (bucket: R2Bucket, files: readonly Upload[]): Promise<void> => {
  await Promise.all(files.map((file) => bucket.delete(file.objectKey))).catch(() => undefined);
};

/** Names the files a member sent as sent to one answer's Run, in the order sent, so the conversation serves them. */
export const recordUploads = async (input: { database: D1Database; threadId: string; runId: string; files: readonly Upload[]; timestamp: string }): Promise<void> => {
  if (!input.files.length) return;
  const db = accountDatabase(input.database);
  // D1 binds at most 100 values to one statement, and each row binds ten.
  const rows = input.files.map((file, position) => ({ ...file, threadId: input.threadId, runId: input.runId, origin: 'request' as const, position, createdAt: input.timestamp }));
  const [first, ...rest] = Array.from({ length: Math.ceil(rows.length / UPLOADS_PER_STATEMENT) }, (_, index) =>
    db.insert(chatFiles).values(rows.slice(index * UPLOADS_PER_STATEMENT, (index + 1) * UPLOADS_PER_STATEMENT)));
  if (first) await db.batch([first, ...rest]);
};

const UPLOADS_PER_STATEMENT = 9;

/** The Account's key, asked for only when a file is an envelope, which only a conversation copied from the chat before ADR 0201 names. */
export type FileKey = () => Promise<CryptoKey>;

/** The files members sent, by id, with their bytes, in the order asked; one that cannot be read is left out. */
export const readUploads = async (input: { database: D1Database; bucket: R2Bucket; key?: FileKey; threadId: string; ids: readonly string[] }): Promise<TurnFile[]> => {
  const files = await Promise.all(input.ids.map((fileId) => readFile({ ...input, fileId }).catch(() => null)));
  return files.flatMap((file) => file ? [{ filename: file.filename, mediaType: file.mediaType, bytes: file.bytes }] : []);
};

/**
 * One file of the conversation with its bytes, or null when it holds none by
 * that id. A file of a conversation copied from the chat before ADR 0201 names that
 * chat's object, which is either the file as it is or, kept before files
 * were stored so, an envelope the Account's key opens; one that cannot be
 * opened without the key is not there.
 */
export const readFile = async (input: { database: D1Database; bucket: R2Bucket; key?: FileKey; threadId: string; fileId: string }): Promise<(StoredFile & { bytes: Uint8Array }) | null> => {
  const row = await accountDatabase(input.database).select(fileColumns).from(chatFiles)
    .where(and(eq(chatFiles.threadId, input.threadId), eq(chatFiles.id, input.fileId))).get();
  if (!row) return null;
  const context = envelopeContext(row.objectKey);
  if (context !== null && !input.key) return null;
  const object = await input.bucket.get(row.objectKey);
  if (!object) return null;
  if (context === null || !input.key) return { ...row, bytes: new Uint8Array(await object.arrayBuffer()) };
  return { ...row, bytes: await openEnvelope(await object.text(), await input.key(), context) };
};

/** The latest file the conversation's answers kept under this name, but those of the answers `except` names, with its bytes, or null. */
export const latestFile = async (input: { database: D1Database; bucket: R2Bucket; key?: FileKey; threadId: string; filename: string; except?: ReadonlySet<string> }): Promise<(StoredFile & { bytes: Uint8Array }) | null> => {
  const row = (await listFiles(input.database, input.threadId, input.except)).filter((file) => file.filename === input.filename).at(-1);
  if (!row) return null;
  return readFile({ database: input.database, bucket: input.bucket, ...(input.key ? { key: input.key } : {}), threadId: input.threadId, fileId: row.id });
};

/**
 * A new conversation continued from another (`source`) up to one of its
 * answers: its row, in the mode the member's next conversation starts in,
 * the events its object computed (conversation.ts `fork`), and a row for
 * each file those events name, under the id the events give it, naming the
 * same R2 object as the file it copies. The bytes are not copied, so
 * deleting either conversation leaves those the other names (`deleteThread`).
 * Everything is kept in one batch, so a conversation is never half copied.
 */
export const forkThread = async (input: {
  database: D1Database;
  accountId: string;
  source: string;
  threadId: string;
  title: string;
  createdBy: ThreadActor;
  events: readonly StoredEvent[];
  files: ReadonlyArray<{ id: string; copy: string }>;
  timestamp: string;
}): Promise<ChatThread> => {
  const db = accountDatabase(input.database);
  const copies = new Map(input.files.map((file) => [file.id, file.copy]));
  const sources = copies.size
    ? await db.select().from(chatFiles).where(and(eq(chatFiles.threadId, input.source), inArray(chatFiles.id, [...copies.keys()]))).all()
    : [];
  const files = sources.map((file) => ({ ...file, id: copies.get(file.id) ?? file.id, threadId: input.threadId }));
  const row = {
    id: input.threadId,
    accountId: input.accountId,
    title: input.title,
    lastSequence: input.events.at(-1)?.sequence ?? 0,
    createdByIdentity: input.createdBy.identityId,
    createdByName: input.createdBy.name,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  const mode = await startingMode(input.database, input.createdBy.identityId);
  await db.batch([
    db.insert(chatThreads).values(row),
    db.insert(chatThreadModes).values({ threadId: row.id, mode, changedByIdentity: null, changedByName: '', changedAt: input.timestamp }),
    ...Array.from({ length: Math.ceil(files.length / UPLOADS_PER_STATEMENT) }, (_, index) =>
      db.insert(chatFiles).values(files.slice(index * UPLOADS_PER_STATEMENT, (index + 1) * UPLOADS_PER_STATEMENT))),
    ...eventInserts(db, row.id, input.events),
  ]);
  return viewOf(row);
};

/** How many R2 keys one statement asks after: D1 binds at most 100 values to one statement. */
const KEYS_PER_STATEMENT = 90;

/**
 * The keys of those R2 objects that nothing names any longer: no file of any
 * conversation, and no file of the chat before ADR 0201, whose rows
 * (`chat_attachments`) are kept as they were and still name the objects the
 * conversations copied from it name too (migration 0061).
 */
const unnamedKeys = async (database: D1Database, keys: readonly string[]): Promise<string[]> => {
  const db = accountDatabase(database);
  const named = new Set<string>();
  for (let index = 0; index < keys.length; index += KEYS_PER_STATEMENT) {
    const chunk = keys.slice(index, index + KEYS_PER_STATEMENT);
    const [files, legacy] = await Promise.all([
      db.select({ key: chatFiles.objectKey }).from(chatFiles).where(inArray(chatFiles.objectKey, chunk)).all(),
      db.select({ key: chatAttachments.objectKey }).from(chatAttachments).where(inArray(chatAttachments.objectKey, chunk)).all(),
    ]);
    for (const row of [...files, ...legacy]) named.add(row.key);
  }
  return keys.filter((key) => !named.has(key));
};

/**
 * Deletes a conversation: its row and everything kept with it (its events,
 * files, mode, waiting answer, and notices) in one batch, then the R2 objects
 * of its files that nothing else names any longer — a conversation continued
 * from it, or it from another, names the same objects, and so does the chat
 * before ADR 0201 for a copied conversation — and the state of an answer it
 * kept waiting. The Runs its answers were recorded as stay (ADR 0146). The
 * caller has stopped the conversation's object first.
 */
export const deleteThread = async (input: { database: D1Database; bucket: R2Bucket; threadId: string }): Promise<void> => {
  const db = accountDatabase(input.database);
  const { threadId } = input;
  const [files, pauses] = await Promise.all([
    db.select({ objectKey: chatFiles.objectKey }).from(chatFiles).where(eq(chatFiles.threadId, threadId)).all(),
    db.select({ stateKey: chatPauses.stateKey }).from(chatPauses).where(eq(chatPauses.threadId, threadId)).all(),
  ]);
  await db.batch([
    db.delete(chatNotices).where(eq(chatNotices.threadId, threadId)),
    db.delete(chatPauses).where(eq(chatPauses.threadId, threadId)),
    db.delete(chatFiles).where(eq(chatFiles.threadId, threadId)),
    db.delete(chatEvents).where(eq(chatEvents.threadId, threadId)),
    db.delete(chatThreadModes).where(eq(chatThreadModes.threadId, threadId)),
    db.delete(chatThreads).where(eq(chatThreads.id, threadId)),
  ]);
  // Only once no row names them: an object left behind by a failure here names nothing and is harmless, one removed too early is not.
  const unnamed = await unnamedKeys(input.database, [...new Set(files.map((file) => file.objectKey))]);
  await Promise.all(unnamed.map((key) => input.bucket.delete(key))).catch(() => undefined);
  await Promise.all(pauses.map((pause) => removeObjects(input.bucket, pause.stateKey)));
};
