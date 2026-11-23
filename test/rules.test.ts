import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SOURCES = ['apps', 'packages', 'scripts', 'test'];

/** Every test file of the repository, by its path from the root. */
const testFiles = (): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.tsx?$/u.test(entry.name)) found.push(relative(ROOT, path));
    }
  };
  for (const source of SOURCES) walk(join(ROOT, source));
  return found;
};

describe('the suite', () => {
  it('replaces no module: a test swaps what a module reads at call time instead', () => {
    // The unit suite runs each worker's files in one module graph (vitest.config.ts),
    // where a module one file replaced would stay replaced for every file after it.
    const replacing = testFiles().filter((file) => /\bvi\.(?:mock|doMock|hoisted)\(/u.test(readFileSync(join(ROOT, file), 'utf8')));

    expect(replacing).toEqual([]);
  });
});
