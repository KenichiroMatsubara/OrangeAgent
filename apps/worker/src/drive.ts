/**
 * The Account's Google Drive as every run reaches it, through the Automation
 * Inbox's grant: finding and reading files, and filing them — making a folder,
 * moving or renaming a file, saving a file Claude wrote, and putting a file
 * away in OrangeAgent's own trash folder. Nothing deletes a file: putting one
 * away moves it, and Google's trash is never used.
 *
 * Where in the Drive a run reaches is its Drive Reach: the whole Drive, or
 * beneath the Drive Folders the Account named, and OrangeAgent's trash folder
 * with them, so a file put away can be found and moved back.
 */

import type { DriveFolder } from '@mail/domain';

import { driveFolders, driveTrashFolderId, saveDriveTrashFolderId } from './drive-folders';
import { escapeDriveQueryValue } from './google-api';
import { GoogleApiError, type DriveFileResource, type GoogleProvider } from './providers';
import { createAccountStore } from './storage/account-store';
import { accountDatabase } from './storage/database';
import { FileAnswer } from './turns';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

/** The folder at the top of My Drive that OrangeAgent puts files away in instead of deleting them. */
export const DRIVE_TRASH_FOLDER_NAME = 'OrangeAgent のゴミ箱';
/** The name the trash folder had while the product was called FlareChat. */
const FORMER_DRIVE_TRASH_FOLDER_NAME = 'FlareChat のゴミ箱';

/** The most of one Drive file a run is handed, the most a mail carries. */
export const MAX_DRIVE_FILE_BYTES = 25 * 1024 * 1024;

/** The most files one drive.search answers with, the most Drive lists at once. */
const MAX_DRIVE_PAGE = 1000;

/** The most folders above a file walked before it is taken to lie outside. */
const MAX_DRIVE_DEPTH = 100;

/**
 * What a Google Docs, Sheets, Slides, or Drawings file is read as, since Drive
 * holds no file for it: a document as Word and a spreadsheet as Excel, opened
 * as a mail's Word and Excel files are, and a presentation or a drawing as a PDF.
 */
