import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { now } from './clock';

import { decrypt, encrypt, masterKey } from './cryptography';
import { randomToken, sha256 } from './encoding';
import {
  createPkce,
  exchangeGoogleCode,
  fetchGmailHistoryId,
  fetchGoogleIdentity,
  GOOGLE_IDENTITY_SCOPES,
  googleAuthorizationUrl,
  hasCompleteGoogleGrant,
  missingGoogleScopes,
  revokeGoogleToken,
  type GoogleIdentity,
  type GoogleTokenSet,
} from './google';
import { accountKeyFor } from './keys';
import { startMailIntake } from './starter';
import { loginReturnOrigin } from './origin';
import { createDatabaseAccess } from './database-access';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import {
  accountIdentities,
  automationInboxClaims,
  identities,
  oauthFlows,
  accounts,
  sessions,
} from './storage/control-schema';
import { googleConnections } from './storage/account-schema';
import type { Bindings } from './types';

/**
 * What a Google authorization is for: signing in, which asks Google only who
 * the person is, or connecting the Account's mailbox, which asks for the whole
 * grant its tools need. The stored word for connecting a mailbox is
 * `organization_setup`, from when the grant also created the Account.
 */
type StoredIntent = 'login' | 'organization_setup';
const INBOX_INTENT: StoredIntent = 'organization_setup';

export interface GoogleEntryCompletion {
  location: string;
  /** A sign-in's new session, and whose it is. */
  signedIn?: { sessionId: string; identityId: string };
  /** The person signed in on the browser who connected a mailbox, to be its current person again. */
  currentIdentityId?: string;
}

const OAUTH_WINDOW_MS = 10 * 60 * 1_000;
/**
 * How long a session lasts after its last renewal. Each bootstrap renews it,
 * so only thirty days without opening the GUI signs a device out.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const redirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/google/callback`;
const INBOX_RETURN_PARAMETER = 'automation_reauthorization';
const inboxReturnOrigin = (env: Bindings, accountId: string): string => {
  const target = new URL('/connections', env.WEB_ORIGIN || env.APP_URL);
  target.searchParams.set(INBOX_RETURN_PARAMETER, accountId);
  return target.toString();
};
const inboxAccountIdFrom = (returnOrigin: string): string | null =>
  new URL(returnOrigin).searchParams.get(INBOX_RETURN_PARAMETER);
/** Where a mailbox connection returns: the 接続 screen, without the Account it carried there. */
const inboxReturnTarget = (returnOrigin: string): URL => {
  const target = new URL(returnOrigin);
  target.searchParams.delete(INBOX_RETURN_PARAMETER);
  // A connection begun before the GUI's paths lost the Account returns to the same screen.
  if (target.pathname.startsWith('/organizations/')) target.pathname = '/connections';
  return target;
};

/**
 * Extends a live session to a full lifetime from now, at most once a day, so a
 * session in use never expires. False when it was renewed within the last day
 * or is no longer live, in which case the browser's cookie needs no update.
 */
export const renewSession = async (env: Bindings, sessionId: string): Promise<boolean> => {
  const timestamp = now();
  const renewed = await controlDatabase(env.CONTROL_DB).update(sessions).set({
    expiresAt: expiresIn(SESSION_LIFETIME_MS),
    lastSeenAt: timestamp,
  }).where(and(
    eq(sessions.id, sessionId),
    isNull(sessions.revokedAt),
    gt(sessions.expiresAt, timestamp),
    lt(sessions.lastSeenAt, new Date(Date.now() - SESSION_RENEWAL_INTERVAL_MS).toISOString()),
  )).returning({ id: sessions.id }).get();
  return renewed !== undefined;
};

export const entryConfigurationError = (env: Bindings): string | null => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return 'Google OAuth credentials are not configured.';
  if (!env.CREDENTIAL_MASTER_KEY || !env.CREDENTIAL_MASTER_KEY_VERSION) return 'Credential encryption is not configured.';
  return null;
};

const beginGoogleEntry = async (
  env: Bindings,
  intent: StoredIntent,
  returnOrigin: string,
): Promise<string> => {
  const id = crypto.randomUUID();
  const state = randomToken();
  const pkce = await createPkce();
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const verifierEnvelope = await encrypt(pkce.verifier, key, `oauth-flow-pkce:${id}`);
  await controlDatabase(env.CONTROL_DB).insert(oauthFlows).values({
    id,
    intent,
    stateHash: await sha256(state),
    pkceVerifierEnvelope: JSON.stringify(verifierEnvelope),
    returnOrigin,
    expiresAt: expiresIn(OAUTH_WINDOW_MS),
    createdAt: now(),
  }).run();
  // Signing in only verifies identity. It must not create or revoke an
  // offline grant, because Google's revocation endpoint can invalidate the
  // Automation Inbox grant held by the same OAuth project.
  return googleAuthorizationUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: redirectUri(env),
    state,
    challenge: pkce.challenge,
    ...(intent === 'login' ? {
      scopes: GOOGLE_IDENTITY_SCOPES,
      accessType: 'online' as const,
      prompt: 'select_account' as const,
    } : {}),
  });
};

