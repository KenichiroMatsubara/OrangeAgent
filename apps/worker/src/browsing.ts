/**
 * The browser one run operates (ADR 0200), the same for every run that holds
 * one, whichever entrance started it: Operator Chat, an Automation, or a
 * program calling the run's tools with its Run Token.
 *
 * The browser is started by the run's first browser call, with every sign-in
 * the Account saved put back, and is closed when the run ends, when what the
 * sites renewed of each sign-in is written back. Each call acts at once and
 * answers what the page shows after it.
 */

import { acquireBrowser, connectBrowser, type BrowserBinding, type Cdp } from './cdp';
import {
  KEY_NAMES,
  browserCookies,
  clickRef,
  loginCovers,
  navigate,
  openPage,
  pageStorage,
  pressKey,
  readPage,
  renewedLogin,
  restoreLogins,
  screenshot,
  selectRef,
  typeRef,
  type BrowserPage,
  type LoginState,
  type PageReading,
} from './browser';
import { logBrowserCall, logBrowserSession } from './logging';
import { FileAnswer, type ToolHandler } from './turns';

/** How long the browser waits for a run's next call: as long as a model may think between two. */
const RUN_KEEP_ALIVE_MS = 10 * 60 * 1000;

/** A saved sign-in as the run's browser holds it. */
export interface RunLogin {
  id: string;
  site: string;
  state: LoginState;
}

/** Where a run's browser reads and writes back the Account's sign-ins. */
export interface LoginStore {
  saved(): Promise<RunLogin[]>;
  renew(login: RunLogin, state: LoginState, used: boolean): Promise<void>;
}

export interface RunBrowser {
  /** The handlers of the `browser.*` tools. */
  handlers: Record<'browser.open' | 'browser.read' | 'browser.click' | 'browser.type' | 'browser.select' | 'browser.press', ToolHandler>;
  /**
   * Writes back the sign-ins and closes the browser, if the run started one,
   * and answers how many milliseconds the run held it: 0 when it started none.
   */
  close(): Promise<number>;
}

interface Open {
  cdp: Cdp;
  page: BrowserPage;
  logins: RunLogin[];
  storage: Record<string, Record<string, string>>;
  hosts: Set<string>;
  /** When the session was acquired, by the run's clock. */
  acquiredAt: number;
}

const refused = (message: string): { isError: true; message: string } => ({ isError: true, message });

const ref = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : null);

