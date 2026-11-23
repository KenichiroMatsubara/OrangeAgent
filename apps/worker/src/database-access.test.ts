import { afterEach, describe, expect, it } from 'vitest';

import { createTestD1Database, type TestD1Database } from '../test/d1';
import { createDatabaseAccess, DatabaseBindingUnavailableError } from './database-access';
import type { Bindings } from './types';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Database Access', () => {
  it('returns the bound Account database without touching its schema', async () => {
    const database = createTestD1Database();
    openDatabases.push(database);
    const access = createDatabaseAccess({
      ORG_EXAMPLE: database.binding,
    } as unknown as Bindings);

    const ready = await access.open({
      kind: 'organization',
      bindingName: 'ORG_EXAMPLE',
      databaseId: 'database-example',
    });

    expect(ready.raw).toBe(database.binding);
    expect(database.rows("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
  });

  it('refuses a binding the Worker does not have', async () => {
    const access = createDatabaseAccess({} as Bindings);

    await expect(access.open({
      kind: 'organization',
      bindingName: 'ORG_MISSING',
      databaseId: 'database-missing',
    })).rejects.toBeInstanceOf(DatabaseBindingUnavailableError);
  });
});
