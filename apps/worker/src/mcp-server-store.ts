/**
 * Binds OrangeAgent's MCP Server to one Account's database: which Token called,
 * what it was granted, whom it may reach, and how its writes actually happen.
 */

import { asc, eq } from 'drizzle-orm';

import { accessTokenHash } from './access-token';
import { publishedSkill, type SkillStore } from './skills';
import { suppressionExpiry, suppressionHolds, type SuppressionWindow } from './suppression';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import {
  accessTokens,
  accessTokenTools,
  contactListMembers,
  skills,
  suppressions,
} from './storage/account-schema';
import type { McpServerPrompt } from './mcp-server';

export interface AuthenticatedAccessToken {
  id: string;
  name: string;
  grant: string[];
  contactIds: string[];
  suppressionWindow: SuppressionWindow;
}

/** Resolves the presented credential, or null when it is not this Account's. */
export const authenticateAccessToken = async (input: {
  database: D1Database;
  presented: string;
}): Promise<AuthenticatedAccessToken | null> => {
  const db = drizzleAccountDatabase(input.database);
  const hash = await accessTokenHash(input.presented);
  const row = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, hash)).get();
  if (!row) return null;
  const [grantRows, listRows] = await Promise.all([
    db.select({ tool: accessTokenTools.tool }).from(accessTokenTools).where(eq(accessTokenTools.tokenId, row.id)).all(),
    db.select({ contactId: contactListMembers.contactId }).from(contactListMembers)
      .where(eq(contactListMembers.listId, row.contactListId)).all(),
  ]);
  return {
    id: row.id,
    name: row.name,
    grant: grantRows.map(({ tool }) => tool),
    contactIds: listRows.map(({ contactId }) => contactId),
    suppressionWindow: row.suppressionWindow,
  };
};

/** Records when a Token was last used; every call it makes is admitted. */
export const recordAccessTokenUse = async (input: { database: D1Database; token: AuthenticatedAccessToken; at: Date }): Promise<void> => {
  const timestamp = input.at.toISOString();
  await drizzleAccountDatabase(input.database).update(accessTokens).set({ lastUsedAt: timestamp, updatedAt: timestamp })
    .where(eq(accessTokens.id, input.token.id)).run();
};

export const suppressionPort = (input: { database: D1Database; scope: string; window: SuppressionWindow; at: Date }) => {
  const db = drizzleAccountDatabase(input.database);
  return {
    check: async (key: string): Promise<boolean> => {
      const row = await db.select({ expiresAt: suppressions.expiresAt }).from(suppressions).where(eq(suppressions.key, key)).get();
      if (!row) return false;
      if (suppressionHolds({ expiresAt: row.expiresAt, at: input.at })) return true;
      await db.delete(suppressions).where(eq(suppressions.key, key)).run();
      return false;
    },
    record: async (key: string): Promise<void> => {
      const timestamp = input.at.toISOString();
      await db.insert(suppressions).values({
        key,
        scope: input.scope,
        tool: key.split(' ')[1] ?? '',
        recordedAt: timestamp,
        expiresAt: suppressionExpiry({ window: input.window, at: input.at }),
      }).onConflictDoUpdate({
        target: suppressions.key,
        set: { recordedAt: timestamp, expiresAt: suppressionExpiry({ window: input.window, at: input.at }) },
      }).run();
    },
  };
};

/** The Account's published Skills, offered to an outside agent as MCP prompts under their own description, each opened with its files when asked for. */
export const publishedPrompts = async (store: SkillStore): Promise<McpServerPrompt[]> => {
  const rows = await store.db.select({
    id: skills.id,
    name: skills.name,
    description: skills.description,
    instructions: skills.instructions,
    revision: skills.revision,
  }).from(skills).where(eq(skills.published, true)).orderBy(asc(skills.name)).all();
  return rows.map((row) => ({
    name: row.name,
    // A Skill written before descriptions were opens with what it is for.
    description: row.description.trim() || row.instructions.split('\n')[0]?.slice(0, 120) || row.name,
    open: () => publishedSkill(store, row.id),
  }));
};
