/**
 * In-memory twins of the providers.
 *
 * A test states what Gmail holds, what the Calendar shows, and what the model
 * will answer, runs the use-case, and then reads what was sent and written back
 * — the same seam production crosses, with nothing stubbed around it.
 */

import { GoogleGrantRejectedError, type GoogleTokenSet } from '../src/google';
import { GoogleApiError } from '../src/providers';
import type {
  AiProvider,
  CalendarEventResource,
  DriveFileResource,
  Fetch,
  GmailMessage,
  GmailPart,
  GoogleProvider,
  MeetConferenceResource,
  MeetParticipantResource,
  MeetSpaceResource,
  MeetTranscriptEntryResource,
  MeetTranscriptResource,
  Providers,
  SourceAttachmentContent,
  TaskListResource,
  TaskResource,
} from '../src/providers';
import type { ModelCompletion, ModelRequest } from '../src/turns';
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResponse } from '../src/transcription';

export const gmailBody = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

export interface MemoryAttachment {
  attachmentId?: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface MemoryMessage {
  id: string;
  subject?: string;
  sender?: string;
  body?: string;
  /** A ready-made Gmail part tree, for messages whose shape is the point of the test. */
  payload?: GmailPart;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  attachments?: MemoryAttachment[];
}

const messagePayload = (message: MemoryMessage): GmailPart => {
  if (message.payload) return message.payload;
  const attachments = (message.attachments ?? []).map((attachment, index): GmailPart => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    body: {
      attachmentId: attachment.attachmentId ?? `attachment-${index + 1}`,
      size: attachment.bytes.byteLength,
    },
  }));
  const text: GmailPart = {
    mimeType: 'text/plain',
    body: { data: gmailBody(message.body ?? '') },
  };
  return {
    headers: [
      { name: 'Subject', value: message.subject ?? '' },
      { name: 'From', value: message.sender ?? 'member@example.com' },
    ],
    ...(attachments.length
      ? { mimeType: 'multipart/mixed', parts: [text, ...attachments] }
      : { mimeType: 'text/plain', body: { data: gmailBody(message.body ?? '') } }),
  };
};

export interface MemoryCalendarEvent extends CalendarEventResource {
  id: string;
}

type GoogleOperation = 'listHistory' | 'readMessage' | 'readAttachments' | 'sendMail' | 'createDraft' | 'listEvents' | 'readEvent' | 'createEvent' | 'patchEvent' | 'publishAttachment' | 'ensureFolderPath' | 'uploadFile' | 'createTask' | 'patchTask';

/** One task Google Tasks holds, in the list it is in. */
export interface MemoryTask extends TaskResource {
  id: string;
  listId: string;
}

/** A file of the Account's own Drive: its bytes, or for a Google Docs, Sheets, or Slides file, what each export answers. */
export interface MemoryDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  bytes?: Uint8Array;
  exports?: Record<string, Uint8Array>;
  shortcutTo?: string;
  appProperties?: Record<string, string>;
}

const driveResource = (file: MemoryDriveFile): DriveFileResource => ({
  id: file.id,
  name: file.name,
  mimeType: file.mimeType,
  modifiedTime: file.modifiedTime ?? '2026-10-01T00:00:00.000Z',
  parents: file.parents ?? ['root'],
  webViewLink: `https://drive.example/${file.id}`,
  ...(file.bytes ? { size: String(file.bytes.byteLength) } : {}),
  ...(file.shortcutTo ? { shortcutDetails: { targetId: file.shortcutTo } } : {}),
});

