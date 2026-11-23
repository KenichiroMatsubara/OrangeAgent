/**
 * This browser's side of Operator Chat's notifications: whether it can
 * receive them at all, whether it has been allowed to show them, and its push
 * subscription, which the Worker sends each notification to (register.ts
 * registers the Service Worker that shows them).
 *
 * An iPhone or iPad receives them only in OrangeAgent added to the home screen
 * and opened from there, so a page opened in Safari is told to do that first.
 */

/** Whether this browser can be notified: yes, not until it is opened from the home screen, or not at all. */
export type Support = 'supported' | 'install' | 'unsupported';

/** A subscription as the Worker keeps it. */
export interface Subscribed {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What the setting needs of the browser, so a test or the mocked GUI can stand in for it. */
export interface Device {
  support: () => Support;
  /** Whether showing notifications was allowed, refused, or not asked yet. */
  permission: () => NotificationPermission;
  /** The subscription this browser holds for `publicKey`; one made with another key is dropped, as the Worker cannot send to it. */
  subscription: (publicKey: string) => Promise<Subscribed | null>;
  /** Asks to show notifications, then subscribes; null when the person did not allow them. */
  subscribe: (publicKey: string) => Promise<Subscribed | null>;
  /** Drops the subscription; the address it had, or null when there was none. */
  unsubscribe: () => Promise<string | null>;
  /** The browser and its system in words. */
  label: () => string;
}

/** Whether a user agent is an iPhone's or iPad's, whose every browser is Safari underneath. */
export const isApple = (userAgent: string, platform: string, touchPoints: number): boolean =>
  /iPhone|iPad|iPod/u.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1);

/** The browser and system a user agent names, in words, such as 「iPhone の Safari」. */
export const labelOf = (userAgent: string, apple: boolean): string => {
  // An iPad asking for desktop sites calls itself a Mac; only its touch screen tells it apart.
  const system = /iPhone|iPod/u.test(userAgent) ? 'iPhone'
    : apple || /iPad/u.test(userAgent) ? 'iPad'
      : /Android/u.test(userAgent) ? 'Android'
        : /Windows/u.test(userAgent) ? 'Windows'
          : /Mac OS X|Macintosh/u.test(userAgent) ? 'Mac'
            : /CrOS/u.test(userAgent) ? 'Chromebook'
              : /Linux/u.test(userAgent) ? 'Linux' : '';
  const browser = /Edg\/|EdgiOS/u.test(userAgent) ? 'Edge'
    : /Firefox\/|FxiOS/u.test(userAgent) ? 'Firefox'
      : /SamsungBrowser/u.test(userAgent) ? 'Samsung Internet'
        : /CriOS/u.test(userAgent) ? 'Chrome'
        : apple ? 'Safari'
          : /Chrome\/|CriOS/u.test(userAgent) ? 'Chrome'
            : /Safari\//u.test(userAgent) ? 'Safari' : 'ブラウザ';
  return system ? `${system} の ${browser}` : browser;
};

const base64Url = (bytes: ArrayBuffer | null): string => {
  if (!bytes) return '';
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const keyBytes = (key: string): Uint8Array<ArrayBuffer> => {
  const padded = key.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (key.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const subscribedOf = (subscription: PushSubscription): Subscribed => ({
  endpoint: subscription.endpoint,
  keys: { p256dh: base64Url(subscription.getKey('p256dh')), auth: base64Url(subscription.getKey('auth')) },
});

/** Whether the subscription was made with this key. */
const madeWith = (subscription: PushSubscription, publicKey: string): boolean => {
  const key = subscription.options.applicationServerKey;
  return key === null || base64Url(key) === publicKey;
};

/** The registration of the Service Worker that shows notifications, waited for at most a few seconds. */
const registration = async (): Promise<ServiceWorkerRegistration> => {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new Error('通知の準備ができませんでした。画面を再読み込みしてから、もう一度お試しください。')), 10_000);
  });
  return Promise.race([ready, timeout]);
};

/** This browser, as it is. */
export const browserDevice = (): Device => {
  const apple = isApple(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    support: () => {
      if (apple && !standalone) return 'install';
      return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'supported' : 'unsupported';
    },
    permission: () => 'Notification' in window ? Notification.permission : 'denied',
    subscription: async (publicKey) => {
      const existing = await (await registration()).pushManager.getSubscription();
      if (!existing) return null;
      if (madeWith(existing, publicKey)) return subscribedOf(existing);
      await existing.unsubscribe().catch(() => false);
      return null;
    },
    subscribe: async (publicKey) => {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return null;
      const manager = (await registration()).pushManager;
      const existing = await manager.getSubscription();
      if (existing && madeWith(existing, publicKey)) return subscribedOf(existing);
      await existing?.unsubscribe().catch(() => false);
      return subscribedOf(await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    },
    unsubscribe: async () => {
      const existing = await (await registration()).pushManager.getSubscription();
      if (!existing) return null;
      const { endpoint } = existing;
      await existing.unsubscribe().catch(() => false);
      return endpoint;
    },
    label: () => labelOf(navigator.userAgent, apple),
  };
};

/**
 * The browser the mocked GUI plays (`npm run dev:mock`), which has no Service
 * Worker: `?device=install|unsupported|denied|on` shows each state.
 */
export const mockDevice = (shown: string | null): Device => {
  let subscribed: Subscribed | null = shown === 'on' ? { endpoint: 'https://push.example.com/mock', keys: { p256dh: 'mock', auth: 'mock' } } : null;
  let permission: NotificationPermission = shown === 'denied' ? 'denied' : shown === 'on' ? 'granted' : 'default';
  return {
    support: () => shown === 'install' ? 'install' : shown === 'unsupported' ? 'unsupported' : 'supported',
    permission: () => permission,
    subscription: async () => subscribed,
    subscribe: async () => {
      if (permission === 'denied') return null;
      permission = 'granted';
      subscribed = { endpoint: 'https://push.example.com/mock', keys: { p256dh: 'mock', auth: 'mock' } };
      return subscribed;
    },
    unsubscribe: async () => {
      const endpoint = subscribed?.endpoint ?? null;
      subscribed = null;
      return endpoint;
    },
    label: () => 'iPhone の Safari',
  };
};
