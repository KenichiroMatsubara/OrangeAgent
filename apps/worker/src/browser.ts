/**
 * Driving one page of a Browser Run browser for a run: opening a URL, reading
 * the page as its words with each control it can act on numbered, clicking,
 * typing, choosing, and pressing keys, all through the Chrome DevTools
 * Protocol (`cdp.ts`).
 *
 * The page is read by a script it runs, which writes each control's number
 * onto the control itself as `data-orangeagent-ref`, so a later click names the
 * very element the reading showed. Every reading numbers the controls afresh.
 */

import type { Cdp } from './cdp';

/** One page of a browser: the target it is and the session its commands carry. */
export interface BrowserPage {
  targetId: string;
  sessionId: string;
}

/** What a page reads as. */
export interface PageReading {
  url: string;
  title: string;
  text: string;
  /** Where the next part starts when the page is longer than one answer holds, or null at its end. */
  nextOffset: number | null;
}

/** How many characters of a page one answer holds; a run reads on from `offset`. */
export const PAGE_CHARACTERS = 30_000;

const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 600;
const REF_ATTRIBUTE = 'data-orangeagent-ref';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Evaluated {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** Runs an expression in the page and answers its value. */
export const evaluate = async (cdp: Cdp, page: BrowserPage, expression: string): Promise<unknown> => {
  const answer = await cdp.send<Evaluated>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? 'The page refused the script.');
  return answer.result?.value;
};

/**
 * Opens a blank page in the browser, its clock in `timeZone`: Browser Run's
 * Chrome runs in UTC, so without it a site shows its times nine hours behind
 * Tokyo. The zone holds only while this connection stays attached.
 */
export const openPage = async (cdp: Cdp, timeZone: string): Promise<BrowserPage> => {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: timeZone }, sessionId).catch(() => undefined);
  return { targetId, sessionId };
};

/** Waits until the page has loaded, and a moment more for what its scripts draw. */
export const settle = async (cdp: Cdp, page: BrowserPage): Promise<void> => {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  await wait(SETTLE_MS / 2);
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, page, 'document.readyState').catch(() => 'loading');
    if (state === 'complete') break;
    await wait(250);
  }
  await wait(SETTLE_MS);
};

/** Opens a URL in the page. */
export const navigate = async (cdp: Cdp, page: BrowserPage, url: string): Promise<void> => {
  const answer = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, page.sessionId);
  if (answer.errorText) throw new Error(`${url} could not be opened: ${answer.errorText}`);
  await settle(cdp, page);
};

/**
 * The script that reads a page: its visible words in reading order, each
 * control written as `[n] kind "name"` with its state, and each control
 * marked with its number so it can be acted on.
 */
