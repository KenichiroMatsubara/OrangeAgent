import type { PushDevice, PushDeviceRemoval, PushDeviceState, PushSettings } from '@mail/domain';

import { now } from '../clock';
import { fromBase64Url } from '../encoding';
import { vapidOf } from '../push';
import { invalid } from '../refusal';
import { resource } from '../response';
import { removeSubscription, saveSubscription } from '../subscriptions';
import type { Bindings } from '../types';
import { accountRoute } from './account';

/** The longest push address a browser is taken with; browsers' are a few hundred characters. */
const ENDPOINT_CHARACTERS = 2_048;
const LABEL_CHARACTERS = 80;

const decodes = (value: unknown, bytes: number, first?: number): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const decoded = fromBase64Url(value);
    return decoded.byteLength === bytes && (first === undefined || decoded[0] === first);
  } catch {
    return false;
  }
};

/** Whether the Worker itself runs on this machine, as `wrangler dev` does, where a push address may be a local fake. */
const isLocal = (env: Bindings): boolean => {
  try {
    const host = new URL(env.APP_URL).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

/** A browser's push address: a push service's https URL, or, only where the Worker runs locally, a local one. */
const endpointOf = (env: Bindings, value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > ENDPOINT_CHARACTERS) throw invalid('この端末の通知先を読み取れませんでした。');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('この端末の通知先を読み取れませんでした。');
  }
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && isLocal(env);
  if (url.protocol !== 'https:' && !local) throw invalid('この端末の通知先は https で始まる必要があります。');
  if (url.username || url.password) throw invalid('この端末の通知先を読み取れませんでした。');
  return value;
};

/**
 * Operator Chat's notifications on one browser of one member: whether the
 * deployment can send any, and turning them on and off for the browser that
 * asks. Which conversations notify whom is the conversation's object's.
 */
export const pushRoutes = resource();

/** The VAPID public key a browser subscribes with, or null where the Worker holds no VAPID keys. */
pushRoutes.get('/organizations/:accountId/push', accountRoute(async ({ env }): Promise<PushSettings> => ({ publicKey: vapidOf(env)?.publicKey ?? null })));

/** Notifies this member on the browser that subscribed, from now on; a browser that subscribed again replaces what it had handed over. */
pushRoutes.post('/organizations/:accountId/push/devices', accountRoute<Partial<PushDevice>>(async (request): Promise<PushDeviceState> => {
  if (!vapidOf(request.env)) throw invalid('この FlareChat には通知の鍵（VAPID）が設定されていないため、通知を送れません。');
  const { keys, label } = request.body;
  const endpoint = endpointOf(request.env, request.body.endpoint);
  if (!keys || !decodes(keys.p256dh, 65, 4) || !decodes(keys.auth, 16)) throw invalid('この端末の通知の鍵を読み取れませんでした。');
  await saveSubscription({
    database: request.database,
    identityId: request.session.identity_id,
    target: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    label: typeof label === 'string' ? label.trim().slice(0, LABEL_CHARACTERS) : '',
    timestamp: now(),
  });
  return { subscribed: true };
}));

/** Stops notifying this member on the browser that asks. */
pushRoutes.delete('/organizations/:accountId/push/devices', accountRoute<Partial<PushDeviceRemoval>>(async (request): Promise<PushDeviceState> => {
  const { endpoint } = request.body;
  if (typeof endpoint !== 'string' || !endpoint) throw invalid('どの端末の通知を止めるかが分かりません。');
  await removeSubscription({ database: request.database, identityId: request.session.identity_id, endpoint });
  return { subscribed: false };
}));
