import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { now } from './clock';

import type { AppState, SignedInPerson } from '@mail/domain';

import { verifyInboxCredential } from './inbox';
import { productionProviders } from './providers';
import { decrypt, masterKey } from './cryptography';
import { createDatabaseAccess } from './database-access';
import { revokeGoogleToken } from './google';
import { accountDatabaseIdentity } from './account-db';
import {
  createProvisioningAccountKey,
  provisionAccount,
  SchemaReleaseInProgressError,
} from './provisioning';
import { conflict } from './refusal';
import { controlDatabase } from './storage/database';
import {
  accountIdentities,
  automationInboxClaims,
  identities,
  contactLogins,
  accountProvisionings,
  accounts,
  accountSetups,
} from './storage/control-schema';
import type { AccountProvisioningRecord, AccountSetupRecord } from './storage/control-schema';
import type { Bindings, SessionRow } from './types';

const PROVISIONING_WINDOW_MS = 24 * 60 * 60 * 1_000;

const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const provisioningByAccountId = (
  env: Bindings,
  accountId: string,
): Promise<AccountProvisioningRecord | undefined> =>
  controlDatabase(env.CONTROL_DB).select().from(accountProvisionings)
    .where(eq(accountProvisionings.accountId, accountId)).get();

const revokeCredential = async (
  env: Bindings,
  credentialEnvelope: string | null,
  googleSubject: string | null,
): Promise<void> => {
  if (!credentialEnvelope || !googleSubject) return;
  try {
    const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
    const tokens = JSON.parse(await decrypt(
      JSON.parse(credentialEnvelope),
      key,
      `automation-inbox-token:${googleSubject}`,
    )) as { refreshToken?: string };
    if (tokens.refreshToken) await revokeGoogleToken(tokens.refreshToken);
  } catch {
    // Local state must still be erased when Google revocation is unavailable.
  }
};

const discardSetup = async (env: Bindings, setup: AccountSetupRecord): Promise<void> => {
  await revokeCredential(env, setup.credentialEnvelope, setup.googleSubject);
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.delete(automationInboxClaims).where(eq(automationInboxClaims.setupId, setup.id)),
    control.delete(accountSetups).where(eq(accountSetups.id, setup.id)),
  ]);
};

const discardProvisioning = async (
  env: Bindings,
  provisioning: AccountProvisioningRecord,
): Promise<void> => {
  await revokeCredential(env, provisioning.credentialEnvelope, provisioning.googleSubject);
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.delete(automationInboxClaims).where(eq(automationInboxClaims.accountId, provisioning.accountId)),
    control.delete(accounts).where(eq(accounts.id, provisioning.accountId)),
  ]);
};

const attemptProvision = async (env: Bindings, provisioning: AccountProvisioningRecord): Promise<void> => {
  try {
    await createProvisioningAccountKey(env, provisioning.accountId);
    await provisionAccount(env, provisioning);
  } catch (error) {
    if (error instanceof SchemaReleaseInProgressError) return;
    await controlDatabase(env.CONTROL_DB).update(accountProvisionings).set({
      state: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Provisioning failed.',
      updatedAt: now(),
    }).where(eq(accountProvisionings.accountId, provisioning.accountId)).run();
  }
};

/**
 * Creates the signed-in person's own Account, named after them: no name to
 * confirm, nothing to grant, and no Google mailbox, which is connected later
 * on the 接続 screen.
 */
