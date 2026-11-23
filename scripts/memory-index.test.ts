import { describe, expect, it } from 'vitest';

import { ensureMemoryIndex, memoryIndexName } from './memory-index';

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const cloudflare = (found: Response) => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return calls.length === 1 ? found : answer(200, { success: true, result: { name: 'flarechat-memory' } });
  }) as typeof fetch;
  return { calls, fetcher };
};

describe('the Memory index', () => {
  it('creates the index with the dimensions and metric the embedding model needs when it is missing', async () => {
    const { calls, fetcher } = cloudflare(answer(404, { success: false, errors: [{ code: 3000, message: 'vectorize.index.not_found' }] }));
    await expect(ensureMemoryIndex({ fetch: fetcher, accountId: 'acct', token: 't', name: 'flarechat-memory' })).resolves.toBe('created');
    expect(calls[1]).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/accounts/acct/vectorize/v2/indexes',
      method: 'POST',
      body: { name: 'flarechat-memory', config: { dimensions: 1024, metric: 'cosine' } },
    });
  });

  it('leaves an index that already reads text as the Memory does', async () => {
    const { calls, fetcher } = cloudflare(answer(200, { success: true, result: { name: 'flarechat-memory', config: { dimensions: 1024, metric: 'cosine' } } }));
    await expect(ensureMemoryIndex({ fetch: fetcher, accountId: 'acct', token: 't', name: 'flarechat-memory' })).resolves.toBe('present');
    expect(calls).toHaveLength(1);
  });

  it('stops the release on an index created for another model', async () => {
    const { fetcher } = cloudflare(answer(200, { success: true, result: { config: { dimensions: 768, metric: 'cosine' } } }));
    await expect(ensureMemoryIndex({ fetch: fetcher, accountId: 'acct', token: 't', name: 'flarechat-memory' })).rejects.toThrow(/768 dimensions/u);
  });

  it('stops the release when the index cannot be read', async () => {
    const { fetcher } = cloudflare(answer(403, { success: false }));
    await expect(ensureMemoryIndex({ fetch: fetcher, accountId: 'acct', token: 't', name: 'flarechat-memory' })).rejects.toThrow(/403/u);
  });

  it('reads the index name from the binding wrangler.jsonc declares', () => {
    expect(memoryIndexName({ vectorize: [{ binding: 'MEMORY_INDEX', index_name: 'flarechat-memory' }] })).toBe('flarechat-memory');
    expect(() => memoryIndexName({})).toThrow(/MEMORY_INDEX/u);
  });
});
