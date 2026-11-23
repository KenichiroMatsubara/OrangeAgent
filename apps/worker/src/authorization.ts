/**
 * The OAuth authorization server in front of the MCP Server.
 *
 * A client such as Claude registers itself (RFC 7591), sends a member to the
 * authorization screen, and exchanges the code it is given (PKCE S256) for an
 * Operator Token: the same credential a Login Code yields, bound to the member
 * who approved it and checked against their membership on every call. Google
 * sign-in stays the only way a person is identified; this server only records
 * what a signed-in member approved.
 *
 * A client's registration is sealed into its own client_id with the deployment
 * key, so registering keeps no row: a client that registers again on every
 * connection costs nothing, and only a member's approval is stored.
 *
 * The grant lasts ninety days from the approval, as an Operator Token always
 * has. Within them the client holds an access token for an hour and replaces it
 * with a refresh token that is itself replaced on every use.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';

import { accessTokenHash, generateAccessToken } from './access-token';
import { decrypt, encrypt, masterKey } from './cryptography';
import { decodeText, encodeText, fromBase64Url, toArrayBuffer, toBase64Url } from './encoding';
import { isActiveMember, LOGIN_CODE_MINUTES, OPERATOR_TOKEN_DAYS } from './operator';
import { activeAccountDatabase } from './routes/request-context';
import { operatorTokens } from './storage/account-schema';
import { accountDatabase, type AccountDatabase } from './storage/database';
import type { Bindings } from './types';

/** How long one access token works before the client refreshes it. */
export const ACCESS_TOKEN_SECONDS = 3600;

const CLIENT_CONTEXT = 'mcp-oauth-client';
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_CLIENT_NAME = 100;
/** Schemes a redirect may never use, whatever a client registers. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const issuerOf = (env: Bindings): string => env.APP_URL.replace(/\/$/u, '');
const webOriginOf = (env: Bindings): string => (env.WEB_ORIGIN || env.APP_URL).replace(/\/$/u, '');
const later = (at: Date, milliseconds: number): string => new Date(at.getTime() + milliseconds).toISOString();

/** Where an outside agent or a member's CLI reaches the Account's MCP Server. */
export const mcpUrl = (env: Bindings, accountId: string): string =>
  `${issuerOf(env)}/api/public/organizations/${encodeURIComponent(accountId)}/mcp`;

/** Where the Account's MCP Server says which authorization server issues its tokens (RFC 9728). */
export const resourceMetadataUrl = (env: Bindings, accountId: string): string =>
  `${issuerOf(env)}/.well-known/oauth-protected-resource/api/public/organizations/${encodeURIComponent(accountId)}/mcp`;

/** The Account an MCP Server URL names, or null when it is not one of this deployment's. */
const accountOfResource = (env: Bindings, resource: string): string | null => {
  const prefix = `${issuerOf(env)}/api/public/organizations/`;
  if (!resource.startsWith(prefix) || !resource.endsWith('/mcp')) return null;
  const segment = resource.slice(prefix.length, -'/mcp'.length);
  if (!segment || segment.includes('/')) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const protectedResourceMetadata = (env: Bindings, accountId: string) => ({
  resource: mcpUrl(env, accountId),
  authorization_servers: [issuerOf(env)],
  bearer_methods_supported: ['header'],
  resource_name: 'OrangeAgent',
});

export const authorizationServerMetadata = (env: Bindings) => ({
  issuer: issuerOf(env),
  authorization_endpoint: `${webOriginOf(env)}/authorize`,
  token_endpoint: `${issuerOf(env)}/api/public/oauth/token`,
  registration_endpoint: `${issuerOf(env)}/api/public/oauth/register`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true,
});

/** What the 401 of an MCP call without a working token says, so a client can find where to sign in. */
export const bearerChallenge = (env: Bindings, accountId: string, invalid: boolean): string =>
  `Bearer resource_metadata="${resourceMetadataUrl(env, accountId)}"${invalid ? ', error="invalid_token"' : ''}`;

/* Clients */

export interface OAuthClient {
  name: string;
  redirectUris: string[];
}

const isLoopback = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

/** A redirect a client may register: https, http to this machine, or a native app's own scheme. */
const acceptableRedirect = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === 'http:') return isLoopback(url);
  return true;
};