/**
 * A page of this application to return to after signing in: a path on its own
 * origin and nothing else, so signing in can never send a person elsewhere.
 */
export const returnPath = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 4000 && /^\/(?![/\\])/u.test(value) ? value : null;

/** Signs a person in by who they are on Google, asking for nothing else, and returns them to the page they were on when one is named. */
export const beginGoogleLogin = (env: Bindings, request: Request, returnTo: string | null = null): Promise<string> =>
  beginGoogleEntry(env, 'login', `${loginReturnOrigin(request, env.APP_URL, env.WEB_ORIGIN)}${returnTo ?? ''}`);

/** Connects, or reconnects, the Account's mailbox with the whole grant its tools need. */
export const beginInboxConnection = (env: Bindings, accountId: string): Promise<string> =>
  beginGoogleEntry(env, INBOX_INTENT, inboxReturnOrigin(env, accountId));

const locationWithError = (target: URL, message: string): GoogleEntryCompletion => {
  target.searchParams.set('error', message);
  return { location: target.toString() };
};

/**
 * A mailbox grant refused after Google handed it over. It is revoked only when
 * no Account reads mail with that Google account, because revoking it would
 * also revoke the grant that Account already holds.
 */
class InboxRefusal extends Error {
  constructor(message: string, readonly revoke: boolean) {
    super(message);
  }
}

interface InboxOwner {
  identityId: string;
  databaseId: string | null;
  bindingName: string;
}

/** Which of the people signed in on the browser owns the Account, if any does and it is active. */
const inboxOwner = async (env: Bindings, accountId: string, identityIds: readonly string[]): Promise<InboxOwner | undefined> => {
  if (identityIds.length === 0) return undefined;
  return await controlDatabase(env.CONTROL_DB).select({
    identityId: accountIdentities.identityId,
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId)).where(and(
    eq(accountIdentities.accountId, accountId),
    inArray(accountIdentities.identityId, [...identityIds]),
    eq(accountIdentities.state, 'active'),
    eq(accounts.status, 'active'),
  )).get();
};

/**
 * Finishes a Google authorization. Signing in stores who the person is and
 * opens a session. Connecting a mailbox needs a session on the browser of the
 * person who owns the Account it began for, and opens none: the mailbox is the
 * Account's, whoever's Google account it is.
 */
export const completeGoogleEntry = async (
  env: Bindings,
  code: string | undefined,
  state: string | undefined,
  signedInIdentityIds: readonly string[],
): Promise<GoogleEntryCompletion> => {
  let target = new URL('/', env.WEB_ORIGIN || env.APP_URL);
  if (!code || !state) return locationWithError(target, 'Google authorization was cancelled.');
  const control = controlDatabase(env.CONTROL_DB);
  const flow = await control.select().from(oauthFlows).where(and(
    eq(oauthFlows.stateHash, await sha256(state)),
    gt(oauthFlows.expiresAt, now()),
  )).get();
  if (!flow) return locationWithError(target, 'Google authorization flow expired.');
  await control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)).run();
  const inboxAccountId = flow.intent === INBOX_INTENT ? inboxAccountIdFrom(flow.returnOrigin) : null;
  target = flow.intent === 'login' ? new URL('/', flow.returnOrigin) : inboxReturnTarget(flow.returnOrigin);
  if (flow.intent !== 'login' && !inboxAccountId) return locationWithError(target, 'Google authorization flow expired.');
  const owner = inboxAccountId ? await inboxOwner(env, inboxAccountId, signedInIdentityIds) : undefined;
  const current = owner ? { currentIdentityId: owner.identityId } : {};
  try {
    const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
    const verifier = await decrypt(JSON.parse(flow.pkceVerifierEnvelope), key, `oauth-flow-pkce:${flow.id}`);
    const tokenSet = await exchangeGoogleCode({
      code,
      verifier,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(env),
    });
    const identity = await fetchGoogleIdentity(tokenSet.accessToken);
    if (!inboxAccountId) return await signIn(env, identity, returnPath(new URL(flow.returnOrigin).pathname + new URL(flow.returnOrigin).search));
    try {
      await connectInbox(env, { accountId: inboxAccountId, owner, tokenSet, identity });
    } catch (error) {
      if (tokenSet.refreshToken && error instanceof InboxRefusal && error.revoke) await revokeGoogleToken(tokenSet.refreshToken);
      throw error;
    }
    return { location: target.toString(), ...current };
  } catch (error) {
    return {
      ...locationWithError(target, error instanceof Error ? error.message : 'Google authorization failed.'),
      ...current,
    };
  }
};

