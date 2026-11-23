/**
 * The providers the automation is built from.
 *
 * Each provider is one adapter that owns its URLs, its authentication, and its
 * transport, and speaks in the operations the product performs rather than in
 * request and response shapes. A use-case receives the set and never reaches a
 * provider by any other path, so a test substitutes an in-memory twin of the
 * same interface instead of stubbing the global `fetch` around it.
 */

import { completeTurn } from './model';
import type { ModelCompletion, ModelRequest, TurnEvent } from './turns';
import type { CalendarAttendee } from './calendar';
import type { GoogleTokenSet } from './google';
import { googleApi } from './google-api';
import { openRouterTranscription, type TranscriptionProvider } from './transcription';

export interface GmailPart {
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  labelIds?: string[];
  payload?: GmailPart;
  snippet?: string;
  /** Gmail's delivery timestamp as epoch milliseconds. */
  internalDate?: string;
}

export interface GmailHistory {
  historyId?: string;
  nextPageToken?: string;
  /** Each record's `id` is a history position a later read may start after. */
  history?: Array<{ id?: string; messagesAdded?: Array<{ message?: { id?: string } }> }>;
}

export interface CalendarTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEventResource {
  id?: string;
  etag?: string;
  /** `cancelled` once the event was deleted. */
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  attendees?: CalendarAttendee[];
  /** The Google Meet link the event carries, when it has one. */
  hangoutLink?: string;
}

/** One attachment part of a Source Message, before its bytes are read. */
export interface SourceAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** An attachment with its bytes. */
export interface SourceAttachmentContent extends SourceAttachment {
  bytes: Uint8Array;
}

/** A Public Attachment as Drive reports it, or the failure that withheld its link. */
export interface PublishedDriveAttachment {
  outcome: 'succeeded' | 'failed';
  driveFileId: string | null;
  publicUrl: string | null;
}

export interface ReusableDriveAttachment {
  driveFileId: string;
  publicUrl: string;
}

/** One file or folder of the Drive, as Drive describes it. */
export interface DriveFileResource {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  /** Bytes, as a decimal string; absent for a Google Docs, Sheets, or Slides file and for a folder. */
  size?: string;
  parents?: string[];
  webViewLink?: string;
  /** Whether it is in Google's own trash. */
  trashed?: boolean;
  /** What a shortcut points at, for a file whose type is a shortcut. */
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

/** A Meet meeting space: the room a meeting link opens, held across every meeting in it. */
export interface MeetSpaceResource {
  /** `spaces/{id}`. */
  name?: string;
  meetingUri?: string;
  meetingCode?: string;
  config?: { artifactConfig?: { transcriptionConfig?: { autoTranscriptionGeneration?: string } } };
}

/** One meeting held in a space, from its start to its end. */
export interface MeetConferenceResource {
  /** `conferenceRecords/{id}`. */
  name?: string;
  startTime?: string;
  /** Absent while the meeting goes on. */
  endTime?: string;
  /** `spaces/{id}`. */
  space?: string;
}

/** Someone who joined one meeting. */
export interface MeetParticipantResource {
  /** `conferenceRecords/{id}/participants/{id}`. */
  name?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

/** One transcript of a meeting: transcription started and stopped once. */
export interface MeetTranscriptResource {
  /** `conferenceRecords/{id}/transcripts/{id}`. */
  name?: string;
  /** `STARTED`, `ENDED`, or `FILE_GENERATED`. */
  state?: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: { document?: string; exportUri?: string };
}

/** One utterance of a transcript. */
export interface MeetTranscriptEntryResource {
  /** The participant who spoke, `conferenceRecords/{id}/participants/{id}`. */
  participant?: string;
  text?: string;
  languageCode?: string;
  startTime?: string;
  endTime?: string;
}

/** One task list of Google Tasks. */
export interface TaskListResource {
  id?: string;
  title?: string;
}

/** One task of Google Tasks, as Google describes it. */
export interface TaskResource {
  id?: string;
  title?: string;
  notes?: string;
  /** `needsAction` until it is done, then `completed`. */
  status?: string;
  /** The day it is due, as midnight UTC of that day: Google Tasks keeps no time of day. */
  due?: string;
  /** When it was completed. */
  completed?: string;
  updated?: string;
  deleted?: boolean;
  webViewLink?: string;
}

/** A Google refusal, with the status and the operation the caller needs to classify it. */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.url = url;
  }
}

