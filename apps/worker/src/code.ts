/**
 * `code.run`: the environment FlareChat lends every run to run code in
 * (ADR 0202, 0203). The run names the code, its language, and
 * the files it holds to place beside it; the Worker estimates what the work
 * needs, runs it on the lightest environment that fits (`environment.ts`),
 * and hands back what it printed and the files it wrote, as files the run
 * then holds, and, in a conversation, as files the answer wrote.
 */

import { LENT_NAMES } from './lent';
import { CODE_LANGUAGES, runCode, type CodeJob, type CodeLanguage, type CodeRunner, type Tier } from './environment';
import { runInIsolate } from './isolate';
import type { RunAccess } from './rendezvous';
import { skillDirectory, type SkillStore } from './skills';
import { accountOfPath, lentTools } from './toolbox';
import { FileAnswer, type GeneratedFile, type TurnFile } from './turns';
import type { Bindings } from './types';

/** The stub of the run's tools a Dynamic Worker is given as `env.TOOLS`, when the run lends its code its tools. */
export const toolsOf = (job: CodeJob): Fetcher | undefined => {
  const accountId = job.bridge ? accountOfPath(job.bridge.path) : null;
  return job.bridge && accountId ? lentTools({ accountId, token: job.bridge.token }) : undefined;
};

/** The environments this Worker binds, or null when it binds none, as in local development. */
export const codeRunner = (env: Pick<Bindings, 'LOADER' | 'WORKBENCH_LITE' | 'WORKBENCH_BASIC' | 'WORKBENCH_STANDARD_1' | 'WORKBENCH_STANDARD_4'>): CodeRunner | null => {
  const { LOADER, WORKBENCH_LITE, WORKBENCH_BASIC, WORKBENCH_STANDARD_1, WORKBENCH_STANDARD_4 } = env;
  if (!LOADER || !WORKBENCH_LITE || !WORKBENCH_BASIC || !WORKBENCH_STANDARD_1 || !WORKBENCH_STANDARD_4) return null;
  return async (tier: Tier, job) => {
    switch (tier.name) {
      case 'isolate':
        return runInIsolate(LOADER, job, toolsOf(job));
      case 'lite':
        return WORKBENCH_LITE.get(WORKBENCH_LITE.newUniqueId()).run(job);
      case 'basic':
        return WORKBENCH_BASIC.get(WORKBENCH_BASIC.newUniqueId()).run(job);
      case 'standard-1':
        return WORKBENCH_STANDARD_1.get(WORKBENCH_STANDARD_1.newUniqueId()).run(job);
      case 'standard-4':
        return WORKBENCH_STANDARD_4.get(WORKBENCH_STANDARD_4.newUniqueId()).run(job);
    }
  };
};

/** What a run lends `code.run`: where its code runs, and the files it holds by name. */
export interface CodeContext {
  run: CodeRunner;
  /** The latest file the run holds under this name, or null when it holds none. */
  find(filename: string): Promise<TurnFile | null>;
  /** Keeps a file the code wrote as one the answer wrote, in a conversation that keeps them. */
  keep?: (file: GeneratedFile) => Promise<unknown>;
  /** The Account's Skills, whose directories the code may be given at `skills/<name>/`. */
  skills?: SkillStore;
}

/** Where a Skill's directory is placed in a container, the path Agent Skills give it; a Dynamic Worker holds it at `./skills/<name>/`. */
export const SKILLS_ROOT = '/skills';

