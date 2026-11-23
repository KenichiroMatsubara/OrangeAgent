/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import TASK_PROGRAM from '../starter/tasks.mjs';
import { toolsOf } from './code';
import { runCode, type CodeJob } from './environment';
import { runInIsolate } from './isolate';
import { rendezvous, type RunServing } from './rendezvous';
import { ACCOUNT } from '../test/runtime';

const loader = env.LOADER!;
const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A run offering the tools タスクの管理 calls, answering as the Worker's handlers do. */
const serving = (calls: string[]): RunServing => ({
  tools: [
    { name: 'tasks.search', description: 'Searches the Tasks.', parameters: { type: 'object' } },
    { name: 'query_contacts', description: 'Lists the Contacts.', parameters: { type: 'object' } },
  ],
  call: async (name) => {
    calls.push(name);
    if (name === 'query_contacts') return [{ id: 'c1', name: '山田 太郎', state: 'active', channels: ['line'] }];
    return {
      lists: [{ id: 'L1', name: 'FlareChat' }],
      tasks: [
        { id: 't1', listId: 'L1', title: '登録料の振込', notes: '熱田RACの口座へ\n\n担当: 山田 太郎', due: '2026-11-13', status: 'completed', completedAt: '2026-11-20T13:30:00.000Z' },
        { id: 't2', listId: 'L1', title: '会場の予約', notes: '担当: 山田 太郎', due: '2026-11-25', status: 'open', completedAt: null },
      ],
    };
  },
});

const skill = [
  { path: '/skills/task-management/SKILL.md', bytes: encoded('---\nname: task-management\n---\n') },
  { path: '/skills/task-management/scripts/tasks.mjs', bytes: encoded(TASK_PROGRAM) },
];