/**
 * Whether a presented redirect is one the client registered. A loopback
 * redirect matches whatever port it names, since a native client such as
 * Claude Code listens on a port it picks for each sign-in (RFC 8252 7.3).
 */
export const redirectMatches = (registered: readonly string[], presented: string): boolean => {
  if (registered.includes(presented)) return true;
  let url: URL;
  try {
    url = new URL(presented);
  } catch {
    return false;
  }
  if (!isLoopback(url)) return false;
  return registered.some((candidate) => {
    const known = new URL(candidate);
    return isLoopback(known) && known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
  });
};

const sealClient = async (env: Bindings, client: OAuthClient): Promise<string> => {
  const envelope = await encrypt(JSON.stringify({ n: client.name, r: client.redirectUris }), await masterKey(env.CREDENTIAL_MASTER_KEY), CLIENT_CONTEXT);
  return `${envelope.iv}.${envelope.ciphertext}`;
};

/** The client a client_id was registered as, or null when this deployment never sealed it. */
export const openClient = async (env: Bindings, clientId: string): Promise<OAuthClient | null> => {
  const [iv, ciphertext, extra] = clientId.split('.');
  if (!iv || !ciphertext || extra !== undefined) return null;
  try {
    const opened = JSON.parse(await decrypt({ algorithm: 'A256GCM', iv, ciphertext }, await masterKey(env.CREDENTIAL_MASTER_KEY), CLIENT_CONTEXT)) as { n?: unknown; r?: unknown };
    if (typeof opened.n !== 'string' || !Array.isArray(opened.r) || !opened.r.every((uri) => typeof uri === 'string')) return null;
    return { name: opened.n, redirectUris: opened.r as string[] };
  } catch {
    return null;
  }
};

export type OAuthAnswer = { status: 200 | 201 | 400 | 401; body: Record<string, unknown> };

const oauthError = (status: 400 | 401, error: string, description: string): OAuthAnswer =>
  ({ status, body: { error, error_description: description } });

/** Registers a client (RFC 7591). It is always a public client that proves itself with PKCE. */
export const registerClient = async (env: Bindings, metadata: unknown, at: Date): Promise<OAuthAnswer> => {
  const body = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {};
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    return oauthError(400, 'invalid_redirect_uri', `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} URIs.`);
  }
  if (!redirectUris.every(acceptableRedirect)) {
    return oauthError(400, 'invalid_redirect_uri', 'Each redirect URI must be https, http to localhost or 127.0.0.1, or an app scheme, without a fragment.');
  }
  const grantTypes = body.grant_types;
  if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))) {
    return oauthError(400, 'invalid_client_metadata', 'This server grants only authorization_code and refresh_token.');
  }
  const named = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, MAX_CLIENT_NAME) : '';
  const client: OAuthClient = { name: named || new URL(redirectUris[0] as string).host || 'MCP client', redirectUris: redirectUris as string[] };
  return {
    status: 201,
    body: {
      client_id: await sealClient(env, client),
      client_id_issued_at: Math.floor(at.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  };
};

/* Authorization */

export interface AuthorizationRequest {
  clientId: string;
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** The Account the client asked for by naming its MCP Server, or null when it named none. */
  accountId: string | null;
}

export type ReadAuthorization =
  | { kind: 'valid'; request: AuthorizationRequest }
  /** The client must be told, at the redirect it registered. */
  | { kind: 'refused'; location: string }
  /** Nothing can be sent back, because the client or its redirect is not one this server knows. */
  | { kind: 'unsafe'; message: string };

const sendBack = (env: Bindings, redirectUri: string, values: Record<string, string | null>): string => {
  const location = new URL(redirectUri);
  for (const [name, value] of Object.entries({ ...values, iss: issuerOf(env) })) if (value !== null) location.searchParams.set(name, value);
  return location.toString();
};

/** Reads an authorization request as the client sent it, refusing it where the client can be told and stopping where it cannot. */
export const readAuthorizationRequest = async (env: Bindings, query: URLSearchParams): Promise<ReadAuthorization> => {
  const clientId = query.get('client_id') ?? '';
  const client = clientId ? await openClient(env, clientId) : null;
  if (!client) return { kind: 'unsafe', message: 'この接続元は OrangeAgent に登録されていません。接続元でもう一度つなぎ直してください。' };
  const redirectUri = query.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] ?? '' : '');
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return { kind: 'unsafe', message: 'この接続元が登録した戻り先ではありません。接続元でもう一度つなぎ直してください。' };
  }
  const state = query.get('state');
  const refuse = (error: string, description: string): ReadAuthorization =>
    ({ kind: 'refused', location: sendBack(env, redirectUri, { error, error_description: description, state }) });
  if (query.get('response_type') !== 'code') return refuse('unsupported_response_type', 'Only response_type=code is supported.');
  const codeChallenge = query.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge) || query.get('code_challenge_method') !== 'S256') {
    return refuse('invalid_request', 'A PKCE code_challenge with code_challenge_method=S256 is required.');
  }
  const resource = query.get('resource');
  const accountId = resource ? accountOfResource(env, resource) : null;
  if (resource && !accountId) return refuse('invalid_target', 'The resource is not an MCP Server of this deployment.');
  return { kind: 'valid', request: { clientId, client, redirectUri, state, codeChallenge, accountId } };
};