const openUrl = (value: unknown): URL | string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'browser.open requires the url of the page to open.';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `${text} is not a URL. Name the page with its full address, starting with https://.`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${text} is not a web page: only http and https URLs are opened.`;
  return url;
};

/**
 * The browser of one run. `timeZone` is the zone the Browser's clock reads,
 * the one a person's own browser was in (`logins.ts`). Each call and the
 * session are written to the Worker's log with how long they took, under
 * `trace` (`logging.ts`); `clock` answers milliseconds.
 */
export const runBrowser = (input: { binding: BrowserBinding; logins: LoginStore; timeZone: string; trace?: Readonly<Record<string, string>>; clock?: () => number }): RunBrowser => {
  const clock = input.clock ?? Date.now;
  let opening: Promise<Open> | undefined;
  let closed = false;
  let calls = 0;
  // Each picture is named by its number in the run, so file.hand can name any one of them.
  let pictures = 0;

  const start = async (): Promise<Open> => {
    const logins = await input.logins.saved();
    const sessionId = await acquireBrowser(input.binding, RUN_KEEP_ALIVE_MS);
    const acquiredAt = clock();
    const cdp = await connectBrowser(input.binding, sessionId);
    try {
      const page = await openPage(cdp, input.timeZone);
      await restoreLogins(cdp, page, logins.map((login) => login.state));
      return { cdp, page, logins, storage: {}, hosts: new Set(), acquiredAt };
    } catch (error) {
      await cdp.send('Browser.close').catch(() => undefined);
      cdp.close();
      throw error;
    }
  };

  const browser = (): Promise<Open> => {
    if (closed) return Promise.reject(new Error('This run has ended, and its browser with it.'));
    opening ??= start().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };

  /** Notes where the page is, so its sign-in is written back with what the site keeps there. */
  const remember = async (open: Open): Promise<void> => {
    const kept = await pageStorage(open.cdp, open.page);
    if (!kept) return;
    open.storage[kept.origin] = kept.items;
    open.hosts.add(new URL(kept.origin).hostname);
  };

  const answer = async (open: Open, offset = 0): Promise<PageReading> => {
    await remember(open);
    return readPage(open.cdp, open.page, offset);
  };

  /**
   * Runs one call on the run's browser, answering a failure as a refusal the
   * model can act on, and writes the call to the log with how long it took.
   */
  const act = (tool: keyof RunBrowser['handlers'], perform: (open: Open, arguments_: Record<string, unknown>) => Promise<unknown>): ToolHandler => async (arguments_) => {
    const began = clock();
    const starting = !opening;
    const finish = <Answer>(answer: Answer, ok: boolean, startMs?: number): Answer => {
      calls += 1;
      logBrowserCall({ tool, ok, ms: clock() - began, ...(startMs === undefined ? {} : { startMs }), ...(input.trace ? { trace: input.trace } : {}) });
      return answer;
    };
    let open: Open;
    try {
      open = await browser();
    } catch (error) {
      return finish(refused(`The browser could not be started: ${error instanceof Error ? error.message : String(error)}`), false);
    }
    const startMs = starting ? clock() - began : undefined;
    try {
      const answer = await perform(open, arguments_);
      return finish(answer, !(typeof answer === 'object' && answer !== null && 'isError' in answer && answer.isError === true), startMs);
    } catch (error) {
      return finish(refused(error instanceof Error ? error.message : String(error)), false, startMs);
    }
  };

  const handlers: RunBrowser['handlers'] = {
    'browser.open': act('browser.open', async (open, arguments_) => {
      const url = openUrl(arguments_.url);
      if (typeof url === 'string') return refused(url);
      await navigate(open.cdp, open.page, url.href);
      return answer(open);
    }),
    'browser.read': act('browser.read', async (open, arguments_) => {
      const offset = typeof arguments_.offset === 'number' && Number.isInteger(arguments_.offset) && arguments_.offset > 0 ? arguments_.offset : 0;
      const reading = await answer(open, offset);
      if (arguments_.screenshot !== true) return reading;
      const bytes = await screenshot(open.cdp, open.page);
      pictures += 1;
      const filename = `screenshot-${pictures}.jpg`;
      return new FileAnswer({ ...reading, screenshot: { filename, mimeType: 'image/jpeg', size: bytes.byteLength } }, [{ filename, mediaType: 'image/jpeg', bytes, shown: true }]);
    }),
    'browser.click': act('browser.click', async (open, arguments_) => {
      const target = ref(arguments_.ref);
      if (target === null) return refused('browser.click requires ref, the number a reading of the page showed beside the control.');
      await clickRef(open.cdp, open.page, target);
      return answer(open);
    }),
    'browser.type': act('browser.type', async (open, arguments_) => {
      const target = ref(arguments_.ref);
      if (target === null) return refused('browser.type requires ref, the number a reading of the page showed beside the field.');
      if (typeof arguments_.text !== 'string') return refused('browser.type requires text, what to type into the field.');
      await typeRef(open.cdp, open.page, target, arguments_.text);
      if (arguments_.submit === true) await pressKey(open.cdp, open.page, 'Enter');
      return answer(open);
    }),
    'browser.select': act('browser.select', async (open, arguments_) => {
      const target = ref(arguments_.ref);
      if (target === null) return refused('browser.select requires ref, the number a reading of the page showed beside the list box.');
      if (typeof arguments_.option !== 'string' || !arguments_.option.trim()) return refused('browser.select requires option, the words or value of the option to choose.');
      await selectRef(open.cdp, open.page, target, arguments_.option);
      return answer(open);
    }),
    'browser.press': act('browser.press', async (open, arguments_) => {
      const key = typeof arguments_.key === 'string' ? arguments_.key.trim() : '';
      if (!KEY_NAMES.includes(key)) return refused(`browser.press requires key, one of ${KEY_NAMES.join(', ')}.`);
      await pressKey(open.cdp, open.page, key);
      return answer(open);
    }),
  };

  return {
    handlers,
    close: async () => {
      closed = true;
      const pending = opening;
      opening = undefined;
      if (!pending) return 0;
      const open = await pending.catch(() => null);
      if (!open) return 0;
      try {
        await remember(open).catch(() => undefined);
        const cookies = await browserCookies(open.cdp);
        for (const login of open.logins) {
          const used = [...open.hosts].some((host) => loginCovers(login.state, host));
          await input.logins.renew(login, renewedLogin(login.state, cookies, open.storage), used).catch(() => undefined);
        }
      } catch {
        // A browser that ended on its own leaves each sign-in as it was saved.
      } finally {
        await open.cdp.send('Browser.close').catch(() => undefined);
        open.cdp.close();
      }
      const ms = clock() - open.acquiredAt;
      logBrowserSession({ ms, calls, ...(input.trace ? { trace: input.trace } : {}) });
      return ms;
    },
  };
};
