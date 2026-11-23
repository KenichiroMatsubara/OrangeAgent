/**
 * The lightest environment OrangeAgent lends a run's code: a Dynamic Worker, a
 * V8 isolate the Worker Loader starts for one run of JavaScript and drops
 * after it (ADR 0202). It reaches no network and holds no filesystem; it is
 * given the files it was handed as bytes by name, the Skills it was handed as
 * modules, and, when the run lends its tools, the run's tools as an RPC stub.
 *
 * The code is a module. Before it is evaluated it finds `files`, an object
 * of each file's bytes by its name, and `output(name, data)`, which hands a
 * file back as text or bytes; what it logs is its stdout and stderr. A Skill
 * named in `skills` is at `./skills/<name>/<path>`: its `.mjs` and `.js` files
 * are modules the code imports, and every other file a module of its bytes.
 * A library OrangeAgent lends (`lent.ts`) is imported by its npm name.
 * With `tools`, `env.TOOLS` and the global `tools` call the run's tools
 * (`toolbox.ts`); that stub is the isolate's only way out.
 */

import { parse, type Program } from 'acorn';

import { ranOutOfMemory, type CodeJob, type CodeResult } from './environment';
import { toArrayBuffer } from './encoding';
import { LENT, lentModulePath, lentOf, pointedAtLent } from './lent';

/** The compatibility date a Dynamic Worker runs at, the Worker's own. */
const COMPATIBILITY_DATE = '2026-07-24';

/** The CPU one run may spend. Its memory is the isolate's 128 MiB. */
export const ISOLATE_CPU_MS = 30_000;

/** The most bytes the code may hand back. */
const OUTPUT_BYTES = 32 * 1024 * 1024;

/** The most calls the code may make to the run's tools in one run. */
const TOOL_CALLS = 1000;

/** Where a Skill's directory is among the isolate's modules, beside the code. */
const SKILLS_MODULES = 'skills/';

/**
 * The module the isolate starts in: it imports the files as data modules,
 * sets the globals, and only then imports the run's code and calls its body
 * (`bodied`), so whatever the code does — a call to the run's tools at its
 * top level included — runs inside the call and is caught there. It answers
 * over RPC, the files the code wrote as their bytes.
 */
const harness = (names: readonly string[]): string => [
  `import { WorkerEntrypoint } from 'cloudflare:workers';`,
  ...names.map((_, index) => `import file${index} from './files/${index}';`),
  `const names = ${JSON.stringify(names)};`,
  `const text = (values) => values.map((value) => typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).join(' ');`,
  `const unlent = { call: async () => { throw new Error('This code was lent no tools: call code.run with tools set to true.'); }, list: async () => [] };`,
  `export default class extends WorkerEntrypoint {`,
  `  async run() {`,
  `    const stdout = []; const stderr = []; const written = []; let size = 0;`,
  `    console.log = console.info = console.debug = (...values) => stdout.push(text(values));`,
  `    console.error = console.warn = (...values) => stderr.push(text(values));`,
  `    globalThis.files = Object.fromEntries(names.map((name, index) => [name, new Uint8Array([${names.map((_, index) => `file${index}`).join(', ')}][index])]));`,
  `    globalThis.tools = this.env.TOOLS ?? unlent;`,
  `    globalThis.output = (name, data) => {`,
  `      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data.slice() : new Uint8Array(data);`,
  `      size += bytes.byteLength;`,
  `      if (size > ${OUTPUT_BYTES}) throw new Error('The files handed back exceed ${OUTPUT_BYTES / 1024 / 1024} MiB.');`,
  `      written.push({ filename: String(name), bytes });`,
  `    };`,
  `    let exitCode = 0;`,
  `    try { const task = await import('./task.js'); if (typeof task.${BODY} === 'function') await task.${BODY}(); } catch (error) { exitCode = 1; stderr.push(error && error.stack ? String(error.stack) : String(error)); }`,
  `    return { exitCode, stdout: stdout.join('\\n'), stderr: stderr.join('\\n'), files: written };`,
  `  }`,
  `}`,
].join('\n');

/** What the run's code is wrapped in, which the harness calls. */
const BODY = '__orangeagentRun';

