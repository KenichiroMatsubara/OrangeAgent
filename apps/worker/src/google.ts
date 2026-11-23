import { randomToken, sha256, toBase64Url, encodeText, toArrayBuffer } from './encoding';
import { called, temporaryAnswer } from './temporary';

/**
 * The scope that lets FlareChat save a Gmail draft, which `gmail.send` alone
 * does not: the whole mailbox, which the OAuth consent screen already declares.
 */
export const GMAIL_DRAFT_SCOPE = 'https://mail.google.com/';

/**
 * The scope that lets FlareChat read, move, and rename every file of the
 * Drive, which `drive.file` alone does not. Google has no narrower scope that
 * moves a file FlareChat did not create.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * The scopes that let FlareChat read the meetings the Account held or joined
 * with their transcripts, and turn on a meeting's automatic transcription.
 * Meet reads a transcript through its own API, so no Drive scope is needed.
 */
export const MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/meetings.space.settings',
] as const;

/**
 * The scope that lets FlareChat keep the Account's Tasks in Google Tasks:
 * every task list of the Google account and every task in them. Google has
 * no scope for one list alone.
 */
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  GMAIL_DRAFT_SCOPE,
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/drive.file',
  DRIVE_SCOPE,
  ...MEET_SCOPES,
  TASKS_SCOPE,
] as const;

export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

const normalizedGoogleScopes = (scopes: Iterable<string>): Set<string> =>
  new Set(Array.from(scopes, (scope) => GOOGLE_SCOPE_ALIASES[scope] ?? scope));

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scopes: string[];
  tokenType: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string;
}

export const createPkce = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = randomToken(64);
  const challenge = toBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(encodeText(verifier))));
  return { verifier, challenge };
};

export const hasCompleteGoogleGrant = (scopes: Iterable<string>): boolean => {
  const granted = normalizedGoogleScopes(scopes);
  return GOOGLE_SCOPES.every((scope) => granted.has(scope));
};

/** Whether a grant lets FlareChat save Gmail drafts; one given before drafts existed lacks it until the Inbox is reconnected. */
export const grantsDrafts = (scopes: Iterable<string>): boolean => normalizedGoogleScopes(scopes).has(GMAIL_DRAFT_SCOPE);

/** Whether a grant lets FlareChat reach the whole Drive; one given before it did lacks it until the Inbox is reconnected. */
export const grantsDrive = (scopes: Iterable<string>): boolean => normalizedGoogleScopes(scopes).has(DRIVE_SCOPE);

/** Whether a grant lets FlareChat read Meet transcripts and transcribe meetings; one given before it did lacks it until the Inbox is reconnected. */
export const grantsMeet = (scopes: Iterable<string>): boolean => {
  const granted = normalizedGoogleScopes(scopes);
  return MEET_SCOPES.every((scope) => granted.has(scope));
};

/** Whether a grant lets FlareChat keep Tasks in Google Tasks; one given before it did lacks it until the Inbox is reconnected. */
export const grantsTasks = (scopes: Iterable<string>): boolean => normalizedGoogleScopes(scopes).has(TASKS_SCOPE);

export const missingGoogleScopes = (scopes: Iterable<string>): string[] => {
  const granted = normalizedGoogleScopes(scopes);
  return GOOGLE_SCOPES.filter((scope) => !granted.has(scope));
};

export const googleAuthorizationUrl = (input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
  accessType?: 'online' | 'offline';
  prompt?: 'consent' | 'select_account';
}): string => {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: (input.scopes ?? GOOGLE_SCOPES).join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    access_type: input.accessType ?? 'offline',
    prompt: input.prompt ?? 'consent',
    include_granted_scopes: 'false',
  }).toString();
  return url.toString();
};

/**
 * Google rejected the stored grant itself, so no retry can succeed and only a
 * new authorization restores automation. Every other token endpoint failure —
 * a 5xx, a rate limit, a network fault, a misconfigured deployment client — is
 * a plain Error, because retrying it later is the correct response.
 */
export class GoogleGrantRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoogleGrantRejectedError';
    this.code = code;
  }
}

/** `invalid_grant` is Google's single answer for a revoked, expired, or unknown refresh token. */
const REJECTED_GRANT_ERROR = 'invalid_grant';

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export const exchangeGoogleCode = async (input: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokenSet> => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = await response.json() as GoogleTokenResponse;
  if (!response.ok || !body.access_token || !body.scope || !body.expires_in) {
    throw new Error(body.error_description ?? body.error ?? 'Google authorization failed.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + body.expires_in * 1_000).toISOString(),
    scopes: body.scope.split(' ').filter(Boolean),
    tokenType: body.token_type ?? 'Bearer',
  };
};

export const refreshGoogleToken = async (input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
}): Promise<GoogleTokenSet> => {
  const response = await called('Google', () => fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      ...(input.scopes ? { scope: input.scopes.join(' ') } : {}),
    }),
  }));
  // A token endpoint that cannot answer now is an outage the next attempt rides out, never a rejected grant.
  const temporary = temporaryAnswer('Google', response);
  if (temporary) throw temporary;
  const body = await response.json() as GoogleTokenResponse;
  if (!response.ok || !body.access_token || !body.expires_in) {
    const message = body.error_description ?? body.error ?? 'Google token refresh failed.';
    if (body.error === REJECTED_GRANT_ERROR) throw new GoogleGrantRejectedError(body.error, message);
    throw new Error(message);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? input.refreshToken,
    expiresAt: new Date(Date.now() + body.expires_in * 1_000).toISOString(),
    scopes: body.scope?.split(' ').filter(Boolean) ?? [...GOOGLE_SCOPES],
    tokenType: body.token_type ?? 'Bearer',
  };
};

export const fetchGoogleIdentity = async (accessToken: string): Promise<GoogleIdentity> => {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json() as { sub?: string; email?: string; name?: string };
  if (!response.ok || !body.sub || !body.email) throw new Error('Google identity could not be verified.');
  return { subject: body.sub, email: body.email.toLowerCase(), displayName: body.name ?? body.email };
};

export const fetchGmailHistoryId = async (accessToken: string): Promise<string> => {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json() as { historyId?: string };
  if (!response.ok || !body.historyId) throw new Error('Gmail history position could not be captured.');
  return body.historyId;
};

export const revokeGoogleToken = async (token: string): Promise<void> => {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
};

export const opaqueStateHash = (state: string): Promise<string> => sha256(state);
