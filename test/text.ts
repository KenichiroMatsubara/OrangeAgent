import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/**
 * What the Worker imports as its text, as wrangler.jsonc's Text rule has it:
 * a migration, a program a starting Skill carries (`starter/*.mjs`), and a
 * library a run's code is lent (`lent/*.mjs`). The
 * program's own tests read its file and import that text as a module, as a
 * Dynamic Worker does.
 */
export const textModules = (): Plugin => ({
  name: 'text-modules',
  enforce: 'pre',
  load: async (id) => id.endsWith('.sql') || /\/(starter|lent)\/[^/]+\.mjs$/u.test(id)
    ? `export default ${JSON.stringify(await readFile(id, 'utf8'))};`
    : null,
});