export interface MemoryGoogle extends GoogleProvider {
  mailbox: {
    historyId: string;
    /** Messages Gmail history reports as added, in order. */
    inbox: MemoryMessage[];
    /** Messages readable by id, whether or not history reports them. */
    messages: Map<string, MemoryMessage>;
    /** Ids Gmail answers 404 for, as a deleted message does. */
    missing: Set<string>;
    /** Whether the stored history cursor has fallen outside Gmail's window. */
    historyExpired: boolean;
    historyRequests: string[];
    sent: Array<{ destination: string; subject: string; body: string }>;
    /** Drafts saved and sent by nobody. */
    drafts: Array<{ destination: string; subject: string; body: string }>;
  };
  events: Map<string, MemoryCalendarEvent>;
  eventWrites: Array<{ operation: 'create' | 'patch'; id: string; body: Record<string, unknown>; etag: string | null }>;
  drive: GoogleProvider['drive'] & {
    files: Array<{ id: string; filename: string; folderId: string; url: string }>;
    folders: string[];
    publishFails: boolean;
    /** What the Account's own Drive holds, as drive.search and drive.read find it. */
    held: MemoryDriveFile[];
    /** Each search Drive was asked for. */
    searches: Array<{ query: string; orderBy: string | null; pageSize: number; pageToken: string | null }>;
  };
  tasks: GoogleProvider['tasks'] & {
    lists: Array<TaskListResource & { id: string; title: string }>;
    held: MemoryTask[];
    /** Each task created or changed, with what was sent. */
    writes: Array<{ operation: 'create' | 'patch'; listId: string; id: string; body: Record<string, unknown> }>;
  };
  meet: GoogleProvider['meet'] & {
    spaces: MeetSpaceResource[];
    /** The spaces the Account owns, the only ones whose settings it may change. */
    owned: Set<string>;
    conferences: MeetConferenceResource[];
    /** Keyed by conference, then by transcript. */
    participants: Map<string, MeetParticipantResource[]>;
    transcripts: Map<string, MeetTranscriptResource[]>;
    entries: Map<string, MeetTranscriptEntryResource[]>;
    /** Each window meetings were listed in. */
    listed: Array<{ startFrom: string; startTo: string }>;
  };
  tokens: {
    refreshed: number;
    /** The scopes each refresh asked to be narrowed to, or null when it asked for the whole grant. */
    narrowedTo: Array<readonly string[] | null>;
    rejectGrant: boolean;
    refreshError: Error | null;
  };
  /** Makes the named operation throw once, with the error given. */
  failNext(operation: GoogleOperation, error: Error): void;
  addMessage(message: MemoryMessage): void;
  addEvent(event: Omit<MemoryCalendarEvent, 'etag'> & { etag?: string }): MemoryCalendarEvent;
}

