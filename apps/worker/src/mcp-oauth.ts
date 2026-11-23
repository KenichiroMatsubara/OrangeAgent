/**
 * Signing an Account in to a remote MCP Server it registered, by OAuth, so
 * Operator Chat and Automations reach a server that takes no static token.
 * This is the client side of the RFCs ADR 0196's authorization server serves:
 * the server's 401 or its well-known document names its authorization server
 * (RFC 9728), whose metadata names its endpoints (RFC 8414, or OpenID
 * discovery), FlareChat registers itself there (RFC 7591), and the person is
 * sent to sign in with PKCE S256, the token naming the server as its
 * resource (RFC 8707).
 *
 * The OAuth state carries the Account, the person who asked, the server, the
 * PKCE verifier, and the client it registered, sealed under the deployment's
 * master key as the Microsoft connection's is, so the callback needs no flow
 * recorded beforehand and refuses a state minted for anyone else. The grant it
 * yields is kept on the server's row under the Account's key, and renewed with
 * its refresh token when it is about to expire.
 */

import { and, eq } from 'drizzle-orm';

import { decrypt, encrypt, masterKey, type CipherEnvelope } from './cryptography';
import { decodeText, encodeText, fromBase64Url, toBase64Url } from './encoding';
import { createPkce } from './google';
import type { McpFetch } from './mcp';
import { mcpServers } from './storage/account-schema';
import { accountDatabase } from './storage/database';
import type { Bindings } from './types';

/** How long a person has to finish the server's sign-in screen. */
const STATE_WINDOW_MS = 10 * 60 * 1_000;

/** An access token is renewed this long before it expires, so none expires mid-run. */
const RENEWAL_MARGIN_MS = 2 * 60 * 1_000;

const STATE_CONTEXT = 'mcp-oauth-state';
const grantContext = (accountId: string, serverId: string): string => `mcp-server-oauth:${accountId}:${serverId}`;

type ClientAuthentication = 'none' | 'client_secret_post' | 'client_secret_basic';

/** The client FlareChat registered with a server's authorization server, and where it trades codes and refresh tokens. */
interface McpClient {
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  authentication: ClientAuthentication;
  /** The MCP Server the tokens are for, as RFC 8707 names it. */
  resource: string;
}

export interface McpGrant extends McpClient {
  accessToken: string;
  refreshToken: string | null;
  /** Null when the authorization server said nothing of when the token expires. */
  expiresAt: string | null;
}