/**
 * The run's code as a module whose body is a function the harness calls.
 * The runtime refuses I/O — an RPC to the run's tools among it — while a
 * module is evaluated, even one imported inside a call, so the code's
 * statements but its imports are moved into a function, keeping each on its
 * line, one line down. Code that exports anything, or that does not parse,
 * is run as it was written.
 */
export const bodied = (code: string): string => {
  let program: Program;
  try {
    program = parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch {
    return code;
  }
  if (program.body.some((node) => node.type.startsWith('Export'))) return code;
  const imports = program.body.filter((node) => node.type === 'ImportDeclaration');
  let rest = code;
  for (const node of [...imports].reverse()) rest = `${rest.slice(0, node.start)}${rest.slice(node.start, node.end).replace(/[^\n]/gu, ' ')}${rest.slice(node.end)}`;
  const head = imports.map((node) => code.slice(node.start, node.end).replace(/\r?\n/gu, ' ')).join(' ');
  return `${head}${head ? ' ' : ''}export async function ${BODY}() {\n${rest}\n}\n`;
};

/** A file of a Skill as the isolate's module: a script as the module it is, its lent libraries pointed at, any other file as its bytes. */
const moduleOf = (path: string, bytes: Uint8Array): WorkerLoaderModule =>
  /\.m?js$/u.test(path) ? { js: pointedAtLent(new TextDecoder().decode(bytes), path) } : { data: toArrayBuffer(bytes) };

/** The lent libraries the code and its Skills import, each as a module at `lent/<name>.js`. */
const lentModules = (job: CodeJob): Record<string, WorkerLoaderModule> =>
  Object.fromEntries(lentOf(job.code, job.placed).map((name) => [lentModulePath(name), { js: LENT[name] ?? '' }]));

/** Each file placed under `/skills/<name>/`, as a module at `skills/<name>/<path>`. */
const skillModules = (job: CodeJob): Record<string, WorkerLoaderModule> => Object.fromEntries((job.placed ?? []).flatMap((file) => {
  const path = file.path.replace(/^\/+/u, '');
  return path.startsWith(SKILLS_MODULES) ? [[path, moduleOf(path, file.bytes)]] : [];
}));

/** What a Dynamic Worker that reached its own limits says, which a container need not. */
const ISOLATE_LIMIT = /exceeded (its )?(CPU|memory)|Worker exceeded|resource limits/iu;

/** What the harness answers. */
interface Ran {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  files?: Array<{ filename: string; bytes: Uint8Array }>;
}

/** Runs the job in a Dynamic Worker; `tools` is the stub of the run's tools, when the run lends them. */
export const runInIsolate = async (loader: WorkerLoader, job: CodeJob, tools?: Fetcher): Promise<CodeResult> => {
  const names = job.files.map((file) => file.filename);
  try {
    const worker = loader.load({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: 'main.js',
      modules: {
        ...skillModules(job),
        ...lentModules(job),
        'main.js': harness(names),
        'task.js': bodied(pointedAtLent(job.code, 'task.js')),
        ...Object.fromEntries(job.files.map((file, index) => [`files/${index}`, { data: toArrayBuffer(file.bytes) }])),
      },
      ...(tools ? { env: { TOOLS: tools } } : {}),
      // No fetch leaves the isolate; its one way out is the run's tools, when they are lent.
      globalOutbound: null,
      limits: { cpuMs: ISOLATE_CPU_MS, subRequests: tools ? TOOL_CALLS : 0 },
    });
    const entrypoint = worker.getEntrypoint() as unknown as { run(): Promise<Ran> };
    const body = await entrypoint.run();
    const stderr = body.stderr ?? '';
    const exitCode = body.exitCode ?? 1;
    return {
      exitCode,
      stdout: body.stdout ?? '',
      stderr,
      files: (body.files ?? []).map((file) => ({ filename: file.filename, bytes: new Uint8Array(file.bytes) })),
      outOfMemory: exitCode !== 0 && (ranOutOfMemory(exitCode, stderr) || ISOLATE_LIMIT.test(stderr)),
    };
  } catch (error) {
    // An isolate that ran past its memory or CPU is stopped by the runtime, which throws here instead of answering.
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: '', stderr: message, files: [], outOfMemory: ranOutOfMemory(1, message) || ISOLATE_LIMIT.test(message) };
  }
};
