import { MEMORY_DIMENSIONS, MEMORY_EMBEDDING_MODEL } from '../src/memory/vectors';

/**
 * A twin of Workers AI's bge-m3 that reads a text as the character pairs it
 * holds, so texts sharing words are near and others are not, without calling
 * the real, billed Workers AI.
 */
export const twinEmbedding = (text: string): number[] => {
  const vector = new Array<number>(MEMORY_DIMENSIONS).fill(0);
  const letters = [...text.toLowerCase().replace(/\s+/gu, '')];
  for (let index = 0; index < letters.length; index += 1) {
    const pair = `${letters[index]}${letters[index + 1] ?? ''}`;
    let hash = 0;
    for (const unit of pair) hash = (hash * 31 + (unit.codePointAt(0) ?? 0)) % MEMORY_DIMENSIONS;
    vector[hash] = (vector[hash] ?? 0) + 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
};

const cosine = (left: readonly number[], right: readonly number[]): number =>
  left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);

export interface MemoryBindings {
  AI: Ai;
  MEMORY_INDEX: Vectorize;
  /** Every vector kept, by namespace and id, with its metadata, so a test can read what was indexed. */
  vectors: Map<string, Map<string, { values: number[]; metadata?: Record<string, unknown> }>>;
  /** How many texts Workers AI was asked to read. */
  embedded: () => number;
  /** Makes the next upsert fail, as Vectorize may. */
  failNextUpsert: () => void;
}

/** In-memory twins of the Workers AI and Vectorize bindings the Memory is given. */
export const memoryBindings = (): MemoryBindings => {
  type Kept = { values: number[]; metadata?: Record<string, unknown> };
  const vectors = new Map<string, Map<string, Kept>>();
  let embedded = 0;
  let failing = false;
  const space = (namespace: string | undefined): Map<string, Kept> => {
    const key = namespace ?? '';
    const found = vectors.get(key) ?? new Map<string, Kept>();
    vectors.set(key, found);
    return found;
  };
  const ai = {
    run: async (model: string, inputs: { text: string | string[] }) => {
      if (model !== MEMORY_EMBEDDING_MODEL) throw new Error(`Unexpected model ${model}`);
      const texts = typeof inputs.text === 'string' ? [inputs.text] : inputs.text;
      embedded += texts.length;
      return { data: texts.map(twinEmbedding), shape: [texts.length, MEMORY_DIMENSIONS] };
    },
  } as unknown as Ai;
  const index = {
    upsert: async (input: Array<{ id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }>) => {
      if (failing) {
        failing = false;
        throw new Error('Vectorize is unavailable.');
      }
      for (const vector of input) space(vector.namespace).set(vector.id, { values: vector.values, ...(vector.metadata ? { metadata: vector.metadata } : {}) });
      return { mutationId: 'mutation' };
    },
    query: async (vector: number[], options: { topK?: number; namespace?: string; returnMetadata?: string }) => {
      const matches = [...space(options.namespace).entries()]
        .map(([id, kept]) => ({ id, score: cosine(vector, kept.values), ...(options.returnMetadata === 'all' && kept.metadata ? { metadata: kept.metadata } : {}) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, options.topK ?? 5);
      return { matches, count: matches.length };
    },
    deleteByIds: async (ids: string[]) => {
      for (const namespace of vectors.values()) for (const id of ids) namespace.delete(id);
      return { mutationId: 'mutation' };
    },
  } as unknown as Vectorize;
  return { AI: ai, MEMORY_INDEX: index, vectors, embedded: () => embedded, failNextUpsert: () => { failing = true; } };
};
