/**
 * The Account's browser (ADR 0200): whether its runs may operate one, the
 * sites it is signed in to, and how a person signs in to one.
 *
 * A person signs in once, in Browser Run's Live View of a tab OrangeAgent
 * opened at the site; saving keeps what that browser then holds, its cookies
 * and the site's localStorage, under the Account's envelope encryption. Every
 * run's browser starts with every saved sign-in put back, and at its end
 * writes back what the sites renewed, so a sign-in lasts as long as the site
 * keeps it.
 */

import { asc, eq, sql } from 'drizzle-orm';

import type { BrowserLogin, BrowserSettings, BrowserSignIn } from '@mail/domain';

import { acquireBrowser, connectBrowser, MAX_KEEP_ALIVE_MS, type BrowserBinding, type Cdp } from './cdp';
import { browserCookies, liveView, navigate, openPage, pageStorage, type BrowserPage, type LoginState } from './browser';
import { runBrowser, type LoginStore, type RunBrowser } from './browsing';
import { decrypt, encrypt, type CipherEnvelope } from './cryptography';
import { logBrowserSignIn } from './logging';
import { invalid, notFound, upstream } from './refusal';
import { browserLogins, runs, settings } from './storage/account-schema';
import { accountDatabase, type AccountDatabase } from './storage/database';

/** The `settings` key that holds whether the Account's runs may operate a browser. */
export const BROWSER_SETTING = 'browser';

/** The `settings` key that holds the time zone the Browser's clock reads in. */
export const BROWSER_TIME_ZONE_SETTING = 'browser.time_zone';

/** The zone the Browser's clock reads until one is set: the zone OrangeAgent counts its days in. */
export const DEFAULT_BROWSER_TIME_ZONE = 'Asia/Tokyo';

/** The IANA zone `value` names, or null when it names none this runtime knows. */
export const timeZoneOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

/** The zone set on the ブラウザ screen, or null while none is. */
const storedTimeZone = async (db: AccountDatabase): Promise<string | null> => {
  const stored = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, BROWSER_TIME_ZONE_SETTING)).get();
  return timeZoneOf(stored?.value);
};

/** The zone every run's Browser reads its clock in. */
export const browserTimeZone = async (db: AccountDatabase): Promise<string> => await storedTimeZone(db) ?? DEFAULT_BROWSER_TIME_ZONE;

/** Sets the zone the Browser's clock reads in to any zone a person chooses. */
export const setBrowserTimeZone = async (db: AccountDatabase, value: unknown, at: Date): Promise<void> => {
  const zone = timeZoneOf(value);
  if (!zone) throw invalid('タイムゾーンを選んでください。');
  const updatedAt = at.toISOString();
  await db.insert(settings).values({ key: BROWSER_TIME_ZONE_SETTING, value: zone, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value: zone, updatedAt } });
};

/**
 * Sets the zone to the one the person's own browser is in, when none is set
 * yet: the zone a person first turns the Browser on or signs in from is its
 * default, and one already set, chosen or not, is kept.
 */
export const defaultTimeZone = async (db: AccountDatabase, value: unknown, at: Date): Promise<void> => {
  const zone = timeZoneOf(value);
  if (!zone) return;
  await db.insert(settings).values({ key: BROWSER_TIME_ZONE_SETTING, value: zone, updatedAt: at.toISOString() }).onConflictDoNothing({ target: settings.key });
};

/** How long a person has to sign in before the browser stops waiting: Browser Run's longest. */
export const SIGN_IN_MS = MAX_KEEP_ALIVE_MS;

type LoginRow = typeof browserLogins.$inferSelect;

const stateContext = (accountId: string, loginId: string): string => `browser-login:${accountId}:${loginId}`;

/**
 * Whether the Account lets its runs operate a browser: off until a person
 * turns it on, since a browser call acts on a site at once and a sign-in acts
 * as the person who saved it.
 */
export const browserEnabled = async (db: AccountDatabase): Promise<boolean> => {
  const stored = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, BROWSER_SETTING)).get();
  return stored?.value === 'on';
};

