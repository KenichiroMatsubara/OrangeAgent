import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as controlSchema from './control-schema';
import * as accountSchema from './account-schema';

export type ControlDatabase = DrizzleD1Database<typeof controlSchema>;
export type AccountDatabase = DrizzleD1Database<typeof accountSchema>;

export const controlDatabase = (binding: D1Database): ControlDatabase =>
  drizzle(binding, { schema: controlSchema });

export const accountDatabase = (binding: D1Database): AccountDatabase =>
  drizzle(binding, { schema: accountSchema });

/**
 * Whether a column contains a phrase, ignoring ASCII case as LIKE does. D1
 * refuses a LIKE pattern longer than 50 bytes, which a phrase of about sixteen
 * Japanese characters already is, so a search never builds one.
 */
export const contains = (column: SQLWrapper, phrase: string): SQL =>
  sql`instr(lower(${column}), lower(${phrase})) > 0`;
