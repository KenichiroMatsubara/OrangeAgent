/**
 * The Account's Memory as its D1 records it, which is the record (ADR 0197):
 * each memory, the Episode it was kept from, its keywords, and every change
 * to it. Vectorize is an index of these rows; a memory is written here
 * first, and is found by its words at once and by its meaning once indexed.
 */

import type { Memory, MemoryAuthorKind, MemoryChange, MemoryDetail, MemoryProvenance } from '@mail/domain';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import { memories, memoryChanges, memoryEpisodes, memoryTerms } from '../storage/account-schema';
import type { AccountDatabase } from '../storage/database';
import type { Bindings } from '../types';
import { chunks, normalize, termsOf } from './terms';
import { memoryVectorsOf, type MemoryVectors } from './vectors';

/** The Account's Memory as one run or request reaches it. */
export interface MemoryStore {
  db: AccountDatabase;
  /** Null where Workers AI and Vectorize are not bound, as in local development: a memory is then found by its words alone. */
  vectors: MemoryVectors | null;
  at: () => Date;
}

/**
 * Who keeps a memory: Operator Chat's AI, which a memory does not link to a
 * conversation of (ADR 0201), the AI of a member's own CLI, or a member on 記憶.
 */
export type MemoryAuthor =
  | { kind: 'chat' }
  | { kind: 'cli'; name: string }
  | { kind: 'person'; name: string };

/** The member who kept it, or whose CLI did; empty for Operator Chat's AI. */
const nameOf = (author: MemoryAuthor): string => author.kind === 'cli' || author.kind === 'person' ? author.name : '';

export type MemoryRow = typeof memories.$inferSelect;

export const memoryStoreOf = (env: Pick<Bindings, 'AI' | 'MEMORY_INDEX'>, db: AccountDatabase, accountId: string): MemoryStore =>
  ({ db, vectors: memoryVectorsOf(env, accountId), at: () => new Date() });

const PROVENANCE: Record<number, MemoryProvenance> = { 1: 'member', 2: 'confirmed', 3: 'proposed', 4: 'inferred', 5: 'external' };

