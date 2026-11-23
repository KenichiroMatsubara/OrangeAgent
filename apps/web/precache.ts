/**
 * Builds the Service Worker (`src/sw.ts`) as `/sw.js` beside the page, and
 * hands it the release it serves: a version that changes whenever any built
 * file does, and the files it fetches when it is installed — the app shell
 * (the page at `/`, the entry and every chunk and stylesheet it loads at once, and
 * the public icons and manifest) and Operator Chat's lazy chunk with
 * everything that chunk loads at once. Chunks loaded only on demand (syntax
 * highlighting for one language, a picture converter) are kept when first
 * used instead.
 *
 * The worker is built on its own, once the page's bundle is known, as one
 * classic script that imports nothing, so every browser runs it without
 * module Service Worker support and it shares no chunk with the page.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { build, type Plugin, type ResolvedConfig } from 'vite';
import type { OutputBundle, OutputChunk, RollupOutput } from 'rollup';

import type { Release } from './src/cache';


/** What the worker's source names in place of its release, defined once the bundle is known. */
const RELEASE_PLACEHOLDER = '__ORANGEAGENT_RELEASE__';

/** The worker's source, and the file it is served as. */
const WORKER_SOURCE = 'src/sw.ts';
const WORKER_FILE = 'sw.js';

/**
 * Modules whose chunks, with what each loads at once, are fetched when the
 * worker is installed: Operator Chat, and its Japanese words, which it
 * always loads.
 */
const LAZY_MODULES = ['packages/t3chat/src/chat/surface.tsx', 'packages/t3chat/src/web/i18n/translations/ja.json'];

const chunks = (bundle: OutputBundle): OutputChunk[] =>
  Object.values(bundle).filter((output): output is OutputChunk => output.type === 'chunk');

/** A chunk with every chunk and stylesheet it imports statically, as page addresses. */
const closure = (bundle: OutputBundle, start: OutputChunk): string[] => {
  const seen = new Set<string>();
  const files: string[] = [];
  const visit = (fileName: string): void => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    files.push(`/${fileName}`);
    const output = bundle[fileName];
    if (output?.type !== 'chunk') return;
    for (const css of output.viteMetadata?.importedCss ?? []) visit(css);
    for (const asset of output.viteMetadata?.importedAssets ?? []) visit(asset);
    for (const imported of output.imports) visit(imported);
  };
  visit(start.fileName);
  return files;
};

/** The files of the public folder, which Vite copies beside the page as they are. */
const publicFiles = (config: ResolvedConfig): string[] => {
  if (!config.publicDir) return [];
  try {
    return readdirSync(config.publicDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `/${entry.name}`);
  } catch {
    return [];
  }
};

/** The release of a bundle: what to precache, and a version that changes when any built file does. */
export const releaseOf = (bundle: OutputBundle, extra: readonly string[]): Release => {
  const all = chunks(bundle);
  const entries = all.filter((chunk) => chunk.isEntry);
  // A chunk is found by the modules it holds: a dynamic entry that re-exports its module names no facade.
  const lazy = all.filter((chunk) => chunk.moduleIds.some((id) => LAZY_MODULES.some((module) => id.split(path.sep).join('/').endsWith(module))));
  const precache = [...new Set(['/', ...extra, ...[...entries, ...lazy].flatMap((chunk) => closure(bundle, chunk))])];
  const html = bundle['index.html'];
  const hash = createHash('sha256');
  for (const name of Object.keys(bundle).sort()) hash.update(`${name}\n`);
  if (html?.type === 'asset') hash.update(typeof html.source === 'string' ? html.source : Buffer.from(html.source));
  for (const file of extra) hash.update(`${file}\n`);
  return { version: hash.digest('base64url').slice(0, 16), precache };
};

/** The worker as one classic script, its release written into it. */
const workerOf = async (root: string, release: Release): Promise<string> => {
  const output = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: false,
    define: { [RELEASE_PLACEHOLDER]: JSON.stringify(release) },
    build: {
      write: false,
      emptyOutDir: false,
      minify: true,
      target: 'es2022',
      lib: { entry: path.join(root, WORKER_SOURCE), formats: ['iife'], name: 'orangeagent', fileName: () => WORKER_FILE },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }) as RollupOutput | RollupOutput[];
  const [first] = Array.isArray(output) ? output : [output];
  const chunk = first?.output.find((entry): entry is OutputChunk => entry.type === 'chunk');
  if (!chunk) throw new Error('The Service Worker was not built.');
  return chunk.code;
};

export const precache = (): Plugin => {
  let config: ResolvedConfig | null = null;
  return {
    name: 'orangeagent-precache',
    apply: 'build',
    enforce: 'post',
    configResolved: (resolved) => {
      config = resolved;
    },
    async generateBundle(_options, bundle) {
      if (!config) return;
      const release = releaseOf(bundle, publicFiles(config));
      this.emitFile({ type: 'asset', fileName: WORKER_FILE, source: await workerOf(config.root, release) });
      const size = release.precache.reduce((total, file) => {
        const output = bundle[file.slice(1)];
        if (!output) return total;
        return total + (output.type === 'chunk' ? output.code.length : typeof output.source === 'string' ? output.source.length : output.source.byteLength);
      }, 0);
      this.info(`Service Worker release ${release.version}: ${release.precache.length} files, ${(size / 1024 / 1024).toFixed(1)} MB precached`);
    },
  };
};
