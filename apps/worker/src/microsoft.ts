/**
 * Microsoft 365 as an Account reaches it: one person's Microsoft account,
 * granted only its own app folder in OneDrive, through which Word for the web
 * renders a Word, Excel, or PowerPoint file Claude wrote as a PDF exactly as
 * Office lays it out. Its refresh token is kept encrypted under the Account's
 * key in the Account's settings, so connecting it needs no migration.
 *
 * The OAuth state carries the Account, the person who asked, the PKCE
 * verifier, and when it expires, encrypted under the deployment's master key,
 * so the callback needs no flow recorded beforehand and refuses a state minted
 * for anyone else.
 */

import { eq } from 'drizzle-orm';

import type { Connections } from '@mail/domain';

import { decrypt, encrypt, masterKey, type CipherEnvelope } from './cryptography';
import { decodeText, encodeText, fromBase64Url, toArrayBuffer, toBase64Url } from './encoding';
import { createPkce } from './google';
import { settings } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';
import type { Bindings } from './types';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Who the person is, and their OneDrive app folder alone: FlareChat never sees the rest of their files. */
export const MICROSOFT_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'Files.ReadWrite.AppFolder'] as const;

export const MICROSOFT_SETTING = 'microsoft_connection';

/** How long a person has to finish Microsoft's consent screen. */
const STATE_WINDOW_MS = 10 * 60 * 1_000;

/** The most Graph takes in one simple upload; a larger file is rendered by Google instead. */
export const MAX_WORD_UPLOAD_BYTES = 4 * 1024 * 1024;

/** An access token is renewed this long before it expires, so none expires mid-render. */
const RENEWAL_MARGIN_MS = 2 * 60 * 1_000;

interface MicrosoftGrant {
  refreshToken: string;
  accessToken: string;
  expiresAt: string;
  email: string;
}

