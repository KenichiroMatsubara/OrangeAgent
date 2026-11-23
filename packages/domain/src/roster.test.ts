import { describe, expect, it } from 'vitest';

import { CONTACT_CSV_SAMPLE, ContactCsvRefusal, readContactCsv, writeContactCsv } from './roster';

describe('Contact CSV', () => {
  it('reads the sample the screen shows, quoted commas and all', () => {
    expect(readContactCsv(CONTACT_CSV_SAMPLE)).toEqual({
      rows: [
        { line: 2, name: '山田 太郎', email: 'taro@example.com', description: '会計', tags: ['役員', '2026'] },
        { line: 3, name: '佐藤 花子, 幹事', email: 'hanako@example.com', description: '幹事、受付', tags: ['役員'] },
        { line: 4, name: '役員グループ', email: '', description: '役員全員の LINE グループ', tags: [] },
      ],
      problems: [],
    });
  });

  it('takes Japanese headings in any order, a BOM, CRLF, and a line break inside quotes', () => {
    const csv = '﻿メールアドレス,名前,タグ\r\nA@Example.com,"Alice\r\nSmith","x、y"\r\n\r\n,Bob,\r\n';
    expect(readContactCsv(csv)).toEqual({
      rows: [
        { line: 2, name: 'Alice\r\nSmith', email: 'a@example.com', description: '', tags: ['x', 'y'] },
        { line: 5, name: 'Bob', email: '', description: '', tags: [] },
      ],
      problems: [],
    });
  });

  it('names the line and the reason of each row it cannot take', () => {
    expect(readContactCsv('name,email\n,a@example.com\nBob,bob@example.com,extra\nCarol,carol').problems).toEqual([
      { line: 2, text: ',a@example.com', reason: '名前が空です。' },
      { line: 3, text: 'Bob,bob@example.com,extra', reason: expect.stringContaining('列が見出しより多く') },
      { line: 4, text: 'Carol,carol', reason: 'メールアドレス「carol」の形が正しくありません。' },
    ]);
  });

  it('refuses a file whose heading it cannot read', () => {
    expect(() => readContactCsv('Alice,alice@example.com')).toThrow(ContactCsvRefusal);
    expect(() => readContactCsv('email,phone\na@example.com,1')).toThrow('「phone」');
    expect(() => readContactCsv('name,名前\nA,B')).toThrow('2 つ');
    expect(() => readContactCsv('name\n"Alice')).toThrow('閉じられていません');
    expect(() => readContactCsv('  \n')).toThrow('空');
  });

  it('writes what it reads back', () => {
    const contacts = [{ name: 'Smith, "Al"', email: 'al@example.com', description: '一行目\n二行目', tags: ['a', 'b'] }];
    const csv = writeContactCsv(contacts);
    expect(csv.startsWith('﻿name,email,description,tags\r\n')).toBe(true);
    expect(readContactCsv(csv).rows).toEqual([{ line: 2, ...contacts[0] }]);
  });
});
