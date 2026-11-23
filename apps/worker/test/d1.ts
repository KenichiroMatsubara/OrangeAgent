import BetterSqlite3 from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;
const TEST_QUERY = Symbol('test-query');

interface TestPreparedQuery {
  query: string;
  parameters: unknown[];
}

/** The longest LIKE or GLOB pattern D1 accepts, in bytes; local SQLite allows far longer. */
export const D1_PATTERN_LIMIT = 50;

const PATTERN_LITERAL = /\b(?:LIKE|GLOB)\s+'((?:[^']|'')*)'/giu;
const PATTERN_PARAMETER = /\b(?:LIKE|GLOB)\s+\?/giu;
const STRING_LITERAL = /'(?:[^']|'')*'/gu;

/**
 * Refuses what D1 refuses, so a migration or a query that only production
 * would reject fails here first: a LIKE or GLOB pattern longer than 50 bytes,
 * whether it is written in the SQL or bound as a parameter.
 */
const assertD1Limits = (query: string, parameters: readonly unknown[] = []): void => {
  const tooLong = (pattern: string): boolean => new TextEncoder().encode(pattern).length > D1_PATTERN_LIMIT;
  const refuse = (): never => { throw new Error('LIKE or GLOB pattern too complex: SQLITE_ERROR'); };
  for (const match of query.matchAll(PATTERN_LITERAL)) {
    if (tooLong((match[1] ?? '').replaceAll("''", "'"))) refuse();
  }
  const blanked = query.replace(STRING_LITERAL, (literal) => ' '.repeat(literal.length));
  for (const match of blanked.matchAll(PATTERN_PARAMETER)) {
    const position = (match.index ?? 0) + match[0].length - 1;
    const index = blanked.slice(0, position).split('?').length - 1;
    const value = parameters[index];
    if (typeof value === 'string' && tooLong(value)) refuse();
  }
};

const d1Result = <T>(results: T[], changes = 0): D1Result<T> => ({
  success: true,
  results,
  meta: {
    served_by: 'test',
    duration: 0,
    changes,
    last_row_id: 0,
    changed_db: changes > 0,
    size_after: 0,
    rows_read: results.length,
    rows_written: changes,
  },
});

const createStatement = (database: SqliteDatabase, query: string, parameters: unknown[] = []): D1PreparedStatement => ({
  [TEST_QUERY]: { query, parameters },
  bind: (...values: unknown[]) => createStatement(database, query, values),
  first: async <T>(column?: string): Promise<T | null> => {
    assertD1Limits(query, parameters);
    const row = database.prepare(query).get(...parameters) as Record<string, T> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  },
  all: async <T>(): Promise<D1Result<T>> => {
    assertD1Limits(query, parameters);
    return d1Result(database.prepare(query).all(...parameters) as T[]);
  },
  run: async <T>(): Promise<D1Result<T>> => {
    assertD1Limits(query, parameters);
    const result = database.prepare(query).run(...parameters);
    return d1Result<T>([], result.changes);
  },
  raw: async <T>(): Promise<T[][]> => {
    assertD1Limits(query, parameters);
    return database.prepare(query).raw(true).all(...parameters) as T[][];
  },
} as unknown as D1PreparedStatement);

export interface TestD1Database {
  binding: D1Database;
  execute: (query: string, ...parameters: unknown[]) => void;
  rows: <T>(query: string, ...parameters: unknown[]) => T[];
  row: <T>(query: string, ...parameters: unknown[]) => T | undefined;
  close: () => void;
}

/**
 * Opens an empty in-memory database, or a private in-memory copy of `image`
 * when one is given. Pragmas belong to the connection, not to the image, so
 * they are set here whichever way the database was opened.
 */
const openSqlite = (image?: Buffer): SqliteDatabase => {
  const database = image ? new BetterSqlite3(image) : new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  return database;
};

const wrapTestD1Database = (database: SqliteDatabase): TestD1Database => {
  const binding = {
    prepare: (query: string) => createStatement(database, query),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      database.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const prepared = (statement as unknown as {
            [TEST_QUERY]?: TestPreparedQuery;
          })[TEST_QUERY];
          if (!prepared) throw new Error('Test D1 received an unsupported prepared statement.');
          assertD1Limits(prepared.query, prepared.parameters);
          const result = database.prepare(prepared.query).run(...prepared.parameters);
          return d1Result<T>([], result.changes);
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (query: string): Promise<D1ExecResult> => {
      assertD1Limits(query);
      database.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
  return {
    binding,
    execute: (query, ...parameters) => {
      assertD1Limits(query, parameters);
      database.prepare(query).run(...parameters);
    },
    rows: <T>(query: string, ...parameters: unknown[]) => database.prepare(query).all(...parameters) as T[],
    row: <T>(query: string, ...parameters: unknown[]) => database.prepare(query).get(...parameters) as T | undefined,
    close: () => database.close(),
  };
};

export const createTestD1Database = (): TestD1Database => wrapTestD1Database(openSqlite());

const migrationDirectory = (kind: 'control' | 'organization'): string =>
  resolve(import.meta.dirname, `../migrations/${kind}`);

export const applyTestMigrations = (
  database: TestD1Database,
  kind: 'control' | 'organization',
  through?: string,
): void => {
  const names = readdirSync(migrationDirectory(kind))
    .filter((file) => file.endsWith('.sql') && (through === undefined || file <= through))
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory(kind), name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
      database.execute(statement);
    }
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) {
    database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  }
};

/** Each migrated schema, built once per test file (Vitest isolates modules per file), keyed by kind and last migration. */
const migratedImages = new Map<string, Buffer>();

const migratedImage = (kind: 'control' | 'organization', through: string | undefined): Buffer => {
  const key = `${kind}:${through ?? ''}`;
  const cached = migratedImages.get(key);
  if (cached) return cached;
  const database = openSqlite();
  applyTestMigrations(wrapTestD1Database(database), kind, through);
  const image = database.serialize();
  database.close();
  migratedImages.set(key, image);
  return image;
};

/**
 * A database with every migration of `kind` applied, through `through` when
 * given. The migrations run once per test file; each call opens its own
 * copy of the result, so no test sees another's writes.
 */
export const createMigratedTestD1 = (
  kind: 'control' | 'organization',
  through?: string,
): TestD1Database => wrapTestD1Database(openSqlite(migratedImage(kind, through)));
