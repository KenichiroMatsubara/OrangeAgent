/**
 * Makes sure the Vectorize index the Memory's meanings are kept in exists
 * before `wrangler deploy` binds the Worker to it, and that it reads text as
 * the Worker's embedding model writes it. A missing index is created; one
 * created with other dimensions or another metric stops the release, because
 * every query against it would fail.
 *
 * Runs in `npm run deploy:cloudflare`, after the migrations and before the
 * Worker is deployed. It creates an index and never changes or deletes one.
 */

import { readFileSync } from 'node:fs';

import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';

import { MEMORY_DIMENSIONS } from '../apps/worker/src/memory/vectors';
import { deployedConfigPath } from './deploy-config';

export const MEMORY_METRIC = 'cosine';

interface IndexConfig {
  dimensions?: number;
  metric?: string;
}

interface CloudflareAnswer {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: { name?: string; config?: IndexConfig } | null;
}

export type EnsureOutcome = 'created' | 'present';

/** Creates the index when it is missing, and refuses one whose dimensions or metric differ. */
export const ensureMemoryIndex = async (input: {
  fetch: typeof fetch;
  accountId: string;
  token: string;
  name: string;
}): Promise<EnsureOutcome> => {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/vectorize/v2/indexes`;
  const headers = { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' };
  const found = await input.fetch(`${base}/${encodeURIComponent(input.name)}`, { headers });
  if (found.ok) {
    const config = ((await found.json()) as CloudflareAnswer).result?.config ?? {};
    if (config.dimensions !== MEMORY_DIMENSIONS || config.metric !== MEMORY_METRIC) {
      throw new Error(`Vectorize index ${input.name} reads ${config.dimensions ?? '?'} dimensions by ${config.metric ?? '?'}; the Memory needs ${MEMORY_DIMENSIONS} by ${MEMORY_METRIC}.`);
    }
    return 'present';
  }
  if (found.status !== 404) throw new Error(`Vectorize index ${input.name} could not be read: ${found.status} ${await found.text()}`);
  const made = await input.fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: input.name,
      description: 'FlareChat Memory: one namespace per Account',
      config: { dimensions: MEMORY_DIMENSIONS, metric: MEMORY_METRIC },
    }),
  });
  if (!made.ok) throw new Error(`Vectorize index ${input.name} could not be created: ${made.status} ${await made.text()}`);
  return 'created';
};

/** The index the Worker binds the Memory to, as wrangler.jsonc names it. */
export const memoryIndexName = (wrangler: { vectorize?: Array<{ binding?: string; index_name?: string }> }): string => {
  const name = wrangler.vectorize?.find(({ binding }) => binding === 'MEMORY_INDEX')?.index_name;
  if (!name) throw new Error('wrangler.jsonc binds no Vectorize index as MEMORY_INDEX.');
  return name;
};

const main = async (): Promise<void> => {
  const wrangler = JSON5.parse(readFileSync(deployedConfigPath(), 'utf8')) as {
    vars?: Record<string, unknown>;
    vectorize?: Array<{ binding?: string; index_name?: string }>;
  };
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required to make sure the Memory index exists.');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || wrangler.vars?.CLOUDFLARE_ACCOUNT_ID;
  if (typeof accountId !== 'string' || !accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is missing from the environment and the deploy configuration.');
  const name = memoryIndexName(wrangler);
  const outcome = await ensureMemoryIndex({ fetch, accountId, token, name });
  process.stdout.write(`${JSON.stringify({ phase: 'memory_index', index: name, outcome })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