/** Where the browser goes when the member declines: back to the client, told so. */
export const denialLocation = (env: Bindings, request: AuthorizationRequest): string =>
  sendBack(env, request.redirectUri, { error: 'access_denied', error_description: 'The member declined.', state: request.state });

/**
 * A code carries the Account it was issued in before its random part, so the
 * token endpoint, which every Account shares, knows whose D1 holds its grant.
 */
const accountTagged = (accountId: string): string => `${toBase64Url(encodeText(accountId))}.${generateAccessToken()}`;

const accountOfTagged = (value: string): string | null => {
  const [tag, secret, extra] = value.split('.');
  if (!tag || !secret || extra !== undefined) return null;
  try {
    return decodeText(fromBase64Url(tag));
  } catch {
    return null;
  }
};

/** Records the member's approval as an Operator Token awaiting its code, and sends the code back to the client. */
export const approveAuthorization = async (input: {
  env: Bindings;
  db: AccountDatabase;
  accountId: string;
  identityId: string;
  request: AuthorizationRequest;
  at: Date;
}): Promise<string> => {
  const code = accountTagged(input.accountId);
  const timestamp = input.at.toISOString();
  await input.db.insert(operatorTokens).values({
    id: crypto.randomUUID(),
    identityId: input.identityId,
    codeHash: await accessTokenHash(code),
    codeExpiresAt: later(input.at, LOGIN_CODE_MINUTES * 60_000),
    clientId: input.request.clientId,
    clientName: input.request.client.name,
    redirectUri: input.request.redirectUri,
    codeChallenge: input.request.codeChallenge,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
  return sendBack(input.env, input.request.redirectUri, { code, state: input.request.state });
};

/** When a grant approved at this moment ends. */
export const grantEnd = (approvedAt: Date): string => later(approvedAt, OPERATOR_TOKEN_DAYS * 86_400_000);

/* Tokens */

const s256 = async (verifier: string): Promise<string> =>
  toBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(encodeText(verifier))));

