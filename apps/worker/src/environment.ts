/**
 * Where a run's model runs code: its Execution Environment.
 *
 * An AI Connection whose API runs code itself lends the model that API's own
 * environment — Anthropic's sandbox, OpenAI's code interpreter, Gemini's code
 * execution — and the model runs code there inside its own request. Every
 * other API, OpenRouter's among them, runs none, so OrangeAgent lends the model
 * one of its own (ADR 0202): `code.run`, which the Worker answers on the
 * lightest environment the work fits — a Dynamic Worker, then a Cloudflare
 * container of 256 MiB, 1 GiB, 4 GiB, or 12 GiB — chosen by the rules below
 * before the code runs, and one size larger, once, when it ran out of memory.
 *
 * Nothing here reaches the network: the environments OrangeAgent starts reach
 * none. Their one way out is OrangeAgent itself, when the run lends its code
 * its tools: a Dynamic Worker calls them through `env.TOOLS`, an RPC stub that
 * holds the run's Run Token, and a container through a request to
 * `orangeagent.internal`, which reaches the run's MCP Server; every call made
 * either way is the run's own (ADR 0199, 0203). Files go in by name and come
 * back as files; a Skill's directory goes in whole, at `./skills/<name>/` in
 * a Dynamic Worker and `/skills/<name>/` in a container.
 */

import { aiEnvironment, type AiEnvironment } from '@mail/domain';

import { lentBytes, lentOf } from './lent';

export { GEMINI_HOST, OPENAI_HOST } from '@mail/domain';

/** Whose environment a run's model runs code in, read from its AI Connection's host as its protocol is. */
export type Environment = AiEnvironment;

export const environmentOf = (baseUrl: string): Environment => aiEnvironment(baseUrl);

/** The languages `code.run` runs. JavaScript alone runs in a Dynamic Worker; Python and the shell need Linux. */
export type CodeLanguage = 'javascript' | 'python' | 'shell';

export const CODE_LANGUAGES: readonly CodeLanguage[] = ['javascript', 'python', 'shell'];

/** One size of environment OrangeAgent lends, the lightest first. */
export interface Tier {
  name: 'isolate' | 'lite' | 'basic' | 'standard-1' | 'standard-4';
  /** The memory the code may use. */
  memoryMiB: number;
  /** What a person reads it as. */
  label: string;
}

const MIB = 1024 * 1024;

/**
 * A Dynamic Worker is a V8 isolate of 128 MiB with no filesystem, so it runs
 * only JavaScript and only work that fits well inside that. Each container
 * size is one Cloudflare instance type, declared in wrangler.jsonc as its own
 * container class.
 */
export const TIERS: readonly Tier[] = [
  { name: 'isolate', memoryMiB: 128, label: 'Dynamic Worker (128 MiB)' },
  { name: 'lite', memoryMiB: 256, label: 'コンテナ lite (256 MiB)' },
  { name: 'basic', memoryMiB: 1024, label: 'コンテナ basic (1 GiB)' },
  { name: 'standard-1', memoryMiB: 4096, label: 'コンテナ standard-1 (4 GiB)' },
  { name: 'standard-4', memoryMiB: 12288, label: 'コンテナ standard-4 (12 GiB)' },
];

/** What a run's code needs before any of it runs: its language and the bytes of the files placed beside it. */
export interface Work {
  language: CodeLanguage;
  inputBytes: number;
}

/** What each runtime holds before the code reads anything, in MiB. */
const BASE_MIB: Readonly<Record<CodeLanguage, number>> = { javascript: 16, python: 160, shell: 192 };

/**
 * How many times the bytes of its files the code is taken to hold: a file
 * read whole, parsed, and written out again is held three or four times over,
 * and a table parsed into a data frame more, so six covers the usual work.
 */
const INPUT_FACTOR = 6;

/** The share of a Dynamic Worker's 128 MiB its code may be estimated to use: the runtime and the files' copies take the rest. */
const ISOLATE_SHARE_MIB = 64;

/** The memory the work is estimated to need, in MiB. */
export const estimateMiB = (work: Work): number =>
  BASE_MIB[work.language] + Math.ceil((Math.max(0, work.inputBytes) / MIB) * INPUT_FACTOR);

/**
 * The lightest environment the work fits: a Dynamic Worker for JavaScript
 * whose estimate stays well inside its isolate, the Skills and the tools it is
 * handed included, otherwise the smallest container whose memory covers the
 * estimate, or null when none does. Only Python, the shell, and work too
 * large for the isolate go to a container.
 */
export const tierFor = (work: Work): Tier | null => {
  const estimate = estimateMiB(work);
  if (work.language === 'javascript' && estimate <= ISOLATE_SHARE_MIB) return TIERS[0] ?? null;
  return TIERS.slice(1).find((tier) => tier.memoryMiB >= estimate) ?? null;
};