export const setBrowserEnabled = async (db: AccountDatabase, enabled: boolean, at: Date): Promise<void> => {
  const value = enabled ? 'on' : 'off';
  const updatedAt = at.toISOString();
  await db.insert(settings).values({ key: BROWSER_SETTING, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
};

const loginView = (row: LoginRow): BrowserLogin => ({
  id: row.id,
  site: row.site,
  url: row.url,
  signingIn: row.sessionId !== null,
  savedAt: row.savedAt,
  usedAt: row.usedAt,
});

export const listLogins = async (db: AccountDatabase): Promise<BrowserLogin[]> =>
  (await db.select().from(browserLogins).orderBy(asc(browserLogins.site)).all()).map(loginView);

/** The ブラウザ screen. */
export const browserSettings = async (db: AccountDatabase, binding: BrowserBinding | undefined): Promise<BrowserSettings> => ({
  enabled: await browserEnabled(db),
  available: binding !== undefined,
  timeZone: await storedTimeZone(db),
  logins: await listLogins(db),
});

const readState = async (row: LoginRow, key: CryptoKey, accountId: string): Promise<LoginState | null> => {
  if (!row.stateEnvelope) return null;
  const value = JSON.parse(await decrypt(JSON.parse(row.stateEnvelope) as CipherEnvelope, key, stateContext(accountId, row.id))) as Partial<LoginState>;
  return { cookies: Array.isArray(value.cookies) ? value.cookies : [], storage: typeof value.storage === 'object' && value.storage !== null ? value.storage : {} };
};

const sealState = async (state: LoginState, key: CryptoKey, accountId: string, loginId: string): Promise<string> =>
  JSON.stringify(await encrypt(JSON.stringify(state), key, stateContext(accountId, loginId)));

/** Every saved sign-in, as a run's browser puts it back. */
export const savedLogins = async (db: AccountDatabase, key: CryptoKey, accountId: string): Promise<Array<{ id: string; site: string; state: LoginState }>> => {
  const rows = await db.select().from(browserLogins).all();
  const states = await Promise.all(rows.map(async (row) => {
    const state = await readState(row, key, accountId).catch(() => null);
    return state ? [{ id: row.id, site: row.site, state }] : [];
  }));
  return states.flat();
};

/** Writes back what a run's browser left of one sign-in. */
export const renewLogin = async (input: { db: AccountDatabase; key: CryptoKey; accountId: string; loginId: string; state: LoginState; used: boolean; at: Date }): Promise<void> => {
  const at = input.at.toISOString();
  await input.db.update(browserLogins).set({
    stateEnvelope: await sealState(input.state, input.key, input.accountId, input.loginId),
    ...(input.used ? { usedAt: at } : {}),
    updatedAt: at,
  }).where(eq(browserLogins.id, input.loginId)).run();
};

/** The page a person signs in at, or why it cannot be. */
export const signInUrl = (value: unknown): URL => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw invalid('ログインするページの URL を入れてください。');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/iu.test(text) ? text : `https://${text}`);
  } catch {
    throw invalid(`${text} は URL として読めません。`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('http か https のページだけにログインできます。');
  if (url.username || url.password) throw invalid('ユーザー名やパスワードを含む URL は使えません。');
  return url;
};

const requireBinding = (binding: BrowserBinding | undefined): BrowserBinding => {
  if (!binding) throw upstream('この Worker には Browser Run が結び付けられていません。');
  return binding;
};

/** Closes the Browser Run session of a sign-in, if it is still there, and writes how the sign-in ended to the log. */
const closeSession = async (binding: BrowserBinding, sessionId: string, ended: { accountId: string; loginId: string; how: 'cancelled' | 'removed' | 'replaced' }): Promise<void> => {
  logBrowserSignIn({ ...ended, phase: 'ended' });
  let cdp: Cdp | undefined;
  try {
    cdp = await connectBrowser(binding, sessionId);
    await cdp.send('Browser.close');
  } catch {
    // A session that already ended has nothing left to close.
  } finally {
    cdp?.close();
  }
};

/**
 * Begins a sign-in: a browser waiting up to twenty minutes, a tab open at the
 * page, and its Live View for the person. Signing in again to a site keeps
 * the saved sign-in until the new one is saved.
 */
export const beginSignIn = async (input: { db: AccountDatabase; binding: BrowserBinding | undefined; accountId: string; url: unknown; timeZone?: unknown; at: Date }): Promise<BrowserSignIn> => {
  const binding = requireBinding(input.binding);
  const url = signInUrl(input.url);
  await defaultTimeZone(input.db, input.timeZone, input.at);
  const timeZone = await browserTimeZone(input.db);
  const site = url.hostname.toLowerCase();
  const existing = await input.db.select().from(browserLogins).where(eq(browserLogins.site, site)).get();
  if (existing?.sessionId) await closeSession(binding, existing.sessionId, { accountId: input.accountId, loginId: existing.id, how: 'replaced' });
  let sessionId: string;
  let page: BrowserPage;
  let view: string;
  try {
    sessionId = await acquireBrowser(binding, SIGN_IN_MS);
  } catch (error) {
    throw upstream(`ブラウザを起動できませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
  const id = existing?.id ?? crypto.randomUUID();
  logBrowserSignIn({ accountId: input.accountId, loginId: id, phase: 'started' });
  const cdp = await connectBrowser(binding, sessionId);
  try {
    page = await openPage(cdp, timeZone);
    await navigate(cdp, page, url.href).catch(() => undefined);
    view = await liveView(cdp, page, SIGN_IN_MS);
  } catch (error) {
    await cdp.send('Browser.close').catch(() => undefined);
    logBrowserSignIn({ accountId: input.accountId, loginId: id, phase: 'ended', how: 'failed' });
    throw upstream(`ログイン用の画面を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    cdp.close();
  }
  const at = input.at.toISOString();
  if (existing) {
    await input.db.update(browserLogins).set({ url: url.href, sessionId, targetId: page.targetId, updatedAt: at }).where(eq(browserLogins.id, id)).run();
  } else {
    await input.db.insert(browserLogins).values({ id, accountId: input.accountId, site, url: url.href, sessionId, targetId: page.targetId, createdAt: at, updatedAt: at }).run();
  }
  const row = await input.db.select().from(browserLogins).where(eq(browserLogins.id, id)).get();
  if (!row) throw notFound('ログインが見つかりません。');
  return { login: loginView(row), liveViewUrl: view, expiresAt: new Date(input.at.getTime() + SIGN_IN_MS).toISOString() };
};

/** Saves what the browser a person signed in through holds, and closes it. */
export const saveSignIn = async (input: { db: AccountDatabase; binding: BrowserBinding | undefined; key: CryptoKey; accountId: string; loginId: string; at: Date }): Promise<BrowserLogin> => {
  const binding = requireBinding(input.binding);
  const row = await input.db.select().from(browserLogins).where(eq(browserLogins.id, input.loginId)).get();
  if (!row) throw notFound('ログインが見つかりません。');
  if (!row.sessionId || !row.targetId) throw invalid('このサイトにはいまログインしていません。もう一度ログインを始めてください。');
  let state: LoginState;
  let cdp: Cdp | undefined;
  try {
    cdp = await connectBrowser(binding, row.sessionId);
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: row.targetId, flatten: true });
    const page: BrowserPage = { targetId: row.targetId, sessionId };
    const cookies = await browserCookies(cdp);
    const storage = await pageStorage(cdp, page);
    state = { cookies, storage: storage ? { [storage.origin]: storage.items } : {} };
    await cdp.send('Browser.close').catch(() => undefined);
    logBrowserSignIn({ accountId: row.accountId, loginId: row.id, phase: 'ended', how: 'saved' });
  } catch (error) {
    await input.db.update(browserLogins).set({ sessionId: null, targetId: null, updatedAt: input.at.toISOString() }).where(eq(browserLogins.id, row.id)).run();
    throw upstream(`ログインに使ったブラウザが閉じていました。もう一度ログインを始めてください（${error instanceof Error ? error.message : String(error)}）。`);
  } finally {
    cdp?.close();
  }
  if (!state.cookies.length) throw invalid('ブラウザにログインの記録（Cookie）がありません。ログインし終えてから保存してください。');
  const at = input.at.toISOString();
  await input.db.update(browserLogins).set({
    stateEnvelope: await sealState(state, input.key, input.accountId, row.id),
    sessionId: null,
    targetId: null,
    savedAt: at,
    updatedAt: at,
  }).where(eq(browserLogins.id, row.id)).run();
  return loginView({ ...row, sessionId: null, targetId: null, savedAt: at, updatedAt: at });
};

