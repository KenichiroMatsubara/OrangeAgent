/**
 * The libraries FlareChat lends a run's JavaScript, as a container's image
 * holds Python's: the code imports each by its npm name — `import ExcelJS
 * from 'exceljs'` — wherever it runs. They read and write Office files and
 * PDFs (ExcelJS, docx, PptxGenJS, pdf-lib) and the ZIP and XML an Office
 * file is made of (fflate, xmldom). Each is one dependency-free module under
 * `apps/worker/lent/`, bundled by `scripts/lent.ts` at the version
 * `package.json` pins.
 *
 * A run is lent only the libraries its code, or a Skill script it was
 * handed, imports at its top level, so a run that imports none carries none.
 */

import { parse, type Program } from 'acorn';

import DOCX from '../lent/docx.mjs';
import EXCELJS from '../lent/exceljs.mjs';
import FFLATE from '../lent/fflate.mjs';
import PDF_LIB from '../lent/pdf-lib.mjs';
import PPTXGENJS from '../lent/pptxgenjs.mjs';
import XMLDOM from '../lent/xmldom.mjs';

/** Each lent library's source, by the name the code imports it by. */
export const LENT: Readonly<Record<string, string>> = {
  exceljs: EXCELJS,
  docx: DOCX,
  pptxgenjs: PPTXGENJS,
  'pdf-lib': PDF_LIB,
  fflate: FFLATE,
  '@xmldom/xmldom': XMLDOM,
};

/** The names the code may import, as code.run's description lists them. */
export const LENT_NAMES: readonly string[] = Object.keys(LENT);

const isLent = (name: string): boolean => Object.hasOwn(LENT, name);

/** Where a specifier stands in the code: the string literal of an import, an export-from, or an `import()` of a literal. */
interface Specifier {
  start: number;
  end: number;
  value: string;
}

const parsed = (code: string): Program | null => {
  try {
    return parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch {
    return null;
  }
};

/** The top-level specifiers of a module that name a lent library. */
const lentSpecifiers = (program: Program): Specifier[] => program.body.flatMap((node) => {
  const source = node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration' ? node.source : null;
  if (!source || typeof source.value !== 'string' || !isLent(source.value)) return [];
  return [{ start: source.start, end: source.end, value: source.value }];
});

/** The lent libraries the module imports at its top level, or none when it does not parse. */
export const lentIn = (code: string): string[] => {
  const program = parsed(code);
  return program ? [...new Set(lentSpecifiers(program).map((specifier) => specifier.value))] : [];
};

const isScript = (path: string): boolean => /\.m?js$/u.test(path);

/** The lent libraries a run's code imports, or a Skill script it was handed does. */
export const lentOf = (code: string, placed: ReadonlyArray<{ path: string; bytes: Uint8Array }> = []): string[] => {
  const scripts = placed.filter((file) => isScript(file.path)).map((file) => new TextDecoder().decode(file.bytes));
  return [...new Set([code, ...scripts].flatMap(lentIn))];
};

/** The bytes the named libraries add to a run, which its memory estimate counts. */
export const lentBytes = (names: readonly string[]): number =>
  names.reduce((sum, name) => sum + new TextEncoder().encode(LENT[name] ?? '').byteLength, 0);

/** Where a lent library is among a Dynamic Worker's modules. */
export const lentModulePath = (name: string): string => `lent/${name}.js`;

/**
 * The module with each import of a lent library pointed at its path among the
 * Dynamic Worker's modules, relative to the module's own path: the runtime
 * resolves a bare specifier beside the module that imports it, not at the
 * root. Everything else is kept as written, and a module that does not parse
 * is returned as it was.
 */
export const pointedAtLent = (code: string, path: string): string => {
  const program = parsed(code);
  if (!program) return code;
  const depth = path.split('/').length - 1;
  const up = depth === 0 ? './' : '../'.repeat(depth);
  let pointed = code;
  for (const specifier of lentSpecifiers(program).reverse()) {
    pointed = `${pointed.slice(0, specifier.start)}${JSON.stringify(`${up}${lentModulePath(specifier.value)}`)}${pointed.slice(specifier.end)}`;
  }
  return pointed;
};
