import { vi } from 'vitest';

import type { BrowserBinding } from '../src/cdp';

/** One CDP command the fake browser was sent. */
export interface SentCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** What the fake browser answers a command with: its result, or an Error it refuses with. */
export type Answerer = (command: SentCommand) => unknown;

/** The longest wait the Worker lets a page take to load and draw (browser.ts `settle`); longer timers keep their length. */
const PAGE_WAIT_MS = 1_000;

/**
 * Makes the waits a page is given to load and draw pass at once for the rest
 * of the test, as a fake page has nothing left to draw. A command's timeout
 * keeps its length. `unstubGlobals` puts the real timer back after the test.
 */
const settleAtOnce = (): void => {
  const real = globalThis.setTimeout;
  const hurried = ((act: () => void, ms?: number, ...rest: unknown[]) =>
    real(act, ms !== undefined && ms <= PAGE_WAIT_MS ? 0 : ms, ...rest)) as typeof setTimeout;
  vi.stubGlobal('setTimeout', hurried);
};

/**
 * A Browser Run binding whose browser answers each CDP command with what
 * `answer` returns, recording every command, every session acquired, and
 * every socket opened. Its pages settle at once.
 */
export const fakeBrowser = (answer: Answerer = () => ({})) => {
  settleAtOnce();
  const sent: SentCommand[] = [];
  const acquired: string[] = [];
  const connected: string[] = [];
  let sessions = 0;
  const binding: BrowserBinding = {
    fetch: async (input, init) => {
      const url = new URL(input);
      if (init?.method === 'POST') {
        sessions += 1;
        const sessionId = `session-${sessions}`;
        acquired.push(`${sessionId}?${url.searchParams.toString()}`);
        return new Response(JSON.stringify({ sessionId }));
      }
      connected.push(decodeURIComponent(url.pathname.split('/').at(-1) ?? ''));
      const listeners: { message: Array<(event: { data: unknown }) => void>; close: Array<() => void> } = { message: [], close: [] };
      const socket = {
        accept: () => undefined,
        close: () => undefined,
        addEventListener: (type: 'message' | 'close', listener: never) => {
          (listeners[type] as unknown[]).push(listener);
        },
        send: (text: string) => {
          const command = JSON.parse(text) as SentCommand;
          sent.push(command);
          queueMicrotask(() => {
            let reply: Record<string, unknown>;
            try {
              const result = answer(command);
              reply = result instanceof Error ? { id: command.id, error: { message: result.message } } : { id: command.id, result: result ?? {} };
            } catch (error) {
              reply = { id: command.id, error: { message: error instanceof Error ? error.message : String(error) } };
            }
            for (const listener of listeners.message) listener({ data: JSON.stringify(reply) });
          });
        },
      };
      return { status: 101, ok: true, webSocket: socket, text: async () => '' } as unknown as Response;
    },
  };
  return { binding, sent, acquired, connected, methods: () => sent.map((command) => command.method) };
};

/**
 * Answers a page's scripts as a loaded page at `url` would: ready, read as
 * `text`, and holding `storage` in its localStorage.
 */
export const pageAnswers = (input: { url: string; title?: string; text?: string; storage?: Record<string, string>; cookies?: unknown[] }): Answerer => (command) => {
  if (command.method === 'Target.createTarget') return { targetId: 'target-1' };
  if (command.method === 'Target.attachToTarget') return { sessionId: 'page-1' };
  if (command.method === 'Storage.getCookies') return { cookies: input.cookies ?? [] };
  if (command.method === 'Cloudflare.getLiveView') return { devtoolsFrontendUrl: 'https://live.browser.run/view/target-1' };
  if (command.method !== 'Runtime.evaluate') return {};
  const expression = String(command.params.expression);
  if (expression === 'document.readyState') return { result: { value: 'complete' } };
  if (expression.includes('localStorage.length')) return { result: { value: { origin: new URL(input.url).origin, items: input.storage ?? {} } } };
  if (expression.includes('querySelectorAll')) return { result: { value: { url: input.url, title: input.title ?? '', text: input.text ?? '' } } };
  if (expression.includes('getBoundingClientRect')) return { result: { value: { x: 10, y: 20 } } };
  return { result: { value: true } };
};
