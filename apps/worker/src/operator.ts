/**
 * The Operator Token: how a member's own CLI or agent acts on an Account as
 * Operator Chat does, over the MCP Server, for ninety days.
 *
 * A signed-in member asks the 接続 screen for a Login Code, which lasts ten
 * minutes and is exchanged once for the Token. Google sign-in is what admits
 * the member, so the Token is only ever as good as that member's membership:
 * it is checked on every call, and a member who is removed takes their
 * Tokens with them.
 */

import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';

import { accessTokenHash, generateAccessToken } from './access-token';
import { operatorTokens } from './storage/account-schema';
import { accountIdentities, identities } from './storage/control-schema';
import { controlDatabase, type AccountDatabase } from './storage/database';

export const LOGIN_CODE_MINUTES = 10;
export const OPERATOR_TOKEN_DAYS = 90;

/** Thirty-two characters a person reads without confusing one for another: no 0, 1, I, or O. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/** Eight characters, forty random bits, written as two groups of four. */
export const generateLoginCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

/** A code as it is typed, read without its case or the hyphen and spaces between its groups. */
export const loginCodeHash = (presented: string): Promise<string> =>
  accessTokenHash(presented.toUpperCase().replace(/[^0-9A-Z]/gu, ''));

const later = (at: Date, milliseconds: number): string => new Date(at.getTime() + milliseconds).toISOString();

/**
 * Issues a Login Code for the member asking. Codes nobody exchanged and Tokens
 * that have expired are removed first, since neither can be used again.
 */
export const issueLoginCode = async (input: { db: AccountDatabase; identityId: string; at: Date }): Promise<{ code: string; expiresAt: string }> => {
  const timestamp = input.at.toISOString();
  await input.db.delete(operatorTokens).where(or(
    and(isNull(operatorTokens.tokenHash), lte(operatorTokens.codeExpiresAt, timestamp)),
    lte(operatorTokens.expiresAt, timestamp),
  )).run();
  const code = generateLoginCode();
  const expiresAt = later(input.at, LOGIN_CODE_MINUTES * 60_000);
  await input.db.insert(operatorTokens).values({
    id: crypto.randomUUID(),
    identityId: input.identityId,
    codeHash: await loginCodeHash(code),
    codeExpiresAt: expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
  return { code, expiresAt };
};

/**
 * Exchanges an unexpired Login Code for its Operator Token, at most once: the
 * one update that writes the Token also clears the code, so two CLIs
 * presenting the same code cannot both receive one.
 */
export const exchangeLoginCode = async (input: { db: AccountDatabase; presented: string; at: Date }): Promise<{ id: string; identityId: string; token: string; expiresAt: string } | null> => {
  const timestamp = input.at.toISOString();
  const token = generateAccessToken();
  const expiresAt = later(input.at, OPERATOR_TOKEN_DAYS * 86_400_000);
  const exchanged = await input.db.update(operatorTokens).set({
    codeHash: null,
    tokenHash: await accessTokenHash(token),
    expiresAt,
    updatedAt: timestamp,
  }).where(and(
    eq(operatorTokens.codeHash, await loginCodeHash(input.presented)),
    isNull(operatorTokens.tokenHash),
    gt(operatorTokens.codeExpiresAt, timestamp),
  )).returning({ id: operatorTokens.id, identityId: operatorTokens.identityId }).get();
  return exchanged ? { ...exchanged, token, expiresAt } : null;
};

export interface AuthenticatedOperatorToken {
  id: string;
  identityId: string;
}

/**
 * Resolves the presented credential, or null when it is not one of this
 * Account's unexpired Operator Tokens. One an OAuth client holds also stops
 * working when its hour is up, until the client refreshes it.
 */
export const authenticateOperatorToken = async (input: { db: AccountDatabase; presented: string; at: Date }): Promise<AuthenticatedOperatorToken | null> => {
  const timestamp = input.at.toISOString();
  const row = await input.db.select({ id: operatorTokens.id, identityId: operatorTokens.identityId }).from(operatorTokens).where(and(
    eq(operatorTokens.tokenHash, await accessTokenHash(input.presented)),
    gt(operatorTokens.expiresAt, timestamp),
    or(isNull(operatorTokens.accessExpiresAt), gt(operatorTokens.accessExpiresAt, timestamp)),
  )).get();
  return row ?? null;
};

/** Records when a Token was last used. */
export const recordOperatorTokenUse = async (input: { db: AccountDatabase; tokenId: string; at: Date }): Promise<void> => {
  const timestamp = input.at.toISOString();
  await input.db.update(operatorTokens).set({ lastUsedAt: timestamp, updatedAt: timestamp }).where(eq(operatorTokens.id, input.tokenId)).run();
};

/** Whether the Identity is still an active member of the Account, which every Operator Token is only as good as. */
export const isActiveMember = async (input: { control: D1Database; accountId: string; identityId: string }): Promise<boolean> => {
  const row = await controlDatabase(input.control).select({ state: accountIdentities.state }).from(accountIdentities).where(and(
    eq(accountIdentities.accountId, input.accountId),
    eq(accountIdentities.identityId, input.identityId),
    eq(accountIdentities.state, 'active'),
  )).get();
  return Boolean(row);
};

/** The Account's unexpired Operator Tokens, newest first, each named by the Google account of the member it acts as and the client that holds it. */
export const listOperatorTokens = async (input: { db: AccountDatabase; control: D1Database; at: Date }): Promise<Array<{
  id: string;
  email: string;
  client: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}>> => {
  const rows = await input.db.select().from(operatorTokens).where(and(
    isNotNull(operatorTokens.tokenHash),
    gt(operatorTokens.expiresAt, input.at.toISOString()),
  )).all();
  const identityIds = [...new Set(rows.map((row) => row.identityId))];
  const emails = identityIds.length
    ? new Map((await controlDatabase(input.control).select({ id: identities.id, email: identities.email }).from(identities)
      .where(inArray(identities.id, identityIds)).all()).map((identity) => [identity.id, identity.email]))
    : new Map<string, string>();
  return rows
    .map((row) => ({
      id: row.id,
      email: emails.get(row.identityId) ?? '',
      client: row.clientId ? row.clientName ?? '' : null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt ?? '',
      lastUsedAt: row.lastUsedAt,
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

export const revokeOperatorToken = async (input: { db: AccountDatabase; tokenId: string }): Promise<void> => {
  await input.db.delete(operatorTokens).where(eq(operatorTokens.id, input.tokenId)).run();
};

/** The member an Operator Token acts as, as a memory their CLI keeps names them: by name, else by Google account. */
export const memberName = async (input: { control: D1Database; identityId: string }): Promise<string> => {
  const row = await controlDatabase(input.control).select({ email: identities.email, displayName: identities.displayName })
    .from(identities).where(eq(identities.id, input.identityId)).get();
  return row ? row.displayName.trim() || row.email : '';
};
