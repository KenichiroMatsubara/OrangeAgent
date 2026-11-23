/**
 * The Worker left at the URL the product had while it was called FlareChat.
 * A page a browser opens there is sent to the same path at OrangeAgent's URL,
 * so a bookmark or a link already sent still opens; every other request — a
 * LINE or Discord webhook, an MCP call, an API call — is handed to the
 * OrangeAgent Worker as it is, because those callers do not follow redirects.
 */

interface Env {
  TARGET: Fetcher;
  TARGET_ORIGIN: string;
}

const isPage = (request: Request): boolean =>
  (request.method === 'GET' || request.method === 'HEAD') && (request.headers.get('accept') ?? '').includes('text/html');

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const from = new URL(request.url);
    const to = new URL(`${from.pathname}${from.search}`, env.TARGET_ORIGIN);
    if (isPage(request)) return Response.redirect(to.toString(), 301);
    return env.TARGET.fetch(new Request(to.toString(), request));
  },
} satisfies ExportedHandler<Env>;
