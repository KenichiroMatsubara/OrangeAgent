/**
 * The Memory's part of the background pass: in each active Account, build
 * the keywords and vectors of the memories not yet indexed. That is every
 * memory kept before Episodes, once, and any memory whose vector could not
 * be written when it was kept.
 */

import { eq } from 'drizzle-orm';

import { createDatabaseAccess } from '../database-access';
import { accounts } from '../storage/control-schema';
import { accountDatabase, controlDatabase } from '../storage/database';
import type { Bindings } from '../types';
import { memoryStoreOf, reindexMemories } from './store';

/** How many memories one pass indexes in one Account; the rest wait for the next pass. */
const PER_PASS = 200;

export const indexPendingMemories = async (env: Bindings): Promise<number> => {
  const active = await controlDatabase(env.CONTROL_DB).select({
    id: accounts.id,
    bindingName: accounts.bindingName,
    databaseId: accounts.databaseId,
  }).from(accounts).where(eq(accounts.status, 'active')).all();
  const databases = createDatabaseAccess(env);
  let indexed = 0;
  for (const account of active) {
    if (!account.databaseId) continue;
    try {
      const database = await databases.open({ kind: 'organization', bindingName: account.bindingName, databaseId: account.databaseId });
      const outcome = await reindexMemories(memoryStoreOf(env, accountDatabase(database.raw), account.id), PER_PASS);
      indexed += outcome.indexed;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'memory_upkeep_skipped',
        accountId: account.id,
        message: error instanceof Error ? error.message : 'The Account’s memories could not be indexed.',
      }));
    }
  }
  return indexed;
};
