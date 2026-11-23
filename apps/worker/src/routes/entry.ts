import { and, eq, isNotNull } from 'drizzle-orm';

import { now } from '../clock';
import { createDatabaseAccess } from '../database-access';
import { beginGoogleLogin, completeGoogleEntry, entryConfigurationError, renewSession, returnPath } from '../entry';
import { accountKeyFor } from '../keys';
import { completeMicrosoftConnection, openMicrosoftState } from '../microsoft';
import { completeMcpSignIn, openMcpState, recordMcpSignInFailure } from '../mcp-oauth';
import { applicationState, cancelAccountOnboarding, retryAccountProvisioning, startAccount } from '../onboarding';
import { noAccess, upstream } from '../refusal';
import { json, resource } from '../response';
import { CONTROL_SCHEMA_TARGET, schemaLifecycle } from '../schema-lifecycle';
import { browserCookie, browserSessionIds, revokeSessions, signInto, withCurrent } from './browser';
import { createRequestContext } from './request-context';
import type { SessionRow } from '../types';
import { accountDatabase, controlDatabase } from '../storage/database';
import { accountIdentities, accounts } from '../storage/control-schema';

export const entryRoutes = resource();
export const oauthRoutes = resource();


entryRoutes.get('/health', async (context) => {
  const control = await createDatabaseAccess(context.env).open({ kind: 'control' });
  return json(context, {
    status: 'ok',
    service: 'mail-automation',
    time: now(),
    database: {
      control: {
        currentMigration: await schemaLifecycle.currentMigration(control.raw),
        expectedMigration: CONTROL_SCHEMA_TARGET,
      },
    },
  });
});

// Signing in asks Google only who the person is; a mailbox is connected from inside the Account.
entryRoutes.post('/entry/google', async (context) => {
  const misconfigured = entryConfigurationError(context.env);
  if (misconfigured) throw upstream(misconfigured);
  const body = await context.req.json<{ returnTo?: unknown }>().catch(() => ({} as { returnTo?: unknown }));
  return json(context, { authorizationUrl: await beginGoogleLogin(context.env, context.req.raw, returnPath(body.returnTo)) }, 201);
});

/** The browser's sessions with this person's first, or null when they are not signed in on it. */
const currentFirst = (signedIn: readonly SessionRow[], identityId: string): string[] | null => {
  const session = signedIn.find((candidate) => candidate.identity_id === identityId);
  return session ? withCurrent(signedIn, session.id) : null;
};

// Signing in adds the Google account to those the browser holds, as its current person; connecting a mailbox makes its owner current again.
oauthRoutes.get('/oauth/google/callback', async (context) => {
  const signedIn = await createRequestContext(context.req.raw, context.env).signedIn();
  const completed = await completeGoogleEntry(context.env, context.req.query('code'), context.req.query('state'), signedIn.map((session) => session.identity_id));
  const ids = completed.signedIn
    ? await signInto(context.env, signedIn, completed.signedIn)
    : completed.currentIdentityId ? currentFirst(signedIn, completed.currentIdentityId) : null;
  if (ids && ids.join() !== signedIn.map((session) => session.id).join()) context.header('Set-Cookie', browserCookie(context.req.raw, ids));
  return context.redirect(completed.location);
});

// The Microsoft account is connected only to the Account, and by the person, the state was minted for.
oauthRoutes.get('/oauth/microsoft/callback', async (context) => {
  const state = await openMicrosoftState(context.env, context.req.query('state'));
  if (!state) return context.redirect(context.env.WEB_ORIGIN || context.env.APP_URL);
  const target = new URL('/connections', context.env.WEB_ORIGIN || context.env.APP_URL);
  const code = context.req.query('code');
  try {
    const requestContext = createRequestContext(context.req.raw, context.env);
    const access = await requestContext.account(state.accountId);
    // The 接続 screen it returns to opens as the person who connected it.
    const signedIn = await requestContext.signedIn();
    if (signedIn[0]?.id !== access.session.id) context.header('Set-Cookie', browserCookie(context.req.raw, withCurrent(signedIn, access.session.id)));
    if (!code || access.session.identity_id !== state.identityId || !access.database) throw new Error('Microsoft connection was not completed.');
    await completeMicrosoftConnection({
      env: context.env, db: accountDatabase(access.database), key: await accountKeyFor(context.env, state.accountId),
      accountId: state.accountId, code, verifier: state.verifier,
    });
    target.searchParams.set('microsoft', 'connected');
  } catch (error) {
    console.error(JSON.stringify({ event: 'microsoft_connection_failed', accountId: state.accountId, message: error instanceof Error ? error.message : String(error) }));
    target.searchParams.set('microsoft', 'failed');
  }
  return context.redirect(target.toString());
});

