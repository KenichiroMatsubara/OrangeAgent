/**
 * What a Vite build needs to bundle the chat: the copied sources' own import aliases, applied
 * only to files inside this package, the Japanese catalog cut to what the copy still says
 * (below), and Tailwind, whose output chat.css scopes to `.t3chat`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import type { Plugin, PluginOption } from 'vite';


const source = path.join(import.meta.dirname, 'src');

/** `~/x` is the copy of t3code's web app and `@t3tools/<package>/x` one of its packages. */
const target = (specifier: string): string | null => {
  if (specifier.startsWith('~/')) return path.join(source, 'web', specifier.slice(2));
  if (specifier.startsWith('@t3tools/')) return path.join(source, specifier.slice('@t3tools/'.length));
  return null;
};

const aliases = (): Plugin => ({
  name: 'orangeagent-t3chat-aliases',
  enforce: 'pre',
  // Web workers are bundled apart from the page, with their own plugins.
  config: () => ({ worker: { format: 'es', plugins: () => [aliases()] } }),
  async resolveId(specifier, importer, options) {
    if (!importer?.startsWith(source)) return null;
    const file = target(specifier);
    if (file === null) return null;
    return this.resolve(file, importer, { ...options, skipSelf: true });
  },
});

/*
 * The Japanese catalog the chat ships: t3code's whole catalog holds about ten thousand entries,
 * most of them for the parts of t3code that were not copied (git, terminals, settings, providers).
 * An entry is keyed by a hash of its English source text, which `en.json` holds under the same key,
 * so an entry is kept when every piece of its English text is still written somewhere in the copied
 * sources — as a `msg()` string, a `<T>` child, or any other literal — and dropped otherwise. A
 * string the sources hold is never dropped; an entry kept that no screen asks for costs only bytes.
 */
type Catalog = Readonly<Record<string, unknown>>;

const whitespace = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The pieces of English text one entry holds: the string itself, or each text child of its JSX. */
export const fragmentsOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(fragmentsOf);
  if (value !== null && typeof value === 'object' && 'c' in value) return fragmentsOf((value as { readonly c: unknown }).c);
  return [];
};

const ENTITIES: Readonly<Record<string, string>> = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };

/** JSX text as React reads it: its entities decoded. */
const decodeEntities = (text: string): string => text
  .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&([a-z]+);/gu, (match, name: string) => ENTITIES[name] ?? match);

/** Every string literal with an escape in it, as the string it stands for. */
const escapedLiterals = (code: string): string[] => {
  const literals: string[] = [];
  for (const match of code.matchAll(/"((?:[^"\\\n]|\\.)*\\(?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*\\(?:[^'\\\n]|\\.)*)'/gu)) {
    const body = match[1] ?? match[2] ?? '';
    try {
      literals.push(JSON.parse(`"${body.replace(/\\'/gu, "'").replace(/(?<!\\)"/gu, '\\"')}"`) as string);
    } catch {
      // A literal JSON cannot read, such as one with \x escapes, is matched as written.
    }
  }
  return literals;
};

/** Every source file of the copy, tests and catalogs left out. */
const sourceFiles = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const file = path.join(directory, name);
  if (statSync(file).isDirectory()) return name === 'translations' ? [] : sourceFiles(file);
  return /\.(?:ts|tsx)$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [file] : [];
});

/** All the text the copied sources hold, each run of whitespace one space, as an entry's pieces are compared with it. */
export const sourceText = (directory: string): string => sourceFiles(directory)
  .map((file) => {
    const code = readFileSync(file, 'utf8');
    return `${whitespace(decodeEntities(code))}\n${whitespace(escapedLiterals(code).join('\n'))}`;
  })
  .join('\n');

/**
 * Which of `patterns` occur in `text`, found in one pass over it (Aho–Corasick): the copy's sources
 * are megabytes and the catalog's pieces number thousands, which one search apiece makes slow.
 */
export const occurring = (text: string, patterns: Iterable<string>): Set<string> => {
  const children: Array<Map<number, number>> = [new Map()];
  const fail: number[] = [0];
  const ends: string[][] = [[]];
  for (const pattern of new Set(patterns)) {
    if (pattern === '') continue;
    let node = 0;
    for (let index = 0; index < pattern.length; index += 1) {
      const code = pattern.charCodeAt(index);
      let next = children[node]?.get(code);
      if (next === undefined) {
        next = children.length;
        children.push(new Map());
        fail.push(0);
        ends.push([]);
        children[node]?.set(code, next);
      }
      node = next;
    }
    ends[node]?.push(pattern);
  }
  // Breadth first, so each node's fallback is shallower and already linked.
  const queue: number[] = [...(children[0]?.values() ?? [])];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] ?? 0;
    for (const [code, child] of children[node] ?? []) {
      let fallback = fail[node] ?? 0;
      while (fallback !== 0 && !children[fallback]?.has(code)) fallback = fail[fallback] ?? 0;
      const target = children[fallback]?.get(code);
      fail[child] = target !== undefined && target !== child ? target : 0;
      queue.push(child);
    }
  }
  const found = new Set<string>();
  const seen = new Set<number>();
  let node = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    while (node !== 0 && !children[node]?.has(code)) node = fail[node] ?? 0;
    node = children[node]?.get(code) ?? 0;
    // Each node's matches, and those of the nodes it falls back to, are reported once.
    for (let match = node; match !== 0 && !seen.has(match); match = fail[match] ?? 0) {
      seen.add(match);
      for (const pattern of ends[match] ?? []) found.add(pattern);
    }
  }
  return found;
};

/** One piece of an entry as the sources may write it: as it is, or with ICU's doubled apostrophe read as one. */
const variants = (fragment: string): string[] => {
  const piece = whitespace(fragment);
  return piece === '' ? [] : [piece, piece.replace(/''/gu, "'")];
};

/** The entries of `target` whose English source, in `english`, the sources still write. */
export const trimCatalog = (target: Catalog, english: Catalog, text: string): Record<string, unknown> => {
  const pieces = (key: string): string[][] => fragmentsOf(english[key]).map(variants).filter((options) => options.length > 0);
  const found = occurring(text, Object.keys(target).flatMap((key) => pieces(key).flat()));
  return Object.fromEntries(Object.entries(target).filter(([key]) =>
    english[key] === undefined || pieces(key).every((options) => options.some((option) => found.has(option)))));
};

const translations = path.join(source, 'web', 'i18n', 'translations');

/** Ships only the Japanese entries whose English text the copied sources still hold. */
const catalog = (): Plugin => {
  let trimmed: string | null = null;
  return {
    name: 'orangeagent-t3chat-catalog',
    // Before Vite's JSON plugin, which reads the text this returns.
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== path.join(translations, 'ja.json')) return null;
      trimmed ??= JSON.stringify(trimCatalog(
        JSON.parse(code) as Record<string, unknown>,
        JSON.parse(readFileSync(path.join(translations, 'en.json'), 'utf8')) as Record<string, unknown>,
        sourceText(source),
      ));
      return { code: trimmed, map: null };
    },
  };
};

export const t3chat = (): PluginOption[] => [aliases(), catalog(), tailwindcss()];

/** The aliases alone, for a build of the Worker's code or its tests, which import `./wire` and no styles. */
export const t3chatAliases = (): Plugin => aliases();
