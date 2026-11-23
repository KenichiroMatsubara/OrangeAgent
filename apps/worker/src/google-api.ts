/**
 * The production Google adapter: Gmail, Calendar, Drive, Meet, and Tasks spoken over `fetch`.
 * URLs, encodings, and the `sendUpdates=none` rule live here and
 * nowhere else; a use-case asks for an operation and receives its result.
 */

import { fromBase64Url, toArrayBuffer, toBase64 } from './encoding';
import { refreshGoogleToken } from './google';
import { GoogleApiError } from './providers';
import { called, rateLimited, retryAfterSeconds, temporaryAnswer, TemporaryFailure } from './temporary';
import type {
  CalendarEventResource,
  DriveFileResource,
  GmailHistory,
  GmailMessage,
  GoogleProvider,
  MailFile,
  MeetConferenceResource,
  MeetParticipantResource,
  MeetSpaceResource,
  MeetTranscriptEntryResource,
  MeetTranscriptResource,
  PublishedDriveAttachment,
  ReusableDriveAttachment,
  SourceAttachment,
  SourceAttachmentContent,
  TaskListResource,
  TaskResource,
} from './providers';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MEET = 'https://meet.googleapis.com/v2';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';

interface GoogleErrorBody {
  error?: { message?: string; errors?: Array<{ reason?: string }> };
}

/** The reasons Google gives for a rate limit it answers with 403 rather than 429, which it asks clients to back off from. */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/**
 * What a Google answer that is not a success throws: a `TemporaryFailure` when
 * the same request may succeed later — a 408, 429, or 5xx, or a 403 Google
 * names a rate limit — with the Retry-After it named, and otherwise the
 * `GoogleApiError` its status and message are.
 */
const refusal = (response: Response, body: GoogleErrorBody, url: string): Error => {
  const retryAfter = retryAfterSeconds(response.headers.get('Retry-After'));
  const temporary = temporaryAnswer('Google', response, retryAfter);
  if (temporary) return temporary;
  if (response.status === 403 && (body.error?.errors ?? []).some(({ reason }) => RATE_LIMIT_REASONS.has(reason ?? ''))) {
    return rateLimited('Google', response.status, retryAfter);
  }
  return new GoogleApiError(body.error?.message ?? 'Google API request failed.', response.status, url);
};

const request = async <T>(token: string, url: string, init: RequestInit = {}): Promise<T> => {
  const response = await called('Google', () => fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  }));
  const body = await response.json().catch(() => ({})) as T & GoogleErrorBody;
  if (!response.ok) throw refusal(response, body, url);
  return body;
};

/** A file's bytes, read once as they arrive; a refusal is read as the JSON error Google answers with. */
const bytesRequest = async (token: string, url: string): Promise<Uint8Array> => {
  const response = await called('Google', () => fetch(url, { headers: { Authorization: `Bearer ${token}` } }));
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as GoogleErrorBody;
    throw refusal(response, body, url);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,trashed,shortcutDetails';

/** Gmail hands an attachment over as base64url inside JSON; it is read back to its bytes here, once. */
const attachmentBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) throw new Error('Gmail attachment data is not valid base64url.');
  return fromBase64Url(value);
};

/** A Drive multipart upload: the file's metadata as JSON, then the file as its bytes. */
const multipart = (boundary: string, metadata: string, mimeType: string, bytes: Uint8Array): Blob => new Blob([
  `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  toArrayBuffer(bytes),
  `\r\n--${boundary}--`,
]);

const base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Url = (value: string): string =>
  base64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** The single UTF-8 plain-text message body the Gmail send endpoint accepts. */
export const gmailRawMessage = (input: { destination: string; subject: string; body: string }): string =>
  base64Url([
    `To: ${input.destination}`,
    `Subject: =?UTF-8?B?${base64(input.subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body,
  ].join('\r\n'));

/** A header value as RFC 2047 words, so a Japanese filename survives every mail client. */
const encodedWord = (value: string): string => `=?UTF-8?B?${base64(value)}?=`;

/** A file's bytes as MIME base64, in lines of 76 characters. */
const mimeBase64 = (bytes: Uint8Array): string => toBase64(bytes).replace(/.{76}/gu, '$&\r\n');

/**
 * A UTF-8 plain-text message with files attached, as the RFC 822 bytes
 * Gmail's upload endpoint takes. Each file is base64 inside the message
 * because a mail carries a file no other way, and the message itself is sent
 * as it is rather than base64url inside JSON.
 */
export const gmailMessageWithFiles = (input: { destination: string; subject: string; body: string; files: readonly MailFile[] }): string => {
  const boundary = `flarechat-${crypto.randomUUID()}`;
  return [
    `To: ${input.destination}`,
    `Subject: ${encodedWord(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    mimeBase64(new TextEncoder().encode(input.body)),
    ...input.files.flatMap((file) => [
      `--${boundary}`,
      `Content-Type: ${file.mediaType}; name="${encodedWord(file.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodedWord(file.filename)}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      '',
      mimeBase64(file.bytes),
    ]),
    `--${boundary}--`,
    '',
  ].join('\r\n');
};

