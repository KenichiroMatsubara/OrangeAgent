/**
 * The Chrome DevTools Protocol spoken to Cloudflare Browser Run over its
 * Worker binding, without a browser library: a session is acquired with one
 * POST, and its browser is driven over one WebSocket, the page reached by the
 * `sessionId` Target.attachToTarget answers with `flatten`.
 *
 * Browser Run's own commands (`Cloudflare.getLiveView`) travel the same
 * socket as the standard ones.
 */

/** The `browser` binding of wrangler.jsonc: only its `fetch` is used. */
export interface BrowserBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** The one socket a browser is driven over. */
export interface CdpSocket {
  send(message: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
}

/** One connection to one browser. */
export interface Cdp {
  /** Sends a command to the browser, or to the page whose `sessionId` is named, and answers its result. */
  send<Result = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Result>;
  close(): void;
}

/** The host the binding is addressed by; Browser Run reads only the path. */
const HOST = 'https://browser.run';

const COMMAND_TIMEOUT_MS = 60_000;

/** The longest a session waits for its next command: Browser Run's own ceiling. */
export const MAX_KEEP_ALIVE_MS = 20 * 60 * 1000;

/** Acquires a new browser session and answers its id. */
export const acquireBrowser = async (binding: BrowserBinding, keepAliveMs: number): Promise<string> => {
  const response = await binding.fetch(`${HOST}/v1/devtools/browser?keep_alive=${Math.min(Math.max(keepAliveMs, 10_000), MAX_KEEP_ALIVE_MS)}`, { method: 'POST' });
  const text = await response.text();
  if (!response.ok) throw new Error(`Browser Run did not start a browser: HTTP ${response.status} ${text.slice(0, 300)}`);
  const sessionId = (JSON.parse(text) as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Browser Run started a browser without naming its session.');
  return sessionId;
};

/** Opens the socket of an acquired session. */
export const openSocket = async (binding: BrowserBinding, sessionId: string): Promise<CdpSocket> => {
  const response = await binding.fetch(`${HOST}/v1/devtools/browser/${encodeURIComponent(sessionId)}`, { headers: { Upgrade: 'websocket' } });
  const socket = (response as Response & { webSocket?: (CdpSocket & { accept(): void }) | null }).webSocket;
  if (!socket) throw new Error(`The browser could not be reached: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  socket.accept();
  return socket;
};

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Speaks CDP over a socket: each command is answered by the message carrying its id. */
export const cdpOver = (socket: CdpSocket): Cdp => {
  let next = 0;
  let closed = false;
  const pending = new Map<number, Pending>();
  const fail = (error: Error): void => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : '';
    if (!text) return;
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'The browser refused the command.'));
    else entry.resolve((message.result ?? {}) as Record<string, unknown>);
  });
  socket.addEventListener('close', () => fail(new Error('The browser closed.')));
  return {
    send: <Result = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Result> => {
      if (closed) return Promise.reject(new Error('The browser closed.'));
      next += 1;
      const id = next;
      return new Promise<Result>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The browser did not answer ${method} within ${COMMAND_TIMEOUT_MS / 1000} seconds.`));
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve: (value) => resolve(value as Result), reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => {
      if (closed) return;
      fail(new Error('The browser closed.'));
      try {
        socket.close();
      } catch {
        // A socket the browser already closed has nothing left to close.
      }
    },
  };
};

/** Connects to an acquired session. */
export const connectBrowser = async (binding: BrowserBinding, sessionId: string): Promise<Cdp> => cdpOver(await openSocket(binding, sessionId));
