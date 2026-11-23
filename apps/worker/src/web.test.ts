import { describe, expect, it, vi } from 'vitest';

import { FileAnswer } from './turns';
import { WEB_PAGE_CHARACTERS, htmlText, readWebPage, webUrl } from './web';

const answering = (response: Response, url = 'https://example.com/page') => vi.fn(async () => {
  Object.defineProperty(response, 'url', { value: url });
  return response;
});

describe('reading a page of the web', () => {
  it('reads any public URL Claude names, as its words with its links written out', async () => {
    const html = `<!doctype html><html><head><title>料金 &amp; プラン</title><style>.x{}</style><script>alert(1)</script></head>
      <body><nav><a href="/">ホーム</a></nav><h1>Business Standard</h1><p>1 ユーザー&nbsp;1,600 円</p>
      <ul><li>Meet の文字起こし</li><li><a href="https://support.example.com/answer/1">詳しく</a></li></ul></body></html>`;
    const transport = answering(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

    const page = await readWebPage({ url: 'https://example.com/page' }, transport);

    expect(transport).toHaveBeenCalledWith('https://example.com/page', expect.objectContaining({ redirect: 'follow' }));
    expect(page).toMatchObject({ url: 'https://example.com/page', status: 200, contentType: 'text/html', title: '料金 & プラン', nextOffset: null });
    const { text } = page as { text: string };
    expect(text).toContain('[ホーム](https://example.com/)');
    expect(text).toContain('# Business Standard');
    expect(text).toContain('1 ユーザー 1,600 円');
    expect(text).toContain('- Meet の文字起こし');
    expect(text).toContain('[詳しく](https://support.example.com/answer/1)');
    expect(text).not.toContain('alert');
  });

  it('answers a long page part by part, from the offset Claude reads on from', async () => {
    const body = 'あ'.repeat(WEB_PAGE_CHARACTERS + 10);
    const first = await readWebPage({ url: 'https://example.com/long' }, answering(new Response(body, { headers: { 'content-type': 'text/plain' } })));
    const rest = await readWebPage({ url: 'https://example.com/long', offset: WEB_PAGE_CHARACTERS }, answering(new Response(body, { headers: { 'content-type': 'text/plain' } })));

    expect(first).toMatchObject({ nextOffset: WEB_PAGE_CHARACTERS });
    expect((first as { text: string }).text).toHaveLength(WEB_PAGE_CHARACTERS);
    expect(rest).toMatchObject({ text: 'あ'.repeat(10), nextOffset: null });
  });

  it('hands a PDF over as the file itself', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const answer = await readWebPage({ url: 'https://example.com/docs/plan.pdf' }, answering(new Response(bytes, { headers: { 'content-type': 'application/pdf' } }), 'https://example.com/docs/plan.pdf'));

    expect(answer).toBeInstanceOf(FileAnswer);
    expect((answer as FileAnswer).files).toEqual([{ filename: 'plan.pdf', mediaType: 'application/pdf', bytes }]);
  });

  it('refuses a page that answers with an error, saying which', async () => {
    const answer = await readWebPage({ url: 'https://example.com/missing' }, answering(new Response('', { status: 404, statusText: 'Not Found' }), 'https://example.com/missing'));

    expect(answer).toEqual({ isError: true, message: 'https://example.com/missing answered HTTP 404 Not Found. Try another page.' });
  });

  it('reads only the public web', () => {
    expect(webUrl('https://workspace.google.com/pricing')).toBeInstanceOf(URL);
    expect(webUrl('file:///etc/passwd')).toMatchObject({ isError: true });
    expect(webUrl('http://localhost:8787/api')).toMatchObject({ isError: true });
    expect(webUrl('http://192.168.1.1/')).toMatchObject({ isError: true });
    expect(webUrl('http://[::1]/')).toMatchObject({ isError: true });
    expect(webUrl('')).toMatchObject({ isError: true });
  });

  it('keeps the words of a link that leads nowhere it can open', () => {
    expect(htmlText('<p><a href="javascript:void(0)">開く</a></p>', new URL('https://example.com/')).text).toBe('開く');
  });
});
