/**
 * The Worker left at the URL the product had while it was called FlareChat.
 * A page a browser opens there is sent to the same path at OrangeAgent's URL,
 * so a bookmark or a link already sent still opens; every other request — a
 * LINE or Discord webhook, an MCP call, an API call — is handed to the
 * OrangeAgent Worker as it is, because those callers do not follow redirects.
 *
 * A browser that installed the app at the old URL keeps answering its pages
 * from its Service Worker, never asking the network. Its next update check
 * fetches `/sw.js`, so that path answers a Service Worker that removes itself
 * and moves every open window to the same page at OrangeAgent's URL.
 */

interface Env {
  TARGET: Fetcher;
  TARGET_ORIGIN: string;
}

const farewell = (origin: string): string => `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.registration.unregister();
  for (const key of await caches.keys()) await caches.delete(key);
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    const url = new URL(client.url);
    client.navigate(${JSON.stringify(origin)} + url.pathname + url.search);
  }
})()));
`;

const isPage = (request: Request): boolean =>
  (request.method === 'GET' || request.method === 'HEAD') && (request.headers.get('accept') ?? '').includes('text/html');

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const from = new URL(request.url);
    const to = new URL(`${from.pathname}${from.search}`, env.TARGET_ORIGIN);
    if (from.pathname === '/sw.js') {
      return new Response(farewell(env.TARGET_ORIGIN), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (isPage(request)) return Response.redirect(to.toString(), 301);
    return env.TARGET.fetch(new Request(to.toString(), request));
  },
} satisfies ExportedHandler<Env>;