interface MicrosoftState {
  accountId: string;
  identityId: string;
  verifier: string;
  expiresAt: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Microsoft refused the stored grant itself, so only connecting again restores it. */
export class MicrosoftGrantRevoked extends Error {}

export const microsoftConfigured = (env: Bindings): boolean => Boolean(env.MICROSOFT_CLIENT_ID?.trim() && env.MICROSOFT_CLIENT_SECRET?.trim());

const redirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/microsoft/callback`;

const STATE_CONTEXT = 'microsoft-oauth-state';
const grantContext = (accountId: string): string => `microsoft-connection:${accountId}`;

/** The URL that starts connecting a Microsoft account to this Account, for the person asking. */
export const beginMicrosoftConnection = async (env: Bindings, input: { accountId: string; identityId: string }): Promise<string> => {
  const pkce = await createPkce();
  const state: MicrosoftState = { ...input, verifier: pkce.verifier, expiresAt: new Date(Date.now() + STATE_WINDOW_MS).toISOString() };
  const sealed = await encrypt(JSON.stringify(state), await masterKey(env.CREDENTIAL_MASTER_KEY), STATE_CONTEXT);
  const url = new URL(`${AUTHORITY}/authorize`);
  url.search = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: redirectUri(env),
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state: toBase64Url(encodeText(JSON.stringify(sealed))),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
};

/** The state Microsoft hands back, opened, or null when it was not minted here or has expired. */
export const openMicrosoftState = async (env: Bindings, value: string | undefined): Promise<MicrosoftState | null> => {
  if (!value) return null;
  try {
    const sealed = JSON.parse(decodeText(fromBase64Url(value))) as CipherEnvelope;
    const state = JSON.parse(await decrypt(sealed, await masterKey(env.CREDENTIAL_MASTER_KEY), STATE_CONTEXT)) as MicrosoftState;
    return Date.parse(state.expiresAt) > Date.now() ? state : null;
  } catch {
    return null;
  }
};

/** The person an ID token names, read without verifying it: it came straight from Microsoft's token endpoint over TLS. */
const emailOf = (idToken: string | undefined): string => {
  const payload = idToken?.split('.')[1];
  if (!payload) return '';
  try {
    const claims = JSON.parse(decodeText(fromBase64Url(payload))) as { email?: string; preferred_username?: string };
    return claims.email ?? claims.preferred_username ?? '';
  } catch {
    return '';
  }
};

const tokenRequest = async (env: Bindings, parameters: Record<string, string>): Promise<TokenResponse> => {
  const response = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID ?? '',
      client_secret: env.MICROSOFT_CLIENT_SECRET ?? '',
      scope: MICROSOFT_SCOPES.join(' '),
      ...parameters,
    }).toString(),
  });
  const body = await response.json().catch(() => ({})) as TokenResponse;
  if (response.ok && body.access_token) return body;
  if (body.error === 'invalid_grant' || body.error === 'interaction_required') throw new MicrosoftGrantRevoked(body.error_description ?? body.error);
  throw new Error(`Microsoft token endpoint: ${body.error_description ?? body.error ?? response.status}`);
};

const saveGrant = async (db: AccountDatabase, key: CryptoKey, accountId: string, grant: MicrosoftGrant): Promise<void> => {
  const value = JSON.stringify(await encrypt(JSON.stringify(grant), key, grantContext(accountId)));
  const updatedAt = new Date().toISOString();
  await db.insert(settings).values({ key: MICROSOFT_SETTING, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
};

const readGrant = async (db: AccountDatabase, key: CryptoKey, accountId: string): Promise<MicrosoftGrant | null> => {
  const stored = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MICROSOFT_SETTING)).get();
  if (!stored) return null;
  return JSON.parse(await decrypt(JSON.parse(stored.value) as CipherEnvelope, key, grantContext(accountId))) as MicrosoftGrant;
};

/** Trades the code Microsoft handed back for a grant, and keeps it as the Account's one Microsoft connection. */
export const completeMicrosoftConnection = async (input: {
  env: Bindings;
  db: AccountDatabase;
  key: CryptoKey;
  accountId: string;
  code: string;
  verifier: string;
}): Promise<void> => {
  const tokens = await tokenRequest(input.env, {
    grant_type: 'authorization_code', code: input.code, redirect_uri: redirectUri(input.env), code_verifier: input.verifier,
  });
  if (!tokens.refresh_token) throw new Error('Microsoft did not grant offline access.');
  await saveGrant(input.db, input.key, input.accountId, {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? '',
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 0) * 1_000).toISOString(),
    email: emailOf(tokens.id_token),
  });
};

/** What the Connections screen shows of Microsoft: whether the deployment can connect it, and to whom it is connected. */
export const microsoftView = async (env: Bindings, db: AccountDatabase, key: CryptoKey, accountId: string): Promise<Connections['microsoft']> => {
  const grant = await readGrant(db, key, accountId).catch(() => null);
  return { configured: microsoftConfigured(env), connected: grant !== null, email: grant?.email || null };
};

export const disconnectMicrosoft = async (db: AccountDatabase): Promise<void> => {
  await db.delete(settings).where(eq(settings.key, MICROSOFT_SETTING)).run();
};

/**
 * A current access token of the Account's Microsoft connection, renewed and
 * kept when it is about to expire, or null when none is connected. Microsoft
 * may hand back a new refresh token with each renewal, so it is kept too.
 */
export const microsoftAccessToken = async (input: { env: Bindings; db: AccountDatabase; key: CryptoKey; accountId: string }): Promise<string | null> => {
  if (!microsoftConfigured(input.env)) return null;
  const grant = await readGrant(input.db, input.key, input.accountId);
  if (!grant) return null;
  if (grant.accessToken && Date.parse(grant.expiresAt) - RENEWAL_MARGIN_MS > Date.now()) return grant.accessToken;
  const tokens = await tokenRequest(input.env, { grant_type: 'refresh_token', refresh_token: grant.refreshToken });
  const renewed: MicrosoftGrant = {
    ...grant,
    refreshToken: tokens.refresh_token ?? grant.refreshToken,
    accessToken: tokens.access_token ?? '',
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 0) * 1_000).toISOString(),
  };
  await saveGrant(input.db, input.key, input.accountId, renewed);
  return renewed.accessToken;
};

const graphError = async (response: Response, what: string): Promise<Error> => {
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
  return new Error(`Microsoft Graph could not ${what}: ${body.error?.message ?? response.status}`);
};

/**
 * A Word, Excel, or PowerPoint file as Word, Excel, or PowerPoint for the web
 * renders it to a PDF: uploaded under a name of its own into FlareChat's app
 * folder, converted, and removed whether or not the conversion succeeded.
 */
export const renderPdfWithOffice = async (token: string, input: { extension: string; bytes: Uint8Array }): Promise<Uint8Array> => {
  if (input.bytes.byteLength > MAX_WORD_UPLOAD_BYTES) throw new Error(`The file holds ${input.bytes.byteLength} bytes; Microsoft renders at most ${MAX_WORD_UPLOAD_BYTES} in one upload.`);
  const authorization = { Authorization: `Bearer ${token}` };
  const uploaded = await fetch(`${GRAPH}/me/drive/special/approot:/${crypto.randomUUID()}.${input.extension}:/content`, {
    method: 'PUT',
    headers: { ...authorization, 'Content-Type': 'application/octet-stream' },
    body: toArrayBuffer(input.bytes),
  });
  if (!uploaded.ok) throw await graphError(uploaded, 'upload the file');
  const { id } = await uploaded.json() as { id?: string };
  if (!id) throw new Error('Microsoft Graph did not return the uploaded file.');
  try {
    // Graph answers with a redirect to a pre-authenticated download, which is fetched without the token.
    const converted = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}/content?format=pdf`, { headers: authorization, redirect: 'manual' });
    const location = converted.headers.get('Location');
    const pdf = location ? await fetch(location) : converted;
    if (!pdf.ok) throw await graphError(pdf, 'convert the file to a PDF');
    return new Uint8Array(await pdf.arrayBuffer());
  } finally {
    await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authorization }).catch(() => undefined);
  }
};
