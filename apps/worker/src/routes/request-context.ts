import { and, eq, gt, inArray, isNull } from 'drizzle-orm';

import { now } from '../clock';
import { createDatabaseAccess, DatabaseBindingUnavailableError } from '../database-access';
import { accountKeyFor } from '../keys';
import { accountUnavailable, noAccess, unauthenticated } from '../refusal';
import type { Bindings, AccountRow, SessionRow } from '../types';
import { controlDatabase } from '../storage/database';
import { browserSessionIds } from './browser';
import { accountIdentities, identities, accounts, sessions } from '../storage/control-schema';

export interface AccountAccess {
  /** The session of the person this browser is signed in as who owns the Account. */
  session: SessionRow;
  account: AccountRow;
  database: D1Database | null;
}

export interface RequestContext {
  /** Every live session the browser holds, the current one first. */
  signedIn(): Promise<SessionRow[]>;
  /** The person the browser is now, or null when it is signed in as nobody. */
  session(): Promise<SessionRow | null>;
  /** The current session, or a refusal when there is none. */
  requiredSession(): Promise<SessionRow>;
  /**
   * The Account and the session of whichever person signed in on this browser
   * owns it, whatever its state. A tab keeps working on the Account it opened
   * after another tab switches to someone else.
   */
  owner(accountId: string): Promise<{ session: SessionRow; account: AccountRow }>;
  account(accountId: string): Promise<AccountAccess>;
  accountKey(accountId: string): Promise<CryptoKey>;
  activeAccountDatabase(accountId: string): Promise<D1Database | null>;
}

/** The Account D1 of an active Account, reached without a session, or null when the Account cannot be served. */
export const activeAccountDatabase = async (env: Bindings, accountId: string): Promise<D1Database | null> => {
  const account = await controlDatabase(env.CONTROL_DB).select({
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accounts).where(and(
    eq(accounts.id, accountId),
    eq(accounts.status, 'active'),
  )).get();
  if (!account) return null;
  try {
    return (await createDatabaseAccess(env).open({
      kind: 'organization',
      bindingName: account.bindingName,
      databaseId: account.databaseId,
    })).raw;
  } catch (error) {
    if (error instanceof DatabaseBindingUnavailableError) return null;
    throw error;
  }
};

export const createRequestContext = (request: Request, env: Bindings): RequestContext => {
  const databases = createDatabaseAccess(env);
  let live: Promise<SessionRow[]> | undefined;
  const signedIn = (): Promise<SessionRow[]> => {
    live ??= (async () => {
      const ids = browserSessionIds(request.headers.get('Cookie'));
      if (ids.length === 0) return [];
      const rows = await controlDatabase(env.CONTROL_DB).select({
        id: sessions.id,
        identity_id: sessions.identityId,
        email: identities.email,
        display_name: identities.displayName,
      }).from(sessions).innerJoin(identities, eq(identities.id, sessions.identityId)).where(and(
        inArray(sessions.id, ids),
        gt(sessions.expiresAt, now()),
        isNull(sessions.revokedAt),
      )).all();
      return ids.flatMap((id) => rows.filter((row) => row.id === id));
    })();
    return live;
  };
  const session = async (): Promise<SessionRow | null> => (await signedIn())[0] ?? null;
  const requiredSession = async (): Promise<SessionRow> => {
    const current = await session();
    if (!current) throw unauthenticated();
    return current;
  };
  const owner = async (accountId: string): Promise<{ session: SessionRow; account: AccountRow }> => {
    const people = await signedIn();
    if (people.length === 0) throw unauthenticated();
    const membership = await controlDatabase(env.CONTROL_DB).select({
      identityId: accountIdentities.identityId,
      id: accounts.id,
      name: accounts.name,
      status: accounts.status,
      database_id: accounts.databaseId,
      binding_name: accounts.bindingName,
    }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
      .where(and(
        inArray(accountIdentities.identityId, people.map((person) => person.identity_id)),
        eq(accountIdentities.accountId, accountId),
        eq(accountIdentities.state, 'active'),
      ))
      .get();
    const person = membership && people.find((candidate) => candidate.identity_id === membership.identityId);
    if (!membership || !person) throw noAccess('このアカウントへのアクセス権がありません。');
    const { id, name, status, database_id, binding_name } = membership;
    return { session: person, account: { id, name, status, database_id, binding_name } };
  };

  return {
    signedIn,
    session,
    requiredSession,
    owner,
    async account(accountId) {
      const { session: currentSession, account: membership } = await owner(accountId);
      if (membership.status !== 'active') throw accountUnavailable('このアカウントは現在利用できません。');
      let database: D1Database | null = null;
      try {
        database = (await databases.open({
          kind: 'organization',
          bindingName: membership.binding_name,
          databaseId: membership.database_id,
        })).raw;
      } catch (error) {
        if (!(error instanceof DatabaseBindingUnavailableError)) throw error;
      }
      return {
        session: currentSession,
        account: membership,
        database,
      };
    },
    accountKey: (accountId) => accountKeyFor(env, accountId),
    activeAccountDatabase: (accountId) => activeAccountDatabase(env, accountId),
  };
};
