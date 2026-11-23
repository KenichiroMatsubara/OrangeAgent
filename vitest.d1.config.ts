import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

import { t3chatAliases } from './packages/t3chat/vite';
import { textModules } from './test/text';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-07-24',
        d1Databases: {
          CONTROL_DB: 'control-test',
          LOCAL_ORGANIZATION_DB_1: 'organization-test',
        },
        r2Buckets: ['RECOVERY_RECEIPTS'],
      },
    }),
    t3chatAliases(),
    textModules(),
  ],
  test: {
    include: ['apps/worker/src/**/*.d1.test.ts'],
    setupFiles: ['./test/clock.ts', './test/storage.ts'],
  },
});
