import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

import { t3chatAliases } from './packages/t3chat/vite';
import { textModules } from './test/text';

/**
 * The tests that drive screens in a page: the GUI's, and the chat's it
 * renders. They are two projects so CI can run each in its own job: the
 * chat's files alone import about a thousand modules before their first test.
 */
const webTests = ['apps/web/**/*.test.{ts,tsx}'];
const chatTests = ['packages/t3chat/src/**/*.test.tsx'];

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Modules the tests resolve elsewhere than Node would, for every file alike:
 * the Workers runtime's own module, which Node lacks, and the chat's
 * translations as a browser loads them, where Node would pick their server
 * build.
 */
const nodeAliases = [{ find: /^cloudflare:workers$/u, replacement: at('./apps/worker/test/workers.ts') }];
const domAliases = [{ find: /^gt-react$/u, replacement: at('./node_modules/gt-react/dist/index.client.mjs') }];

export default defineConfig({
  plugins: [t3chatAliases(), textModules()],
  test: {
    exclude: [...configDefaults.exclude, '**/*.d1.test.ts', '**/*.do.test.ts', '**/.claude/**'],
    setupFiles: ['./test/clock.ts', './test/reset.ts'],
    // Every file of a worker runs in one module graph: importing the Worker or
    // a screen once per worker instead of once per file was most of the
    // suite's time. A test therefore never replaces a module (`vi.mock`); it
    // swaps what a module reads at call time, and `test/reset.ts` puts back
    // what a test leaves behind.
    isolate: false,
    unstubGlobals: true,
    unstubEnvs: true,
    // Vitest's default is one worker fewer than the CPUs, which on CI's
    // two-CPU runner is a single worker: every file ran one after another.
    maxWorkers: '100%',
    projects: [
      { extends: true, resolve: { alias: domAliases }, test: { name: 'web', environment: './test/dom.ts', include: webTests } },
      { extends: true, resolve: { alias: domAliases }, test: { name: 'chat', environment: './test/dom.ts', include: chatTests } },
      { extends: true, resolve: { alias: nodeAliases }, test: { name: 'node', exclude: [...configDefaults.exclude, '**/*.d1.test.ts', '**/*.do.test.ts', '**/.claude/**', ...webTests, ...chatTests] } },
    ],
  },
});
