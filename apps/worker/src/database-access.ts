import type { Bindings } from './types';

export interface ReadyAccountDatabase {
  kind: 'organization';
  raw: D1Database;
}

export interface ReadyControlDatabase {
  kind: 'control';
  raw: D1Database;
}

export type ReadyDatabase = ReadyControlDatabase | ReadyAccountDatabase;

type ControlDatabaseLocator = {
  kind: 'control';
};

type AccountDatabaseLocator = {
  kind: 'organization';
  bindingName: string;
  databaseId: string | null;
};

export type DatabaseLocator = ControlDatabaseLocator | AccountDatabaseLocator;

export class DatabaseBindingUnavailableError extends Error {
  constructor(bindingName: string) {
    super(`Account database binding ${bindingName} is unavailable.`);
    this.name = 'DatabaseBindingUnavailableError';
  }
}

/**
 * Resolves the D1 binding a locator names. Making a schema current
 * is the release's job, not a request's: `npm run deploy:cloudflare` migrates
 * Control and every Organization database before a Worker serves them, and
 * provisioning migrates a new database before activating it.
 */
export const createDatabaseAccess = (env: Bindings) => ({
  async open(locator: DatabaseLocator): Promise<ReadyDatabase> {
    const bindingName = locator.kind === 'control' ? 'CONTROL_DB' : locator.bindingName;
    const bound = (env as unknown as Record<string, unknown>)[bindingName];
    if (!bound || typeof bound !== 'object') {
      throw new DatabaseBindingUnavailableError(bindingName);
    }
    return { kind: locator.kind, raw: bound as D1Database } as ReadyDatabase;
  },
});