/** The next size up, which a run that ran out of memory is given once, or null after the largest. */
export const largerTier = (tier: Tier): Tier | null => {
  const index = TIERS.findIndex((entry) => entry.name === tier.name);
  return index < 0 ? null : TIERS[index + 1] ?? null;
};

/**
 * OpenAI's code interpreter takes its memory as one of four sizes for the
 * whole life of its container, so the same estimate names the smallest that
 * covers it; Python is what it runs.
 */
export type OpenAiMemory = '1g' | '4g' | '16g' | '64g';

const OPENAI_MEMORY: ReadonlyArray<{ limit: OpenAiMemory; memoryMiB: number }> = [
  { limit: '1g', memoryMiB: 1024 },
  { limit: '4g', memoryMiB: 4096 },
  { limit: '16g', memoryMiB: 16384 },
  { limit: '64g', memoryMiB: 65536 },
];

export const openAiMemoryFor = (inputBytes: number): OpenAiMemory => {
  const estimate = estimateMiB({ language: 'python', inputBytes });
  return OPENAI_MEMORY.find((entry) => entry.memoryMiB >= estimate)?.limit ?? '64g';
};

/** One run of code, as `code.run` is asked for it. */
export interface CodeJob {
  language: CodeLanguage;
  code: string;
  /** The files placed beside the code, by name. */
  files: ReadonlyArray<{ filename: string; bytes: Uint8Array }>;
  /** Files placed at their own absolute paths, as every file of a Skill is under `/skills/<name>/`; a Dynamic Worker holds them as modules at `skills/<name>/`. */
  placed?: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  /** The run's MCP Server and its Run Token, its code's only way out: `env.TOOLS` in a Dynamic Worker, `orangeagent.internal` in a container. */
  bridge?: { path: string; token: string };
}

/** What one run of code came to on one environment. */
export interface CodeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The files the code wrote to be handed back. */
  files: Array<{ filename: string; bytes: Uint8Array }>;
  /** Whether it stopped for want of memory, so a larger environment may run it again. */
  outOfMemory: boolean;
}

/** What runs a job on one tier. A tier this Worker binds no environment for has none. */
export type CodeRunner = (tier: Tier, job: CodeJob) => Promise<CodeResult>;

/** What a stopped run says when it ran out of memory: the kernel's kill, a runtime's own words, or the isolate's. */
const OUT_OF_MEMORY = /MemoryError|out of memory|Cannot allocate memory|heap out of memory|Allocation failed|exceeded (its )?memory|Memory limit/iu;

/** Exit status 137 is a process the kernel killed, which in a container is its memory running out. */
export const ranOutOfMemory = (exitCode: number, stderr: string): boolean => exitCode === 137 || OUT_OF_MEMORY.test(stderr);

/** The longest stdout or stderr handed back to the model, in characters. */
export const OUTPUT_LIMIT = 20_000;

export const clipped = (text: string): string =>
  text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} more characters were cut)` : text;

/** What `code.run` answers: where it ran, how much it was estimated to need, and what it came to. */
export interface CodeAnswer {
  environment: string;
  memoryMiB: number;
  estimateMiB: number;
  /** The smaller environment the code first ran in, when it ran out of memory there. */
  retriedFrom?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  files: Array<{ filename: string; bytes: Uint8Array }>;
}

/**
 * Runs a job on the lightest environment the estimate allows, and once more
 * one size up when it ran out of memory there. The estimate is never the
 * model's: it is worked out from the job alone, so the same job always starts
 * in the same place.
 */
export const runCode = async (job: CodeJob, run: CodeRunner): Promise<CodeAnswer | { refused: string }> => {
  const placedBytes = (job.placed ?? []).reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const borrowedBytes = job.language === 'javascript' ? lentBytes(lentOf(job.code, job.placed)) : 0;
  const work: Work = {
    language: job.language,
    inputBytes: job.files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + placedBytes + borrowedBytes,
  };
  const estimate = estimateMiB(work);
  const first = tierFor(work);
  if (!first) {
    return { refused: `The work is estimated to need ${estimate} MiB, more than the largest environment OrangeAgent lends (${TIERS.at(-1)?.memoryMiB ?? 0} MiB). Hand it fewer or smaller files.` };
  }
  const answer = (tier: Tier, result: CodeResult, retriedFrom?: Tier): CodeAnswer => ({
    environment: tier.label,
    memoryMiB: tier.memoryMiB,
    estimateMiB: estimate,
    ...(retriedFrom ? { retriedFrom: retriedFrom.label } : {}),
    exitCode: result.exitCode,
    stdout: clipped(result.stdout),
    stderr: clipped(result.stderr),
    files: result.files,
  });
  const result = await run(first, job);
  if (!result.outOfMemory) return answer(first, result);
  // A Dynamic Worker runs JavaScript alone, and so does the container after it: node is in its image.
  const larger = largerTier(first);
  if (!larger) return answer(first, result);
  return answer(larger, await run(larger, job), first);
};