describe('a Dynamic Worker running a run\'s JavaScript', () => {
  it('imports a Skill\'s script and calls the run\'s tools through the stub it is lent, reaching no network', async () => {
    const calls: string[] = [];
    const access = await rendezvous({ namespace: env.RUN_CALLS!, accountId: ACCOUNT, url: `https://flarechat.example/api/public/organizations/${ACCOUNT}/mcp` }).open(serving(calls));
    const job: CodeJob = {
      language: 'javascript',
      code: [
        `import { Tasks, noticeOf } from './skills/task-management/scripts/tasks.mjs';`,
        `import { env } from 'cloudflare:workers';`,
        `const t = new Tasks(env.TOOLS);`,
        `const [paid] = await t.search({ status: 'completed' });`,
        `console.log(noticeOf(paid, { today: '2026-11-22' }));`,
        `console.log((await tools.list()).map((tool) => tool.name).join(','));`,
        `const refused = await tools.call('channel.send', { text: 'x' });`,
        `console.log(refused.message);`,
        `try { await fetch('https://example.com'); } catch (error) { console.log('fetch refused'); }`,
      ].join('\n'),
      files: [],
      placed: skill,
      bridge: { path: new URL(access.url).pathname, token: access.token },
    };

    const answer = await runCode(job, (tier, lent) => {
      expect(tier.name).toBe('isolate');
      return runInIsolate(loader, lent, toolsOf(lent));
    });
    access.close();

    expect(answer).toMatchObject({ environment: 'Dynamic Worker (128 MiB)', exitCode: 0, stderr: '' });
    expect('stdout' in answer ? answer.stdout.split('\n') : []).toEqual([
      '【タスクのお知らせ】',
      '・11/13(金) 登録料の振込（完了: 11/20）',
      '  熱田RACの口座へ',
      'tasks.search,query_contacts',
      'channel.send is not one of the tools this run was given.',
      'fetch refused',
    ]);
    expect(calls).toEqual(['tasks.search']);
  });

  it('hands back a file the code wrote as its bytes, and lends no tools it was not asked for', async () => {
    const result = await runInIsolate(loader, {
      language: 'javascript',
      code: `output('a.bin', new Uint8Array([0, 255, 7])); await tools.call('tasks.search', {});`,
      files: [],
    });

    expect(result.files).toEqual([{ filename: 'a.bin', bytes: new Uint8Array([0, 255, 7]) }]);
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('lent no tools') });
  });
});

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** A form as an organisation sends one: a styled cell to fill, a merged title, and a drawing no library may drop. */
const form = (): Uint8Array => zipSync({
  '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`),
  '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
  'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="申込書" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
  'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${SHEET_NS}"><fonts count="1"><font><sz val="11"/><name val="游ゴシック"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fillId="2" applyFill="1"/></cellXfs></styleSheet>`),
  'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${SHEET_NS}" count="2" uniqueCount="2"><si><t>参加申込書</t></si><si><t>団体名</t></si></sst>`),
  'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" s="1"/></row></sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells></worksheet>`),
  'xl/drawings/drawing1.xml': strToU8(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><!-- 記入例の矢印 --></xdr:wsDr>`),
});

/** A Skill that fills a form by writing its sheet's XML, leaving every other part as it was. */
const FILL = [
  `import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';`,
  `import { DOMParser, XMLSerializer } from '@xmldom/xmldom';`,
  `const NS = '${SHEET_NS}';`,
  `export const fill = (bytes, ref, text) => {`,
  `  const parts = unzipSync(bytes);`,
  `  const strings = new DOMParser().parseFromString(strFromU8(parts['xl/sharedStrings.xml']), 'text/xml');`,
  `  const si = strings.createElementNS(NS, 'si'); const t = strings.createElementNS(NS, 't'); t.textContent = text; si.appendChild(t); strings.documentElement.appendChild(si);`,
  `  const index = strings.getElementsByTagNameNS(NS, 'si').length - 1;`,
  `  const sheet = new DOMParser().parseFromString(strFromU8(parts['xl/worksheets/sheet1.xml']), 'text/xml');`,
  `  const cell = Array.from(sheet.getElementsByTagNameNS(NS, 'c')).find((c) => c.getAttribute('r') === ref);`,
  `  const value = sheet.createElementNS(NS, 'v'); value.textContent = String(index); cell.setAttribute('t', 's'); cell.appendChild(value);`,
  `  parts['xl/sharedStrings.xml'] = strToU8(new XMLSerializer().serializeToString(strings));`,
  `  parts['xl/worksheets/sheet1.xml'] = strToU8(new XMLSerializer().serializeToString(sheet));`,
  `  return zipSync(parts);`,
  `};`,
].join('\n');

describe('a Dynamic Worker running JavaScript that reads and writes Office files', () => {
  it('imports the libraries it is lent by name, from its code and from a Skill script, fills a form, and hands it back as its bytes', async () => {
    const template = form();
    const job: CodeJob = {
      language: 'javascript',
      code: [
        `import ExcelJS from 'exceljs';`,
        `import template from './skills/forms/templates/form.xlsx';`,
        `import { fill } from './skills/forms/scripts/fill.mjs';`,
        `const filled = fill(new Uint8Array(template), 'B3', 'さくら青年会');`,
        `const book = new ExcelJS.Workbook();`,
        `await book.xlsx.load(filled);`,
        `const cell = book.getWorksheet('申込書').getCell('B3');`,
        `console.log(cell.value, cell.fill.fgColor.argb, book.getWorksheet('申込書').model.merges.join(','));`,
        `output('記入済み.xlsx', filled);`,
      ].join('\n'),
      files: [],
      placed: [
        { path: '/skills/forms/SKILL.md', bytes: encoded('---\nname: forms\n---\n') },
        { path: '/skills/forms/scripts/fill.mjs', bytes: encoded(FILL) },
        { path: '/skills/forms/templates/form.xlsx', bytes: template },
      ],
    };

    const answer = await runCode(job, (tier, lent) => {
      expect(tier.name).toBe('isolate');
      return runInIsolate(loader, lent);
    });

    expect(answer).toMatchObject({ environment: 'Dynamic Worker (128 MiB)', exitCode: 0, stderr: '', stdout: 'さくら青年会 FFFFFF00 A1:D1' });
    const written = 'files' in answer ? answer.files.find((file) => file.filename === '記入済み.xlsx') : undefined;
    expect(written?.bytes).toBeInstanceOf(Uint8Array);
    const before = unzipSync(template);
    const after = unzipSync(written?.bytes ?? new Uint8Array());
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(strFromU8(after['xl/drawings/drawing1.xml'] ?? new Uint8Array())).toBe(strFromU8(before['xl/drawings/drawing1.xml'] ?? new Uint8Array()));
    expect(strFromU8(after['xl/sharedStrings.xml'] ?? new Uint8Array())).toContain('さくら青年会');
  });

  it('makes a Word document, a deck, and a PDF with the libraries it is lent', async () => {
    const result = await runInIsolate(loader, {
      language: 'javascript',
      code: [
        `import { Document, Packer, Paragraph } from 'docx';`,
        `import PptxGenJS from 'pptxgenjs';`,
        `import { PDFDocument } from 'pdf-lib';`,
        `output('a.docx', new Uint8Array(await Packer.toArrayBuffer(new Document({ sections: [{ children: [new Paragraph('例会のご案内')] }] }))));`,
        `const deck = new PptxGenJS(); deck.addSlide().addText('例会', { x: 1, y: 1 });`,
        `output('a.pptx', new Uint8Array(await deck.write({ outputType: 'arraybuffer' })));`,
        `const pdf = await PDFDocument.create(); pdf.addPage(); output('a.pdf', await pdf.save());`,
      ].join('\n'),
      files: [],
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.files.map((file) => [file.filename, new TextDecoder().decode(file.bytes.subarray(0, 4))])).toEqual([['a.docx', 'PK\u0003\u0004'], ['a.pptx', 'PK\u0003\u0004'], ['a.pdf', '%PDF']]);
  });
});
