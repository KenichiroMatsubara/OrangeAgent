import { describe, expect, it } from 'vitest';

import { environmentOf, estimateMiB, largerTier, openAiMemoryFor, ranOutOfMemory, runCode, tierFor, TIERS, type CodeJob, type CodeResult, type Tier } from './environment';

const MIB = 1024 * 1024;
const job = (language: CodeJob['language'], bytes = 0): CodeJob => ({ language, code: 'print(1)', files: bytes ? [{ filename: 'data.csv', bytes: new Uint8Array(bytes) }] : [] });
const done = (overrides: Partial<CodeResult> = {}): CodeResult => ({ exitCode: 0, stdout: '', stderr: '', files: [], outOfMemory: false, ...overrides });

describe('execution environments', () => {
  it('lends an API that runs code its own environment and every other API OrangeAgent’s', () => {
    expect(environmentOf('https://api.anthropic.com')).toBe('anthropic');
    expect(environmentOf('https://api.openai.com/v1')).toBe('openai');
    expect(environmentOf('https://generativelanguage.googleapis.com/v1beta/openai')).toBe('gemini');
    expect(environmentOf('https://openrouter.ai/api/v1')).toBe('orangeagent');
    expect(environmentOf('not a url')).toBe('orangeagent');
  });

  it('runs small JavaScript in a Dynamic Worker and everything else in the smallest container its estimate fits', () => {
    expect(tierFor({ language: 'javascript', inputBytes: 0 })?.name).toBe('isolate');
    expect(tierFor({ language: 'javascript', inputBytes: 8 * MIB })?.name).toBe('isolate');
    expect(tierFor({ language: 'javascript', inputBytes: 9 * MIB })?.name).toBe('lite');
    expect(tierFor({ language: 'python', inputBytes: 0 })?.name).toBe('lite');
    expect(tierFor({ language: 'shell', inputBytes: 10 * MIB })?.name).toBe('lite');
    expect(tierFor({ language: 'python', inputBytes: 100 * MIB })?.name).toBe('basic');
    expect(tierFor({ language: 'python', inputBytes: 600 * MIB })?.name).toBe('standard-1');
    expect(tierFor({ language: 'python', inputBytes: 1500 * MIB })?.name).toBe('standard-4');
    expect(tierFor({ language: 'python', inputBytes: 3000 * MIB })).toBeNull();
    expect(estimateMiB({ language: 'python', inputBytes: 10 * MIB })).toBe(220);
  });

  it('names one size larger until the largest', () => {
    const names = TIERS.map((tier) => largerTier(tier)?.name ?? null);
    expect(names).toEqual(['lite', 'basic', 'standard-1', 'standard-4', null]);
  });

  it('sizes OpenAI’s container from the same estimate', () => {
    expect(openAiMemoryFor(0)).toBe('1g');
    expect(openAiMemoryFor(200 * MIB)).toBe('4g');
    expect(openAiMemoryFor(1000 * MIB)).toBe('16g');
    expect(openAiMemoryFor(100_000 * MIB)).toBe('64g');
  });

  it('reads a kill or a runtime’s own words as running out of memory', () => {
    expect(ranOutOfMemory(137, '')).toBe(true);
    expect(ranOutOfMemory(1, 'Traceback …\nMemoryError')).toBe(true);
    expect(ranOutOfMemory(1, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')).toBe(true);
    expect(ranOutOfMemory(1, 'NameError: name x is not defined')).toBe(false);
  });

  it('runs once more one size up when the first environment ran out of memory, and no more', async () => {
    const tiers: Tier['name'][] = [];
    const answer = await runCode(job('python'), async (tier) => {
      tiers.push(tier.name);
      return tier.name === 'lite' ? done({ exitCode: 137, outOfMemory: true }) : done({ stdout: 'ok' });
    });
    expect(tiers).toEqual(['lite', 'basic']);
    expect(answer).toMatchObject({ environment: 'コンテナ basic (1 GiB)', memoryMiB: 1024, retriedFrom: 'コンテナ lite (256 MiB)', stdout: 'ok' });

    const twice: Tier['name'][] = [];
    await runCode(job('python'), async (tier) => {
      twice.push(tier.name);
      return done({ exitCode: 137, outOfMemory: true });
    });
    expect(twice).toEqual(['lite', 'basic']);
  });

  it('refuses work larger than the largest environment without running it', async () => {
    let ran = false;
    const answer = await runCode(job('python', 3000 * MIB), async () => {
      ran = true;
      return done();
    });
    expect(ran).toBe(false);
    expect(answer).toHaveProperty('refused');
  });
});
