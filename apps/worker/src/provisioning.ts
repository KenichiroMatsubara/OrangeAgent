import { and, eq } from 'drizzle-orm';

import { createAccountKey, decrypt, encrypt, masterKey, unwrapAccountKey } from './cryptography';
import { fleetMigration } from './fleet-migration';
import { provisionAccountDatabase } from './account-db';
import { applyPreset } from './presets';
import { ensureStarterAutomations } from './starter';
import { controlDatabase, accountDatabase } from './storage/database';
import { accountIdentities, accountKeys, accountProvisionings, accounts, identities } from './storage/control-schema';
import type { AccountProvisioningRecord } from './storage/control-schema';
import { googleConnections } from './storage/account-schema';
import type { Bindings } from './types';

type ProvisioningPhase = NonNullable<AccountProvisioningRecord['phase']>;

export class SchemaReleaseInProgressError extends Error {
  constructor() {
    super('Account provisioning is paused during a schema release.');
    this.name = 'SchemaReleaseInProgressError';
  }
}

const requireProvisioningAllowed = async (env: Bindings): Promise<void> => {
  if (!await fleetMigration.provisioningAllowed(env)) {
    throw new SchemaReleaseInProgressError();
  }
};

const recordPhase = async (env: Bindings, accountId: string, phase: ProvisioningPhase): Promise<void> => {
  await controlDatabase(env.CONTROL_DB).update(accountProvisionings).set({
    phase,
    updatedAt: new Date().toISOString(),
  }).where(eq(accountProvisionings.accountId, accountId)).run();
};

export const provisionAccount = async (
  env: Bindings,
  provisioning: AccountProvisioningRecord,
): Promise<void> => {
  await requireProvisioningAllowed(env);
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  await recordPhase(env, provisioning.accountId, 'allocating_database');
  const owner = await controlDatabase(env.CONTROL_DB).select({ email: identities.email }).from(identities)
    .where(eq(identities.id, provisioning.ownerIdentityId)).get();
  if (!owner) throw new Error('The Account owner is missing.');
  const provisioned = await provisionAccountDatabase(env, {
    accountId: provisioning.accountId,
    ownerAddress: owner.email,
    bindingName: provisioning.bindingName,
    databaseId: provisioning.databaseId,
  });
  const control = controlDatabase(env.CONTROL_DB);
  await control.update(accountProvisionings).set({
    databaseId: provisioned.databaseId,
    bindingName: provisioned.bindingName,
    updatedAt: new Date().toISOString(),
  }).where(eq(accountProvisionings.accountId, provisioning.accountId)).run();
  await recordPhase(env, provisioning.accountId, 'applying_schema');
  await provisioned.initialize();
  const account = accountDatabase(provisioned.database);
  if (provisioning.presetId) {
    await applyPreset(account, provisioning.accountId, provisioning.presetId, {
      applicationKey: provisioning.provisioningKey,
    });
  }
  const inbox = inboxOf(provisioning);
  await ensureStarterAutomations(account, provisioning.accountId, { mailbox: inbox !== null });
  if (inbox) await storeInbox(env, account, provisioning.accountId, inbox, key);
  await recordPhase(env, provisioning.accountId, 'verifying_binding');
  await provisioned.finalize();
  await requireProvisioningAllowed(env);
  await recordPhase(env, provisioning.accountId, 'activating_organization');
  const timestamp = new Date().toISOString();
  await control.batch([
    control.update(accounts).set({
      databaseId: provisioned.databaseId,
      bindingName: provisioned.bindingName,
      status: 'active',
      updatedAt: timestamp,
    }).where(eq(accounts.id, provisioning.accountId)),
    control.update(accountIdentities).set({ state: 'active', updatedAt: timestamp }).where(and(
      eq(accountIdentities.accountId, provisioning.accountId),
      eq(accountIdentities.identityId, provisioning.ownerIdentityId),
    )),
    control.delete(accountProvisionings)
      .where(eq(accountProvisionings.accountId, provisioning.accountId)),
  ]);
};

/** The mailbox a provisioning begun before migration 0006 was handed, or null for an Account created without one. */
interface PendingInbox {
  inboxAddress: string;
  googleSubject: string;
  grantedScopes: string;
  credentialEnvelope: string;
  historyId: string;
}

const inboxOf = (provisioning: AccountProvisioningRecord): PendingInbox | null => {
  const { inboxAddress, googleSubject, grantedScopes, credentialEnvelope, historyId } = provisioning;
  if (!inboxAddress || !googleSubject || !grantedScopes || !credentialEnvelope || !historyId) return null;
  return { inboxAddress, googleSubject, grantedScopes, credentialEnvelope, historyId };
};

const storeInbox = async (
  env: Bindings,
  account: ReturnType<typeof accountDatabase>,
  accountId: string,
  inbox: PendingInbox,
  key: CryptoKey,
): Promise<void> => {
  const control = controlDatabase(env.CONTROL_DB);
  const keyRecord = await control.select({
    masterKeyVersion: accountKeys.masterKeyVersion,
    wrappedKeyEnvelope: accountKeys.wrappedKeyEnvelope,
  }).from(accountKeys).where(eq(accountKeys.accountId, accountId)).get();
  if (!keyRecord) throw new Error('Account encryption key is missing.');
  const accountKey = await unwrapAccountKey({
    masterKeyVersion: keyRecord.masterKeyVersion,
    envelope: JSON.parse(keyRecord.wrappedKeyEnvelope),
  }, key, accountId);
  const tokenSet = await decrypt(
    JSON.parse(inbox.credentialEnvelope),
    key,
    `automation-inbox-token:${inbox.googleSubject}`,
  );
  const tokenEnvelope = await encrypt(
    tokenSet,
    accountKey,
    `google-connection:${accountId}:automation-inbox`,
  );
  const timestamp = new Date().toISOString();
  await recordPhase(env, accountId, 'storing_credentials');
  await account.insert(googleConnections).values({
    id: crypto.randomUUID(),
    kind: 'automation_inbox',
    googleSubject: inbox.googleSubject,
    inboxAddress: inbox.inboxAddress,
    grantedScopes: inbox.grantedScopes,
    tokenEnvelope: JSON.stringify(tokenEnvelope),
    gmailHistoryId: inbox.historyId,
    enabled: false,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: googleConnections.googleSubject,
    set: {
      inboxAddress: inbox.inboxAddress,
      grantedScopes: inbox.grantedScopes,
      tokenEnvelope: JSON.stringify(tokenEnvelope),
      gmailHistoryId: inbox.historyId,
      enabled: false,
      status: 'active',
      lastError: null,
      updatedAt: timestamp,
    },
  }).run();
};

export const createProvisioningAccountKey = async (env: Bindings, accountId: string): Promise<void> => {
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const wrapped = await createAccountKey(key, env.CREDENTIAL_MASTER_KEY_VERSION, accountId);
  const timestamp = new Date().toISOString();
  await controlDatabase(env.CONTROL_DB).insert(accountKeys).values({
    accountId,
    masterKeyVersion: wrapped.masterKeyVersion,
    wrappedKeyEnvelope: JSON.stringify(wrapped.envelope),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoNothing().run();
};
