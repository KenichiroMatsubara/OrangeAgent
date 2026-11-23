import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { lentPackage } from './container';
import { estimateMiB, runCode, type CodeJob } from './environment';
import { LENT, LENT_NAMES, lentBytes, lentIn, lentOf, pointedAtLent } from './lent';

const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the libraries a run\'s JavaScript is lent', () => {
  it('finds the lent libraries a module imports at its top level, and no other import', () => {
    const code = [
      `import ExcelJS from 'exceljs';`,
      `import { unzipSync } from 'fflate';`,
      `import { DOMParser } from '@xmldom/xmldom';`,
      `import { env } from 'cloudflare:workers';`,
      `import { Tasks } from './skills/task-management/scripts/tasks.mjs';`,
      `export * from 'pdf-lib';`,
    ].join('\n');

    expect(lentIn(code).sort()).toEqual(['@xmldom/xmldom', 'exceljs', 'fflate', 'pdf-lib']);
    expect(lentIn('this is not a module {')).toEqual([]);
  });

  it('counts the libraries a Skill script imports as well as the code\'s own', () => {
    const placed = [
      { path: '/skills/forms/scripts/fill.mjs', bytes: encoded(`import { zipSync } from 'fflate';\nexport const fill = () => zipSync({});`) },
      { path: '/skills/forms/templates/form.xlsx', bytes: new Uint8Array([0x50, 0x4b]) },
    ];

    expect(lentOf(`import { fill } from './skills/forms/scripts/fill.mjs';`, placed)).toEqual(['fflate']);
    expect(lentOf('console.log(1);')).toEqual([]);
  });

  it('points each import of a lent library at its module, relative to the importing module', () => {
    expect(pointedAtLent(`import ExcelJS from 'exceljs';\nconsole.log('exceljs');`, 'task.js'))
      .toBe(`import ExcelJS from "./lent/exceljs.js";\nconsole.log('exceljs');`);
    expect(pointedAtLent(`import { unzipSync } from 'fflate';\nimport { DOMParser } from '@xmldom/xmldom';\nimport a from './a.mjs';`, 'skills/forms/scripts/fill.mjs'))
      .toBe(`import { unzipSync } from "../../../lent/fflate.js";\nimport { DOMParser } from "../../../lent/@xmldom/xmldom.js";\nimport a from './a.mjs';`);
    expect(pointedAtLent('not { a module', 'task.js')).toBe('not { a module');
  });

  it('holds each library at the version package.json pins, its licence at its head', () => {
    const pins = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies;

    for (const name of LENT_NAMES) {
      expect(LENT[name]?.startsWith(`/*! ${name}@${pins[name]}, bundled by scripts/lent.ts`), name).toBe(true);
      expect(LENT[name], name).toMatch(/Permission is hereby granted|MIT License/u);
    }
  });

  it('counts a lent library in the memory a run is estimated to need, so a run that imports one may still fit the isolate', async () => {
    const job: CodeJob = { language: 'javascript', code: `import ExcelJS from 'exceljs';\nconsole.log(typeof ExcelJS);`, files: [] };
    const tiers: string[] = [];

    await runCode(job, async (tier) => {
      tiers.push(tier.name);
      return { exitCode: 0, stdout: '', stderr: '', files: [], outOfMemory: false };
    });

    expect(lentBytes(['exceljs'])).toBeGreaterThan(500_000);
    expect(estimateMiB({ language: 'javascript', inputBytes: lentBytes(LENT_NAMES) })).toBeLessThanOrEqual(64);
    expect(tiers).toEqual(['isolate']);
  });

  it('gives a container each library as a package node finds by its name', () => {
    expect(lentPackage('@xmldom/xmldom').map((file) => file.path)).toEqual(['/node_modules/@xmldom/xmldom/package.json', '/node_modules/@xmldom/xmldom/index.mjs']);
    expect(JSON.parse(new TextDecoder().decode(lentPackage('fflate')[0]?.bytes))).toEqual({ name: 'fflate', type: 'module', exports: './index.mjs' });
  });
});
