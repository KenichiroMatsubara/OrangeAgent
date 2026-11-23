import { afterEach, beforeEach, vi } from 'vitest';

import { api } from './api';

type Endpoints = Record<string, unknown>;

/**
 * Replaces every endpoint of the GUI's client with a mock for each test of the
 * file that calls it, and puts the real ones back after.
 *
 * The client is one object every screen and loader reads at call time, so its
 * endpoints are swapped in place instead of replacing the module: the whole
 * suite runs in one shared module graph, where a module mock of one file
 * would leak into every file after it. Each mock answers undefined until the
 * test says otherwise with `vi.mocked(api.x)`.
 */
export const fakeApi = (): void => {
  const endpoints = api as unknown as Endpoints;
  const real = { ...endpoints };

  beforeEach(() => {
    for (const [name, value] of Object.entries(real)) {
      if (typeof value === 'function') endpoints[name] = vi.fn();
    }
  });

  afterEach(() => {
    Object.assign(endpoints, real);
  });
};
