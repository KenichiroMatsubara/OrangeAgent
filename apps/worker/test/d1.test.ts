import { afterEach, describe, expect, it } from 'vitest';

import { createTestD1Database, type TestD1Database } from './d1';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('the test D1', () => {
  it('refuses a LIKE or GLOB pattern longer than D1 accepts, written or bound', async () => {
    database = createTestD1Database();
    const long = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]*';

    await expect(database.binding.prepare(`SELECT 'x' GLOB '${long}'`).all()).rejects.toThrow('LIKE or GLOB pattern too complex');
    await expect(database.binding.prepare("SELECT 'x' LIKE ?").bind(`%${'あ'.repeat(17)}%`).all()).rejects.toThrow('LIKE or GLOB pattern too complex');
    await expect(database.binding.prepare("SELECT '?' LIKE ? AS matched").bind('%x%').first('matched')).resolves.toBe(0);
  });
});
