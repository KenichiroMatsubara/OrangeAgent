import { reset } from 'cloudflare:test';
import { afterEach } from 'vitest';

/** Storage is isolated per file since vitest-plugin 0.13; this restores per-test isolation. */
afterEach(async () => {
  await reset();
});
