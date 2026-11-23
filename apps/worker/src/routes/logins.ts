import type { BrowserLogin, BrowserSettings, BrowserSignIn } from '@mail/domain';

import { beginSignIn, browserSettings, cancelSignIn, defaultTimeZone, removeLogin, saveSignIn, setBrowserEnabled, setBrowserTimeZone } from '../logins';
import { invalid } from '../refusal';
import { resource } from '../response';
import { accountRoute } from './account';

/**
 * The ブラウザ screen (ADR 0200): whether the Account's runs operate a
 * browser, and the sites it is signed in to, each signed in to by a person
 * through Browser Run's Live View.
 */
export const loginRoutes = () => {
  const routes = resource();

  routes.get('/organizations/:accountId/browser', accountRoute(async ({ db, env }): Promise<BrowserSettings> => browserSettings(db, env.BROWSER)));

  // Turning it on and beginning a sign-in name the zone the person's own browser is in: the Browser's zone until one is set.
  routes.put('/organizations/:accountId/browser', accountRoute<{ enabled?: unknown; timeZone?: unknown }>(async ({ db, env, body }): Promise<BrowserSettings> => {
    if (typeof body.enabled !== 'boolean') throw invalid('ブラウザを使うかどうかを選んでください。');
    const at = new Date();
    await defaultTimeZone(db, body.timeZone, at);
    await setBrowserEnabled(db, body.enabled, at);
    return browserSettings(db, env.BROWSER);
  }));

  routes.put('/organizations/:accountId/browser/time-zone', accountRoute<{ timeZone?: unknown }>(async ({ db, env, body }): Promise<BrowserSettings> => {
    await setBrowserTimeZone(db, body.timeZone, new Date());
    return browserSettings(db, env.BROWSER);
  }));

  routes.post('/organizations/:accountId/browser/logins', accountRoute<{ url?: unknown; timeZone?: unknown }>(async ({ db, env, accountId, body }): Promise<BrowserSignIn> =>
    beginSignIn({ db, binding: env.BROWSER, accountId, url: body.url, timeZone: body.timeZone, at: new Date() })));

  routes.post('/organizations/:accountId/browser/logins/:loginId/save', accountRoute(async (request): Promise<BrowserLogin> =>
    saveSignIn({ db: request.db, binding: request.env.BROWSER, key: await request.key(), accountId: request.accountId, loginId: request.params.loginId ?? '', at: new Date() })));

  routes.post('/organizations/:accountId/browser/logins/:loginId/cancel', accountRoute(async ({ db, env, params }) => {
    await cancelSignIn({ db, binding: env.BROWSER, loginId: params.loginId ?? '', at: new Date() });
    return { id: params.loginId ?? '', cancelled: true };
  }));

  routes.delete('/organizations/:accountId/browser/logins/:loginId', accountRoute(async ({ db, env, params }) => {
    await removeLogin({ db, binding: env.BROWSER, loginId: params.loginId ?? '' });
    return { id: params.loginId ?? '', deleted: true };
  }));

  return routes;
};
