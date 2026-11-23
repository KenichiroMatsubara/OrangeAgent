/**
 * Running one job in a Cloudflare container OrangeAgent started for it
 * (ADR 0202): the files are written into its working directory, the code is
 * run there with a time limit, and every file it left at the top of `out/`
 * is read back. The container reaches no network but OrangeAgent itself, when
 * the run lends it its Run Token, and its Durable Object
 * (`workbench.ts`) destroys it once the job ends, so nothing outlives it.
 *
 * The code runs through the container's own `exec`, under `timeout`; its
 * files go in and come back through Cloudflare's Sandbox SDK (`Files` of
 * `@cloudflare/sandbox`), which streams their bytes through the
 * `sandbox-shim` the image copies from the SDK's image of the same version.
 */

import type { Files } from '@cloudflare/sandbox';

import { ranOutOfMemory, type CodeJob, type CodeLanguage, type CodeResult } from './environment';
import { LENT, lentOf } from './lent';

export const WORKDIR = '/workspace';

/** The host a container reaches the run's MCP Server at, its only way out (ADR 0203). */
export const BRIDGE_HOST = 'flarechat.internal';
export const OUTPUT_DIR = `${WORKDIR}/out`;

/** How long the code may run, in seconds. `timeout` ends it with status 124. */
export const CONTAINER_SECONDS = 300;

/** The most files, and bytes, read back from `out/`. */
const OUTPUT_FILES = 20;
const OUTPUT_BYTES = 64 * 1024 * 1024;

type Exec = Pick<Container, 'exec'>;

/** The file operations of the Sandbox SDK a job uses; `workbench.ts` hands it `new Files(container)`. */
export type Workspace = Pick<Files, 'mkdir' | 'writeFile' | 'readFile' | 'readDirectory' | 'stat'>;

const decoder = new TextDecoder();

/** The module node imports before JavaScript's own, so the code finds what it finds in a Dynamic Worker. */
const PRELUDE = '.orangeagent.mjs';

const SCRIPT: Readonly<Record<CodeLanguage, { file: string; command: string[] }>> = {
  javascript: { file: '.main.mjs', command: ['node', '--import', `./${PRELUDE}`] },
  python: { file: '.main.py', command: ['python3'] },
  shell: { file: '.main.sh', command: ['bash'] },
};

/**
 * What JavaScript finds in a container as it does in a Dynamic Worker
 * (`isolate.ts`): `files` and `output(name, data)`, a Skill's directory at
 * `./skills/<name>/`, `tools`, which calls the run's tools through its MCP
 * Server at `flarechat.internal`, and each library it imports that OrangeAgent
 * lends (`lent.ts`), as a package in `/node_modules`, which node finds from
 * the working directory and from `/skills` alike.
 */
export const prelude = (names: readonly string[]): string => [
  `import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';`,
  `const names = ${JSON.stringify(names)};`,
  `globalThis.files = Object.fromEntries(names.map((name) => [name, new Uint8Array(readFileSync(name))]));`,
  `globalThis.output = (name, data) => writeFileSync('out/' + String(name).split('/').at(-1), typeof data === 'string' ? data : new Uint8Array(data));`,
  `if (existsSync('/skills') && !existsSync('skills')) symlinkSync('/skills', 'skills');`,
  `const url = process.env.FLARECHAT_MCP_URL; const token = process.env.FLARECHAT_RUN_TOKEN; let id = 0;`,
  `const answer = (text) => { try { return JSON.parse(text); } catch { return text; } };`,
  `const rpc = async (method, params) => {`,
  `  id += 1;`,
  `  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });`,
  `  const reply = await response.json().catch(() => null);`,
  `  if (!response.ok || reply?.error) return { isError: true, message: reply?.error?.message ?? 'OrangeAgent refused with ' + response.status + '.' };`,
  `  return reply.result;`,
  `};`,
  `globalThis.tools = url && token ? {`,
  `  call: async (name, args = {}) => {`,
  `    const result = await rpc('tools/call', { name, arguments: args });`,
  `    if (result?.isError && !result.content) return result;`,
  `    const text = (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('');`,
  `    return result?.isError ? { isError: true, message: text } : answer(text);`,
  `  },`,
  `  list: async () => ((await rpc('tools/list', {}))?.tools ?? []).map(({ name, description }) => ({ name, description })),`,
  `} : { call: async () => { throw new Error('This code was lent no tools: call code.run with tools set to true.'); }, list: async () => [] };`,
].join('\n');

