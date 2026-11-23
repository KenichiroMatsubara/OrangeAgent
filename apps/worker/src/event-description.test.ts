import { describe, expect, it } from 'vitest';

import { attachmentLink, calendarEventDescription } from './event-description';

describe('Google Calendar description', () => {
  it('links a published Source Attachment by filename instead of its raw URL', () => {
    const description = calendarEventDescription({
      summary: '地区大会の登録受付です。参加費は3,000円です。',
      attachments: [
        { filename: '③登録シート.xlsx', url: 'https://docs.google.com/spreadsheets/d/example-sheet-id/edit?usp=drivesdk&rtpof=true' },
        { filename: '②26-27地区大会.pdf', url: 'https://drive.google.com/file/d/example-file-id/view?usp=drivesdk' },
      ],
      attribution: 'FlareChat が Gmail メッセージ 19fc6ffaec9d2256 から作成しました。',
    });

    expect(description).toBe([
      '地区大会の登録受付です。<br>参加費は3,000円です。',
      '<br><br>添付ファイル:',
      '<br><a href="https://docs.google.com/spreadsheets/d/example-sheet-id/edit?usp=drivesdk&amp;rtpof=true">③登録シート.xlsx</a>',
      '<br><a href="https://drive.google.com/file/d/example-file-id/view?usp=drivesdk">②26-27地区大会.pdf</a>',
      '<br><br>FlareChat が Gmail メッセージ 19fc6ffaec9d2256 から作成しました。',
    ].join(''));
  });

  it('keeps the attribution alone when the Event Summary and the attachments are empty', () => {
    expect(calendarEventDescription({
      summary: '   ',
      attachments: [],
      attribution: 'FlareChat が Gmail メッセージ gmail-1 から作成しました。',
    })).toBe('FlareChat が Gmail メッセージ gmail-1 から作成しました。');
  });

  it('escapes untrusted summary text and keeps its line breaks readable', () => {
    expect(calendarEventDescription({
      summary: '受付は<会館>前\n持ち物は "名札" と資料 & 筆記具',
      attachments: [],
      attribution: '',
    })).toBe('受付は&lt;会館&gt;前<br>持ち物は &quot;名札&quot; と資料 &amp; 筆記具');
  });

  it('starts each sentence of the Event Summary on its own line', () => {
    expect(calendarEventDescription({
      summary: 'さくら青年会の11月第一例会。講師から学ぶ「キャリアについて考える。」。受付開始19:00、開始19:30。ビジターフィーは3,000円（リモート1,000円。当日払い）。 出欠は11月7日までに連絡。',
      attachments: [],
      attribution: '',
    })).toBe([
      'さくら青年会の11月第一例会。',
      '講師から学ぶ「キャリアについて考える。」。',
      '受付開始19:00、開始19:30。',
      'ビジターフィーは3,000円（リモート1,000円。当日払い）。',
      '出欠は11月7日までに連絡。',
    ].join('<br>'));
  });

  it('keeps the line breaks and blank lines the Event Summary already has without doubling them', () => {
    expect(calendarEventDescription({
      summary: '例会です。\n\n持ち物は名札です！？ 以上。',
      attachments: [],
      attribution: '',
    })).toBe('例会です。<br><br>持ち物は名札です！？<br>以上。');
  });

  it('states the Guest Registration counts between the Event Summary and the attachments', () => {
    expect(calendarEventDescription({
      summary: '例会のご案内です。',
      guestCounts: '外部からの参加登録: 1団体 2名（北クラブ 2名）',
      attachments: [{ filename: '登録用紙.xlsx', url: 'https://drive.example/sheet' }],
      attribution: 'FlareChat が Gmail メッセージ abc から作成しました。',
    })).toBe([
      '例会のご案内です。',
      '<br><br>外部からの参加登録: 1団体 2名（北クラブ 2名）',
      '<br><br>添付ファイル:',
      '<br><a href="https://drive.example/sheet">登録用紙.xlsx</a>',
      '<br><br>FlareChat が Gmail メッセージ abc から作成しました。',
    ].join(''));
  });

  it('escapes an Affiliation another organization wrote into its registration', () => {
    expect(calendarEventDescription({
      summary: '',
      guestCounts: '外部からの参加登録: 1団体 1名（<script>alert(1)</script> 1名）',
      attachments: [],
      attribution: '',
    })).toBe('外部からの参加登録: 1団体 1名（&lt;script&gt;alert(1)&lt;/script&gt; 1名）');
  });

  it('omits the counts block when nobody from outside has registered', () => {
    expect(calendarEventDescription({ summary: '例会のご案内です。', attachments: [], attribution: '' }))
      .toBe('例会のご案内です。');
  });

  it('escapes a filename that carries markup', () => {
    expect(attachmentLink({ filename: '<b>案内</b>.pdf', url: 'https://drive.example/file' }))
      .toBe('<a href="https://drive.example/file">&lt;b&gt;案内&lt;/b&gt;.pdf</a>');
  });

  it('refuses to link a URL that is not http or https', () => {
    expect(attachmentLink({ filename: '案内.pdf', url: 'javascript:alert(1)' })).toBe('案内.pdf');
    expect(attachmentLink({ filename: '', url: 'not a url' })).toBe('not a url');
  });
});