/** Everything the product does at Google, in the product's own words. */
/** A file a sent mail carries. */
export interface MailFile {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface GoogleProvider {
  /** Given `scopes`, the access token returned is narrowed to them, as one handed to a browser is. */
  refreshToken(input: { refreshToken: string; clientId: string; clientSecret: string; scopes?: readonly string[] }): Promise<GoogleTokenSet>;
  gmail: {
    listHistory(token: string, input: { startHistoryId: string; pageToken?: string }): Promise<GmailHistory>;
    currentHistoryId(token: string): Promise<string>;
    /** The whole message; or, as `summary`, only its sender, subject, date, and snippet, which is all a search lists. */
    readMessage(token: string, messageId: string, view?: 'full' | 'summary'): Promise<GmailMessage>;
    /** One page of the messages the query matches, newest first: at most `maxResults`, from `pageToken` on, and where the next page starts, or null after the last. */
    searchMessages(token: string, input: { query: string; maxResults: number; pageToken?: string }): Promise<{ ids: string[]; nextPageToken: string | null }>;
    readAttachments(token: string, messageId: string, attachments: SourceAttachment[]): Promise<SourceAttachmentContent[]>;
    /** Given files, the mail carries each as an attachment. */
    sendMail(token: string, input: { destination: string; subject: string; body: string; files?: readonly MailFile[] }): Promise<{ id: string | null }>;
    /** Saves the same mail as a draft in the mailbox, sent by nobody until a person sends it from Gmail. */
    createDraft(token: string, input: { destination: string; subject: string; body: string; files?: readonly MailFile[] }): Promise<{ id: string | null }>;
  };
  calendar: {
    /** Every event between the two times, matching the query when one is given. */
    listEvents(token: string, input: { timeMin: string; timeMax: string; query?: string }): Promise<CalendarEventResource[]>;
    readEvent(token: string, eventId: string): Promise<CalendarEventResource>;
    /** Creates an event with `sendUpdates=none`; Google never mails an attendee on the automation's behalf. */
    createEvent(token: string, event: Record<string, unknown>): Promise<CalendarEventResource>;
    /** Patches an event with `sendUpdates=none`, guarded by the revision the caller last saw when one is given. */
    patchEvent(token: string, eventId: string, event: Record<string, unknown>, options?: { etag?: string | null }): Promise<CalendarEventResource>;
  };
  drive: {
    /** The folder at this path beneath the parent, the top of My Drive unless named: each level a folder OrangeAgent made there before, or made now. */
    ensureFolderPath(token: string, segments: readonly string[], parentId?: string): Promise<string>;
    createFolder(token: string, input: { name: string; parentId: string }): Promise<string>;
    findPublishedAttachment(token: string, input: { filename: string; folderId: string }): Promise<ReusableDriveAttachment | null>;
    publishAttachment(token: string, input: { attachment: SourceAttachmentContent; parentFolderId: string }): Promise<PublishedDriveAttachment>;
    /** Uploads one file into a folder, readable only as the folder is: nothing is shared. */
    uploadFile(token: string, input: { filename: string; mimeType: string; bytes: Uint8Array; parentFolderId: string }): Promise<{ driveFileId: string; url: string }>;
    /** One page of the files a Drive search query finds, in the order named when one is. */
    searchFiles(token: string, input: { query: string; orderBy?: string; pageSize: number; pageToken?: string }): Promise<{ files: DriveFileResource[]; nextPageToken: string | null }>;
    readFile(token: string, fileId: string): Promise<DriveFileResource>;
    /** A file's bytes as Drive holds them, or a Google Docs, Sheets, or Slides file exported as the type named. */
    downloadFile(token: string, input: { fileId: string; exportAs?: string }): Promise<Uint8Array>;
    /**
     * Renames a file, moves it between folders, or labels it, and answers what it
     * now is. Nothing here deletes or trashes a file.
     */
    updateFile(token: string, fileId: string, input: { name?: string; addParents?: readonly string[]; removeParents?: readonly string[]; appProperties?: Record<string, string> }): Promise<DriveFileResource>;
    /**
     * A Word, Excel, or PowerPoint file as Google renders it to a PDF: uploaded
     * as a Google Docs, Sheets, or Slides copy, exported, and the copy removed.
     * That copy, made a moment before, is the one file the product ever deletes.
     */
    renderPdf(token: string, input: { filename: string; mimeType: string; bytes: Uint8Array; convertTo: string }): Promise<Uint8Array>;
  };
  tasks: {
    /** Every task list of the Google account. */
    listLists(token: string): Promise<TaskListResource[]>;
    createList(token: string, title: string): Promise<TaskListResource>;
    renameList(token: string, listId: string, title: string): Promise<TaskListResource>;
    /**
     * Every task of one list that is not deleted, read page after page: the
     * open ones, and with `completed` the completed ones too, those completed
     * in Google's own apps included. Bounded by due day and by when it last
     * changed when either is named.
     */
    listTasks(token: string, input: { listId: string; completed: boolean; dueMin?: string; dueMax?: string; updatedMin?: string }): Promise<TaskResource[]>;
    createTask(token: string, listId: string, task: Record<string, unknown>): Promise<TaskResource>;
    patchTask(token: string, listId: string, taskId: string, task: Record<string, unknown>): Promise<TaskResource>;
  };
  meet: {
    /** Every meeting that started between the two times, newest first, among those the Account held or joined. */
    listConferences(token: string, input: { startFrom: string; startTo: string }): Promise<MeetConferenceResource[]>;
    readConference(token: string, name: string): Promise<MeetConferenceResource>;
    /** A space by its name or by its meeting code. */
    readSpace(token: string, nameOrMeetingCode: string): Promise<MeetSpaceResource>;
    /** Turns on the space's automatic transcription, for every meeting held in it from now on. */
    transcribeSpace(token: string, name: string): Promise<MeetSpaceResource>;
    listParticipants(token: string, conference: string): Promise<MeetParticipantResource[]>;
    listTranscripts(token: string, conference: string): Promise<MeetTranscriptResource[]>;
    /** Every utterance of a transcript, in the order spoken. */
    listTranscriptEntries(token: string, transcript: string): Promise<MeetTranscriptEntryResource[]>;
  };
}

/** The model provider: one turn of any run, streamed when the caller is watching. */
export interface AiProvider {
  completeTurn: (request: ModelRequest, onEvent?: (event: TurnEvent) => void) => Promise<ModelCompletion>;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Providers {
  google: GoogleProvider;
  ai: AiProvider;
  /** OpenRouter's speech-to-text, which a recording sent to Operator Chat is transcribed through. */
  transcription: TranscriptionProvider;
  /** The transport the Channels and MCP clients send on; the Channel adapters own the URLs. */
  fetch: Fetch;
}

/** The one production provider set; every entrance builds its use-cases from it. */
export const productionProviders = (): Providers => ({
  google: googleApi(),
  ai: { completeTurn },
  transcription: openRouterTranscription(),
  fetch: (url, init) => fetch(url, init),
});