export const memoryGoogle = (): MemoryGoogle => {
  const failures = new Map<GoogleOperation, Error>();
  const failing = (operation: GoogleOperation): void => {
    const error = failures.get(operation);
    if (!error) return;
    failures.delete(operation);
    throw error;
  };
  let eventCounter = 0;
  let etagCounter = 0;
  const nextEtag = (): string => `etag-${++etagCounter}`;
  // Each task write happens a second after the one before, so a test can tell their order.
  let taskSeconds = 0;
  const taskClock = (): string => new Date(Date.now() + ++taskSeconds * 1_000).toISOString();
  const google: MemoryGoogle = {
    mailbox: {
      historyId: 'history-1',
      inbox: [],
      messages: new Map(),
      missing: new Set(),
      historyExpired: false,
      historyRequests: [],
      sent: [],
      drafts: [],
    },
    events: new Map(),
    eventWrites: [],
    tokens: { refreshed: 0, narrowedTo: [], rejectGrant: false, refreshError: null },
    failNext: (operation, error) => { failures.set(operation, error); },
    addMessage: (message) => {
      google.mailbox.inbox.push(message);
      google.mailbox.messages.set(message.id, message);
    },
    addEvent: (event) => {
      const stored: MemoryCalendarEvent = { ...event, etag: event.etag ?? nextEtag() };
      google.events.set(stored.id, stored);
      return stored;
    },
    refreshToken: async (input): Promise<GoogleTokenSet> => {
      if (google.tokens.rejectGrant) throw new GoogleGrantRejectedError('invalid_grant', 'Token has been expired or revoked.');
      if (google.tokens.refreshError) throw google.tokens.refreshError;
      google.tokens.refreshed += 1;
      google.tokens.narrowedTo.push(input.scopes ?? null);
      return {
        accessToken: `access-token-${google.tokens.refreshed}`,
        refreshToken: 'refresh-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: [...input.scopes ?? []],
        tokenType: 'Bearer',
      };
    },
    gmail: {
      listHistory: async (_token, input) => {
        failing('listHistory');
        google.mailbox.historyRequests.push(input.startHistoryId);
        if (google.mailbox.historyExpired) throw new GoogleApiError('Requested entity was not found.', 404, 'history');
        return {
          historyId: google.mailbox.historyId,
          history: google.mailbox.inbox.map((message) => ({ id: `history-of-${message.id}`, messagesAdded: [{ message: { id: message.id } }] })),
        };
      },
      currentHistoryId: async () => google.mailbox.historyId,
      readMessage: async (_token, messageId): Promise<GmailMessage> => {
        failing('readMessage');
        const message = google.mailbox.messages.get(messageId);
        if (!message || google.mailbox.missing.has(messageId)) {
          throw new GoogleApiError('Requested entity was not found.', 404, `/messages/${encodeURIComponent(messageId)}`);
        }
        return {
          id: message.id,
          ...(message.labelIds === undefined ? {} : { labelIds: message.labelIds }),
          ...(message.internalDate === undefined ? {} : { internalDate: message.internalDate }),
          ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
          payload: messagePayload(message),
        };
      },
      // Gmail's subject search is forgiving about width and whitespace, so the
      // twin offers every message and leaves the exact match to the caller.
      searchMessages: async (_token, input) => {
        const ids = [...google.mailbox.messages.keys()];
        const start = Number(input.pageToken ?? 0);
        const end = start + input.maxResults;
        return { ids: ids.slice(start, end), nextPageToken: end < ids.length ? String(end) : null };
      },
      readAttachments: async (_token, messageId, attachments) => {
        failing('readAttachments');
        const message = google.mailbox.messages.get(messageId);
        return attachments.map((attachment): SourceAttachmentContent => {
          const stored = (message?.attachments ?? []).find((candidate, index) =>
            (candidate.attachmentId ?? `attachment-${index + 1}`) === attachment.attachmentId);
          if (!stored) throw new GoogleApiError('Attachment was not found.', 404, `/attachments/${attachment.attachmentId}`);
          return { ...attachment, bytes: stored.bytes };
        });
      },
      sendMail: async (_token, input) => {
        failing('sendMail');
        google.mailbox.sent.push(input);
        return { id: `sent-${google.mailbox.sent.length}` };
      },
      createDraft: async (_token, input) => {
        failing('createDraft');
        google.mailbox.drafts.push(input);
        return { id: `draft-${google.mailbox.drafts.length}` };
      },
    },
    calendar: {
      listEvents: async (_token, input) => {
        failing('listEvents');
        const min = Date.parse(input.timeMin);
        const max = Date.parse(input.timeMax);
        return [...google.events.values()].filter((event) => {
          const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : null;
          if (start !== null && (start < min || start > max)) return false;
          return !input.query || (event.description ?? '').includes(input.query);
        });
      },
      readEvent: async (_token, eventId) => {
        failing('readEvent');
        const event = google.events.get(eventId);
        if (!event) throw new GoogleApiError('Not Found', 404, `/events/${eventId}`);
        return event;
      },
      createEvent: async (_token, body) => {
        failing('createEvent');
        // As Google does, an id the caller chose is kept, and one the calendar already holds is refused.
        const chosen = typeof body.id === 'string' ? body.id : null;
        if (chosen && google.events.has(chosen)) throw new GoogleApiError('The requested identifier already exists.', 409, '/events');
        const id = chosen ?? `calendar-event-${++eventCounter}`;
        const stored: MemoryCalendarEvent = { ...(body as CalendarEventResource), id, etag: nextEtag() };
        google.events.set(id, stored);
        google.eventWrites.push({ operation: 'create', id, body, etag: null });
        return stored;
      },
      patchEvent: async (_token, eventId, body, options = {}) => {
        failing('patchEvent');
        const current = google.events.get(eventId);
        if (!current) throw new GoogleApiError('Not Found', 404, `/events/${eventId}`);
        if (options.etag && current.etag !== options.etag) throw new GoogleApiError('Precondition Failed', 412, `/events/${eventId}`);
        const updated: MemoryCalendarEvent = { ...current, ...(body as CalendarEventResource), id: eventId, etag: nextEtag() };
        google.events.set(eventId, updated);
        google.eventWrites.push({ operation: 'patch', id: eventId, body, etag: options.etag ?? null });
        return updated;
      },
    },
    drive: {
      files: [],
      folders: [],
      publishFails: false,
      held: [],
      searches: [],
      searchFiles: async (_token, input) => {
        google.drive.searches.push({ query: input.query, orderBy: input.orderBy ?? null, pageSize: input.pageSize, pageToken: input.pageToken ?? null });
        const parent = /'([^']+)' in parents/u.exec(input.query)?.[1];
        const found = google.drive.held.filter((file) => !parent || (file.parents ?? ['root']).includes(parent));
        const start = Number(input.pageToken ?? 0);
        const end = start + input.pageSize;
        return { files: found.slice(start, end).map(driveResource), nextPageToken: end < found.length ? String(end) : null };
      },
      readFile: async (_token, fileId) => {
        const file = google.drive.held.find((held) => held.id === fileId);
        if (!file) throw new GoogleApiError('File not found.', 404, `/drive/v3/files/${fileId}`);
        return driveResource(file);
      },
      updateFile: async (_token, fileId, input) => {
        const file = google.drive.held.find((held) => held.id === fileId);
        if (!file) throw new GoogleApiError('File not found.', 404, `/drive/v3/files/${fileId}`);
        if (input.name !== undefined) file.name = input.name;
        const parents = (file.parents ?? ['root']).filter((parent) => !input.removeParents?.includes(parent));
        file.parents = [...parents, ...(input.addParents ?? [])];
        if (input.appProperties) file.appProperties = { ...file.appProperties, ...input.appProperties };
        return driveResource(file);
      },
      downloadFile: async (_token, input) => {
        const file = google.drive.held.find((held) => held.id === input.fileId);
        const bytes = input.exportAs ? file?.exports?.[input.exportAs] : file?.bytes;
        if (!bytes) throw new GoogleApiError('Export not available.', 400, `/drive/v3/files/${input.fileId}`);
        return bytes;
      },
      ensureFolderPath: async (_token, segments, parentId = 'root') => {
        failing('ensureFolderPath');
        const id = parentId === 'root' ? `folder:${segments.join('/')}` : `${parentId}/${segments.join('/')}`;
        if (!google.drive.folders.includes(id)) google.drive.folders.push(id);
        if (!google.drive.held.some((held) => held.id === id)) {
          google.drive.held.push({ id, name: segments.at(-1) ?? '', mimeType: 'application/vnd.google-apps.folder', ...(segments.length === 1 ? { parents: [parentId] } : {}) });
        }
        return id;
      },
      createFolder: async (_token, input) => {
        const id = `${input.parentId}/${input.name}`;
        google.drive.folders.push(id);
        google.drive.held.push({ id, name: input.name, mimeType: 'application/vnd.google-apps.folder', parents: [input.parentId] });
        return id;
      },
      findPublishedAttachment: async (_token, input) => {
        const found = google.drive.files.find((file) => file.filename === input.filename && file.folderId === input.folderId);
        return found ? { driveFileId: found.id, publicUrl: found.url } : null;
      },
      publishAttachment: async (_token, input) => {
        failing('publishAttachment');
        if (google.drive.publishFails) return { outcome: 'failed', driveFileId: null, publicUrl: null };
        const id = `drive-file-${google.drive.files.length + 1}`;
        const url = `https://drive.example/${encodeURIComponent(input.attachment.filename)}`;
        google.drive.files.push({ id, filename: input.attachment.filename, folderId: input.parentFolderId, url });
        return { outcome: 'succeeded', driveFileId: id, publicUrl: url };
      },
      uploadFile: async (_token, input) => {
        failing('uploadFile');
        const id = `drive-file-${google.drive.files.length + 1}`;
        const url = `https://drive.example/${encodeURIComponent(input.filename)}`;
        google.drive.files.push({ id, filename: input.filename, folderId: input.parentFolderId, url });
        return { driveFileId: id, url };
      },
      // Nothing is kept: the copy Google renders from is removed once it is exported.
      renderPdf: async (_token, input) => new TextEncoder().encode(`%PDF-1.7 ${input.filename} as ${input.convertTo}`),
    },
    tasks: {
      lists: [{ id: 'list-default', title: 'マイタスク' }],
      held: [],
      writes: [],
      listLists: async () => google.tasks.lists,
      createList: async (_token, title) => {
        const list = { id: `list-${google.tasks.lists.length + 1}`, title };
        google.tasks.lists.push(list);
        return list;
      },
      listTasks: async (_token, input) => {
        if (!google.tasks.lists.some((list) => list.id === input.listId)) throw new GoogleApiError('Task list not found.', 404, `/lists/${input.listId}/tasks`);
        return google.tasks.held.filter((task) => task.listId === input.listId && !task.deleted
          && (input.completed || task.status !== 'completed')
          && (!input.dueMin || (task.due !== undefined && task.due >= input.dueMin))
          && (!input.dueMax || (task.due !== undefined && task.due <= input.dueMax))
          && (!input.updatedMin || (task.updated ?? '') >= input.updatedMin));
      },
      createTask: async (_token, listId, body) => {
        failing('createTask');
        if (!google.tasks.lists.some((list) => list.id === listId)) throw new GoogleApiError('Task list not found.', 404, `/lists/${listId}/tasks`);
        const id = `task-${google.tasks.held.length + 1}`;
        const stored: MemoryTask = {
          status: 'needsAction', ...(body as TaskResource), id, listId,
          updated: taskClock(), webViewLink: `https://tasks.example/${id}`,
        };
        if (stored.status === 'completed') stored.completed = stored.updated ?? '';
        google.tasks.held.push(stored);
        google.tasks.writes.push({ operation: 'create', listId, id, body });
        return stored;
      },
      patchTask: async (_token, listId, taskId, body) => {
        failing('patchTask');
        const stored = google.tasks.held.find((task) => task.listId === listId && task.id === taskId && !task.deleted);
        if (!stored) throw new GoogleApiError('Task not found.', 404, `/lists/${listId}/tasks/${taskId}`);
        for (const [key, value] of Object.entries(body)) {
          if (value === null) delete (stored as unknown as Record<string, unknown>)[key];
          else (stored as unknown as Record<string, unknown>)[key] = value;
        }
        stored.updated = taskClock();
        if (stored.status === 'completed') stored.completed ??= stored.updated;
        else delete stored.completed;
        google.tasks.writes.push({ operation: 'patch', listId, id: taskId, body });
        return stored;
      },
    },
    meet: {
      spaces: [],
      owned: new Set(),
      conferences: [],
      participants: new Map(),
      transcripts: new Map(),
      entries: new Map(),
      listed: [],
      listConferences: async (_token, input) => {
        google.meet.listed.push(input);
        return google.meet.conferences
          .filter((conference) => (conference.startTime ?? '') >= input.startFrom && (conference.startTime ?? '') <= input.startTo)
          .sort((left, right) => (right.startTime ?? '').localeCompare(left.startTime ?? ''));
      },
      readConference: async (_token, name) => {
        const conference = google.meet.conferences.find((held) => held.name === name);
        if (!conference) throw new GoogleApiError('Not Found', 404, `/v2/${name}`);
        return conference;
      },
      readSpace: async (_token, nameOrMeetingCode) => {
        const space = google.meet.spaces.find((held) => held.name === nameOrMeetingCode || held.meetingCode === nameOrMeetingCode);
        if (!space) throw new GoogleApiError('Not Found', 404, `/v2/spaces/${nameOrMeetingCode}`);
        return space;
      },
      transcribeSpace: async (_token, name) => {
        const space = google.meet.spaces.find((held) => held.name === name);
        if (!space) throw new GoogleApiError('Not Found', 404, `/v2/${name}`);
        if (!google.meet.owned.has(name)) throw new GoogleApiError('The caller does not have permission', 403, `/v2/${name}`);
        space.config = { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } };
        return space;
      },
      listParticipants: async (_token, conference) => google.meet.participants.get(conference) ?? [],
      listTranscripts: async (_token, conference) => google.meet.transcripts.get(conference) ?? [],
      listTranscriptEntries: async (_token, transcript) => google.meet.entries.get(transcript) ?? [],
    },
  };
  return google;
};

