import { describe, expect, it } from 'vitest';

import { previewContactCsv } from './roster';

describe('Contact CSV preview', () => {
  it('skips a row whose Contact the roster or an earlier row already holds, and never merges', () => {
    const csv = [
      'name,email,description,tags',
      'Alice,ALICE@example.com,会計,役員',
      'Bob,bob@example.com,,',
      'Bob again,bob@example.com,,',
      '役員グループ,,LINE グループ,',
      '役員 グループ,,,',
      'Carol,,,',
      'Dave,not-an-email,,',
    ].join('\n');
    expect(previewContactCsv(csv, [{ name: 'Alice Smith', email: 'alice@example.com' }, { name: 'Carol', email: '' }])).toEqual({
      accepted: [
        { line: 3, name: 'Bob', email: 'bob@example.com', description: '', tags: [] },
        { line: 5, name: '役員グループ', email: '', description: 'LINE グループ', tags: [] },
      ],
      skipped: [
        { line: 2, name: 'Alice', email: 'alice@example.com', reason: 'このメールアドレスは既に「Alice Smith」に登録されています。' },
        { line: 4, name: 'Bob again', email: 'bob@example.com', reason: '3 行目と同じメールアドレスです。' },
        { line: 6, name: '役員 グループ', email: '', reason: 'メールアドレスがなく、5 行目と同じ名前です。' },
        { line: 7, name: 'Carol', email: '', reason: 'メールアドレスがなく、同じ名前の「Carol」が既にあります。' },
      ],
      invalid: [{ line: 8, text: 'Dave,not-an-email,,', reason: 'メールアドレス「not-an-email」の形が正しくありません。' }],
    });
  });
});