const EXPORTS: Readonly<Record<string, { mediaType: string; extension: string }>> = {
  'application/vnd.google-apps.document': { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
  'application/vnd.google-apps.presentation': { mediaType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.drawing': { mediaType: 'application/pdf', extension: 'pdf' },
};

type Refusal = { isError: true; message: string };

const refused = (message: string): Refusal => ({ isError: true, message });

/**
 * Where in the Drive one run reaches: nothing unless the grant holds the whole
 * Drive, and then beneath the Account's Drive Folders, or everywhere when it
 * named none. The parents of each folder are asked of Drive once per run.
 */
export interface DriveReach {
  granted: boolean;
  folders: readonly DriveFolder[];
  /** OrangeAgent's trash folder, once it has made one. */
  trashId: string | null;
  parents: Map<string, Promise<string[]>>;
}

/** The Drive Reach the Account's grant and settings give a run now. */
export const driveReachOf = async (database: D1Database): Promise<DriveReach> => {
  const db = accountDatabase(database);
  const [automation, folders, trashId] = await Promise.all([createAccountStore(db).currentAutomation(), driveFolders(db), driveTrashFolderId(db)]);
  return { granted: automation?.driveGranted ?? false, folders, trashId, parents: new Map() };
};

/** What one Drive call needs: the provider, a token of the Automation Inbox, and the run's reach. */
export interface DriveSession {
  google: GoogleProvider;
  accessToken: string;
  reach: DriveReach;
}

/** A Drive file as every Drive tool answers with it. */
const driveSummary = (file: DriveFileResource) => ({
  id: file.id ?? '',
  name: file.name ?? '',
  mimeType: file.mimeType ?? '',
  folder: file.mimeType === FOLDER,
  modifiedTime: file.modifiedTime ?? null,
  size: file.size === undefined ? null : Number(file.size),
  parents: file.parents ?? [],
  url: file.webViewLink ?? null,
});

/** What a run is told when the grant reaches no more of the Drive than OrangeAgent's own files. */
const DRIVE_UNGRANTED = 'Google has not granted OrangeAgent permission to reach this Drive. The administrator reconnects the mail inbox on the 接続 (Connections) screen to grant it.';

/** Google refusing the Drive for want of a scope, told to the run as the grant it lacks rather than thrown. */
const driveRefusal = (error: unknown): Refusal => {
  if (error instanceof GoogleApiError && error.status === 403 && /scope/iu.test(error.message)) return refused(DRIVE_UNGRANTED);
  throw error;
};

/** Whether a Drive file is one of the reach's folders, or OrangeAgent's trash folder, or lies anywhere beneath one, found by walking up its parents. */
const beneath = async (session: DriveSession, file: DriveFileResource): Promise<boolean> => {
  if (!session.reach.folders.length) return true;
  const roots = new Set([...session.reach.folders.map((folder) => folder.id), ...(session.reach.trashId ? [session.reach.trashId] : [])]);
  if (file.id !== undefined && roots.has(file.id)) return true;
  const parentsOf = (id: string): Promise<string[]> => {
    const known = session.reach.parents.get(id);
    if (known) return known;
    // A folder the grant cannot read, such as one above a file shared with the Account, leads nowhere.
    const asked = session.google.drive.readFile(session.accessToken, id).then((folder) => folder.parents ?? [], () => []);
    session.reach.parents.set(id, asked);
    return asked;
  };
  const seen = new Set<string>();
  let level = file.parents ?? [];
  for (let depth = 0; level.length && depth < MAX_DRIVE_DEPTH; depth += 1) {
    if (level.some((id) => roots.has(id))) return true;
    for (const id of level) seen.add(id);
    level = [...new Set((await Promise.all(level.map(parentsOf))).flat())].filter((id) => !seen.has(id));
  }
  return false;
};

/** What a run is told of a file or folder outside the reach, naming where it may look instead. */
const outsideReach = (reach: DriveReach): Refusal => refused(
  `That is outside the Drive folders this Account lets you reach: ${reach.folders.map((folder) => `${folder.name} (${folder.id})`).join(', ')}. Look within them with drive.search, naming one as folderId.`,
);

/** The folders a bounded reach names, which every drive.search answer carries. */
const reachable = (reach: DriveReach) => reach.folders.length ? {
  reachableFolders: reach.folders.map(({ id, name }) => ({ id, name })),
  ...(reach.trashId ? { trashFolderId: reach.trashId } : {}),
} : {};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/**
 * drive.search: one page of the files and folders a Drive search query finds
 * within the run's reach, never those in Google's trash. Given a folder, it
 * lists what that folder holds, folders first and by name; otherwise the most
 * recently changed come first, except where the query searches the files'
 * contents, which Drive does not sort. A reach bounded to folders is named in
 * every answer, and a page searched outside a folder keeps only what lies
 * beneath them, so it may hold fewer files than asked for.
 */
export const searchDrive = async (session: DriveSession, arguments_: Record<string, unknown>) => {
  if (!session.reach.granted) return refused(DRIVE_UNGRANTED);
  const bounded = session.reach.folders.length > 0;
  const query = text(arguments_.query);
  const folderId = text(arguments_.folderId);
  const pageToken = text(arguments_.pageToken);
  const requested = Number(arguments_.maxResults);
  const pageSize = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_DRIVE_PAGE) : 100;
  const terms = ['trashed = false', ...(folderId ? [`'${escapeDriveQueryValue(folderId)}' in parents`] : []), ...(query ? [`(${query})`] : [])];
  const orderBy = /fullText/u.test(query) ? undefined : folderId && !query ? 'folder,name' : 'modifiedTime desc';
  try {
    if (bounded && folderId && !await beneath(session, await session.google.drive.readFile(session.accessToken, folderId))) return outsideReach(session.reach);
    const page = await session.google.drive.searchFiles(session.accessToken, {
      query: terms.join(' and '), pageSize, ...(orderBy ? { orderBy } : {}), ...(pageToken ? { pageToken } : {}),
    });
    // Everything a folder within the reach holds lies within it too.
    const inside = bounded && !folderId ? await Promise.all(page.files.map((file) => beneath(session, file))) : null;
    return {
      files: page.files.filter((_file, index) => inside?.[index] ?? true).map(driveSummary),
      nextPageToken: page.nextPageToken,
      ...reachable(session.reach),
    };
  } catch (error) {
    return driveRefusal(error);
  }
};

/**
 * drive.read: one Drive file as the file itself, handed to the model beside
 * its description as a mail's attachment is. A shortcut is read as the file it
 * points at, a Google Docs, Sheets, Slides, or Drawings file as its export, and
 * a folder is listed with drive.search instead. A file outside the run's reach,
 * or a shortcut that points outside it, is refused.
 */
export const readDriveFile = async (session: DriveSession, fileId: string): Promise<FileAnswer | Refusal> => {
  if (!session.reach.granted) return refused(DRIVE_UNGRANTED);
  if (!fileId) return refused('drive.read requires a fileId from drive.search.');
  try {
    const found = await session.google.drive.readFile(session.accessToken, fileId);
    const file = found.mimeType === SHORTCUT && found.shortcutDetails?.targetId
      ? await session.google.drive.readFile(session.accessToken, found.shortcutDetails.targetId)
      : found;
    if (!await beneath(session, file)) return outsideReach(session.reach);
    const summary = driveSummary(file);
    if (summary.folder) return refused(`${summary.name} is a folder. List what it holds with drive.search, naming it as folderId.`);
    const exported = EXPORTS[summary.mimeType];
    if (!exported && summary.mimeType.startsWith('application/vnd.google-apps.')) {
      return refused(`${summary.name} is a ${summary.mimeType} file, which Drive cannot hand over as a file. Open it from its link: ${summary.url ?? 'none'}.`);
    }
    if (summary.size !== null && summary.size > MAX_DRIVE_FILE_BYTES) {
      return refused(`${summary.name} holds ${summary.size} bytes; a run is handed at most ${MAX_DRIVE_FILE_BYTES} of one Drive file. Say so, and give its link: ${summary.url ?? 'none'}.`);
    }
    const bytes = await session.google.drive.downloadFile(session.accessToken, { fileId: summary.id, ...(exported ? { exportAs: exported.mediaType } : {}) });
    const filename = exported && !summary.name.toLowerCase().endsWith(`.${exported.extension}`) ? `${summary.name}.${exported.extension}` : summary.name;
    const mediaType = exported?.mediaType ?? summary.mimeType;
    return new FileAnswer(
      { ...summary, ...(exported ? { exportedAs: mediaType } : {}), file: { filename, mimeType: mediaType, size: bytes.byteLength } },
      [{ filename, mediaType, bytes }],
    );
  } catch (error) {
    return driveRefusal(error);
  }
};

/** A Drive write's call: every file and folder it touches named by its id and by the name drive.search answered with. */
export interface DriveWriteCall {
  fileId?: string;
  fileName?: string;
  folderId?: string;
  folderName?: string;
  name?: string;
}

const required = (tool: string, input: Record<string, unknown>, field: keyof DriveWriteCall): string => {
  const value = text(input[field]);
  if (!value) throw new Error(`${tool} requires ${field}.`);
  return value;
};

/**
 * Reads a Drive write's arguments the same way however the run applies it.
 * Each file and folder is named by its name as well as its id, so a person
 * approving a planned write reads names, and a write whose names no longer
 * match what Drive holds is refused when it is performed.
 */
export const driveWriteCall = (tool: 'drive.create_folder' | 'drive.move' | 'drive.rename' | 'drive.trash', input: Record<string, unknown>): DriveWriteCall => {
  switch (tool) {
    case 'drive.create_folder':
      return { name: required(tool, input, 'name'), folderId: required(tool, input, 'folderId'), folderName: required(tool, input, 'folderName') };
    case 'drive.move':
      return { fileId: required(tool, input, 'fileId'), fileName: required(tool, input, 'fileName'), folderId: required(tool, input, 'folderId'), folderName: required(tool, input, 'folderName') };
    case 'drive.rename':
      return { fileId: required(tool, input, 'fileId'), fileName: required(tool, input, 'fileName'), name: required(tool, input, 'name') };
    case 'drive.trash':
      return { fileId: required(tool, input, 'fileId'), fileName: required(tool, input, 'fileName') };
  }
};

/** The file a write names, read from Drive and checked against the name it was named by and the run's reach. */
const namedFile = async (session: DriveSession, id: string, name: string, kind: 'file' | 'folder'): Promise<DriveFileResource | Refusal> => {
  const file = await session.google.drive.readFile(session.accessToken, id);
  if (file.trashed) return refused(`${name} (${id}) is in Google's trash, which OrangeAgent does not reach.`);
  // The top of My Drive is named by Google in its own words, whatever the Account calls it.
  if (id !== 'root' && file.name !== name) return refused(`${id} is named ${JSON.stringify(file.name ?? '')} in Drive, not ${JSON.stringify(name)}. Find it again with drive.search.`);
  if (kind === 'folder' && file.mimeType !== FOLDER) return refused(`${name} (${id}) is not a folder.`);
  if (!await beneath(session, file)) return outsideReach(session.reach);
  return file;
};

const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && (value as Refusal).isError === true;

/** The folder a file is saved into, checked as any folder a write names is. */
export const writableFolder = async (session: DriveSession, folderId: string, folderName: string): Promise<Refusal | null> => {
  if (!session.reach.granted) return refused(DRIVE_UNGRANTED);
  try {
    const folder = await namedFile(session, folderId, folderName, 'folder');
    return isRefusal(folder) ? folder : null;
  } catch (error) {
    return driveRefusal(error);
  }
};

/**
 * OrangeAgent's trash folder, made at the top of My Drive the first time a file
 * is put away and recorded, and made again if it has since been removed. One
 * still named FlareChat のゴミ箱, from before the rename, is renamed and kept.
 */
const trashFolder = async (session: DriveSession, database: D1Database, at: Date): Promise<string> => {
  const recorded = session.reach.trashId;
  if (recorded) {
    const folder = await session.google.drive.readFile(session.accessToken, recorded).catch(() => null);
    if (folder && !folder.trashed) {
      if (folder.name !== FORMER_DRIVE_TRASH_FOLDER_NAME) return recorded;
      await session.google.drive.updateFile(session.accessToken, recorded, { name: DRIVE_TRASH_FOLDER_NAME }).catch(() => undefined);
      return recorded;
    }
  }
  const id = await session.google.drive.ensureFolderPath(session.accessToken, [DRIVE_TRASH_FOLDER_NAME]);
  await saveDriveTrashFolderId(accountDatabase(database), id, at.toISOString());
  session.reach.trashId = id;
  return id;
};

/**
 * Performs one Drive write already read by `driveWriteCall`: it makes a folder,
 * moves or renames a file, or puts one away in OrangeAgent's trash folder, which
 * moves it there and records where it was. OrangeAgent's trash folder itself is
 * never moved, renamed, or put away.
 */
export const performDriveWrite = async (
  session: DriveSession & { database: D1Database; at: Date },
  tool: 'drive.create_folder' | 'drive.move' | 'drive.rename' | 'drive.trash',
  call: DriveWriteCall,
): Promise<unknown> => {
  if (!session.reach.granted) return refused(DRIVE_UNGRANTED);
  const drive = session.google.drive;
  const token = session.accessToken;
  try {
    if (tool === 'drive.create_folder') {
      const parent = await namedFile(session, call.folderId!, call.folderName!, 'folder');
      if (isRefusal(parent)) return parent;
      const id = await drive.createFolder(token, { name: call.name!, parentId: call.folderId! });
      return { created: true, folder: driveSummary(await drive.readFile(token, id)) };
    }
    const file = await namedFile(session, call.fileId!, call.fileName!, 'file');
    if (isRefusal(file)) return file;
    if (file.id === session.reach.trashId) return refused(`${DRIVE_TRASH_FOLDER_NAME} is where OrangeAgent puts files away; it is never moved, renamed, or put away itself.`);
    const parents = file.parents ?? [];
    if (tool === 'drive.rename') return { renamed: true, file: driveSummary(await drive.updateFile(token, call.fileId!, { name: call.name! })) };
    if (tool === 'drive.move') {
      const folder = await namedFile(session, call.folderId!, call.folderName!, 'folder');
      if (isRefusal(folder)) return folder;
      const moved = await drive.updateFile(token, call.fileId!, { addParents: [call.folderId!], removeParents: parents.filter((parent) => parent !== call.folderId) });
      return { moved: true, file: driveSummary(moved) };
    }
    const trashId = await trashFolder(session, session.database, session.at);
    if (parents.includes(trashId)) return refused(`${call.fileName} is already in ${DRIVE_TRASH_FOLDER_NAME}.`);
    const moved = await drive.updateFile(token, call.fileId!, {
      addParents: [trashId], removeParents: parents, appProperties: { orangeagentPutAwayFrom: parents.join(',') },
    });
    return {
      putAway: true, deleted: false, file: driveSummary(moved), from: parents, trashFolder: { id: trashId, name: DRIVE_TRASH_FOLDER_NAME },
      note: `Nothing was deleted. It is in ${DRIVE_TRASH_FOLDER_NAME} and goes back with drive.move to the folder it came from.`,
    };
  } catch (error) {
    return driveRefusal(error);
  }
};
