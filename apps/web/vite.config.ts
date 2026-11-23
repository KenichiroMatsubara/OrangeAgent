import { readFile } from 'node:fs/promises';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type PluginOption } from 'vite';

import { t3chat } from '@mail/t3chat/vite';

import { precache } from './precache';

/** The Worker imports its migrations and the Workbench's programs as text, as wrangler's `Text` rule reads them. */
const text = (): Plugin => ({
  name: 'sql-text-modules',
  enforce: 'pre',
  load: async (id) => id.endsWith('.sql') || id.endsWith('.py')
    ? `export default ${JSON.stringify(await readFile(id, 'utf8'))};`
    : null,
});

/**
 * `vite` serves the GUI and runs the Worker beside it in workerd, on one origin at port 8787,
 * configured as `wrangler.jsonc` configures the environment CLOUDFLARE_ENV names.
 * `vite build` builds the GUI alone: the Worker is built and deployed by wrangler, never by this plugin,
 * whose build writes the Worker's secrets into its output.
 */
const worker = (): PluginOption[] => [
  cloudflare({
    configPath: '../worker/wrangler.jsonc',
    persistState: { path: '../worker/.wrangler/state' },
  }),
  text(),
];

export default defineConfig(({ command }) => ({
  // The Service Worker is built beside the page as /sw.js, so its scope is the whole site.
  plugins: [react(), ...t3chat(), precache(), ...(command === 'serve' ? worker() : [])],
  server: { port: 8787, strictPort: true },
}));