/** A name a file may be placed under: its last segment, never a hidden or parent name. */
export const placedName = (filename: string): string | null => {
  const name = filename.split('/').at(-1)?.trim() ?? '';
  if (!name || name === '.' || name === '..' || name.startsWith('.') || name.includes('\0')) return null;
  return name;
};

/** Writes a file, making the directories above it first, each once per job. */
const writeFile = async (files: Workspace, made: Set<string>, path: string, bytes: Uint8Array): Promise<void> => {
  const directory = path.slice(0, path.lastIndexOf('/')) || '/';
  if (!made.has(directory)) {
    await files.mkdir(directory, { recursive: true });
    made.add(directory);
  }
  await files.writeFile(path, bytes);
};

/** The files at the top of `out/`, smallest first, within the limits on how many and how much. */
const outputs = async (files: Workspace): Promise<Array<{ filename: string; size: number }>> => {
  const entries = await files.readDirectory(OUTPUT_DIR).catch(() => []);
  const listed: Array<{ filename: string; size: number }> = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const { size } = await files.stat(`${OUTPUT_DIR}/${entry.name}`);
    listed.push({ filename: entry.name, size: Number(size) });
  }
  listed.sort((left, right) => left.size - right.size);
  const kept: Array<{ filename: string; size: number }> = [];
  let total = 0;
  for (const file of listed) {
    if (kept.length >= OUTPUT_FILES || total + file.size > OUTPUT_BYTES) break;
    kept.push(file);
    total += file.size;
  }
  return kept;
};

/**
 * Waits for a container just started to take a command: exec is refused
 * until its process is up, which takes a moment after `start`.
 */
export const ready = async (container: Exec, attempts = 40, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<void> => {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const process = await container.exec(['true']);
      if ((await process.output()).exitCode === 0) return;
    } catch (error) {
      last = error;
    }
    await wait(500);
  }
  throw new Error(`The container did not start: ${last instanceof Error ? last.message : 'it took no command'}`);
};

/** A lent library as the package node imports it by its name: its source as the package's one module. */
export const lentPackage = (name: string): Array<{ path: string; bytes: Uint8Array }> => {
  const encoder = new TextEncoder();
  return [
    { path: `/node_modules/${name}/package.json`, bytes: encoder.encode(JSON.stringify({ name, type: 'module', exports: './index.mjs' })) },
    { path: `/node_modules/${name}/index.mjs`, bytes: encoder.encode(LENT[name] ?? '') },
  ];
};

export const runInContainer = async (container: Exec, files: Workspace, job: CodeJob): Promise<CodeResult> => {
  const script = SCRIPT[job.language];
  const made = new Set<string>();
  await files.mkdir(OUTPUT_DIR, { recursive: true });
  made.add(OUTPUT_DIR);
  for (const file of job.placed ?? []) await writeFile(files, made, file.path, file.bytes);
  for (const file of job.files) {
    const name = placedName(file.filename);
    if (name) await writeFile(files, made, `${WORKDIR}/${name}`, file.bytes);
  }
  if (job.language === 'javascript') {
    const names = job.files.flatMap((file) => placedName(file.filename) ?? []);
    await writeFile(files, made, `${WORKDIR}/${PRELUDE}`, new TextEncoder().encode(prelude(names)));
    for (const name of lentOf(job.code, job.placed)) {
      for (const file of lentPackage(name)) await writeFile(files, made, file.path, file.bytes);
    }
  }
  await writeFile(files, made, `${WORKDIR}/${script.file}`, new TextEncoder().encode(job.code));
  const env: Record<string, string> = job.bridge
    ? { FLARECHAT_MCP_URL: `http://${BRIDGE_HOST}${job.bridge.path}`, FLARECHAT_RUN_TOKEN: job.bridge.token }
    : {};
  const process = await container.exec(['timeout', String(CONTAINER_SECONDS), ...script.command, script.file], { cwd: WORKDIR, env });
  const { exitCode, stdout, stderr } = await process.output();
  const errors = decoder.decode(stderr);
  const written = [];
  for (const file of await outputs(files)) {
    const response = await files.readFile(`${OUTPUT_DIR}/${file.filename}`);
    written.push({ filename: file.filename, bytes: new Uint8Array(await response.arrayBuffer()) });
  }
  return {
    exitCode,
    stdout: decoder.decode(stdout),
    stderr: exitCode === 124 ? `${errors}\nThe code was stopped after ${CONTAINER_SECONDS} seconds.`.trim() : errors,
    files: written,
    outOfMemory: ranOutOfMemory(exitCode, errors),
  };
};