/**
 * Removes a sign-in: the saved one, and the browser a person was signing in
 * through. A sign-in never saved is removed the same way, which is how a
 * person stops signing in.
 */
export const removeLogin = async (input: { db: AccountDatabase; binding: BrowserBinding | undefined; loginId: string }): Promise<void> => {
  const row = await input.db.select().from(browserLogins).where(eq(browserLogins.id, input.loginId)).get();
  if (!row) throw notFound('ログインが見つかりません。');
  if (row.sessionId && input.binding) await closeSession(input.binding, row.sessionId, { accountId: row.accountId, loginId: row.id, how: 'removed' });
  await input.db.delete(browserLogins).where(eq(browserLogins.id, row.id)).run();
};

/**
 * Stops a sign-in a person began without saving: its browser is closed, a
 * site signed in to before keeps its saved sign-in, and one never saved is
 * removed.
 */
export const cancelSignIn = async (input: { db: AccountDatabase; binding: BrowserBinding | undefined; loginId: string; at: Date }): Promise<void> => {
  const row = await input.db.select().from(browserLogins).where(eq(browserLogins.id, input.loginId)).get();
  if (!row) throw notFound('ログインが見つかりません。');
  if (row.sessionId && input.binding) await closeSession(input.binding, row.sessionId, { accountId: row.accountId, loginId: row.id, how: 'cancelled' });
  if (!row.stateEnvelope) {
    await input.db.delete(browserLogins).where(eq(browserLogins.id, row.id)).run();
    return;
  }
  await input.db.update(browserLogins).set({ sessionId: null, targetId: null, updatedAt: input.at.toISOString() }).where(eq(browserLogins.id, row.id)).run();
};