const READ_SCRIPT = `(() => {
  const REF = ${JSON.stringify(REF_ATTRIBUTE)};
  for (const element of document.querySelectorAll('[' + REF + ']')) element.removeAttribute(REF);
  const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DD','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TBODY','THEAD','TFOOT','TR','UL','DIALOG']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','HEAD','META','LINK']);
  const ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','menuitemcheckbox','menuitemradio','option','switch','combobox','textbox','searchbox','slider','spinbutton','treeitem']);
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  const shown = (element) => {
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const control = (element) => {
    const tag = element.tagName;
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return tag.toLowerCase();
    if (tag === 'INPUT') return element.type === 'hidden' ? null : 'input';
    const role = element.getAttribute('role');
    if (role && ROLES.has(role)) return role;
    if (element.isContentEditable && element.getAttribute('contenteditable') !== null) return 'editable';
    if (element.hasAttribute('onclick')) return 'clickable';
    return null;
  };
  const nameOf = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const byId = labelledBy ? clean(labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ')) : '';
    const label = element.labels && element.labels.length ? clean(Array.from(element.labels).map((entry) => entry.innerText).join(' ')) : '';
    const words = element.tagName === 'SELECT' ? '' : clean(element.innerText);
    return clean(element.getAttribute('aria-label')) || byId || label || words || clean(element.getAttribute('title')) || clean(element.getAttribute('alt')) || clean(element.getAttribute('placeholder')) || clean(element.getAttribute('name'));
  };
  let next = 0;
  const out = [];
  const line = () => { if (out.length && out[out.length - 1] !== '\\n') out.push('\\n'); };
  const describe = (element, kind) => {
    next += 1;
    element.setAttribute(REF, String(next));
    if (element.tagName === 'A') element.setAttribute('target', '_self');
    const parts = ['[' + next + '] ' + kind];
    if (element.tagName === 'INPUT') parts[0] += ' (' + (element.type || 'text') + ')';
    const name = nameOf(element);
    if (name) parts.push(JSON.stringify(name.slice(0, 200)));
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      if (element.type === 'checkbox' || element.type === 'radio') parts.push(element.checked ? 'checked' : 'unchecked');
      else if (element.type === 'password') parts.push(element.value ? 'filled' : 'empty');
      else if (element.value) parts.push('value=' + JSON.stringify(String(element.value).slice(0, 200)));
      if (element.placeholder && element.placeholder !== name) parts.push('placeholder=' + JSON.stringify(element.placeholder));
    }
    if (element.tagName === 'SELECT') {
      const options = Array.from(element.options).slice(0, 30).map((option) => (option.selected ? '*' : '') + clean(option.text));
      parts.push('options=' + JSON.stringify(options));
    }
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push('-> ' + element.href);
    }
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    const expanded = element.getAttribute('aria-expanded');
    if (expanded) parts.push(expanded === 'true' ? 'expanded' : 'collapsed');
    const checked = element.getAttribute('aria-checked');
    if (checked && element.tagName !== 'INPUT') parts.push(checked === 'true' ? 'checked' : 'unchecked');
    out.push(' ' + parts.join(' ') + ' ');
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.textContent);
      if (text) out.push(text + ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (SKIP.has(element.tagName.toUpperCase()) || !shown(element)) return;
    const block = BLOCK.has(element.tagName);
    if (block) line();
    const kind = control(element);
    if (kind) {
      describe(element, kind);
      if (kind === 'link' || kind === 'button' || kind === 'summary' || kind === 'option' || kind === 'tab' || kind === 'menuitem') {
        if (block) line();
        return;
      }
      if (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return;
    }
    if (element.tagName === 'IMG') {
      const alt = clean(element.getAttribute('alt'));
      if (alt) out.push('(image: ' + alt + ') ');
    }
    if (element.tagName === 'TD' || element.tagName === 'TH') out.push('| ');
    for (const child of element.childNodes) walk(child);
    if (element.shadowRoot) for (const child of element.shadowRoot.childNodes) walk(child);
    if (block) line();
  };
  if (document.body) walk(document.body);
  const text = out.join('').split('\\n').map((entry) => entry.replace(/ +/g, ' ').trim()).filter(Boolean).join('\\n');
  return { url: location.href, title: document.title, text };
})()`;

/** Reads the page from `offset`. */
export const readPage = async (cdp: Cdp, page: BrowserPage, offset = 0): Promise<PageReading> => {
  const value = await evaluate(cdp, page, READ_SCRIPT) as { url?: unknown; title?: unknown; text?: unknown } | null;
  const text = typeof value?.text === 'string' ? value.text : '';
  const start = Math.min(Math.max(offset, 0), text.length);
  const end = Math.min(start + PAGE_CHARACTERS, text.length);
  return {
    url: typeof value?.url === 'string' ? value.url : '',
    title: typeof value?.title === 'string' ? value.title : '',
    text: text.slice(start, end),
    nextOffset: end < text.length ? end : null,
  };
};

const refSelector = (ref: number): string => `[${REF_ATTRIBUTE}="${ref}"]`;

/** Where on the screen a numbered control is, scrolled into view, or null when the page no longer has it. */
const pointOf = async (cdp: Cdp, page: BrowserPage, ref: number): Promise<{ x: number; y: number } | null> => {
  const value = await evaluate(cdp, page, `(() => {
    const element = document.querySelector(${JSON.stringify(refSelector(ref))});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`) as { x?: unknown; y?: unknown } | null;
  return value && typeof value.x === 'number' && typeof value.y === 'number' ? { x: value.x, y: value.y } : null;
};