export interface McpOAuthState extends McpClient {
  accountId: string;
  identityId: string;
  serverId: string;
  verifier: string;
  expiresAt: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** The server cannot be signed in to by OAuth as FlareChat signs in: the message says why, in the screen's words. */
export class McpSignInUnavailable extends Error {}

/** The authorization server refused the stored grant itself, so only signing in again restores it. */
export class McpGrantRevoked extends Error {}

export const mcpRedirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/mcp/callback`;

const httpsUrl = (value: unknown): URL | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

/** One parameter of a `WWW-Authenticate: Bearer …` challenge. */
const challengeParameter = (header: string | null, name: string): string | null => {
  if (!header) return null;
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, 'iu').exec(header);
  return match?.[1] ?? match?.[2] ?? null;
};

const readJson = async (fetch: McpFetch, url: string): Promise<Record<string, unknown> | null> => {
  try {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const firstJson = async (fetch: McpFetch, urls: readonly string[]): Promise<Record<string, unknown> | null> => {
  for (const url of urls) {
    const found = await readJson(fetch, url);
    if (found) return found;
  }
  return null;
};

/** The well-known paths a document may sit at for a URL with a path, the path-inserted one first (RFC 8414 §3, RFC 9728 §3). */
const wellKnown = (base: URL, name: string): string[] => {
  const path = base.pathname.replace(/\/$/u, '');
  return path ? [`${base.origin}/.well-known/${name}${path}`, `${base.origin}/.well-known/${name}`] : [`${base.origin}/.well-known/${name}`];
};

interface Discovered {
  resource: string;
  issuer: URL;
  scope: string | null;
}

/**
 * What the MCP Server says of its own protection: asked once without a token,
 * a server that needs one answers 401 naming its resource metadata; a server
 * that names none is looked up at the well-known path. A server with no
 * metadata at all is its own authorization server, as servers of the
 * 2025-03-26 revision are.
 */
const discoverResource = async (fetch: McpFetch, url: URL): Promise<Discovered> => {
  let challenge: string | null = null;
  try {
    const probe = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flarechat', version: '1' } } }),
    });
    if (probe.status === 401) challenge = probe.headers.get('WWW-Authenticate');
  } catch {
    // An unreachable server is found unreachable again by the metadata it cannot serve either.
  }
  const named = httpsUrl(challengeParameter(challenge, 'resource_metadata'));
  const metadata = named ? await readJson(fetch, named.toString()) : await firstJson(fetch, wellKnown(url, 'oauth-protected-resource'));
  const servers = Array.isArray(metadata?.authorization_servers) ? metadata.authorization_servers : [];
  const issuer = metadata ? httpsUrl(servers[0]) : new URL(url.origin);
  if (!issuer) throw new McpSignInUnavailable('この MCP Server は、サインインに使う認可サーバーを https で示していません。');
  const scopes = Array.isArray(metadata?.scopes_supported) ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === 'string') : [];
  const resource = httpsUrl(metadata?.resource)?.toString() ?? `${url.origin}${url.pathname}${url.search}`;
  return { resource, issuer, scope: challengeParameter(challenge, 'scope') ?? (scopes.length ? scopes.join(' ') : null) };
};

interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/** The authorization server's metadata, by OAuth's well-known path and then OpenID's, as the MCP revisions after 2025-06-18 look them up. */
const discoverAuthorizationServer = async (fetch: McpFetch, issuer: URL): Promise<AuthorizationServer> => {
  const path = issuer.pathname.replace(/\/$/u, '');
  const candidates = path
    ? [`${issuer.origin}/.well-known/oauth-authorization-server${path}`, `${issuer.origin}/.well-known/openid-configuration${path}`, `${issuer.origin}${path}/.well-known/openid-configuration`]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  const metadata = await firstJson(fetch, candidates);
  const authorization = httpsUrl(metadata?.authorization_endpoint);
  const token = httpsUrl(metadata?.token_endpoint);
  if (!metadata || !authorization || !token) throw new McpSignInUnavailable('この MCP Server の認可サーバーから、サインインの窓口を読み取れませんでした。');
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) throw new McpSignInUnavailable('この MCP Server の認可サーバーは PKCE（S256）に対応していないため、サインインできません。');
  return {
    issuer: typeof metadata.issuer === 'string' ? metadata.issuer : issuer.toString(),
    authorizationEndpoint: authorization.toString(),
    tokenEndpoint: token.toString(),
    registrationEndpoint: httpsUrl(metadata.registration_endpoint)?.toString() ?? null,
  };
};

/** Registers FlareChat as a client of the authorization server (RFC 7591), a public one unless the server hands it a secret. */
const registerClient = async (fetch: McpFetch, input: { env: Bindings; server: AuthorizationServer; resource: string; scope: string | null }): Promise<McpClient> => {
  if (!input.server.registrationEndpoint) {
    throw new McpSignInUnavailable('この MCP Server はクライアントの自動登録に対応していないため、サインインできません。トークンを発行できるサーバーなら、トークンで登録してください。');
  }
  const response = await fetch(input.server.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'FlareChat',
      client_uri: input.env.APP_URL,
      redirect_uris: [mcpRedirectUri(input.env)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(input.scope ? { scope: input.scope } : {}),
    }),
  });
  const body = await response.json().catch(() => ({})) as { client_id?: unknown; client_secret?: unknown; token_endpoint_auth_method?: unknown; error_description?: unknown };
  if (!response.ok || typeof body.client_id !== 'string' || !body.client_id) {
    throw new McpSignInUnavailable(`この MCP Server の認可サーバーに FlareChat を登録できませんでした（HTTP ${response.status}${typeof body.error_description === 'string' ? `: ${body.error_description}` : ''}）。`);
  }
  const secret = typeof body.client_secret === 'string' && body.client_secret ? body.client_secret : null;
  const method = body.token_endpoint_auth_method;
  const authentication: ClientAuthentication = !secret ? 'none' : method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post';
  return { issuer: input.server.issuer, tokenEndpoint: input.server.tokenEndpoint, clientId: body.client_id, clientSecret: secret, authentication, resource: input.resource };
};

/** The URL that starts signing this Account in to one of its MCP Servers, for the person asking. */
export const beginMcpSignIn = async (input: {
  env: Bindings;
  fetch: McpFetch;
  accountId: string;
  identityId: string;
  serverId: string;
  url: string;
}): Promise<string> => {
  const target = httpsUrl(input.url);
  if (!target) throw new McpSignInUnavailable('MCP Server の URL は https で始まる必要があります。');
  const discovered = await discoverResource(input.fetch, target);
  const server = await discoverAuthorizationServer(input.fetch, discovered.issuer);
  const client = await registerClient(input.fetch, { env: input.env, server, resource: discovered.resource, scope: discovered.scope });
  const pkce = await createPkce();
  const state: McpOAuthState = {
    ...client,
    accountId: input.accountId,
    identityId: input.identityId,
    serverId: input.serverId,
    verifier: pkce.verifier,
    expiresAt: new Date(Date.now() + STATE_WINDOW_MS).toISOString(),
  };
  const sealed = await encrypt(JSON.stringify(state), await masterKey(input.env.CREDENTIAL_MASTER_KEY), STATE_CONTEXT);
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', mcpRedirectUri(input.env));
  url.searchParams.set('state', toBase64Url(encodeText(JSON.stringify(sealed))));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', client.resource);
  if (discovered.scope) url.searchParams.set('scope', discovered.scope);
  return url.toString();
};

/** The state the authorization server hands back, opened, or null when it was not minted here or has expired. */
export const openMcpState = async (env: Bindings, value: string | undefined): Promise<McpOAuthState | null> => {
  if (!value) return null;
  try {
    const sealed = JSON.parse(decodeText(fromBase64Url(value))) as CipherEnvelope;
    const state = JSON.parse(await decrypt(sealed, await masterKey(env.CREDENTIAL_MASTER_KEY), STATE_CONTEXT)) as McpOAuthState;
    return Date.parse(state.expiresAt) > Date.now() ? state : null;
  } catch {
    return null;
  }
};

const tokenRequest = async (fetch: McpFetch, client: McpClient, parameters: Record<string, string>): Promise<TokenResponse> => {
  const form = new URLSearchParams({ ...parameters, resource: client.resource });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (client.authentication === 'client_secret_basic' && client.clientSecret) {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  } else {
    form.set('client_id', client.clientId);
    if (client.clientSecret) form.set('client_secret', client.clientSecret);
  }
  const response = await fetch(client.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  const body = await response.json().catch(() => ({})) as TokenResponse;
  if (response.ok && body.access_token) return body;
  if (body.error === 'invalid_grant' || body.error === 'invalid_client' || body.error === 'unauthorized_client') {
    throw new McpGrantRevoked(body.error_description ?? body.error);
  }
  throw new Error(`MCP authorization server token endpoint: ${body.error_description ?? body.error ?? response.status}`);
};

const grantOf = (client: McpClient, tokens: TokenResponse, previous: McpGrant | null): McpGrant => ({
  issuer: client.issuer,
  tokenEndpoint: client.tokenEndpoint,
  clientId: client.clientId,
  clientSecret: client.clientSecret,
  authentication: client.authentication,
  resource: client.resource,
  accessToken: tokens.access_token ?? '',
  refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
  expiresAt: typeof tokens.expires_in === 'number' ? new Date(Date.now() + tokens.expires_in * 1_000).toISOString() : null,
});

const sealGrant = async (key: CryptoKey, accountId: string, serverId: string, grant: McpGrant): Promise<string> =>
  JSON.stringify(await encrypt(JSON.stringify(grant), key, grantContext(accountId, serverId)));

/** Trades the code the authorization server handed back for a grant, kept on the server's row in place of any it had. */
export const completeMcpSignIn = async (input: {
  env: Bindings;
  fetch: McpFetch;
  database: D1Database;
  key: CryptoKey;
  state: McpOAuthState;
  code: string;
}): Promise<void> => {
  const { state } = input;
  const tokens = await tokenRequest(input.fetch, state, {
    grant_type: 'authorization_code', code: input.code, redirect_uri: mcpRedirectUri(input.env), code_verifier: state.verifier,
  });
  const envelope = await sealGrant(input.key, state.accountId, state.serverId, grantOf(state, tokens, null));
  const saved = await accountDatabase(input.database).update(mcpServers)
    .set({ oauthEnvelope: envelope, oauthError: null, updatedAt: new Date().toISOString() })
    .where(eq(mcpServers.id, state.serverId)).run();
  if (!saved.meta.changes) throw new Error('The MCP Server was removed while it was being signed in to.');
};

/** Records why signing in to a server failed, so its row says so until it is signed in to again. */
export const recordMcpSignInFailure = async (database: D1Database, serverId: string, message: string): Promise<void> => {
  await accountDatabase(database).update(mcpServers).set({ oauthError: message.slice(0, 500) }).where(eq(mcpServers.id, serverId)).run();
};

/**
 * A current access token of the grant a server's row keeps, renewed and kept
 * when it is about to expire. Another run renewing the same grant at the same
 * moment may be handed the only new refresh token, so a renewal kept by
 * someone else first is read back rather than overwritten, and a refusal is
 * recorded only when no one renewed it since. Null when the grant cannot be
 * used: the server then answers the run without a token, as one that needs a
 * sign-in, and its row says to sign in again.
 */
export const mcpAccessToken = async (input: {
  database: D1Database;
  fetch: McpFetch;
  key: CryptoKey;
  accountId: string;
  serverId: string;
  envelope: string;
}): Promise<string | null> => {
  const open = async (envelope: string): Promise<McpGrant> =>
    JSON.parse(await decrypt(JSON.parse(envelope) as CipherEnvelope, input.key, grantContext(input.accountId, input.serverId))) as McpGrant;
  const grant = await open(input.envelope);
  if (grant.expiresAt === null || Date.parse(grant.expiresAt) - RENEWAL_MARGIN_MS > Date.now()) return grant.accessToken;
  if (!grant.refreshToken) return grant.accessToken;
  const db = accountDatabase(input.database);
  const current = async (): Promise<string | null> => {
    const row = await db.select({ envelope: mcpServers.oauthEnvelope }).from(mcpServers).where(eq(mcpServers.id, input.serverId)).get();
    return row?.envelope && row.envelope !== input.envelope ? (await open(row.envelope)).accessToken : null;
  };
  try {
    const tokens = await tokenRequest(input.fetch, grant, { grant_type: 'refresh_token', refresh_token: grant.refreshToken });
    const envelope = await sealGrant(input.key, input.accountId, input.serverId, grantOf(grant, tokens, grant));
    const kept = await db.update(mcpServers).set({ oauthEnvelope: envelope, oauthError: null })
      .where(and(eq(mcpServers.id, input.serverId), eq(mcpServers.oauthEnvelope, input.envelope))).run();
    return kept.meta.changes ? tokens.access_token ?? null : await current() ?? tokens.access_token ?? null;
  } catch (error) {
    const renewed = await current();
    if (renewed) return renewed;
    if (!(error instanceof McpGrantRevoked)) {
      console.error(JSON.stringify({ event: 'mcp_oauth_refresh_failed', accountId: input.accountId, serverId: input.serverId, message: error instanceof Error ? error.message : String(error) }));
      return null;
    }
    await db.update(mcpServers).set({ oauthError: 'サインインが切れました。もう一度サインインしてください。' })
      .where(and(eq(mcpServers.id, input.serverId), eq(mcpServers.oauthEnvelope, input.envelope))).run();
    return null;
  }
};
