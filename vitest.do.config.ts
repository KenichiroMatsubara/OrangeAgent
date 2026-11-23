import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

import { t3chatAliases } from './packages/t3chat/vite';
import { textModules } from './test/text';

/**
 * The suite that runs the Worker itself in workerd: its entry points and its
 * Durable Objects, with their storage, alarms, evictions, and hibernating
 * WebSockets as the runtime keeps them. The Worker is configured as
 * `wrangler dev --env local` configures it, which binds no Container, so no
 * Docker is needed and the Workbench's classes are not run here.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './apps/worker/src/index.ts',
      remoteBindings: false,
      wrangler: { configPath: './apps/worker/wrangler.jsonc', environment: 'local' },
      miniflare: {
        // Local development binds no Dynamic Worker loader (deployment-contract.test.ts); the suite binds one to run the
        // code `code.run` lends a Dynamic Worker, as the deployed Worker does.
        workerLoaders: { LOADER: {} },
        // The deployment key every Account's key is wrapped with, as test/automation.ts gives the Node suite.
        bindings: {
          CREDENTIAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          CREDENTIAL_MASTER_KEY_VERSION: 'v1',
        },
      },
    }),
    t3chatAliases(),
    textModules(),
  ],
  test: {
    include: ['apps/worker/src/**/*.do.test.ts'],
    // A worker started for a test file is handed, in one WebSocket message, every module the file's import graph
    // holds that Vitest's module cache already transformed (fetchWarmModules, inlined by the Workers pool). With
    // Pi's SDKs in the Worker's graph that one message passed workerd's 1 MiB limit in CI (1009, Message is too
    // large) and the worker died; without the cache each module is fetched on its own.
    fsModuleCache: false,
    // The clock is the runtime's own: an alarm is set at a time the runtime keeps, which a frozen past would fire at once.
    setupFiles: ['./test/storage.ts'],
    // A test serves the model at the global `fetch`, which the Worker reads at every call.
    unstubGlobals: true,
  },
});