export interface MemoryAi extends AiProvider {
  /** The answers the model gives, in order; the last one repeats. */
  turns: Array<ModelCompletion | Error | ((request: ModelRequest) => ModelCompletion)>;
  requests: ModelRequest[];
}

const nextAnswer = <T>(queue: T[]): T | undefined => queue.length > 1 ? queue.shift() : queue[0];

export const memoryAi = (): MemoryAi => {
  const ai: MemoryAi = {
    turns: [],
    requests: [],
    completeTurn: async (request) => {
      ai.requests.push(request);
      const answer = nextAnswer(ai.turns);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('The test model was given no turn to answer with.');
      return typeof answer === 'function' ? answer(request) : answer;
    },
  };
  return ai;
};

export interface MemoryTranscription extends TranscriptionProvider {
  /** The answers OpenRouter gives, in order; the last one repeats. */
  answers: Array<TranscriptionResponse | Error>;
  requests: TranscriptionRequest[];
}

export const memoryTranscription = (): MemoryTranscription => {
  const transcription: MemoryTranscription = {
    answers: [],
    requests: [],
    transcribe: async (request) => {
      transcription.requests.push(request);
      const answer = nextAnswer(transcription.answers);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('The test transcription was given no answer.');
      return answer;
    },
  };
  return transcription;
};

