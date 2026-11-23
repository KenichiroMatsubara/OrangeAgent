import { describe, expect, it } from 'vitest';

import { codeRunner, mediaTypeOf, performCodeRun, type CodeContext } from './code';
import type { CodeJob, Tier } from './environment';
import { FileAnswer, type GeneratedFile, type TurnFile } from './turns';

const held: TurnFile = { filename: 'sales.csv', mediaType: 'text/csv', bytes: new TextEncoder().encode('a,b\n') };

const context = (overrides: Partial<CodeContext> = {}): CodeContext & { jobs: Array<{ tier: Tier['name']; job: CodeJob }>; kept: GeneratedFile[] } => {
  const jobs: Array<{ tier: Tier['name']; job: CodeJob }> = [];
  const kept: GeneratedFile[] = [];
  return {
    jobs, kept,
    run: async (tier, job) => {
      jobs.push({ tier: tier.name, job });
      return { exitCode: 0, stdout: 'ok', stderr: '', files: [{ filename: 'chart.png', bytes: new Uint8Array([1, 2]) }], outOfMemory: false };
    },
    find: async (filename) => (filename === held.filename ? held : null),
    keep: async (file) => {
      kept.push(file);
    },
    ...overrides,
  };
};

describe('code.run', () => {
  it('places the files the run holds, runs the code where its estimate fits, and hands back what it wrote', async () => {
    const lent = context();
    const answer = await performCodeRun(lent, { language: 'python', code: 'print(1)', files: ['sales.csv'] });

    expect(lent.jobs).toEqual([{ tier: 'lite', job: { language: 'python', code: 'print(1)', files: [{ filename: 'sales.csv', bytes: held.bytes }] } }]);
    expect(answer).toBeInstanceOf(FileAnswer);
    const { answer: view, files } = answer as FileAnswer;
    expect(view).toMatchObject({ environment: 'コンテナ lite (256 MiB)', memoryMiB: 256, exitCode: 0, stdout: 'ok', files: [{ filename: 'chart.png', size: 2 }] });
    expect(files).toEqual([{ filename: 'chart.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2]) }]);
    expect(lent.kept.map((file) => file.filename)).toEqual(['chart.png']);
  });

  it('runs small JavaScript in a Dynamic Worker', async () => {
    const lent = context();
    await performCodeRun(lent, { language: 'javascript', code: 'console.log(1)' });
    expect(lent.jobs.map((entry) => entry.tier)).toEqual(['isolate']);
  });

  it('runs JavaScript lent the run\'s tools in a Dynamic Worker too, and Python lent them in a container', async () => {
    const lent = context();
    const access = async () => ({ url: 'https://orangeagent.example/api/public/organizations/organization-1/mcp', token: 'run_secret', expiresAt: '2026-11-22T08:00:00.000Z' });
    await performCodeRun(lent, { language: 'javascript', code: 'await tools.call("tasks.search", {})', tools: true }, access);
    await performCodeRun(lent, { language: 'python', code: 'print(1)', tools: true }, access);
    expect(lent.jobs.map((entry) => [entry.tier, entry.job.bridge])).toEqual([
      ['isolate', { path: '/api/public/organizations/organization-1/mcp', token: 'run_secret' }],
      ['lite', { path: '/api/public/organizations/organization-1/mcp', token: 'run_secret' }],
    ]);
  });

  it('refuses a file the run does not hold and a language it does not run, running nothing', async () => {
    const lent = context();
    expect(await performCodeRun(lent, { language: 'python', code: 'x', files: ['missing.csv'] })).toMatchObject({ isError: true });
    expect(await performCodeRun(lent, { language: 'ruby', code: 'x' })).toMatchObject({ isError: true });
    expect(await performCodeRun(lent, { language: 'python', code: '  ' })).toMatchObject({ isError: true });
    expect(lent.jobs).toEqual([]);
  });

  it('lends no environment where the Worker binds none, as in local development', () => {
    expect(codeRunner({})).toBeNull();
  });

  it('keeps a written file under the media type its extension names', () => {
    expect(mediaTypeOf('報告.XLSX')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mediaTypeOf('noext')).toBe('application/octet-stream');
  });
});