/** A value inside a quoted Drive search term. */
export const escapeDriveQueryValue = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const createFolder = async (token: string, input: { name: string; parentId: string }): Promise<string> => {
  const created = await request<{ id?: string }>(token, `${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    body: JSON.stringify({ name: input.name, mimeType: FOLDER_MIME_TYPE, parents: [input.parentId] }),
  });
  if (!created.id) throw new Error('Drive did not return a folder ID.');
  return created.id;
};

/**
 * Resolves one level of a folder path FlareChat keeps, such as the subfolder a
 * run names for a mail's files, reusing the folder this application created
 * there before. A folder the Account made by hand is passed over though the
 * grant lists it, and a same-named folder is created beside it, so a path
 * keeps resolving to the folders FlareChat made.
 */
const ensureFolder = async (token: string, input: { name: string; parentId: string }): Promise<string> => {
  const query = [
    `mimeType = '${FOLDER_MIME_TYPE}'`,
    `name = '${escapeDriveQueryValue(input.name)}'`,
    `'${escapeDriveQueryValue(input.parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');
  const url = `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,isAppAuthorized)')}&orderBy=${encodeURIComponent('createdTime')}&pageSize=100`;
  const found = await request<{ files?: Array<{ id?: string; isAppAuthorized?: boolean }> }>(token, url);
  return found.files?.find((folder) => folder.isAppAuthorized === true)?.id ?? createFolder(token, input);
};

/**
 * How a Gmail read waits out Gmail's per-user limits: a 429 (too many
 * requests, or too many at once) or a 500/503 is tried again after 1, 2, 4,
 * 8, then 16 seconds, or after the Retry-After Gmail names, as Gmail asks
 * clients to back off; any other refusal, and the last, is thrown, the last as
 * the temporary failure it still is.
 */
const GMAIL_RETRY_STATUSES = new Set([429, 500, 503]);
const GMAIL_RETRIES = 5;
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const gmailRead = async <T>(token: string, url: string): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await called('Google', () => fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
    const body = await response.json().catch(() => ({})) as T & GoogleErrorBody;
    if (response.ok) return body;
    if (!GMAIL_RETRY_STATUSES.has(response.status) || attempt >= GMAIL_RETRIES) throw refusal(response, body, url);
    const retryAfter = Number(response.headers.get('Retry-After'));
    await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2 ** attempt * 1_000);
  }
};

/** The headers a mail's summary is read from: who sent it, what it is about, and when. */
const SUMMARY_HEADERS = ['From', 'Subject', 'Date'];

