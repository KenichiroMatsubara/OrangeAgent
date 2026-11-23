/**
 * Reading one page of the public web for Claude: the product fetches any URL
 * Claude names from the Worker, so Claude reads a page it has not been handed
 * by a search, such as an official page it knows the address of or a link it
 * found on a page it read. Anthropic's own web fetch opens only URLs the
 * conversation already holds, which turned away every such page.
 *
 * A page that is text is answered as its words, with its links written out so
 * Claude can follow them; a PDF or an image is handed over as the file itself.
 */

import { FileAnswer } from './turns';

export type WebTransport = (url: string, init?: RequestInit) => Promise<Response>;

interface Refusal {
  isError: true;
  message: string;
}

/** What one page reads as when it is text. */
export interface WebPage {
  url: string;
  status: number;
  contentType: string;
  title: string | null;
  text: string;
  /** Where the next part starts when the page is longer than one answer holds, or null at its end. */
  nextOffset: number | null;
}

/** How many characters of a page one answer holds; Claude reads on from `offset`. */
export const WEB_PAGE_CHARACTERS = 40_000;

/** The largest PDF or image handed over, as Claude reads a mail's attachment. */
export const MAX_WEB_FILE_BYTES = 20 * 1024 * 1024;

const TIMEOUT_MS = 20_000;

const USER_AGENT = 'Mozilla/5.0 (compatible; FlareChat/1.0)';

const refused = (message: string): Refusal => ({ isError: true, message });

/** The kinds handed over as files, as a mail's attachments are. */
const FILE_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const isTextType = (mediaType: string): boolean =>
  mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType.endsWith('+json') || mediaType.endsWith('+xml')
  || mediaType === 'application/xml' || mediaType === 'application/xhtml+xml' || mediaType === 'application/javascript' || mediaType === '';

const isHtml = (mediaType: string, body: string): boolean =>
  mediaType === 'text/html' || mediaType === 'application/xhtml+xml' || (mediaType === '' && /^\s*<(!doctype html|html)/iu.test(body));

/**
 * Hosts on the Worker's own side of the network: the machine it runs on and
 * the private ranges, which the public web never names. Only a page anyone
 * could open is read.
 */
const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)?.slice(1).map(Number);
  if (!octets) return false;
  const [a = 0, b = 0] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

/** The URL Claude named, or why it cannot be read. */
export const webUrl = (value: unknown): URL | Refusal => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return refused('web.search requires the url of the page to read.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refused(`${text} is not a URL. Name the page with its full address, starting with https://.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refused(`${text} is not a web page: only http and https URLs are read.`);
  if (url.username || url.password) return refused('A URL that carries a user name or password is not read.');
  if (isPrivateHost(url.hostname)) return refused(`${url.hostname} is not on the public web.`);
  return url;
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', yen: '¥', times: '×', divide: '÷',
};

const decodeEntities = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/giu, (whole, name: string) => {
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[name.toLowerCase()] ?? whole;
});

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
};

const absolute = (href: string, base: URL): string | null => {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

const BLOCK_TAGS = 'p|div|section|article|main|header|footer|nav|aside|ul|ol|table|tr|form|fieldset|blockquote|pre|dl|dt|dd|figure|figcaption|details|summary';

/**
 * A page's words as Claude reads them: its scripts, styles, and markup gone,
 * its headings, list items, and rows on lines of their own, and each link
 * written as Markdown with its full address so Claude can open it next.
 */
export const htmlText = (html: string, base: URL): { title: string | null; text: string } => {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1]).replace(/\s+/gu, ' ').trim() || null : null;
  const text = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|noscript|template|svg|head|iframe|canvas)\b[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/giu, (whole, inner: string) => {
      const href = attribute(whole.slice(0, whole.indexOf('>') + 1), 'href');
      const words = inner.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
      const target = href ? absolute(href, base) : null;
      if (!target) return ` ${words} `;
      return words ? ` [${words}](${target}) ` : '';
    })
    .replace(/<img\b[^>]*>/giu, (tag) => {
      const alt = attribute(tag, 'alt')?.trim();
      return alt ? ` ${alt} ` : ' ';
    })
    .replace(/<h([1-6])\b[^>]*>/giu, (_whole, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/giu, '\n\n')
    .replace(/<li\b[^>]*>/giu, '\n- ')
    .replace(/<(td|th)\b[^>]*>/giu, ' | ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'giu'), '\n')
    .replace(/<[^>]+>/gu, ' ');
  const lines = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v 　]+/gu, ' ').trim())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
  return { title, text: lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim() };
};

