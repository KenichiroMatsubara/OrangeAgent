import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AuthorizationAccount, AuthorizationDecision, AuthorizationPreview } from '@mail/domain';
import { Hono } from 'hono';

import {
  approveAuthorization,
  authorizationServerMetadata,
  denialLocation,
  exchangeGrant,
  grantEnd,
  protectedResourceMetadata,
  readAuthorizationRequest,
  registerClient,
  type OAuthAnswer,
} from '../authorization';
import { invalid, noAccess } from '../refusal';
import { json, resource } from '../response';
import { accountDatabase, controlDatabase } from '../storage/database';
import { accountIdentities, accounts } from '../storage/control-schema';
import type { Bindings, SessionRow } from '../types';
import { activeAccountDatabase, createRequestContext } from './request-context';

/** The discovery documents a client reads before it signs in, served where RFC 8414 and RFC 9728 put them. */
export const wellKnownRoutes = new Hono<{ Bindings: Bindings }>();

wellKnownRoutes.get('/.well-known/oauth-authorization-server', (context) =>
  context.json(authorizationServerMetadata(context.env)));

wellKnownRoutes.get('/.well-known/oauth-protected-resource/api/public/organizations/:accountId/mcp', (context) =>
  context.json(protectedResourceMetadata(context.env, context.req.param('accountId'))));

const answer = (context: { json: (body: unknown, status: number, headers: Record<string, string>) => Response }, reply: OAuthAnswer): Response =>
  context.json(reply.body, reply.status, { 'Cache-Control': 'no-store' });

/** The OAuth endpoints a client calls, and the two the authorization screen calls for the signed-in member. */
export const authorizationRoutes = resource();

/** Dynamic Client Registration (RFC 7591). */
authorizationRoutes.post('/public/oauth/register', async (context) => {
  const metadata = await context.req.json<unknown>().catch(() => null);
  return answer(context, await registerClient(context.env, metadata, new Date()));
});

/** The token endpoint, which takes a form as RFC 6749 says, and JSON from a client that sends it. */
authorizationRoutes.post('/public/oauth/token', async (context) => {
  const type = context.req.header('Content-Type') ?? '';
  const form = type.includes('application/json')
    ? new URLSearchParams(Object.entries(await context.req.json<Record<string, unknown>>().catch(() => ({})))
      .flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : []))
    : new URLSearchParams(await context.req.text());
  return answer(context, await exchangeGrant(context.env, form, new Date()));
});

/** The Accounts the people signed in on this browser own, each with whose it is, the current person's first. */
const signedInAccounts = async (env: Bindings, signedIn: readonly SessionRow[]): Promise<Array<AuthorizationAccount & { identityId: string }>> => {
  if (signedIn.length === 0) return [];
  const owned = await controlDatabase(env.CONTROL_DB).select({
    identityId: accountIdentities.identityId,
    accountId: accountIdentities.accountId,
    name: accounts.name,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(and(
      inArray(accountIdentities.identityId, signedIn.map((session) => session.identity_id)),
      eq(accountIdentities.state, 'active'),
      isNotNull(accounts.databaseId),
    )).all();
  return signedIn.flatMap((session) => owned
    .filter((row) => row.identityId === session.identity_id)
    .map((row) => ({ ...row, email: session.email })));
};

const queryOf = (body: { query?: unknown }): URLSearchParams => {
  if (typeof body.query !== 'string') throw invalid('認可の要求がありません。');
  return new URLSearchParams(body.query);
};

/** What the authorization screen asks the signed-in member, for the query the client sent them with. */
authorizationRoutes.post('/oauth/authorizations/preview', async (context) => {
  const requestContext = createRequestContext(context.req.raw, context.env);
  await requestContext.requiredSession();
  const body = await context.req.json<{ query?: unknown }>().catch(() => ({}));
  const read = await readAuthorizationRequest(context.env, queryOf(body));
  if (read.kind !== 'valid') return json<AuthorizationPreview>(context, read);
  const owned = await signedInAccounts(context.env, await requestContext.signedIn());
  // The MCP Server the client named is one Google account's; whoever else is signed in here is not asked.
  const choices = read.request.accountId ? owned.filter((account) => account.accountId === read.request.accountId) : owned;
  if (choices.length === 0) return json<AuthorizationPreview>(context, { kind: 'sign_in', client: read.request.client.name });
  return json<AuthorizationPreview>(context, {
    kind: 'ask',
    client: read.request.client.name,
    redirectHost: new URL(read.request.redirectUri).host || new URL(read.request.redirectUri).protocol.replace(/:$/u, ''),
    accounts: choices.map(({ accountId, name, email }) => ({ accountId, name, email })),
    expiresAt: grantEnd(new Date()),
  });
});

/** The member's answer: an approval records the grant and sends its code back; a refusal tells the client so. */
authorizationRoutes.post('/oauth/authorizations', async (context) => {
  const requestContext = createRequestContext(context.req.raw, context.env);
  await requestContext.requiredSession();
  const body = await context.req.json<{ query?: unknown; accountId?: unknown; approve?: unknown }>().catch(() => ({} as { query?: unknown; accountId?: unknown; approve?: unknown }));
  const read = await readAuthorizationRequest(context.env, queryOf(body));
  if (read.kind === 'unsafe') throw invalid(read.message);
  if (read.kind === 'refused') return json<AuthorizationDecision>(context, { location: read.location });
  if (body.approve !== true) return json<AuthorizationDecision>(context, { location: denialLocation(context.env, read.request) });
  const accountId = typeof body.accountId === 'string' ? body.accountId : '';
  if (!accountId || (read.request.accountId && read.request.accountId !== accountId)) throw invalid('接続元が求めたアカウントを選んでください。');
  // The grant is the Google account's that owns the Account, whichever person the browser is now.
  const owner = await requestContext.owner(accountId);
  const database = await activeAccountDatabase(context.env, accountId);
  if (!database) throw noAccess('このアカウントは使えません。');
  const location = await approveAuthorization({
    env: context.env,
    db: accountDatabase(database),
    accountId,
    identityId: owner.session.identity_id,
    request: read.request,
    at: new Date(),
  });
  return json<AuthorizationDecision>(context, { location });
});