/** One message whole, or as a summary: its headers above, snippet, and arrival, without its body or attachments. */
const messageUrl = (messageId: string, view: 'full' | 'summary'): string => {
  const url = new URL(`${GMAIL}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', view === 'summary' ? 'metadata' : 'full');
  if (view === 'summary') for (const name of SUMMARY_HEADERS) url.searchParams.append('metadataHeaders', name);
  return url.toString();
};

/** The most results Google Calendar returns in one page; every list reads page after page until it ends. */
const CALENDAR_PAGE = 2_500;

const calendarUrl = (path: string, parameters: Record<string, string>): string => {
  const url = new URL(path);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
};

/** Every item of a Meet list, read page after page under the key Meet answers it with. */
const meetList = async <T>(token: string, path: string, key: string, parameters: Record<string, string>): Promise<T[]> => {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await request<Record<string, unknown> & { nextPageToken?: string }>(token, calendarUrl(`${MEET}/${path}`, {
      ...parameters,
      ...(pageToken ? { pageToken } : {}),
    }));
    items.push(...(page[key] as T[] | undefined) ?? []);
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return items;
};

/** Every item of a Google Tasks list, read page after page, a hundred at a time, the most Google Tasks answers. */
const tasksList = async <T>(token: string, path: string, parameters: Record<string, string> = {}): Promise<T[]> => {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await request<{ items?: T[]; nextPageToken?: string }>(token, calendarUrl(`${TASKS}/${path}`, {
      ...parameters,
      maxResults: '100',
      ...(pageToken ? { pageToken } : {}),
    }));
    items.push(...page.items ?? []);
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return items;
};

const taskPath = (listId: string, taskId?: string): string =>
  `lists/${encodeURIComponent(listId)}/tasks${taskId === undefined ? '' : `/${encodeURIComponent(taskId)}`}`;

/** A Meet resource name as its path: each segment escaped, the slashes between them kept. */
const meetPath = (name: string): string => name.split('/').map(encodeURIComponent).join('/');

const TRANSCRIPTION_MASK = 'config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration';

export const googleApi = (): GoogleProvider => ({
  refreshToken: refreshGoogleToken,
  gmail: {
    listHistory: (token, input) => request<GmailHistory>(token, calendarUrl(`${GMAIL}/history`, {
      startHistoryId: input.startHistoryId,
      historyTypes: 'messageAdded',
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    })),
    currentHistoryId: async (token) => {
      const profile = await request<{ historyId?: string }>(token, `${GMAIL}/profile`);
      if (!profile.historyId) throw new Error('Gmail history position could not be captured.');
      return profile.historyId;
    },
    readMessage: (token, messageId, view = 'full') => gmailRead<GmailMessage>(token, messageUrl(messageId, view)),
    searchMessages: async (token, input) => {
      const list = await gmailRead<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>(token, calendarUrl(`${GMAIL}/messages`, {
        q: input.query,
        maxResults: String(input.maxResults),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      }));
      return {
        ids: (list.messages ?? []).flatMap((message) => message.id ? [message.id] : []),
        nextPageToken: list.nextPageToken || null,
      };
    },
    readAttachments: (token, messageId, attachments: SourceAttachment[]) => Promise.all(attachments.map(async (attachment): Promise<SourceAttachmentContent> => {
      const body = await request<{ data?: string }>(
        token,
        `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
      );
      if (!body.data) throw new Error('Gmail attachment has no downloadable data.');
      return { ...attachment, bytes: attachmentBytes(body.data) };
    })),
    sendMail: async (token, input) => {
      const sent = input.files?.length
        ? await request<{ id?: string }>(token, `${GMAIL_UPLOAD}/messages/send?uploadType=media`, {
          method: 'POST',
          headers: { 'Content-Type': 'message/rfc822' },
          body: gmailMessageWithFiles({ ...input, files: input.files }),
        })
        : await request<{ id?: string }>(token, `${GMAIL}/messages/send`, {
          method: 'POST',
          body: JSON.stringify({ raw: gmailRawMessage(input) }),
        });
      return { id: sent.id ?? null };
    },
    createDraft: async (token, input) => {
      const draft = input.files?.length
        ? await request<{ id?: string }>(token, `${GMAIL_UPLOAD}/drafts?uploadType=media`, {
          method: 'POST',
          headers: { 'Content-Type': 'message/rfc822' },
          body: gmailMessageWithFiles({ ...input, files: input.files }),
        })
        : await request<{ id?: string }>(token, `${GMAIL}/drafts`, {
          method: 'POST',
          body: JSON.stringify({ message: { raw: gmailRawMessage(input) } }),
        });
      return { id: draft.id ?? null };
    },
  },
  calendar: {
    listEvents: async (token, input) => {
      const items: CalendarEventResource[] = [];
      let pageToken: string | undefined;
      do {
        const list = await request<{ items?: CalendarEventResource[]; nextPageToken?: string }>(token, calendarUrl(CALENDAR_EVENTS, {
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          showDeleted: 'false',
          singleEvents: 'false',
          maxResults: String(CALENDAR_PAGE),
          ...(input.query ? { q: input.query } : {}),
          ...(pageToken ? { pageToken } : {}),
        }));
        items.push(...list.items ?? []);
        pageToken = list.nextPageToken;
      } while (pageToken);
      return items;
    },
    readEvent: (token, eventId) =>
      request<CalendarEventResource>(token, `${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`),
    createEvent: (token, event) => request<CalendarEventResource>(token, calendarUrl(CALENDAR_EVENTS, {
      sendUpdates: 'none',
      ...(Array.isArray(event.attachments) && event.attachments.length ? { supportsAttachments: 'true' } : {}),
    }), { method: 'POST', body: JSON.stringify(event) }),
    patchEvent: (token, eventId, event, options = {}) => request<CalendarEventResource>(
      token,
      calendarUrl(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
        sendUpdates: 'none',
        ...(Array.isArray(event.attachments) && event.attachments.length ? { supportsAttachments: 'true' } : {}),
      }),
      {
        method: 'PATCH',
        body: JSON.stringify(event),
        ...(options.etag ? { headers: { 'If-Match': options.etag } } : {}),
      },
    ),
  },
  drive: {
    ensureFolderPath: async (token, segments, from = 'root') => {
      let parentId = from;
      for (const segment of segments) parentId = await ensureFolder(token, { name: segment, parentId });
      return parentId;
    },
    createFolder,
    findPublishedAttachment: async (token, input): Promise<ReusableDriveAttachment | null> => {
      const query = [
        `name = '${escapeDriveQueryValue(input.filename)}'`,
        `'${escapeDriveQueryValue(input.folderId)}' in parents`,
        'trashed = false',
      ].join(' and ');
      const url = `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,webViewLink,isAppAuthorized)')}&pageSize=10`;
      try {
        const body = await request<{ files?: Array<{ id?: string; webViewLink?: string; isAppAuthorized?: boolean }> }>(token, url);
        // Only a file FlareChat published is linked again; one the Account put in the folder by hand is not public.
        const found = (body.files ?? []).find((file) => file.id && file.webViewLink && file.isAppAuthorized === true);
        return found?.id && found.webViewLink ? { driveFileId: found.id, publicUrl: found.webViewLink } : null;
      } catch (error) {
        // A lookup Drive could not answer now is tried again with its write, rather than read as no file and uploaded twice.
        if (error instanceof TemporaryFailure) throw error;
        return null;
      }
    },
    uploadFile: async (token, input) => {
      const boundary = `flarechat-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ name: input.filename, mimeType: input.mimeType, parents: [input.parentFolderId] });
      const uploaded = await request<{ id?: string; webViewLink?: string }>(
        token,
        `${DRIVE_UPLOAD}?uploadType=multipart&fields=id%2CwebViewLink`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipart(boundary, metadata, input.mimeType, input.bytes),
        },
      );
      if (!uploaded.id || !uploaded.webViewLink) throw new Error('Drive did not return the saved file.');
      return { driveFileId: uploaded.id, url: uploaded.webViewLink };
    },
    searchFiles: async (token, input) => {
      const url = new URL(DRIVE_FILES);
      url.search = new URLSearchParams({
        q: input.query,
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        pageSize: String(input.pageSize),
        ...(input.orderBy ? { orderBy: input.orderBy } : {}),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      }).toString();
      const body = await request<{ files?: DriveFileResource[]; nextPageToken?: string }>(token, url.toString());
      return { files: body.files ?? [], nextPageToken: body.nextPageToken ?? null };
    },
    readFile: (token, fileId) =>
      request<DriveFileResource>(token, `${DRIVE_FILES}/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`),
    downloadFile: (token, input) => bytesRequest(token, input.exportAs
      ? `${DRIVE_FILES}/${encodeURIComponent(input.fileId)}/export?mimeType=${encodeURIComponent(input.exportAs)}`
      : `${DRIVE_FILES}/${encodeURIComponent(input.fileId)}?alt=media&supportsAllDrives=true`),
    renderPdf: async (token, input) => {
      const boundary = `flarechat-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ name: input.filename, mimeType: input.convertTo });
      const copy = await request<{ id?: string }>(token, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart(boundary, metadata, input.mimeType, input.bytes),
      });
      if (!copy.id) throw new Error('Drive did not return the converted copy.');
      try {
        return await bytesRequest(token, `${DRIVE_FILES}/${encodeURIComponent(copy.id)}/export?mimeType=${encodeURIComponent('application/pdf')}`);
      } finally {
        // The copy is FlareChat's own, made for this one export, so nothing the Account keeps is touched.
        await fetch(`${DRIVE_FILES}/${encodeURIComponent(copy.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
      }
    },
    updateFile: (token, fileId, input) => {
      const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
      url.search = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: DRIVE_FILE_FIELDS,
        ...(input.addParents?.length ? { addParents: input.addParents.join(',') } : {}),
        ...(input.removeParents?.length ? { removeParents: input.removeParents.join(',') } : {}),
      }).toString();
      return request<DriveFileResource>(token, url.toString(), {
        method: 'PATCH',
        body: JSON.stringify({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.appProperties ? { appProperties: input.appProperties } : {}),
        }),
      });
    },
    /** A Drive URL is withheld unless the anyone-reader permission succeeds. */
    publishAttachment: async (token, input): Promise<PublishedDriveAttachment> => {
      let driveFileId: string | null = null;
      try {
        const boundary = `mail-automation-${crypto.randomUUID()}`;
        const metadata = JSON.stringify({
          name: input.attachment.filename,
          mimeType: input.attachment.mimeType,
          parents: [input.parentFolderId],
        });
        const uploaded = await request<{ id?: string; webViewLink?: string }>(
          token,
          `${DRIVE_UPLOAD}?uploadType=multipart&fields=id%2CwebViewLink`,
          {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body: multipart(boundary, metadata, input.attachment.mimeType, input.attachment.bytes),
          },
        );
        if (!uploaded.id) throw new Error('Drive did not return an attachment file ID.');
        driveFileId = uploaded.id;
        await request(token, `${DRIVE_FILES}/${encodeURIComponent(uploaded.id)}/permissions`, {
          method: 'POST',
          body: JSON.stringify({ type: 'anyone', role: 'reader' }),
        });
        if (!uploaded.webViewLink) throw new Error('Drive did not return a public attachment URL.');
        return { outcome: 'succeeded', driveFileId, publicUrl: uploaded.webViewLink };
      } catch {
        return { outcome: 'failed', driveFileId, publicUrl: null };
      }
    },
  },
  tasks: {
    listLists: (token) => tasksList<TaskListResource>(token, 'users/@me/lists'),
    createList: (token, title) => request<TaskListResource>(token, `${TASKS}/users/@me/lists`, { method: 'POST', body: JSON.stringify({ title }) }),
    // A task completed in Google's own apps is hidden as well as completed, so both are asked for together.
    listTasks: (token, input) => tasksList<TaskResource>(token, taskPath(input.listId), {
      showCompleted: String(input.completed),
      showHidden: String(input.completed),
      showDeleted: 'false',
      ...(input.dueMin ? { dueMin: input.dueMin } : {}),
      ...(input.dueMax ? { dueMax: input.dueMax } : {}),
      ...(input.updatedMin ? { updatedMin: input.updatedMin } : {}),
    }),
    createTask: (token, listId, task) => request<TaskResource>(token, `${TASKS}/${taskPath(listId)}`, { method: 'POST', body: JSON.stringify(task) }),
    patchTask: (token, listId, taskId, task) => request<TaskResource>(token, `${TASKS}/${taskPath(listId, taskId)}`, { method: 'PATCH', body: JSON.stringify(task) }),
  },
  meet: {
    listConferences: (token, input) => meetList<MeetConferenceResource>(token, 'conferenceRecords', 'conferenceRecords', {
      filter: `start_time>="${input.startFrom}" AND start_time<="${input.startTo}"`,
      pageSize: '100',
    }),
    readConference: (token, name) => request<MeetConferenceResource>(token, `${MEET}/${meetPath(name)}`),
    readSpace: (token, nameOrMeetingCode) => request<MeetSpaceResource>(
      token,
      `${MEET}/${meetPath(nameOrMeetingCode.startsWith('spaces/') ? nameOrMeetingCode : `spaces/${nameOrMeetingCode}`)}`,
    ),
    transcribeSpace: (token, name) => request<MeetSpaceResource>(token, calendarUrl(`${MEET}/${meetPath(name)}`, { updateMask: TRANSCRIPTION_MASK }), {
      method: 'PATCH',
      body: JSON.stringify({ config: { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } } }),
    }),
    listParticipants: (token, conference) => meetList<MeetParticipantResource>(token, `${meetPath(conference)}/participants`, 'participants', { pageSize: '250' }),
    listTranscripts: (token, conference) => meetList<MeetTranscriptResource>(token, `${meetPath(conference)}/transcripts`, 'transcripts', { pageSize: '100' }),
    listTranscriptEntries: (token, transcript) => meetList<MeetTranscriptEntryResource>(token, `${meetPath(transcript)}/entries`, 'transcriptEntries', { pageSize: '100' }),
  },
});