const signIn = async (env: Bindings, identity: GoogleIdentity, returnTo: string | null): Promise<GoogleEntryCompletion> => {
  const control = controlDatabase(env.CONTROL_DB);
  const timestamp = now();
  await control.insert(identities).values({
    id: crypto.randomUUID(),
    googleSubject: identity.subject,
    email: identity.email,
    displayName: identity.displayName,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: identities.googleSubject,
    set: { email: identity.email, displayName: identity.displayName, updatedAt: timestamp },
  }).run();
  const person = await control.select({ id: identities.id }).from(identities)
    .where(eq(identities.googleSubject, identity.subject)).get();
  if (!person) throw new Error('Google identity could not be stored.');
  const sessionId = randomToken();
  await control.insert(sessions).values({
    id: sessionId,
    identityId: person.id,
    expiresAt: expiresIn(SESSION_LIFETIME_MS),
    createdAt: timestamp,
    lastSeenAt: timestamp,
  }).run();
  return { location: new URL(returnTo ?? '/', env.WEB_ORIGIN || env.APP_URL).toString(), signedIn: { sessionId, identityId: person.id } };
};

const connectInbox = async (env: Bindings, input: {
  accountId: string;
  owner: InboxOwner | undefined;
  tokenSet: GoogleTokenSet;
  identity: GoogleIdentity;
}): Promise<void> => {
  const { accountId, tokenSet, identity } = input;
  const control = controlDatabase(env.CONTROL_DB);
  const claimed = await control.select({ accountId: automationInboxClaims.accountId })
    .from(automationInboxClaims)
    .where(or(
      eq(automationInboxClaims.googleSubject, identity.subject),
      eq(automationInboxClaims.inboxAddress, identity.email),
    )).get();
  const revoke = !claimed;
  const member = input.owner;
  if (!member) throw new InboxRefusal('このアカウントを持つ Google アカウントで、このブラウザにログインしてから、もう一度つないでください。', revoke);
  if (!tokenSet.refreshToken) throw new InboxRefusal('Google did not return an offline Automation Inbox grant.', revoke);
  if (!hasCompleteGoogleGrant(tokenSet.scopes)) {
    throw new InboxRefusal(`Required Google permissions are missing: ${missingGoogleScopes(tokenSet.scopes).join(', ')}`, revoke);
  }
  if (claimed && claimed.accountId !== accountId) {
    throw new InboxRefusal(`${identity.email} は、別のアカウントのメールの受信箱としてつながっています。`, false);
  }
  const database = await createDatabaseAccess(env).open({
    kind: 'organization',
    bindingName: member.bindingName,
    databaseId: member.databaseId,
  });
  const account = drizzleAccountDatabase(database.raw);
  const inbox = await account.select().from(googleConnections).where(eq(googleConnections.kind, 'automation_inbox')).get();
  if (inbox && inbox.googleSubject !== identity.subject) {
    throw new InboxRefusal(`メールの受信箱は、つないだときと同じ Google アカウント（${inbox.inboxAddress}）でつなぎ直してください。`, revoke);
  }
  const accountKey = await accountKeyFor(env, accountId);
  const credentialEnvelope = JSON.stringify(await encrypt(
    JSON.stringify(tokenSet),
    accountKey,
    `google-connection:${accountId}:automation-inbox`,
  ));
  const timestamp = now();
  if (inbox) {
    // Reconnecting keeps the stored Gmail cursor. Re-anchoring it to the
    // mailbox's current position would silently drop every message that
    // arrived while the grant was rejected, which is precisely the stretch an
    // Account reconnects in order to recover.
    await account.update(googleConnections).set({
      inboxAddress: identity.email,
      grantedScopes: JSON.stringify(tokenSet.scopes),
      tokenEnvelope: credentialEnvelope,
      status: 'active',
      lastError: null,
      updatedAt: timestamp,
    }).where(eq(googleConnections.id, inbox.id)).run();
    return;
  }
  const historyId = await fetchGmailHistoryId(tokenSet.accessToken);
  // The claim is what keeps one Google account the mailbox of one Account, so it is taken before the mailbox is stored.
  if (!claimed) {
    await control.insert(automationInboxClaims).values({
      googleSubject: identity.subject,
      inboxAddress: identity.email,
      accountId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
  }
  await account.insert(googleConnections).values({
    id: crypto.randomUUID(),
    kind: 'automation_inbox',
    googleSubject: identity.subject,
    inboxAddress: identity.email,
    grantedScopes: JSON.stringify(tokenSet.scopes),
    tokenEnvelope: credentialEnvelope,
    gmailHistoryId: historyId,
    enabled: false,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
  await startMailIntake(account, new Date(timestamp));
};