const missing = (ref: number): Error => new Error(`The page has no control [${ref}] now. Read the page again and use the numbers it shows.`);

/** Clicks a numbered control as a person's mouse would, and waits for what it opens. */
export const clickRef = async (cdp: Cdp, page: BrowserPage, ref: number): Promise<void> => {
  const point = await pointOf(cdp, page, ref);
  if (!point) throw missing(ref);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, page.sessionId);
  await settle(cdp, page);
};

/** The keys a run may press, as CDP names them. */
const KEYS: Readonly<Record<string, { key: string; code: string; keyCode: number; text?: string }>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

export const KEY_NAMES: readonly string[] = Object.keys(KEYS);

/** Presses one key in the page, where its focus is. */
export const pressKey = async (cdp: Cdp, page: BrowserPage, name: string): Promise<void> => {
  const key = KEYS[name];
  if (!key) throw new Error(`${name} is not a key that can be pressed. Press one of ${KEY_NAMES.join(', ')}.`);
  const common = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...common, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) }, page.sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, page.sessionId);
  await settle(cdp, page);
};

/** Types into a numbered control, in place of what it held. */
export const typeRef = async (cdp: Cdp, page: BrowserPage, ref: number, text: string): Promise<void> => {
  const focused = await evaluate(cdp, page, `(() => {
    const element = document.querySelector(${JSON.stringify(refSelector(ref))});
    if (!element) return false;
    element.scrollIntoView({ block: 'center' });
    element.focus();
    if (typeof element.select === 'function') element.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  })()`);
  if (focused !== true) throw missing(ref);
  if (text) await cdp.send('Input.insertText', { text }, page.sessionId);
  else await pressKey(cdp, page, 'Delete');
  await wait(SETTLE_MS / 2);
};

/** Chooses an option of a numbered list box by its words or its value. */
export const selectRef = async (cdp: Cdp, page: BrowserPage, ref: number, option: string): Promise<void> => {
  const chosen = await evaluate(cdp, page, `(() => {
    const element = document.querySelector(${JSON.stringify(refSelector(ref))});
    if (!element) return 'missing';
    if (element.tagName !== 'SELECT') return 'not_select';
    const wanted = ${JSON.stringify(option)}.trim();
    const match = Array.from(element.options).find((entry) => entry.text.replace(/\\s+/g, ' ').trim() === wanted || entry.value === wanted);
    if (!match) return 'no_option';
    element.value = match.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return 'chosen';
  })()`);
  if (chosen === 'missing') throw missing(ref);
  if (chosen === 'not_select') throw new Error(`[${ref}] is not a list box. Click it instead, and choose from what it opens.`);
  if (chosen === 'no_option') throw new Error(`[${ref}] has no option ${JSON.stringify(option)}. Choose one of the options the reading lists.`);
  await settle(cdp, page);
};

/** A picture of what the page shows now, as JPEG bytes. */
export const screenshot = async (cdp: Cdp, page: BrowserPage): Promise<Uint8Array> => {
  const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, page.sessionId);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** One cookie as CDP writes and reads it. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** What a browser holds of a person's sign-in to one site: its cookies, and each origin's localStorage. */
export interface LoginState {
  cookies: BrowserCookie[];
  storage: Record<string, Record<string, string>>;
}

const cookieOf = (value: Record<string, unknown>): BrowserCookie | null => {
  if (typeof value.name !== 'string' || typeof value.value !== 'string' || typeof value.domain !== 'string') return null;
  return {
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: typeof value.path === 'string' ? value.path : '/',
    ...(typeof value.expires === 'number' && value.expires > 0 ? { expires: value.expires } : {}),
    ...(value.httpOnly === true ? { httpOnly: true } : {}),
    ...(value.secure === true ? { secure: true } : {}),
    ...(typeof value.sameSite === 'string' ? { sameSite: value.sameSite } : {}),
  };
};

