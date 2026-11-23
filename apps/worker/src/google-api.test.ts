import { afterEach, describe, expect, it, vi } from 'vitest';

import { googleApi } from './google-api';
import { GoogleApiError } from './providers';
import type { TemporaryFailure } from './temporary';

const google = googleApi();

const attachment = { attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9, bytes: new TextEncoder().encode('pdf-bytes') };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the production Google adapter', () => {
  it('returns a public link only after the Drive anyone-reader permission succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.publishAttachment('token', { attachment, parentFolderId: 'source-message-folder' }))
      .resolves.toEqual({ outcome: 'succeeded', driveFileId: 'drive-file-1', publicUrl: 'https://drive.example/file-1' });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('upload/drive/v3/files?uploadType=multipart&fields=id%2CwebViewLink');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.googleapis.com/drive/v3/files/drive-file-1/permissions');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toEqual({ type: 'anyone', role: 'reader' });
    const body = await (fetchMock.mock.calls[0]?.[1].body as Blob).text();
    expect(JSON.parse(/\r\n\r\n(\{.*?\})\r\n/su.exec(body)?.[1] ?? '{}')).toMatchObject({ name: 'agenda.pdf', parents: ['source-message-folder'] });
    // The file goes to Drive as its bytes, never as base64.
    expect(body).toContain('Content-Type: application/pdf\r\n\r\npdf-bytes\r\n--');
    expect(body).not.toContain('Content-Transfer-Encoding');
  });

  it('does not expose a link when public permission creation fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 })));

    await expect(google.drive.publishAttachment('token', { attachment, parentFolderId: 'source-message-folder' }))
      .resolves.toEqual({ outcome: 'failed', driveFileId: 'drive-file-1', publicUrl: null });
  });

  it('reuses the folder this application already created for a level and creates only the missing ones', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'hand-made-top', isAppAuthorized: false }, { id: 'existing-top', isAppAuthorized: true }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'hand-made-leaf', isAppAuthorized: false }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'created-leaf' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.ensureFolderPath('token', ['会計 2026', '添付'])).resolves.toBe('created-leaf');

    expect(decodeURIComponent(fetchMock.mock.calls[0]?.[0] as string)).toContain("'root' in parents");
    expect(decodeURIComponent(fetchMock.mock.calls[1]?.[0] as string)).toContain("'existing-top' in parents");
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1].body as string)).toEqual({
      name: '添付',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['existing-top'],
    });
  });

  it('links again only a file this application published, never one put in the folder by hand', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{ id: 'hand-made', webViewLink: 'https://drive.example/hand-made', isAppAuthorized: false }],
    }), { status: 200 })));

    await expect(google.drive.findPublishedAttachment('token', { filename: 'agenda.pdf', folderId: 'message-folder' })).resolves.toBeNull();
  });

  it('renders an Office file as a PDF from a Google copy it removes, even when the export fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'copy-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('%PDF-1.7', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'copy-2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'This file is too large to be exported.' } }), { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const word = {
      filename: '例会案内.docx', bytes: new TextEncoder().encode('docx-bytes'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', convertTo: 'application/vnd.google-apps.document',
    };

    await expect(google.drive.renderPdf('token', word)).resolves.toEqual(new TextEncoder().encode('%PDF-1.7'));
    await expect(google.drive.renderPdf('token', word)).rejects.toMatchObject({ status: 403, message: 'This file is too large to be exported.' });

    const body = await (fetchMock.mock.calls[0]?.[1].body as Blob).text();
    expect(JSON.parse(/\r\n\r\n(\{.*?\})\r\n/su.exec(body)?.[1] ?? '{}')).toEqual({ name: '例会案内.docx', mimeType: 'application/vnd.google-apps.document' });
    expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`)).toEqual([
      'POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      'GET https://www.googleapis.com/drive/v3/files/copy-1/export?mimeType=application%2Fpdf',
      'DELETE https://www.googleapis.com/drive/v3/files/copy-1',
      'POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      'GET https://www.googleapis.com/drive/v3/files/copy-2/export?mimeType=application%2Fpdf',
      'DELETE https://www.googleapis.com/drive/v3/files/copy-2',
    ]);
  });

  it('reads a Drive file as its bytes, and a Google Docs file as the export asked for', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      .mockResolvedValueOnce(new Response('PK', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.downloadFile('token', { fileId: 'pdf-1' })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await google.drive.downloadFile('token', { fileId: 'doc-1', exportAs: 'application/pdf' });
    await expect(google.drive.downloadFile('token', { fileId: 'pdf-1' })).rejects.toMatchObject({ status: 403, message: 'Request had insufficient authentication scopes.' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.googleapis.com/drive/v3/files/pdf-1?alt=media&supportsAllDrives=true');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.googleapis.com/drive/v3/files/doc-1/export?mimeType=application%2Fpdf');
  });

  it('creates a Source Message folder without looking for a same-named one', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'message-folder' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.createFolder('token', { name: '2026-08-01 年次行事', parentId: 'leaf' })).resolves.toBe('message-folder');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toMatchObject({ name: '2026-08-01 年次行事', parents: ['leaf'] });
  });

  it('writes every Calendar event with sendUpdates=none and the caller-supplied revision guard', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'calendar-1', etag: 'etag-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'calendar-1', etag: 'etag-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await google.calendar.createEvent('token', { summary: '例会', attachments: [{ fileUrl: 'https://drive.example/f' }] });
    await google.calendar.patchEvent('token', 'calendar-1', { description: 'x' }, { etag: 'etag-1' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none&supportsAttachments=true');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-1?sendUpdates=none');
    expect(new Headers(fetchMock.mock.calls[1]?.[1].headers).get('If-Match')).toBe('etag-1');
  });

  it('throws a temporary failure, with the wait Google names, for a request Google cannot take now, and a refusal for one it never will', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Backend Error' } }), { status: 503, headers: { 'Retry-After': '7' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Internal Error' } }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403 }))
      .mockRejectedValueOnce(new TypeError('Network connection lost.'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Invalid start time.' } }), { status: 400 })));

    await expect(google.calendar.createEvent('token', { summary: '例会' }))
      .rejects.toMatchObject({ name: 'TemporaryFailure', status: 503, retryAfterSeconds: 7, performed: 'no' } satisfies Partial<TemporaryFailure>);
    await expect(google.calendar.createEvent('token', { summary: '例会' }))
      .rejects.toMatchObject({ name: 'TemporaryFailure', status: 500, retryAfterSeconds: null, performed: 'unknown' } satisfies Partial<TemporaryFailure>);
    await expect(google.calendar.createEvent('token', { summary: '例会' }))
      .rejects.toMatchObject({ name: 'TemporaryFailure', status: 403, performed: 'no' } satisfies Partial<TemporaryFailure>);
    await expect(google.gmail.sendMail('token', { destination: 'office@example.com', subject: '件名', body: '本文' }))
      .rejects.toMatchObject({ name: 'TemporaryFailure', status: null, performed: 'unknown', message: 'Google did not answer: Network connection lost.' } satisfies Partial<TemporaryFailure>);
    const refused = google.calendar.createEvent('token', { summary: '例会' });
    await expect(refused).rejects.toBeInstanceOf(GoogleApiError);
    await expect(refused).rejects.toMatchObject({ status: 400, message: 'Invalid start time.' });
  });

  it('reads a Gmail attachment back to its bytes and reports a refusal with its status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: 'cGRm-LWJ5_dGVz' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 })));

    await expect(google.gmail.readAttachments('token', 'gmail-1', [attachment]))
      .resolves.toEqual([{ ...attachment, bytes: new Uint8Array(Buffer.from('cGRm+LWJ5/dGVz', 'base64')) }]);
    await expect(google.gmail.readMessage('token', 'missing')).rejects.toMatchObject({ status: 404, url: expect.stringContaining('/messages/missing') } satisfies Partial<GoogleApiError>);
  });

  it('reads a summary of a mail as its sender, subject, and date headers alone', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gmail-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await google.gmail.readMessage('token', 'gmail-1', 'summary');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/gmail-1?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
  });

  it('lists one page of a Gmail search and says where the next starts', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'gmail-1' }, { id: 'gmail-2' }], nextPageToken: 'page-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.gmail.searchMessages('token', { query: 'zoom', maxResults: 2, pageToken: 'page-1' }))
      .resolves.toEqual({ ids: ['gmail-1', 'gmail-2'], nextPageToken: 'page-2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=zoom&maxResults=2&pageToken=page-1');
  });

  it('waits out Gmail refusing too many requests, then reads, and throws a refusal that is not one', async () => {
    // Every test freezes only Date; this one also moves the clock Gmail's back-off waits on.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const throttled = () => new Response(JSON.stringify({ error: { message: 'Too many concurrent requests for user.' } }), { status: 429 });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(throttled())
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Backend Error' } }), { status: 503, headers: { 'Retry-After': '3' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gmail-1' }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      let started = Date.now();
      const read = google.gmail.readMessage('token', 'gmail-1');
      await vi.runAllTimersAsync();
      await expect(read).resolves.toEqual({ id: 'gmail-1' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // One second after the 429, then the three seconds the 503's Retry-After named.
      expect(Date.now() - started).toBe(4_000);

      fetchMock.mockReset().mockImplementation(async () => throttled());
      started = Date.now();
      const refused = expect(google.gmail.searchMessages('token', { query: 'zoom', maxResults: 50 })).rejects.toMatchObject({ status: 429 });
      await vi.runAllTimersAsync();
      await refused;
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(Date.now() - started).toBe(31_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends mail as one UTF-8 plain-text raw message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.gmail.sendMail('token', { destination: 'a@example.com', subject: '件名', body: '本文' })).resolves.toEqual({ id: 'sent-1' });

    const raw = (JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as { raw: string }).raw;
    const decoded = Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
    expect(decoded).toContain('To: a@example.com');
    expect(decoded).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decoded.endsWith('本文')).toBe(true);
  });

  it('sends mail carrying files as one multipart message to the upload endpoint, each file as its bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new Uint8Array(100).map((_, index) => index);

    await expect(google.gmail.sendMail('token', {
      destination: 'a@example.com', subject: '件名', body: '本文',
      files: [{ filename: '例会次第.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes }],
    })).resolves.toEqual({ id: 'sent-2' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media');
    expect(new Headers(init.headers).get('Content-Type')).toBe('message/rfc822');
    const message = String(init.body);
    const boundary = /boundary="([^"]+)"/u.exec(message)?.[1] ?? '';
    const [, text, file] = message.split(`--${boundary}`);
    expect(Buffer.from(text?.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8')).toBe('本文');
    expect(file).toContain(`filename*=UTF-8''${encodeURIComponent('例会次第.docx')}`);
    const encoded = file?.split('\r\n\r\n')[1] ?? '';
    expect(encoded.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(new Uint8Array(Buffer.from(encoded.replaceAll('\r\n', ''), 'base64'))).toEqual(bytes);
  });

  it('saves a draft as one raw message inside the draft, and one carrying files through the drafts upload endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'draft-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.gmail.createDraft('token', { destination: 'a@example.com', subject: '件名', body: '本文' })).resolves.toEqual({ id: 'draft-1' });
    await expect(google.gmail.createDraft('token', {
      destination: 'a@example.com', subject: '件名', body: '本文',
      files: [{ filename: '登録用紙.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new Uint8Array([1, 2, 3]) }],
    })).resolves.toEqual({ id: 'draft-2' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    const raw = (JSON.parse(init.body as string) as { message: { raw: string } }).message.raw;
    expect(Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')).toContain('To: a@example.com');
    const [uploadUrl, upload] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(uploadUrl).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media');
    expect(new Headers(upload.headers).get('Content-Type')).toBe('message/rfc822');
    expect(String(upload.body)).toContain(`filename*=UTF-8''${encodeURIComponent('登録用紙.docx')}`);
  });
});
