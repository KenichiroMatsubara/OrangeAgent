/**
 * What Operator Chat does with a file Claude wrote beyond keeping it: saving
 * it to the Account's Google Drive, in the folder Claude names, when Claude
 * calls `drive.save_file`, and rendering a Word, Excel, or PowerPoint file as
 * a PDF by Microsoft or Google rather than the sandbox (`drive.make_pdf`).
 */

import { FileAnswer, type GeneratedFile } from './turns';
import { readDriveFile, type DriveSession } from './drive';
import { renderPdfWithOffice } from './microsoft';
import type { GoogleProvider } from './providers';
import type { Bindings } from './types';

/** The folder at the top of My Drive a file a member saves from a conversation goes in when they choose none. */
export const CHAT_DRIVE_FOLDER_NAME = 'AI に聞く';

/** The one scope a token handed to the browser for Google Picker carries. */
export const PICKER_SCOPES: readonly string[] = ['https://www.googleapis.com/auth/drive.file'];

/** A Drive file or folder id as Google Picker hands it over. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/u;

/** Whether Google Picker is configured, without which no Drive file is attached and a file is saved into the AI に聞く folder. */
export const pickerConfigured = (env: Bindings): boolean => Boolean(env.GOOGLE_PICKER_API_KEY?.trim() && env.GOOGLE_PICKER_APP_ID?.trim());

/**
 * The Drive files a member picked with Google Picker to send with a message,
 * each as the file itself, read as `drive.read` reads one: a Google Docs,
 * Sheets, or Slides file as its export. The member chose each file there, so
 * the Drive Folders that bound what a run reaches do not bound these; a file
 * Drive cannot hand over is refused with why, in words.
 */
export const pickedDriveFiles = async (input: { google: GoogleProvider; accessToken: string; fileIds: readonly string[] }): Promise<File[]> => {
  const session: DriveSession = { google: input.google, accessToken: input.accessToken, reach: { granted: true, folders: [], trashId: null, parents: new Map() } };
  const read = await Promise.all(input.fileIds.map((fileId) => readDriveFile(session, fileId)));
  return read.flatMap((answer) => {
    if (!(answer instanceof FileAnswer)) throw new PickedFileRefused(answer.message);
    return answer.files.map((file) => new File([file.bytes.slice().buffer], file.filename, { type: file.mediaType }));
  });
};

/** A Drive file a member picked that cannot be sent, with Drive's reason. */
export class PickedFileRefused extends Error {
  constructor(reason: string) {
    super(`Drive のファイルを添付できませんでした。${reason}`);
    this.name = 'PickedFileRefused';
  }
}

/** Uploads one file into the Drive folder named. */
export const uploadFileToDrive = async (input: {
  file: GeneratedFile;
  folderId: string;
  google: GoogleProvider;
  accessToken: () => Promise<string>;
}): Promise<{ driveFileId: string; url: string }> => {
  const token = await input.accessToken();
  return input.google.drive.uploadFile(token, { filename: input.file.filename, mimeType: input.file.mediaType, bytes: input.file.bytes, parentFolderId: input.folderId });
};

/** What Google converts each kind of Office file into before rendering it as a PDF, by the extension its name ends in. */
const RENDERED: Readonly<Record<string, { mimeType: string; convertTo: string }>> = {
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', convertTo: 'application/vnd.google-apps.document' },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', convertTo: 'application/vnd.google-apps.spreadsheet' },
  pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', convertTo: 'application/vnd.google-apps.presentation' },
};

export type ChatPdf =
  | { made: true; filename: string; from: string; renderedBy: 'Microsoft Office' | 'Google Drive'; microsoftFailed?: string }
  | { isError: true; message: string };

/**
 * Renders a Word, Excel, or PowerPoint file Claude wrote as a PDF, whose
 * Japanese fonts the sandbox lacks: by Office for the web when the Account
 * connected a Microsoft account, so it is laid out as Office lays it out, and
 * otherwise, or when Microsoft fails, by Google Drive. The PDF is kept with
 * `keep`, named as the file was with `.pdf` in place of its extension.
 * Nothing is left in OneDrive or the Drive.
 */
export const renderFileAsPdf = async (input: {
  file: GeneratedFile;
  google: GoogleProvider;
  accessToken: () => Promise<string>;
  microsoftToken: () => Promise<string | null>;
  keep: (file: GeneratedFile) => Promise<void>;
}): Promise<ChatPdf> => {
  const { file } = input;
  const extension = /\.([^.]+)$/u.exec(file.filename)?.[1]?.toLowerCase() ?? '';
  const kind = RENDERED[extension];
  if (!kind) return { isError: true, message: `${file.filename} is not a Word, Excel, or PowerPoint file (.docx, .xlsx, .pptx), the only kinds drive.make_pdf renders.` };
  let microsoftFailed: string | undefined;
  let rendered: Uint8Array | null = null;
  try {
    const token = await input.microsoftToken();
    if (token) rendered = await renderPdfWithOffice(token, { extension, bytes: file.bytes });
  } catch (error) {
    microsoftFailed = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: 'microsoft_pdf_failed', message: microsoftFailed }));
  }
  const renderedBy = rendered ? 'Microsoft Office' : 'Google Drive';
  const bytes = rendered ?? await input.google.drive.renderPdf(await input.accessToken(), { filename: file.filename, bytes: file.bytes, ...kind });
  const filename = `${file.filename.slice(0, -extension.length)}pdf`;
  await input.keep({ filename, mediaType: 'application/pdf', bytes });
  return { made: true, filename, from: file.filename, renderedBy, ...(microsoftFailed ? { microsoftFailed } : {}) };
};