/** Every cookie the browser holds. */
export const browserCookies = async (cdp: Cdp): Promise<BrowserCookie[]> => {
  const { cookies } = await cdp.send<{ cookies?: Array<Record<string, unknown>> }>('Storage.getCookies');
  return (cookies ?? []).flatMap((entry) => {
    const cookie = cookieOf(entry);
    return cookie ? [cookie] : [];
  });
};

/** The localStorage of the origin the page is on. */
export const pageStorage = async (cdp: Cdp, page: BrowserPage): Promise<{ origin: string; items: Record<string, string> } | null> => {
  const value = await evaluate(cdp, page, `(() => {
    try {
      const items = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null) items[key] = localStorage.getItem(key) ?? '';
      }
      return { origin: location.origin, items };
    } catch { return null; }
  })()`).catch(() => null) as { origin?: unknown; items?: unknown } | null;
  if (!value || typeof value.origin !== 'string' || !value.origin.startsWith('http') || typeof value.items !== 'object' || value.items === null) return null;
  return { origin: value.origin, items: value.items as Record<string, string> };
};

/**
 * Puts sign-ins back into a fresh browser before its first page opens: every
 * cookie into the browser, and each origin's localStorage into the page as it
 * opens that origin, keeping what the site writes over it afterwards.
 */
export const restoreLogins = async (cdp: Cdp, page: BrowserPage, states: readonly LoginState[]): Promise<void> => {
  const cookies = states.flatMap((state) => state.cookies);
  if (cookies.length) await cdp.send('Storage.setCookies', { cookies });
  const storage: Record<string, Record<string, string>> = {};
  for (const state of states) for (const [origin, items] of Object.entries(state.storage)) storage[origin] = { ...storage[origin], ...items };
  if (!Object.keys(storage).length) return;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const storage = ${JSON.stringify(storage)};
      const items = storage[location.origin];
      if (!items) return;
      try {
        if (sessionStorage.getItem('orangeagent-restored') === '1') return;
        for (const [key, value] of Object.entries(items)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
        sessionStorage.setItem('orangeagent-restored', '1');
      } catch {}
    })()`,
  }, page.sessionId);
};

/** Whether a cookie belongs to a host, as the browser would send it there. */
const cookieDomainMatches = (domain: string, host: string): boolean => {
  const bare = domain.replace(/^\./u, '').toLowerCase();
  const target = host.toLowerCase();
  return target === bare || target.endsWith(`.${bare}`) || bare.endsWith(`.${target}`);
};

/**
 * A sign-in as the browser left it: the cookies of every domain the saved
 * sign-in held, as they are now, so a site that renewed its session keeps
 * the renewed one and one that signed out stays signed out, and the
 * localStorage of each origin read during the run.
 */
export const renewedLogin = (saved: LoginState, cookies: readonly BrowserCookie[], storage: Readonly<Record<string, Record<string, string>>>): LoginState => {
  const domains = new Set(saved.cookies.map((cookie) => cookie.domain.replace(/^\./u, '').toLowerCase()));
  const kept = cookies.filter((cookie) => [...domains].some((domain) => cookieDomainMatches(cookie.domain, domain)));
  const renewed: Record<string, Record<string, string>> = { ...saved.storage };
  for (const origin of Object.keys(saved.storage)) {
    const items = storage[origin];
    if (items) renewed[origin] = items;
  }
  return { cookies: kept, storage: renewed };
};

/** Whether a sign-in covers a host: whether any cookie it holds would be sent there. */
export const loginCovers = (state: LoginState, host: string): boolean => state.cookies.some((cookie) => cookieDomainMatches(cookie.domain, host));

/**
 * The address a person opens to use the remote browser's page themselves,
 * as when they sign in: Browser Run's Live View of that one tab.
 */
export const liveView = async (cdp: Cdp, page: BrowserPage, expiresInMs: number): Promise<string> => {
  const answer = await cdp.send<{ devtoolsFrontendUrl?: unknown }>('Cloudflare.getLiveView', { targetId: page.targetId, mode: 'tab', expiresInMs });
  if (typeof answer.devtoolsFrontendUrl !== 'string' || !answer.devtoolsFrontendUrl) throw new Error('Browser Run did not answer a Live View for the page.');
  return answer.devtoolsFrontendUrl;
};