/** The Account's sign-ins as a run's browser reads and renews them. */
export const loginStore = (input: { db: AccountDatabase; key: CryptoKey; accountId: string; at: () => Date }): LoginStore => ({
  saved: () => savedLogins(input.db, input.key, input.accountId),
  renew: (login, state, used) => renewLogin({ db: input.db, key: input.key, accountId: input.accountId, loginId: login.id, state, used, at: input.at() }),
});

/** Which run a browser is for: the Run it adds its time to, and the entrance that started it, for the log. */
export interface BrowserRun {
  id: string;
  entrance: 'chat' | 'automation';
}

/**
 * The browser a run the Account starts operates, or null when the Account
 * has not turned it on or this Worker has no Browser Run binding: the same for
 * Operator Chat and every Automation. Closing it adds how long the run held
 * it to the Run's `browser_ms`, so a run an answer resumes adds each answer's
 * time.
 */
export const accountBrowser = async (input: { binding: BrowserBinding | undefined; database: D1Database; key: CryptoKey; accountId: string; run: BrowserRun }): Promise<RunBrowser | null> => {
  if (!input.binding) return null;
  const db = accountDatabase(input.database);
  if (!await browserEnabled(db)) return null;
  const browser = runBrowser({
    binding: input.binding,
    timeZone: await browserTimeZone(db),
    logins: loginStore({ db, key: input.key, accountId: input.accountId, at: () => new Date() }),
    trace: { accountId: input.accountId, runId: input.run.id, entrance: input.run.entrance },
  });
  return {
    handlers: browser.handlers,
    close: async () => {
      const ms = await browser.close();
      if (ms > 0) await db.update(runs).set({ browserMs: sql`${runs.browserMs} + ${ms}` }).where(eq(runs.id, input.run.id)).run();
      return ms;
    },
  };
};
