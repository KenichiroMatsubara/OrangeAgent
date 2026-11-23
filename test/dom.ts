import { JSDOM } from 'jsdom';
import { populateGlobal, type Environment } from 'vitest/runtime';

/**
 * The page every DOM test runs in: one jsdom window per worker, kept from one
 * test file to the next.
 *
 * Vitest's own jsdom environment builds a new window for every file. The suite
 * runs a worker's files in one module graph, so a module imported by an
 * earlier file (Testing Library's `screen`, React's event system) would still
 * hold that earlier file's document. Keeping one window keeps them right, and
 * spares building a window per file. Between tests, `test/reset.ts` empties
 * what a test leaves in it.
 */
const KEPT = Symbol.for('flarechat.dom');

interface Kept {
  dom: JSDOM;
}

const keptWindow = (global: Record<symbol, unknown>): JSDOM => {
  const kept = global[KEPT] as Kept | undefined;
  if (kept) return kept.dom;
  const dom = new JSDOM('<!DOCTYPE html>', { pretendToBeVisual: true, runScripts: 'dangerously', url: 'http://localhost:3000' });
  global[KEPT] = { dom } satisfies Kept;
  return dom;
};

/** Raises an error the page threw that no listener of the test took, as Vitest's own environment does. */
const raiseWindowErrors = (window: JSDOM['window']): (() => void) => {
  const raise = (event: ErrorEvent): void => {
    if (event.error != null && !event.defaultPrevented) process.emit('uncaughtException', event.error);
  };
  window.addEventListener('error', raise);
  return () => window.removeEventListener('error', raise);
};

/**
 * How much faster than the wall the page's monotonic clock runs.
 *
 * React holds back each Suspense boundary's content for 300ms after showing
 * its fallback, by `performance.now()`, so a reveal reads as one change.
 * Testing Library re-renders outside `act`, where the hold applies, and
 * every screen fills its sections that way: the suite spent most of its idle
 * time there. On a clock ten times as fast the hold is 30ms.
 */
const CLOCK_RATE = 10;

const quicken = (performance: Performance): void => {
  const marked = performance as Performance & { [KEPT]?: true };
  if (marked[KEPT]) return;
  const real = performance.now.bind(performance);
  const start = real();
  performance.now = () => start + (real() - start) * CLOCK_RATE;
  marked[KEPT] = true;
};

const environment: Environment = {
  name: 'dom',
  viteEnvironment: 'client',
  setup: (global: Record<string | symbol, unknown>) => {
    const dom = keptWindow(global);
    const { keys, originals } = populateGlobal(global, dom.window, { bindFunctions: true });
    quicken(dom.window.performance);
    quicken(globalThis.performance);
    const stopRaising = raiseWindowErrors(dom.window);
    return {
      teardown: (torn: Record<string | symbol, unknown>) => {
        stopRaising();
        for (const key of keys) delete torn[key];
        for (const [key, value] of originals) torn[key] = value;
      },
    };
  },
};

export default environment;
