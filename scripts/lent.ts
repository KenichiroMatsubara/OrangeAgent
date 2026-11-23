/**
 * Bundles each library a run's JavaScript is lent (`apps/worker/src/lent.ts`)
 * into one dependency-free ES module under `apps/worker/lent/`, at the version
 * `apps/worker/package.json` pins, with its licence at its head. Run it after
 * changing a version: `npm run lent`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/** Each lent library: the name the code imports it by, and the file it is bundled into. */
export const LENT_LIBRARIES: ReadonlyArray<{ name: string; file: string; license: string }> = [
  { name: 'exceljs', file: 'exceljs.mjs', license: 'LICENSE' },
  { name: 'docx', file: 'docx.mjs', license: 'LICENSE' },
  { name: 'pptxgenjs', file: 'pptxgenjs.mjs', license: 'LICENSE' },
  { name: 'pdf-lib', file: 'pdf-lib.mjs', license: 'LICENSE.md' },
  { name: 'fflate', file: 'fflate.mjs', license: 'LICENSE' },
  { name: '@xmldom/xmldom', file: 'xmldom.mjs', license: 'LICENSE' },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(root, 'apps/worker');
/** Where npm installed the package: the Worker's own node_modules, or the workspace's it was hoisted to. */
const packageDirectory = (name: string): string => [join(worker, 'node_modules', name), join(root, 'node_modules', name)].find((path) => existsSync(join(path, 'package.json'))) ?? join(root, 'node_modules', name);

/** The comment a bundle starts with: what it is, at which version, and its licence in full. */
export const bundleHead = (name: string, version: string, license: string): string =>
  `/*! ${name}@${version}, bundled by scripts/lent.ts for the code a run's Dynamic Worker runs.\n\n${license.trim().replaceAll('*/', '* /')}\n*/\n`;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/**
 * The module a library is bundled from: its default export, and each name it
 * exports as node reads it. A CommonJS library has no named exports of its
 * own to bundle, so each is written out from what it holds.
 */
const entryOf = async (name: string): Promise<string> => {
  const loaded = await import(name) as Record<string, unknown>;
  const names = [...new Set([...Object.keys(loaded), ...Object.keys((loaded.default ?? {}) as object)])].filter((key) => key !== 'default' && IDENTIFIER.test(key)).sort();
  return [
    `import * as namespace from '${name}';`,
    `const library = namespace.default ?? namespace;`,
    `export default library;`,
    ...names.map((key) => `export const ${key} = namespace[${JSON.stringify(key)}] ?? library[${JSON.stringify(key)}];`),
  ].join('\n');
};

const bundle = async (library: { name: string; file: string; license: string }): Promise<void> => {
  const directory = packageDirectory(library.name);
  const { version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version: string };
  const result = await build({
    stdin: {
      contents: await entryOf(library.name),
      resolveDir: worker,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'error',
  });
  const code = result.outputFiles[0]?.text ?? '';
  writeFileSync(join(worker, 'lent', library.file), bundleHead(library.name, version, readFileSync(join(directory, library.license), 'utf8')) + code);
  console.log(`${library.name}@${version} → apps/worker/lent/${library.file} (${code.length} bytes)`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const library of LENT_LIBRARIES) await bundle(library);
}