/** The charset a response names in its header or, for HTML, in its first bytes. */
const charsetOf = (contentType: string, bytes: Uint8Array): string => {
  const header = /charset\s*=\s*["']?([\w.:-]+)/iu.exec(contentType)?.[1];
  if (header) return header.toLowerCase();
  const head = Array.from(bytes.subarray(0, 4096), (byte) => String.fromCharCode(byte)).join('');
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/iu.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
};

const decode = (bytes: Uint8Array, charset: string): string => {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

const filenameOf = (url: URL, mediaType: string): string => {
  const last = decodeURIComponent(url.pathname.split('/').pop() ?? '').replace(/[\\/:*?"<>|]/gu, '_');
  if (last.includes('.')) return last;
  const extension = mediaType === 'application/pdf' ? 'pdf' : mediaType.split('/')[1] ?? 'bin';
  return `${last || url.hostname}.${extension}`;
};

/**
 * Reads one page of the public web: its words from `offset` on, or the file
 * itself when it is a PDF or an image. A page that answers with an error, or
 * cannot be reached, is refused with why, so Claude tries another.
 */
export const readWebPage = async (input: { url: unknown; offset?: unknown }, transport: WebTransport = (url, init) => fetch(url, init)): Promise<WebPage | FileAnswer | Refusal> => {
  const url = webUrl(input.url);
  if (!(url instanceof URL)) return url;
  const offset = typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0;
  let response: Response;
  try {
    response = await transport(url.href, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? `did not answer within ${TIMEOUT_MS / 1000} seconds` : 'could not be reached';
    return refused(`${url.href} ${reason}. Try another page.`);
  }
  const finalUrl = webUrl(response.url || url.href);
  if (!(finalUrl instanceof URL)) return refused(`${url.href} redirected away from the public web.`);
  if (!response.ok) {
    await response.body?.cancel();
    return refused(`${finalUrl.href} answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}. Try another page.`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_WEB_FILE_BYTES) {
    await response.body?.cancel();
    return refused(`${finalUrl.href} holds ${declared} bytes; at most ${MAX_WEB_FILE_BYTES} of one page are read.`);
  }
  if (!FILE_TYPES.has(mediaType) && !isTextType(mediaType)) {
    await response.body?.cancel();
    return refused(`${finalUrl.href} is a ${mediaType} file, which is not read. Only web pages, text, PDFs, and images are.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WEB_FILE_BYTES) return refused(`${finalUrl.href} holds ${bytes.byteLength} bytes; at most ${MAX_WEB_FILE_BYTES} of one page are read.`);
  if (FILE_TYPES.has(mediaType)) {
    const filename = filenameOf(finalUrl, mediaType);
    return new FileAnswer({ url: finalUrl.href, status: response.status, contentType: mediaType, file: { filename, mimeType: mediaType, size: bytes.byteLength } }, [{ filename, mediaType, bytes }]);
  }
  const body = decode(bytes, charsetOf(contentType, bytes));
  const read = isHtml(mediaType, body) ? htmlText(body, finalUrl) : { title: null, text: body.trim() };
  const end = offset + WEB_PAGE_CHARACTERS;
  return {
    url: finalUrl.href,
    status: response.status,
    contentType: mediaType,
    title: read.title,
    text: read.text.slice(offset, end),
    nextOffset: end < read.text.length ? end : null,
  };
};
