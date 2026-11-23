// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The config loader `npm run dev:mock` names, read from the script itself so the two cannot drift. */
const mockLoader = async (): Promise<'bundle' | 'runner' | 'native'> => {
  const manifest = JSON.parse(await readFile(`${root}package.json`, 'utf8')) as { scripts: Record<string, string> };
  const loader = /--configLoader\s+(\w+)/u.exec(manifest.scripts['dev:mock'] ?? '')?.[1] ?? 'bundle';
  if (loader !== 'bundle' && loader !== 'runner' && loader !== 'native') throw new Error(`Unknown config loader ${loader}`);
  return loader;
};

describe('dev:mock', () => {
  it('loads its config, which reads the domain package, with the loader its script names', async () => {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, `${root}vite.mock.ts`, root, 'silent', undefined, await mockLoader());
    expect(loaded?.config.server?.port).toBe(5199);
  }, 30_000);
});
