import { describe, expect, it } from 'vitest';

import { chatContentType, chatGeneratedFileType, isChatAttachmentType, isChatShownType, unreadableChatAttachmentText, unsupportedChatAttachmentText } from './chat';

describe('Operator Chat attachments', () => {
  it('accepts images, PDFs, and Word, Excel, CSV, and text files', () => {
    expect(['image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv', 'text/plain']
      .every(isChatAttachmentType)).toBe(true);
  });

  it('refuses a kind of file it does not accept, by its name', () => {
    expect(isChatAttachmentType('application/x-msdownload')).toBe(false);
    expect(unsupportedChatAttachmentText('setup.exe')).toContain('setup.exe は添付できません');
  });
});

describe('Operator Chat attachment contents', () => {
  const bytes = (...values: Array<number | string>): Uint8Array =>
    new Uint8Array(values.flatMap((value) => typeof value === 'string' ? [...value].map((character) => character.charCodeAt(0)) : [value]));

  it('names the image or PDF a file holds by its first bytes, whatever it is called', () => {
    expect(chatContentType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(chatContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(chatContentType(bytes('GIF89a'))).toBe('image/gif');
    expect(chatContentType(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBe('image/webp');
    expect(chatContentType(bytes('%PDF-1.7'))).toBe('application/pdf');
  });

  it('names nothing for bytes that are no image or PDF a model reads, such as HEIC', () => {
    expect(chatContentType(bytes(0, 0, 0, 0x18, 'ftypheic'))).toBeNull();
    expect(chatContentType(bytes('PK', 3, 4))).toBeNull();
    expect(chatContentType(new Uint8Array())).toBeNull();
  });

  it('says in words what a file could not be read as', () => {
    expect(unreadableChatAttachmentText('photo.jpg', 'image/jpeg')).toBe('photo.jpg を画像として読み取れませんでした。PNG・JPEG・GIF・WebP で保存し直して添付してください。');
    expect(unreadableChatAttachmentText('名簿.csv', 'text/csv')).toBe('名簿.csv をCSV（UTF-8）として読み取れませんでした。');
  });
});

describe('Operator Chat generated files', () => {
  it('keeps every file Claude writes, typed by its extension', () => {
    expect(chatGeneratedFileType('報告書.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(chatGeneratedFileType('roster.XLSX')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(chatGeneratedFileType('次第.pdf')).toBe('application/pdf');
    expect(chatGeneratedFileType('chart.png')).toBe('image/png');
    expect(chatGeneratedFileType('data.parquet')).toBe('application/octet-stream');
    expect(chatGeneratedFileType('docx')).toBe('application/octet-stream');
  });

  it('shows only images and PDFs in the browser, and downloads anything that could run script', () => {
    expect(isChatShownType('application/pdf')).toBe(true);
    expect(isChatShownType('image/png')).toBe(true);
    expect(isChatShownType('image/svg+xml')).toBe(false);
    expect(isChatShownType('text/html')).toBe(false);
  });
});