/** The media type a written file is kept under, by its extension. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

export const mediaTypeOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return (dot > 0 ? MEDIA_TYPES[filename.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream';
};

const language = (value: unknown): CodeLanguage | null =>
  CODE_LANGUAGES.find((entry) => entry === value) ?? null;

export const performCodeRun = async (context: CodeContext, arguments_: Record<string, unknown>, access?: () => Promise<RunAccess>): Promise<unknown> => {
  const chosen = language(arguments_.language);
  if (!chosen) return { isError: true, message: `code.run requires language, one of ${CODE_LANGUAGES.join(', ')}.` };
  const code = typeof arguments_.code === 'string' ? arguments_.code : '';
  if (!code.trim()) return { isError: true, message: 'code.run requires code.' };
  const names = Array.isArray(arguments_.files) ? arguments_.files.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : [];
  const files: Array<{ filename: string; bytes: Uint8Array }> = [];
  for (const name of names) {
    const file = await context.find(name.trim());
    if (!file) return { isError: true, message: `${name} is not a file you hold in this run. Name a file a tool handed you, one the member sent, or one code.run wrote, exactly as it was named.` };
    files.push({ filename: file.filename.split('/').at(-1) ?? file.filename, bytes: file.bytes });
  }
  const skillNames = Array.isArray(arguments_.skills) ? [...new Set(arguments_.skills.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map((name) => name.trim()))] : [];
  const placed: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const name of skillNames) {
    const directory = context.skills ? await skillDirectory(context.skills, name) : null;
    if (!directory) return { isError: true, message: `No Skill is named ${JSON.stringify(name)}. Name a Skill as the list of Skills names it.` };
    placed.push(...directory.files.map((file) => ({ path: `${SKILLS_ROOT}/${directory.name}/${file.path}`, bytes: file.bytes })));
  }
  let bridge: { path: string; token: string } | undefined;
  if (arguments_.tools === true) {
    if (!access) return { isError: true, message: 'This run lends its code no tools: it is offered no Run Token. Call your tools yourself.' };
    const opened = await access();
    bridge = { path: new URL(opened.url).pathname, token: opened.token };
  }
  const answer = await runCode({ language: chosen, code, files, ...(placed.length ? { placed } : {}), ...(bridge ? { bridge } : {}) }, context.run);
  if ('refused' in answer) return { isError: true, message: answer.refused };
  const written: TurnFile[] = answer.files.map((file) => ({ filename: file.filename, mediaType: mediaTypeOf(file.filename), bytes: file.bytes }));
  if (context.keep) for (const file of written) await context.keep({ filename: file.filename, mediaType: file.mediaType, bytes: file.bytes });
  const view = {
    environment: answer.environment,
    memoryMiB: answer.memoryMiB,
    estimateMiB: answer.estimateMiB,
    ...(answer.retriedFrom ? { retriedFrom: answer.retriedFrom, note: `It ran out of memory in ${answer.retriedFrom} and was run again here.` } : {}),
    exitCode: answer.exitCode,
    stdout: answer.stdout,
    stderr: answer.stderr,
    files: written.map((file) => ({ filename: file.filename, size: file.bytes.byteLength })),
    ...(written.length ? { filesNote: context.keep ? 'These files are offered to the member below your answer, and you hold them by these names for later calls.' : 'You hold these files by these names for later calls.' } : {}),
  };
  return written.length ? new FileAnswer(view, written) : view;
};

/** What the model is told `code.run` is, in its description. */
export const CODE_RUN_DESCRIPTION = [
  'Run code with no network access: compute, parse, read files you hold, and make files.',
  'Write JavaScript. Use Python 3 (pandas, openpyxl, python-docx, python-pptx, reportlab, matplotlib, pypdf) or the shell only for a one-off computation JavaScript cannot do here, such as a matplotlib chart, never for a Skill\'s script. Japanese fonts are installed.',
  'JavaScript is an ES module (top-level await and import, no require()): files maps each placed file\'s name to its bytes (Uint8Array), output(name, data) hands a file back, console.log is stdout.',
  `JavaScript imports, with no install: ${LENT_NAMES.join(', ')}. For an Office file or a PDF follow the Skill office-files: make one with exceljs, docx, pptxgenjs, or pdf-lib; fill a form or template by unzipping it with fflate, editing its XML with @xmldom/xmldom, and zipping it back, never by reopening and resaving it with a library, which may drop its drawings.`,
  'Skills you name are placed whole: at ./skills/<name>/ in JavaScript, where its .mjs scripts are imported as modules (import { Tasks } from \'./skills/task-management/scripts/tasks.mjs\'), and at /skills/<name>/ in Python or the shell.',
  'With tools true, JavaScript calls your tools with await tools.call(name, arguments); Python or the shell reach your MCP Server at FLARECHAT_MCP_URL with FLARECHAT_RUN_TOKEN. Each such call is yours.',
  'In Python or the shell, placed files are in the working directory; write each file to hand back at the top of out/ (out/report.xlsx).',
  'Each call starts empty. Python and the shell stop after 300 seconds; JavaScript after 30 seconds of CPU, then it runs again in a container. Memory is sized for you and raised once if it runs out.',
].join(' ');
