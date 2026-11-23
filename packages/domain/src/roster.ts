/**
 * The one CSV format the Contacts screen takes in and gives out. The screen
 * shows these columns and the sample, the Worker reads and writes by them, and
 * Operator Chat is told the same format, so a file one of them writes the
 * others read.
 */

export type ContactCsvField = 'name' | 'email' | 'description' | 'tags';

export interface ContactCsvColumn {
  field: ContactCsvField;
  /** The heading the export writes. */
  heading: string;
  /** Every heading the import takes for this column, the export's first. */
  headings: readonly string[];
  /** The column's name on screen. */
  label: string;
  required: boolean;
  /** What goes in the column, in the screen's words. */
  note: string;
}

export const CONTACT_CSV_COLUMNS: readonly ContactCsvColumn[] = [
  { field: 'name', heading: 'name', headings: ['name', '名前', '氏名'], label: '名前', required: true, note: '個人名でもグループ名でも構いません。' },
  { field: 'email', heading: 'email', headings: ['email', 'メールアドレス', 'メール'], label: 'メールアドレス', required: false, note: '空でも構いません。' },
  { field: 'description', heading: 'description', headings: ['description', '説明'], label: '説明', required: false, note: '例: 会計、役員全員の LINE グループ' },
  { field: 'tags', heading: 'tags', headings: ['tags', 'タグ'], label: 'タグ', required: false, note: '複数は「、」か「;」で区切ります。' },
];

/** A file the import takes as it is, every column used once. */
export const CONTACT_CSV_SAMPLE = [
  'name,email,description,tags',
  '山田 太郎,taro@example.com,会計,役員;2026',
  '"佐藤 花子, 幹事",hanako@example.com,"幹事、受付",役員',
  '役員グループ,,役員全員の LINE グループ,',
].join('\n');

/** The same format, told to the model so the CSV it writes is one the screen takes. */
export const CONTACT_CSV_INSTRUCTIONS = [
  'When the administrator wants Contacts added from a list, write a CSV they paste or upload on 連絡先 › CSV で入出力, in exactly this format:',
  'UTF-8 text; the first line is the heading `name,email,description,tags` (columns in any order, only `name` required; the headings 名前, メールアドレス, 説明, タグ are taken too); one Contact per line after it.',
  'name is a person or a group; email may be empty; several tags are separated by 「;」 or 「、」 inside the one tags field; a field holding a comma, a double quote, or a line break is wrapped in double quotes, with each double quote inside doubled.',
  'A line whose email an existing Contact already holds, or that has no email and whose name an existing Contact already has, is skipped, never merged; tell the administrator to change such a Contact on its own screen.',
].join(' ');

export interface ContactCsvRow {
  /** The line of the file the row starts on, the heading being line 1. */
  line: number;
  name: string;
  email: string;
  description: string;
  tags: string[];
}

export interface ContactCsvProblem {
  line: number;
  /** The line as it was written, for the screen to show. */
  text: string;
  reason: string;
}

/** What a CSV says: the rows it can take and the lines it cannot. */
export interface ContactCsv {
  rows: ContactCsvRow[];
  problems: ContactCsvProblem[];
}

/** Why a whole file cannot be read; its rows are not looked at. */
export class ContactCsvRefusal extends Error {}

interface CsvRecord {
  line: number;
  text: string;
  fields: string[];
}

/** Splits RFC 4180 text into records, keeping the line each starts on. Quoted fields may hold commas, quotes, and line breaks. */
const recordsOf = (csv: string): CsvRecord[] => {
  const text = csv.replace(/^﻿/u, '');
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let begin = 0;
  const finish = (end: number): void => {
    fields.push(field);
    records.push({ line: start, text: text.slice(begin, end), fields });
    fields = [];
    field = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; continue; }
      if (character === '"') { quoted = false; continue; }
      if (character === '\n') line += 1;
      field += character;
      continue;
    }
    if (character === '"' && field.trim() === '') { field = ''; quoted = true; continue; }
    if (character === ',') { fields.push(field); field = ''; continue; }
    if (character === '\r' && text[index + 1] === '\n') continue;
    if (character === '\n' || character === '\r') {
      finish(index);
      line += 1;
      start = line;
      begin = index + 1;
      continue;
    }
    field += character;
  }
  if (quoted) throw new ContactCsvRefusal(`${start} 行目で始まる「"」が閉じられていません。`);
  finish(text.length);
  return records.filter((record) => record.fields.some((value) => value.trim() !== ''));
};