/** Issues a fresh access token and refresh token for the grant, replacing whichever it held. */
const issueTokens = async (input: {
  db: AccountDatabase;
  accountId: string;
  id: string;
  expiresAt: string;
  at: Date;
  /** Narrows the update to the row as it was read, so a code or refresh token is spent at most once. */
  spending: ReturnType<typeof eq>;
}): Promise<OAuthAnswer> => {
  const accessToken = generateAccessToken();
  const refreshToken = accountTagged(input.accountId);
  const remaining = Math.floor((Date.parse(input.expiresAt) - input.at.getTime()) / 1000);
  const expiresIn = Math.max(1, Math.min(ACCESS_TOKEN_SECONDS, remaining));
  const spent = await input.db.update(operatorTokens).set({
    codeHash: null,
    tokenHash: await accessTokenHash(accessToken),
    expiresAt: input.expiresAt,
    accessExpiresAt: later(input.at, expiresIn * 1000),
    refreshHash: await accessTokenHash(refreshToken),
    updatedAt: input.at.toISOString(),
  }).where(and(eq(operatorTokens.id, input.id), input.spending)).returning({ id: operatorTokens.id }).get();
  if (!spent) return oauthError(400, 'invalid_grant', 'The grant was already used.');
  return { status: 200, body: { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refreshToken } };
};

const grantDatabase = async (env: Bindings, tagged: string): Promise<{ accountId: string; db: AccountDatabase } | null> => {
  const accountId = accountOfTagged(tagged);
  if (!accountId) return null;
  const database = await activeAccountDatabase(env, accountId);
  return database ? { accountId, db: accountDatabase(database) } : null;
};

/** The token endpoint: an authorization code or a refresh token in, an access token and the next refresh token out. */
export const exchangeGrant = async (env: Bindings, form: URLSearchParams, at: Date): Promise<OAuthAnswer> => {
  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return oauthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are granted.');
  }
  const clientId = form.get('client_id') ?? '';
  if (!clientId || !await openClient(env, clientId)) return oauthError(401, 'invalid_client', 'The client is not registered with this server.');
  const presented = form.get(grantType === 'authorization_code' ? 'code' : 'refresh_token') ?? '';
  const grant = presented ? await grantDatabase(env, presented) : null;
  if (!grant) return oauthError(400, 'invalid_grant', 'The grant is not recognised.');
  const resource = form.get('resource');
  if (resource && accountOfResource(env, resource) !== grant.accountId) return oauthError(400, 'invalid_target', 'The resource is not the MCP Server this grant was approved for.');
  const presentedHash = await accessTokenHash(presented);
  const timestamp = at.toISOString();

  if (grantType === 'authorization_code') {
    const row = await grant.db.select().from(operatorTokens).where(and(
      eq(operatorTokens.codeHash, presentedHash),
      isNull(operatorTokens.tokenHash),
      gt(operatorTokens.codeExpiresAt, timestamp),
      eq(operatorTokens.clientId, clientId),
    )).get();
    if (!row) return oauthError(400, 'invalid_grant', 'The authorization code is not recognised, has expired, or was already used.');
    if ((form.get('redirect_uri') ?? row.redirectUri) !== row.redirectUri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
    if (await s256(form.get('code_verifier') ?? '') !== row.codeChallenge) return oauthError(400, 'invalid_grant', 'code_verifier does not match the code_challenge.');
    if (!await isActiveMember({ control: env.CONTROL_DB, accountId: grant.accountId, identityId: row.identityId })) {
      return oauthError(400, 'invalid_grant', 'The member who approved this is no longer in the Account.');
    }
    return issueTokens({ db: grant.db, accountId: grant.accountId, id: row.id, expiresAt: grantEnd(new Date(row.createdAt)), at, spending: eq(operatorTokens.codeHash, presentedHash) });
  }

  const row = await grant.db.select().from(operatorTokens).where(and(
    eq(operatorTokens.refreshHash, presentedHash),
    gt(operatorTokens.expiresAt, timestamp),
    eq(operatorTokens.clientId, clientId),
  )).get();
  if (!row || !row.expiresAt) return oauthError(400, 'invalid_grant', 'The refresh token is not recognised, has expired, or was replaced.');
  if (!await isActiveMember({ control: env.CONTROL_DB, accountId: grant.accountId, identityId: row.identityId })) {
    return oauthError(400, 'invalid_grant', 'The member who approved this is no longer in the Account.');
  }
  return issueTokens({ db: grant.db, accountId: grant.accountId, id: row.id, expiresAt: row.expiresAt, at, spending: eq(operatorTokens.refreshHash, presentedHash) });
};