// An MCP Server is signed in to only for the Account, and by the person, the state was minted for.
oauthRoutes.get('/oauth/mcp/callback', async (context) => {
  const state = await openMcpState(context.env, context.req.query('state'));
  if (!state) return context.redirect(context.env.WEB_ORIGIN || context.env.APP_URL);
  const target = new URL('/connections', context.env.WEB_ORIGIN || context.env.APP_URL);
  const code = context.req.query('code');
  const requestContext = createRequestContext(context.req.raw, context.env);
  let database: D1Database | null = null;
  try {
    const access = await requestContext.account(state.accountId);
    database = access.database;
    // The 接続 screen it returns to opens as the person who signed in.
    const signedIn = await requestContext.signedIn();
    if (signedIn[0]?.id !== access.session.id) context.header('Set-Cookie', browserCookie(context.req.raw, withCurrent(signedIn, access.session.id)));
    if (access.session.identity_id !== state.identityId || !access.database) throw new Error('The MCP Server sign-in was not completed by the person who started it.');
    const refused = context.req.query('error');
    if (!code) throw new Error(refused ? `サインインが取り消されました（${context.req.query('error_description') ?? refused}）。` : 'サインインが完了しませんでした。');
    await completeMcpSignIn({
      env: context.env, fetch: (url, init) => fetch(url, init), database: access.database, key: await accountKeyFor(context.env, state.accountId), state, code,
    });
    target.searchParams.set('mcp', 'connected');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'mcp_sign_in_failed', accountId: state.accountId, serverId: state.serverId, message }));
    if (database) await recordMcpSignInFailure(database, state.serverId, message).catch(() => undefined);
    target.searchParams.set('mcp', 'failed');
  }
  return context.redirect(target.toString());
});

entryRoutes.post('/onboarding/start', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  await startAccount(context.env, session);
  return json(context, { accepted: true });
});

entryRoutes.post('/onboarding/retry', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  await retryAccountProvisioning(context.env, session.identity_id);
  return json(context, { accepted: true });
});

entryRoutes.delete('/onboarding', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  return json(context, { cancelled: await cancelAccountOnboarding(context.env, session.identity_id) });
});

entryRoutes.get('/auth/me', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  const memberships = await controlDatabase(context.env.CONTROL_DB).select({
    accountId: accountIdentities.accountId,
    name: accounts.name,
    status: accounts.status,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(and(eq(accountIdentities.identityId, session.identity_id), eq(accountIdentities.state, 'active'), isNotNull(accounts.databaseId))).all();
  return json(context, { email: session.email, displayName: session.display_name, accounts: memberships });
});

entryRoutes.get('/bootstrap', async (context) => {
  const listed = browserSessionIds(context.req.header('Cookie'));
  const signedIn = await createRequestContext(context.req.raw, context.env).signedIn();
  const [session, ...others] = signedIn;
  if (!session) {
    if (listed.length > 0) context.header('Set-Cookie', browserCookie(context.req.raw, []));
    return json(context, { kind: 'signed_out' });
  }
  const state = await applicationState(context.env, [session, ...others]);
  // Every page load bootstraps, so renewing here keeps the current person's session in use from expiring.
  // A session that ended since the cookie was written is dropped from it.
  if (await renewSession(context.env, session.id) || listed.length !== signedIn.length) {
    context.header('Set-Cookie', browserCookie(context.req.raw, signedIn.map((live) => live.id)));
  }
  return json(context, state);
});

const identityOf = (body: { identityId?: unknown }): string | null =>
  typeof body.identityId === 'string' && body.identityId ? body.identityId : null;

/** Makes another Google account signed in on this browser its current person. */
entryRoutes.post('/auth/switch', async (context) => {
  const signedIn = await createRequestContext(context.req.raw, context.env).signedIn();
  const body = await context.req.json<{ identityId?: unknown }>().catch(() => ({} as { identityId?: unknown }));
  const identityId = identityOf(body);
  const ids = identityId ? currentFirst(signedIn, identityId) : null;
  if (!ids) throw noAccess('この Google アカウントは、このブラウザでログインしていません。');
  context.header('Set-Cookie', browserCookie(context.req.raw, ids));
  return json(context, { switched: true });
});

/**
 * Signs one Google account out of this browser, the current one unless
 * another is named, or every one when asked. The others stay signed in, and
 * the first of them becomes the current person.
 */
entryRoutes.post('/auth/logout', async (context) => {
  const listed = browserSessionIds(context.req.header('Cookie'));
  const signedIn = await createRequestContext(context.req.raw, context.env).signedIn();
  const body = await context.req.json<{ identityId?: unknown; everyone?: unknown }>().catch(() => ({} as { identityId?: unknown; everyone?: unknown }));
  const identityId = identityOf(body) ?? signedIn[0]?.identity_id ?? null;
  const leaving = body.everyone === true ? listed : signedIn.filter((session) => session.identity_id === identityId).map((session) => session.id);
  await revokeSessions(context.env, leaving);
  const remaining = signedIn.filter((session) => !leaving.includes(session.id));
  context.header('Set-Cookie', browserCookie(context.req.raw, remaining.map((session) => session.id)));
  return json(context, { loggedOut: true, remaining: remaining.length });
});
