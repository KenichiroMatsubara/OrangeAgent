/**
 * Where each memory's meaning is kept: a Workers AI `@cf/baai/bge-m3`
 * embedding in Vectorize, under the memory's id, in the Account's own
 * namespace. It is an index rebuilt from D1 and holds no words (ADR 0197):
 * every id it finds is read again in D1, which decides whether the memory
 * is still to be found.
 */

import type { Bindings } from '../types';

/** The Workers AI model a memory's meaning is read with. */
export const MEMORY_EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** How many numbers bge-m3 reads a text as, which the Vectorize index is created with. */
export const MEMORY_DIMENSIONS = 1024;

/** How many texts are read in one Workers AI call when many memories are indexed at once. */
const EMBEDDING_BATCH = 50;

/** One memory Vectorize found near a query, by cosine similarity. */
export interface MemoryNeighbour {
  id: string;
  score: number;
}

/** One memory to put into the index. */
export interface MemoryVector {
  id: string;
  content: string;
  kind: string;
}

/** The Account's memory index; a test substitutes twins of the bindings behind it. */
export interface MemoryVectors {
  /** Keeps the meaning of each memory under its id, replacing whatever was there. */
  put(memories: readonly MemoryVector[]): Promise<void>;
  /** At most `topK` memories nearest to `query`, nearest first. */
  nearest(query: string, topK: number): Promise<MemoryNeighbour[]>;
  remove(ids: readonly string[]): Promise<void>;
}

const embeddings = async (ai: Ai, texts: readonly string[]): Promise<number[][]> => {
  const output = await ai.run(MEMORY_EMBEDDING_MODEL, { text: [...texts] });
  const values = 'data' in output ? output.data : undefined;
  if (!values || values.length !== texts.length) throw new Error('Workers AI did not read every text.');
  return values;
};

/** The Account's memory index, or null where Workers AI or Vectorize is not bound, as in local development. */
export const memoryVectorsOf = (env: Pick<Bindings, 'AI' | 'MEMORY_INDEX'>, accountId: string): MemoryVectors | null => {
  const { AI: ai, MEMORY_INDEX: index } = env;
  if (!ai || !index) return null;
  return {
    put: async (memories) => {
      for (let start = 0; start < memories.length; start += EMBEDDING_BATCH) {
        const batch = memories.slice(start, start + EMBEDDING_BATCH);
        const values = await embeddings(ai, batch.map(({ content }) => content));
        await index.upsert(batch.map((memory, position) => ({
          id: memory.id, values: values[position] ?? [], namespace: accountId, metadata: { kind: memory.kind },
        })));
      }
    },
    nearest: async (query, topK) => {
      const [values] = await embeddings(ai, [query]);
      const results = await index.query(values ?? [], { namespace: accountId, topK });
      return results.matches.map(({ id, score }) => ({ id, score: score || 0 })).sort((left, right) => right.score - left.score);
    },
    remove: async (ids) => {
      if (ids.length) await index.deleteByIds([...ids]);
    },
  };
};