export const startAccount = async (env: Bindings, session: SessionRow): Promise<void> => {
  const control = controlDatabase(env.CONTROL_DB);
  const [membership, provisioning] = await Promise.all([
    control.select({ accountId: accountIdentities.accountId }).from(accountIdentities)
      .where(and(eq(accountIdentities.identityId, session.identity_id), eq(accountIdentities.state, 'active'))).get(),
    control.select({ accountId: accountProvisionings.accountId }).from(accountProvisionings)
      .where(eq(accountProvisionings.ownerIdentityId, session.identity_id)).get(),
  ]);
  if (membership || provisioning) throw conflict('このGoogleアカウントは、すでにアカウントを持っています。');
  const accountId = crypto.randomUUID();
  const { bindingName } = await accountDatabaseIdentity({ ownerAddress: session.email, accountId });
  const createdAt = now();
  await control.batch([
    control.insert(accounts).values({
      id: accountId,
      name: session.display_name.trim() || session.email,
      status: 'provisioning',
      bindingName,
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(accountIdentities).values({
      accountId,
      identityId: session.identity_id,
      state: 'active',
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(accountProvisionings).values({
      accountId,
      ownerIdentityId: session.identity_id,
      state: 'provisioning',
      bindingName,
      provisioningKey: crypto.randomUUID(),
      expiresAt: expiresIn(PROVISIONING_WINDOW_MS),
      createdAt,
      updatedAt: createdAt,
    }),
  ]);
  await createProvisioningAccountKey(env, accountId);
  const current = await provisioningByAccountId(env, accountId);
  if (current) await attemptProvision(env, current);
};

export const retryAccountProvisioning = async (
  env: Bindings,
  ownerIdentityId: string,
): Promise<void> => {
  const provisioning = await controlDatabase(env.CONTROL_DB).select().from(accountProvisionings)
    .where(and(
      eq(accountProvisionings.ownerIdentityId, ownerIdentityId),
      eq(accountProvisionings.state, 'failed'),
    )).get();
  if (!provisioning) throw conflict('Account provisioning is not waiting for retry.');
  if (Date.parse(provisioning.expiresAt) <= Date.now()) {
    await discardProvisioning(env, provisioning);
    throw conflict('Account setup expired. Start over with Google authorization.');
  }
  await controlDatabase(env.CONTROL_DB).update(accountProvisionings)
    .set({ state: 'provisioning', errorMessage: null, updatedAt: now() })
    .where(eq(accountProvisionings.accountId, provisioning.accountId)).run();
  const ready = await provisioningByAccountId(env, provisioning.accountId);
  if (!ready) throw conflict('Account provisioning could not be retried.');
  await attemptProvision(env, ready);
};

export const cancelAccountOnboarding = async (
  env: Bindings,
  ownerIdentityId: string,
): Promise<boolean> => {
  const control = controlDatabase(env.CONTROL_DB);
  const setup = await control.select().from(accountSetups)
    .where(eq(accountSetups.ownerIdentityId, ownerIdentityId)).get();
  if (setup) await discardSetup(env, setup);
  const provisioning = await control.select().from(accountProvisionings)
    .where(eq(accountProvisionings.ownerIdentityId, ownerIdentityId)).get();
  if (provisioning) await discardProvisioning(env, provisioning);
  return Boolean(setup || provisioning);
};

/** Everyone the browser is signed in as, the current person first, each with their own Account. */
export const signedInPeople = async (env: Bindings, signedIn: readonly SessionRow[]): Promise<SignedInPerson[]> => {
  if (signedIn.length === 0) return [];
  const owned = await controlDatabase(env.CONTROL_DB).select({
    identityId: accountIdentities.identityId,
    accountId: accountIdentities.accountId,
    name: accounts.name,
    status: accounts.status,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(and(
      inArray(accountIdentities.identityId, signedIn.map((session) => session.identity_id)),
      eq(accountIdentities.state, 'active'),
      isNotNull(accounts.databaseId),
    )).orderBy(asc(accountIdentities.createdAt)).all();
  return signedIn.map((session) => {
    const account = owned.find((row) => row.identityId === session.identity_id);
    return {
      identityId: session.identity_id,
      email: session.email,
      displayName: session.display_name,
      account: account ? { accountId: account.accountId, name: account.name, status: account.status } : null,
    };
  });
};

/** The application state of the browser's current person, the first of the sessions it holds. */
export const applicationState = async (env: Bindings, signedIn: readonly [SessionRow, ...SessionRow[]]): Promise<AppState> => {
  const [session] = signedIn;
  const signed = { identity: { email: session.email, displayName: session.display_name }, people: await signedInPeople(env, signedIn) };
  const control = controlDatabase(env.CONTROL_DB);
  const memberships = await control.select({
    accountId: accountIdentities.accountId,
    name: accounts.name,
    status: accounts.status,
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(and(
      eq(accountIdentities.identityId, session.identity_id),
      eq(accountIdentities.state, 'active'),
      isNotNull(accounts.databaseId),
    )).orderBy(asc(accountIdentities.createdAt)).all();
  const [owned] = memberships;
  if (owned) {
    const database = await createDatabaseAccess(env).open({
      kind: 'organization',
      bindingName: owned.bindingName,
      databaseId: owned.databaseId,
    });
    await verifyInboxCredential({
      env,
      accountId: owned.accountId,
      database: database.raw,
      google: productionProviders().google,
    });
    return {
      kind: 'ready',
      ...signed,
      account: { accountId: owned.accountId, name: owned.name, status: owned.status },
    };
  }
  const contactLogin = await control.select({
    accountId: contactLogins.accountId,
    name: accounts.name,
  }).from(contactLogins).innerJoin(accounts, eq(accounts.id, contactLogins.accountId))
    .innerJoin(identities, eq(identities.googleSubject, contactLogins.googleSubject))
    .where(and(eq(identities.id, session.identity_id), eq(accounts.status, 'active'))).get();
  if (contactLogin) {
    return {
      kind: 'member',
      ...signed,
      account: { accountId: contactLogin.accountId, name: contactLogin.name },
    };
  }
  // A setup that waited for a name before migration 0006 holds a mailbox grant nobody will confirm now.
  const setup = await control.select().from(accountSetups)
    .where(eq(accountSetups.ownerIdentityId, session.identity_id)).get();
  if (setup) await discardSetup(env, setup);
  const provisioning = await control.select({
    accountId: accountProvisionings.accountId,
    name: accounts.name,
    state: accountProvisionings.state,
    phase: accountProvisionings.phase,
    errorMessage: accountProvisionings.errorMessage,
    expiresAt: accountProvisionings.expiresAt,
  }).from(accountProvisionings)
    .innerJoin(accounts, eq(accounts.id, accountProvisionings.accountId))
    .where(eq(accountProvisionings.ownerIdentityId, session.identity_id)).get();
  if (provisioning?.state === 'failed') {
    return {
      kind: 'provisioning_failed',
      ...signed,
      account: { id: provisioning.accountId, name: provisioning.name },
      phase: provisioning.phase,
      error: provisioning.errorMessage,
      retryUntil: provisioning.expiresAt,
    };
  }
  if (provisioning) {
    return {
      kind: 'provisioning',
      ...signed,
      account: { id: provisioning.accountId, name: provisioning.name },
      phase: provisioning.phase,
    };
  }
  return { kind: 'unassigned', ...signed };
};

export const retryProvisioning = async (env: Bindings): Promise<void> => {
  const rows = await controlDatabase(env.CONTROL_DB).select().from(accountProvisionings)
    .where(inArray(accountProvisionings.state, ['provisioning', 'failed']))
    .orderBy(asc(accountProvisionings.updatedAt)).limit(10).all();
  for (const provisioning of rows) {
    if (Date.parse(provisioning.expiresAt) <= Date.now()) {
      await discardProvisioning(env, provisioning);
      continue;
    }
    await attemptProvision(env, provisioning);
  }
};