const headingKey = (heading: string): string => heading.normalize('NFKC').trim().toLowerCase();

const fieldOf = (heading: string): ContactCsvField | undefined =>
  CONTACT_CSV_COLUMNS.find((column) => column.headings.some((name) => headingKey(name) === headingKey(heading)))?.field;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/** Splits a tags field on 「;」「、」 or a comma, dropping empty tags. */
export const contactCsvTags = (value: string): string[] =>
  value.split(/[;；、,，]/u).map((tag) => tag.trim()).filter(Boolean);

/**
 * Reads a Contact CSV: a heading line, then one Contact per record. A file the
 * format cannot read as a whole is refused with ContactCsvRefusal; a single
 * record it cannot take becomes a problem naming its line.
 */
export const readContactCsv = (csv: string): ContactCsv => {
  const [heading, ...records] = recordsOf(csv);
  if (!heading) throw new ContactCsvRefusal('CSV が空です。');
  const fields = heading.fields.map((value) => value.trim() === '' ? undefined : fieldOf(value));
  const unknown = heading.fields.filter((value, index) => value.trim() !== '' && fields[index] === undefined);
  if (unknown.length > 0) {
    const known = CONTACT_CSV_COLUMNS.map((column) => column.heading).join(',');
    throw new ContactCsvRefusal(`1 行目の見出し「${unknown.join('」「')}」が分かりません。1 行目は ${known} のような見出しにしてください。`);
  }
  if (!fields.includes('name')) throw new ContactCsvRefusal('1 行目の見出しに name（名前）の列がありません。');
  const repeated = CONTACT_CSV_COLUMNS.find((column) => fields.filter((field) => field === column.field).length > 1);
  if (repeated) throw new ContactCsvRefusal(`1 行目に ${repeated.heading}（${repeated.label}）の列が 2 つあります。`);
  const rows: ContactCsvRow[] = [];
  const problems: ContactCsvProblem[] = [];
  for (const record of records) {
    const problem = (reason: string): void => { problems.push({ line: record.line, text: record.text, reason }); };
    const extra = record.fields.slice(fields.length).some((value) => value.trim() !== '');
    if (extra) { problem(`列が見出しより多くあります（見出し ${fields.length} 列、この行 ${record.fields.length} 列）。カンマを含む値は "" で囲んでください。`); continue; }
    const value = (field: ContactCsvField): string => {
      const index = fields.indexOf(field);
      return index < 0 ? '' : (record.fields[index] ?? '').trim();
    };
    const name = value('name');
    const email = value('email').toLowerCase();
    if (!name) { problem('名前が空です。'); continue; }
    if (email && !EMAIL.test(email)) { problem(`メールアドレス「${value('email')}」の形が正しくありません。`); continue; }
    rows.push({ line: record.line, name, email, description: value('description'), tags: contactCsvTags(value('tags')) });
  }
  return { rows, problems };
};

const quoted = (value: string): string => /[",\r\n]/u.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;

/** Writes Contacts in the format readContactCsv takes, with a BOM and CRLF so Excel opens it as UTF-8. */
export const writeContactCsv = (contacts: ReadonlyArray<{ name: string; email: string; description: string; tags: readonly string[] }>): string =>
  `﻿${[
    CONTACT_CSV_COLUMNS.map((column) => column.heading),
    ...contacts.map((contact) => [contact.name, contact.email, contact.description, contact.tags.join(';')]),
  ].map((fields) => fields.map(quoted).join(',')).join('\r\n')}\r\n`;
