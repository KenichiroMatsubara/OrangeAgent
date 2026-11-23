/**
 * Finds what the Account remembers about a query, by meaning and by words,
 * and says nothing when it is not certain (ADR 0197). Vectorize offers the
 * memories nearest in meaning; `memory_terms` offers those holding the
 * query's keywords, each weighted by how rare it is; memories not yet in
 * either index are read directly. Every candidate is read again in D1, and
 * only an active memory still valid is kept. A memory is relevant when its
 * meaning is near enough or it holds enough of the query's keywords, and
 * the relevant ones are ranked by Reciprocal Rank Fusion of the two lists.
 * When none is relevant, the search answers that it has no certain memory
 * rather than return the nearest guess.
 */

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import { memories, memoryTerms } from '../storage/account-schema';
import type { MemoryRow, MemoryStore } from './store';
import { chunks, queryTerms, termsOf } from './terms';
import type { MemoryNeighbour } from './vectors';

/** How many memories each index is asked for before they are fused. */
export const MEMORY_CANDIDATES = 50;

/** How many memories a search returns at most. */
export const MEMORY_RESULTS = 10;

/** A memory is relevant by meaning only when its cosine similarity is above this, the threshold mcp-memory used. */
export const MINIMUM_SIMILARITY = 0.5;

/** A memory is relevant by its words only when it holds at least this share of the query's keywords, weighted by rarity. */
export const MINIMUM_KEYWORDS = 0.6;

/** The constant of Reciprocal Rank Fusion: each list adds 1 / (k + rank). */
const FUSION_K = 60;

/** How many memories not yet indexed are read directly, newest first, so a memory is found by its words before its keywords are built. */
const UNINDEXED_READ = 200;

/** One memory a search found, and how it matched. */
export interface MemoryFound {
  row: MemoryRow;
  /** Cosine similarity to the query, or null when Vectorize did not offer it. */
  similarity: number | null;
  /** The rarity-weighted share of the query's keywords it holds, or null when it holds none. */
  keywords: number | null;
}

const nearestOf = async (store: MemoryStore, query: string): Promise<MemoryNeighbour[]> => {
  if (!store.vectors) return [];
  try {
    return await store.vectors.nearest(query, MEMORY_CANDIDATES);
  } catch (error) {
    // The words still find a memory when its meaning cannot be read.
    console.error(JSON.stringify({ event: 'memory_search_by_meaning_failed', message: error instanceof Error ? error.message : String(error) }));
    return [];
  }
};

/** Each memory holding any of the query's keywords, with the share of their weight it holds. */
const keywordsOf = async (store: MemoryStore, terms: readonly string[]): Promise<Map<string, number>> => {
  if (!terms.length) return new Map();
  const postings = (await Promise.all(chunks(terms, 90).map((piece) => store.db
    .select({ term: memoryTerms.term, memoryId: memoryTerms.memoryId }).from(memoryTerms)
    .where(inArray(memoryTerms.term, piece)).all()))).flat();
  const unindexed = await store.db.select({ id: memories.id, content: memories.content }).from(memories)
    .where(and(eq(memories.status, 'active'), isNull(memories.indexedAt)))
    .orderBy(sql`${memories.createdAt} desc`).limit(UNINDEXED_READ).all();
  const indexed = new Set(postings.map(({ memoryId }) => memoryId));
  for (const row of unindexed) {
    if (indexed.has(row.id)) continue;
    const held = termsOf(row.content);
    for (const term of terms) if (held.has(term)) postings.push({ term, memoryId: row.id });
  }
  const total = await store.db.select({ count: sql<number>`count(*)` }).from(memories).where(eq(memories.status, 'active')).get();
  const memoryCount = Math.max(total?.count ?? 0, 1);
  const holders = new Map<string, Set<string>>();
  for (const { term, memoryId } of postings) holders.set(term, (holders.get(term) ?? new Set()).add(memoryId));
  const weight = (term: string): number => Math.log(1 + memoryCount / Math.max(holders.get(term)?.size ?? 0, 1));
  const whole = terms.reduce((sum, term) => sum + weight(term), 0);
  const held = new Map<string, number>();
  for (const [term, ids] of holders) for (const id of ids) held.set(id, (held.get(id) ?? 0) + weight(term));
  return new Map([...held].map(([id, sum]) => [id, whole ? sum / whole : 0]));
};

const ranks = (scores: ReadonlyMap<string, number>): Map<string, number> =>
  new Map([...scores].sort((left, right) => right[1] - left[1]).map(([id], index) => [id, index + 1]));

/**
 * The memories relevant to the query, best first, at most ten; none when the
 * Memory holds nothing it is certain of.
 */
export const findMemories = async (store: MemoryStore, input: { query: string }): Promise<MemoryFound[]> => {
  const [nearest, keywords] = await Promise.all([nearestOf(store, input.query), keywordsOf(store, queryTerms(input.query))]);
  const similarity = new Map(nearest.map(({ id, score }) => [id, score]));
  const candidates = [...new Set([...similarity.keys(), ...keywords.keys()])];
  if (!candidates.length) return [];
  const now = store.at().toISOString();
  const rows = (await Promise.all(chunks(candidates, 90).map((piece) => store.db.select().from(memories)
    .where(and(inArray(memories.id, piece), eq(memories.status, 'active'), or(isNull(memories.validTo), gt(memories.validTo, now))))
    .all()))).flat();
  const bySimilarity = ranks(similarity);
  const byKeywords = ranks(keywords);
  const fused = (id: string): number =>
    [bySimilarity.get(id), byKeywords.get(id)].reduce<number>((sum, rank) => sum + (rank ? 1 / (FUSION_K + rank) : 0), 0);
  const found = rows
    .map((row): MemoryFound => ({ row, similarity: similarity.get(row.id) ?? null, keywords: keywords.get(row.id) ?? null }))
    .filter(({ similarity: near, keywords: held }) => (near ?? 0) > MINIMUM_SIMILARITY || (held ?? 0) >= MINIMUM_KEYWORDS)
    .sort((left, right) => fused(right.row.id) - fused(left.row.id) || right.row.createdAt.localeCompare(left.row.createdAt))
    .slice(0, MEMORY_RESULTS);
  return found;
};