export const viewOf = (row: MemoryRow): Memory => ({
  id: row.id,
  content: row.content,
  author: { kind: row.authorKind as MemoryAuthorKind, name: row.authorName, conversationId: row.conversationId },
  editedBy: row.editedBy,
  status: row.status,
  kind: row.kind,
  provenance: PROVENANCE[row.provenance] ?? 'proposed',
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Every memory, the one changed last first. */
export const listMemories = async (store: MemoryStore): Promise<Memory[]> =>
  (await store.db.select().from(memories).orderBy(desc(memories.updatedAt), desc(memories.createdAt)).all()).map(viewOf);

/** Two texts that differ only in width, case, kana, or whitespace are the same Episode. */
const hashOf = async (content: string): Promise<string> => {
  const folded = normalize(content).replace(/\s+/gu, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(folded));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/** The statements that replace a memory's keywords with those of `content`. */
const termWrites = (db: AccountDatabase, memoryId: string, content: string): BatchItem<'sqlite'>[] => {
  const rows = [...termsOf(content)].map(([term, count]) => ({ term, memoryId, count }));
  // Three values a row, and D1 binds at most 100 to one statement.
  return [
    db.delete(memoryTerms).where(eq(memoryTerms.memoryId, memoryId)),
    ...chunks(rows, 30).map((piece) => db.insert(memoryTerms).values(piece)),
  ];
};

const batch = async (db: AccountDatabase, writes: readonly BatchItem<'sqlite'>[]): Promise<void> => {
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
};

/**
 * Puts these memories' meaning into Vectorize and marks them indexed. A
 * failure leaves them unindexed, still found by their words, until the
 * background pass indexes them.
 */
export const indexMemories = async (store: MemoryStore, rows: readonly Pick<MemoryRow, 'id' | 'content' | 'kind'>[]): Promise<boolean> => {
  if (!store.vectors || !rows.length) return false;
  try {
    await store.vectors.put(rows);
  } catch (error) {
    console.error(JSON.stringify({ event: 'memory_index_failed', count: rows.length, message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
  const indexedAt = store.at().toISOString();
  for (const piece of chunks(rows.map(({ id }) => id), 90)) {
    await store.db.update(memories).set({ indexedAt }).where(inArray(memories.id, piece)).run();
  }
  return true;
};

/** The Episode with these words, kept now if no Episode holds them yet. */
const episodeFor = async (store: MemoryStore, content: string, author: MemoryAuthor, receivedAt: string): Promise<string> => {
  const contentHash = await hashOf(content);
  const id = crypto.randomUUID();
  await store.db.insert(memoryEpisodes).values({
    id,
    source: author.kind,
    memberName: nameOf(author),
    conversationId: null,
    turnId: null,
    content,
    contentHash,
    state: 'committed',
    receivedAt,
    processedAt: receivedAt,
  }).onConflictDoNothing().run();
  const kept = await store.db.select({ id: memoryEpisodes.id }).from(memoryEpisodes).where(eq(memoryEpisodes.contentHash, contentHash)).get();
  if (!kept) throw new Error('The Episode could not be kept.');
  return kept.id;
};

/** What keeping a memory did: kept it, or found the same words already kept. */
export interface Kept {
  memory: Memory;
  duplicate: boolean;
}

/**
 * Keeps a memory in the words given, resting on an Episode of those words.
 * Words already kept by an active memory are not kept twice; the memory
 * that holds them is returned.
 */
export const saveMemory = async (store: MemoryStore, input: { content: string; author: MemoryAuthor }): Promise<Kept> => {
  const timestamp = store.at().toISOString();
  const { author } = input;
  const episodeId = await episodeFor(store, input.content, author, timestamp);
  const existing = await store.db.select().from(memories)
    .where(and(eq(memories.episodeId, episodeId), eq(memories.status, 'active'))).get();
  if (existing) return { memory: viewOf(existing), duplicate: true };
  const row: MemoryRow = {
    id: crypto.randomUUID(),
    content: input.content,
    authorKind: author.kind,
    authorName: nameOf(author),
    conversationId: null,
    turnId: null,
    editedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    episodeId,
    kind: 'fact',
    speaker: author.kind === 'person' ? 'user' : 'agent',
    provenance: author.kind === 'person' ? 1 : 3,
    status: 'active',
    evidenceStart: 0,
    evidenceEnd: input.content.length,
    validFrom: timestamp,
    validTo: null,
    indexedAt: null,
  };
  await batch(store.db, [
    store.db.insert(memories).values(row),
    ...termWrites(store.db, row.id, row.content),
    store.db.insert(memoryChanges).values({ at: timestamp, actorKind: author.kind === 'person' ? 'member' : author.kind === 'cli' ? 'cli' : 'chat', actorName: row.authorName, action: 'add', memoryId: row.id }),
  ]);
  const indexed = await indexMemories(store, [row]);
  return { memory: viewOf(indexed ? { ...row, indexedAt: store.at().toISOString() } : row), duplicate: false };
};

/**
 * Changes a memory's words as a member corrects them on 記憶: the
 * correction is the member's own words, so it becomes the memory's Episode,
 * and the words before are kept in its history.
 */
export const updateMemory = async (store: MemoryStore, input: { id: string; content: string; editor: string }): Promise<Memory | null> => {
  const before = await store.db.select().from(memories).where(eq(memories.id, input.id)).get();
  if (!before) return null;
  const timestamp = store.at().toISOString();
  const episodeId = await episodeFor(store, input.content, { kind: 'person', name: input.editor }, timestamp);
  const after: MemoryRow = {
    ...before,
    content: input.content,
    editedBy: input.editor,
    updatedAt: timestamp,
    episodeId,
    speaker: 'user',
    provenance: 1,
    evidenceStart: 0,
    evidenceEnd: input.content.length,
    indexedAt: null,
  };
  await batch(store.db, [
    store.db.update(memories).set({
      content: after.content, editedBy: after.editedBy, updatedAt: after.updatedAt, episodeId, speaker: 'user', provenance: 1,
      evidenceStart: after.evidenceStart, evidenceEnd: after.evidenceEnd, indexedAt: null,
    }).where(eq(memories.id, input.id)),
    ...termWrites(store.db, input.id, input.content),
    store.db.insert(memoryChanges).values({ at: timestamp, actorKind: 'member', actorName: input.editor, action: 'correct', memoryId: input.id, detail: JSON.stringify({ before: before.content, episodeId: before.episodeId }) }),
  ]);
  const indexed = await indexMemories(store, [after]);
  return viewOf(indexed ? { ...after, indexedAt: store.at().toISOString() } : after);
};

/** The words a memory rests on, blanked character for character so every other offset in its Episode still holds. */
const blanked = (content: string, start: number, end: number): string =>
  content.slice(0, start) + '■'.repeat(Math.max(0, end - start)) + content.slice(end);

/** The Episodes a memory rested on before a member corrected it, as its history records them. */
const earlierEpisodes = async (store: MemoryStore, id: string): Promise<string[]> => {
  const corrections = await store.db.select({ detail: memoryChanges.detail }).from(memoryChanges)
    .where(and(eq(memoryChanges.memoryId, id), eq(memoryChanges.action, 'correct'))).all();
  return corrections.flatMap(({ detail }) => {
    try {
      const parsed = JSON.parse(detail ?? '{}') as { episodeId?: unknown };
      return typeof parsed.episodeId === 'string' ? [parsed.episodeId] : [];
    } catch {
      return [];
    }
  });
};

/**
 * Erases a memory for good: its row, keywords, and uses, its vector, and the
 * words it rests on in its Episode, or keeping the Episode would keep them.
 * An Episode it rested on before a correction is blanked whole. An Episode
 * another memory also rests on is left as it is. A blanked Episode is no longer matched by its words,
 * so the same words kept again rest on a new one. Its history records the
 * erasure and not the words.
 */
export const eraseMemory = async (store: MemoryStore, input: { id: string; actor: string }): Promise<boolean> => {
  const row = await store.db.select().from(memories).where(eq(memories.id, input.id)).get();
  if (!row) return false;
  const timestamp = store.at().toISOString();
  const earlier = (await earlierEpisodes(store, input.id)).filter((episodeId) => episodeId !== row.episodeId);
  const episodeIds = [...new Set([...(row.episodeId ? [row.episodeId] : []), ...earlier])];
  const episodes = episodeIds.length
    ? await store.db.select().from(memoryEpisodes).where(inArray(memoryEpisodes.id, episodeIds)).all()
    : [];
  const sharing = episodeIds.length
    ? new Set((await store.db.select({ episodeId: memories.episodeId }).from(memories)
      .where(and(inArray(memories.episodeId, episodeIds), ne(memories.id, input.id))).all())
      .filter(({ episodeId }) => episodeId !== null).map(({ episodeId }) => episodeId))
    : new Set<string | null>();
  const writes: BatchItem<'sqlite'>[] = [
    store.db.delete(memories).where(eq(memories.id, input.id)),
    store.db.update(memoryChanges).set({ detail: null }).where(eq(memoryChanges.memoryId, input.id)),
    store.db.insert(memoryChanges).values({ at: timestamp, actorKind: 'member', actorName: input.actor, action: 'erase', memoryId: input.id }),
  ];
  for (const episode of episodes) {
    const current = episode.id === row.episodeId;
    // Another memory may rest on the same words, kept by a correction that matched them; they stay its evidence.
    if (sharing.has(episode.id)) continue;
    const start = current ? row.evidenceStart ?? 0 : 0;
    const end = current ? row.evidenceEnd ?? episode.content.length : episode.content.length;
    writes.push(store.db.update(memoryEpisodes)
      .set({ content: blanked(episode.content, start, end), contentHash: `erased:${episode.id}` })
      .where(eq(memoryEpisodes.id, episode.id)));
  }
  await batch(store.db, writes);
  try {
    await store.vectors?.remove([input.id]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'memory_unindex_failed', memoryId: input.id, message: error instanceof Error ? error.message : String(error) }));
  }
  return true;
};

/** Why the Account remembers something: its Episode and every change to it, the earliest first. */
export const memoryDetail = async (store: MemoryStore, id: string): Promise<MemoryDetail | null> => {
  const row = await store.db.select().from(memories).where(eq(memories.id, id)).get();
  if (!row) return null;
  const episode = row.episodeId
    ? await store.db.select().from(memoryEpisodes).where(eq(memoryEpisodes.id, row.episodeId)).get()
    : undefined;
  const changes = await store.db.select().from(memoryChanges).where(eq(memoryChanges.memoryId, id)).orderBy(memoryChanges.at, memoryChanges.id).all();
  return {
    memory: viewOf(row),
    episode: episode
      ? {
        source: episode.source,
        memberName: episode.memberName,
        content: episode.content,
        evidence: row.evidenceStart !== null && row.evidenceEnd !== null ? { start: row.evidenceStart, end: row.evidenceEnd } : null,
        conversationId: episode.conversationId,
        receivedAt: episode.receivedAt,
      }
      : null,
    changes: changes.map((change): MemoryChange => ({ at: change.at, actor: { kind: change.actorKind, name: change.actorName }, action: change.action })),
  };
};

/**
 * Builds the keywords and the vectors of up to `limit` active memories not
 * yet indexed, oldest first: those kept before Episodes, and any whose
 * vector could not be written when they were kept.
 */
export const reindexMemories = async (store: MemoryStore, limit = 100): Promise<{ indexed: number; remaining: boolean }> => {
  const pending = await store.db.select({ id: memories.id, content: memories.content, kind: memories.kind }).from(memories)
    .where(and(eq(memories.status, 'active'), isNull(memories.indexedAt)))
    .orderBy(memories.createdAt).limit(limit + 1).all();
  const batchOf = pending.slice(0, limit);
  for (const row of batchOf) await batch(store.db, termWrites(store.db, row.id, row.content));
  const indexed = await indexMemories(store, batchOf);
  return { indexed: indexed ? batchOf.length : 0, remaining: pending.length > limit };
};

