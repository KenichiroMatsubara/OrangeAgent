import { inArray } from 'drizzle-orm';

import { now } from '../clock';
import { SESSION_LIFETIME_MS } from '../entry';
import { controlDatabase } from '../storage/database';
import { sessions } from '../storage/control-schema';
import type { Bindings, SessionRow } from '../types';

/**
 * The sessions one browser holds: one per Google account signed in on it, the
 * one it is now first. Each session lasts and is revoked on its own; the
 * cookie only lists them, most recently used first.
 */
export const SESSION_COOKIE = 'mail_session';

/** How many Google accounts one browser stays signed in to at once. Signing in an eleventh signs out the one least recently used. */
export const SIGNED_IN_LIMIT = 10;

/** Session ids are base64url, so a dot never occurs in one. A cookie written before several sessions were held is a list of one. */
const SEPARATOR = '.';

export const requestCookie = (header: string | undefined | null, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
};

/** The session ids a request's cookie lists, the current one first. */
export const browserSessionIds = (header: string | undefined | null): string[] => {
  const value = requestCookie(header, SESSION_COOKIE);
  if (!value) return [];
  return [...new Set(value.split(SEPARATOR).filter(Boolean))].slice(0, SIGNED_IN_LIMIT);
};

/** The Set-Cookie header listing these sessions, or clearing the cookie when there are none. */
export const browserCookie = (request: Request, sessionIds: readonly string[]): string => {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const maxAge = sessionIds.length === 0 ? 0 : Math.floor(SESSION_LIFETIME_MS / 1_000);
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionIds.join(SEPARATOR))}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
};

/** The browser's sessions with the given one moved to the front. */
export const withCurrent = (signedIn: readonly SessionRow[], sessionId: string): string[] =>
  [sessionId, ...signedIn.map((session) => session.id).filter((id) => id !== sessionId)];

export const revokeSessions = async (env: Bindings, sessionIds: readonly string[]): Promise<void> => {
  if (sessionIds.length === 0) return;
  await controlDatabase(env.CONTROL_DB).update(sessions).set({ revokedAt: now() })
    .where(inArray(sessions.id, [...sessionIds])).run();
};

/**
 * Adds a new sign-in to the browser as its current person. A session the same
 * Google account held here before is replaced, and past the limit the one
 * least recently used is signed out.
 */
export const signInto = async (
  env: Bindings,
  signedIn: readonly SessionRow[],
  added: { sessionId: string; identityId: string },
): Promise<string[]> => {
  const others = signedIn.filter((session) => session.identity_id !== added.identityId);
  const kept = others.slice(0, SIGNED_IN_LIMIT - 1);
  const replaced = signedIn.filter((session) => session.identity_id === added.identityId);
  await revokeSessions(env, [...replaced, ...others.slice(SIGNED_IN_LIMIT - 1)].map((session) => session.id));
  return [added.sessionId, ...kept.map((session) => session.id)];
};