export interface RecordedSend {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MemoryTransport {
  fetch: Fetch;
  sends: RecordedSend[];
  /** Answers a URL containing the key with the given response, or the default. */
  answers: Array<{ match: string | RegExp; respond: (send: RecordedSend) => Response }>;
  /** The LINE push status the twin answers with. */
  lineStatus: number;
}

const defaultResponse = (send: RecordedSend): Response => {
  if (send.url.includes('api.line.me')) return new Response('', { status: 200, headers: { 'x-line-request-id': `line-${Date.now()}` } });
  if (send.url.includes('discord.com')) return Response.json({ id: `discord-${Date.now()}` });
  return Response.json({});
};

export const memoryTransport = (): MemoryTransport => {
  const transport: MemoryTransport = {
    sends: [],
    answers: [],
    lineStatus: 200,
    fetch: async (url, init = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
      const raw = typeof init.body === 'string' ? init.body : null;
      let body: unknown = raw;
      try {
        body = raw === null ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const send: RecordedSend = { url, method: init.method ?? 'GET', headers, body };
      transport.sends.push(send);
      const answer = transport.answers.find(({ match }) => typeof match === 'string' ? url.includes(match) : match.test(url));
      if (answer) return answer.respond(send);
      if (url.includes('api.line.me') && transport.lineStatus !== 200) return new Response('', { status: transport.lineStatus });
      return defaultResponse(send);
    },
  };
  return transport;
};

export interface MemoryProviders extends Providers {
  google: MemoryGoogle;
  ai: MemoryAi;
  transcription: MemoryTranscription;
  transport: MemoryTransport;
}

export const memoryProviders = (): MemoryProviders => {
  const transport = memoryTransport();
  return { google: memoryGoogle(), ai: memoryAi(), transcription: memoryTranscription(), transport, fetch: transport.fetch };
};

