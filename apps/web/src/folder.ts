/**
 * A Skill as a folder, the way Claude's Agent Skills write one: a SKILL.md at
 * the top whose front matter names the Skill and says when it applies and
 * whose body is its instructions, beside any files it points to — text,
 * scripts, images, documents, whatever they are. The Skill screen edits that
 * folder as a directory is edited, writing each file as its bytes when it is
 * saved, reads one or several from a folder or a ZIP file the Account
 * chooses, and writes them out as a ZIP file.
 */

import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  SKILL_INSTRUCTIONS_FILE,
  checkSkillDocument,
  isSkillName,
  checkSkillFolder,
  isSkillInstructionsPath,
  readSkillDocument,
  readSkillFilePath,
  sizeLabel,
  skillDocumentRefusalText,
  skillFileText,
  skillFileType,
  skillFolderRefusalText,
  writeSkillDocument,
  type Skill,
} from '@mail/domain';

import { api } from './api';

/** A file chosen in the browser, and the path it has where it was chosen. */
export interface ChosenFile {
  path: string;
  file: Blob;
}

/**
 * What one file of a folder on this screen holds: the file the Skill keeps,
 * unread until it is opened; a file read in from elsewhere, as its bytes; or
 * words written here.
 */
export type FolderBody =
  | { kind: 'kept'; from: string; size: number; mediaType: string }
  | { kind: 'read'; blob: Blob }
  | { kind: 'written'; content: string };

/** One file of a Skill's folder, by its path within it. */
export interface FolderFile {
  path: string;
  body: FolderBody;
}

/** One Skill folder found among chosen files: the folder's own path, and its files within it. */
export interface FoundFolder {
  folder: string;
  files: FolderFile[];
}

/** What was read from chosen files, and each file left out with why. */
export interface ReadFiles {
  files: FolderFile[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Fetches the bytes of a file the Skill keeps. */
export type KeptReader = (from: string) => Promise<Blob>;

/** What a folder saves as: the Skill its SKILL.md states, or why it cannot be saved. */
export type FolderResult = { accepted: true; name: string; title: string; description: string } | { accepted: false; message: string };

/** Whether a path is a Skill folder's own SKILL.md. */
export const isInstructionsFile = isSkillInstructionsPath;

/** What a new Skill's SKILL.md starts as. */
export const NEW_SKILL_DOCUMENT = '---\nname: \ndescription: \nmetadata:\n  display-name: \n---\n\n';

/** A Skill as the files it keeps. */
export const keptFolder = (skill: Pick<Skill, 'files'>): FolderFile[] =>
  skill.files.map((file) => ({ path: file.path, body: { kind: 'kept', from: file.path, size: file.size, mediaType: file.mediaType } }));

/** How many bytes a file is. */
export const sizeOf = (body: FolderBody): number => {
  if (body.kind === 'kept') return body.size;
  if (body.kind === 'read') return body.blob.size;
  return new TextEncoder().encode(body.content).byteLength;
};

/** The media type a file is kept under. */
export const mediaTypeOf = (file: FolderFile): string =>
  file.body.kind === 'kept' && file.body.from === file.path ? file.body.mediaType : skillFileType(file.path, file.body.kind === 'read' ? file.body.blob.type : undefined);

/** A file's bytes, wherever they are. */
export const bytesOf = async (body: FolderBody, kept: KeptReader): Promise<Uint8Array<ArrayBuffer>> => {
  if (body.kind === 'written') return new TextEncoder().encode(body.content);
  const blob = body.kind === 'read' ? body.blob : await kept(body.from);
  return new Uint8Array(await blob.arrayBuffer());
};

/** A file's words when it is text, or null when it is some other kind of file. */
export const textOf = async (body: FolderBody, kept: KeptReader): Promise<string | null> =>
  body.kind === 'written' ? body.content : skillFileText(await bytesOf(body, kept));

/** A file the system that made a folder or ZIP file left in it, such as `.DS_Store` or `__MACOSX/`. */
const isLeftover = (path: string): boolean => path.split('/').some((segment) => segment.startsWith('.') || segment === '__MACOSX');

/**
 * Takes chosen files as they are, of whatever kind, each under the path it
 * was chosen with. A hidden file is passed over silently; one too large or
 * that cannot be named is left out with the reason.
 */
export const readChosen = (chosen: readonly ChosenFile[]): ReadFiles => {
  const read: ReadFiles = { files: [], skipped: [] };
  for (const { path: chosenPath, file } of chosen) {
    const path = readSkillFilePath(chosenPath);
    if (path === null) {
      read.skipped.push({ path: chosenPath, reason: '使えない名前です' });
      continue;
    }
    if (isLeftover(path)) continue;
    read.files.push({ path, body: { kind: 'read', blob: file } });
  }
  return read;
};

/** The folder a path sits in, `''` for the top. */
export const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/');

/** Whether a path is a folder or within it. */
export const isWithin = (path: string, folder: string): boolean => folder === '' || path === folder || path.startsWith(`${folder}/`);

/**
 * Finds the Skill folders among read files: every folder holding a SKILL.md,
 * except one inside another such folder, where a SKILL.md is just one of the
 * outer Skill's files. Each file is given its path within its Skill; a file in
 * no Skill folder is named in `outside`.
 */
export const skillFolders = (files: readonly FolderFile[]): { folders: FoundFolder[]; outside: string[] } => {
  const roots = [...new Set(files.filter((file) => isInstructionsFile(file.path.split('/').at(-1) ?? '')).map((file) => parentOf(file.path)))]
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const outer: string[] = [];
  for (const root of roots) if (!outer.some((kept) => isWithin(root, kept))) outer.push(root);
  const folders: FoundFolder[] = outer.map((folder) => ({ folder, files: [] }));
  const outside: string[] = [];
  for (const file of files) {
    const found = folders.find(({ folder }) => isWithin(file.path, folder));
    if (found) found.files.push({ path: found.folder ? file.path.slice(found.folder.length + 1) : file.path, body: file.body });
    else outside.push(file.path);
  }
  return { folders, outside };
};

/** Reads a folder as the Skill its SKILL.md states, given the SKILL.md's words, or says why it cannot be saved as one. */
export const checkFolder = (files: readonly FolderFile[], document: string | null): FolderResult => {
  const folder = checkSkillFolder(files.map((file) => ({ path: file.path, size: sizeOf(file.body) })));
  if (!folder.accepted) return { accepted: false, message: skillFolderRefusalText(folder) };
  if (document === null) return { accepted: false, message: `${SKILL_INSTRUCTIONS_FILE} は UTF-8 のテキストにしてください。` };
  const read = checkSkillDocument(document);
  if (!read.accepted) return { accepted: false, message: skillDocumentRefusalText(read.reason) };
  return { accepted: true, name: read.name, title: read.title, description: read.description };
};

/** The words of a folder's own SKILL.md, or null when it has none or it is not text. */
export const documentOf = async (files: readonly FolderFile[], kept: KeptReader): Promise<string | null> => {
  const document = files.find((file) => isInstructionsFile(file.path));
  return document ? textOf(document.body, kept) : null;
};

/** A file as the Blob it is sent as: its bytes, under the media type it is kept under. */
export const blobOf = async (file: FolderFile, kept: KeptReader): Promise<Blob> =>
  new Blob([await bytesOf(file.body, kept)], { type: mediaTypeOf(file) });

/**
 * Writes a folder read from elsewhere into a Skill as a directory is copied
 * over: its SKILL.md first, which names the Skill, then every other file, one
 * at a time, then deletes each file the Skill held that the folder does not.
 * Given no Skill, it makes one from the folder's SKILL.md.
 */
export const writeFolder = async (accountId: string, skill: Skill | null, files: readonly FolderFile[]): Promise<Skill> => {
  const none: KeptReader = async () => new Blob();
  const document = files.find((file) => isInstructionsFile(file.path));
  if (!document) throw new Error(`${SKILL_INSTRUCTIONS_FILE} が入っていません。`);
  const sent = (blob: Blob): string => `送ったのは ${sizeLabel(blob.size)} です。`;
  const documentBlob = await blobOf(document, none);
  let saved = await writing(`${document.path} を${skill ? '書き込め' : 'スキルにでき'}ませんでした。`, sent(documentBlob), () => skill
    ? api.writeSkillFile(accountId, skill.id, SKILL_INSTRUCTIONS_FILE, documentBlob)
    : api.createSkill(accountId, documentBlob));
  for (const file of files) {
    if (file === document) continue;
    const blob = await blobOf(file, none);
    const id = saved.id;
    saved = await writing(`${file.path} を書き込めませんでした。`, sent(blob), () => api.writeSkillFile(accountId, id, file.path, blob));
  }
  for (const gone of saved.files.filter((kept) => !files.some((file) => file.path === kept.path))) {
    const id = saved.id;
    saved = await writing(`${gone.path} を削除できませんでした。`, '', () => api.removeSkillFile(accountId, id, gone.path));
  }
  return saved;
};

/** Runs one write of a folder, and when it is refused says which file it was, what was sent, and why. */
const writing = async (what: string, sent: string, write: () => Promise<Skill>): Promise<Skill> => {
  try {
    return await write();
  } catch (cause) {
    throw new Error([what, cause instanceof Error ? cause.message : '', sent].join(''));
  }
};

/** A folder name that every system accepts, made from a Skill's name. */
export const folderName = (name: string): string =>
  [...name.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/gu, '-').trim().replace(/^\.+/u, '')].slice(0, 80).join('').trim() || 'skill';

/** One folder to write into a ZIP file, every file as its bytes. */
export interface ZipFolder {
  folder: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
}

/** Every file of a folder as its bytes, for a ZIP file. */
export const zipFolderOf = async (folder: string, files: readonly FolderFile[], kept: KeptReader): Promise<ZipFolder> => ({
  folder,
  files: await Promise.all(files.map(async (file) => ({ path: file.path, bytes: await bytesOf(file.body, kept) }))),
});

/**
 * Writes folders as one ZIP file holding each under its own name, as Claude
 * takes a Skill folder in. Two folders of the same name are told apart by a
 * number.
 */
export const zipFolders = (folders: readonly ZipFolder[]): Uint8Array<ArrayBuffer> => {
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const { folder: base, files } of folders) {
    let folder = base;
    for (let count = 2; used.has(folder.toLowerCase()); count += 1) folder = `${base} (${count})`;
    used.add(folder.toLowerCase());
    for (const file of files) entries[`${folder}/${file.path}`] = file.bytes;
  }
  return zipSync(entries, { level: 6 });
};

/** A ZIP entry's name as UTF-8 even when the tool that wrote it did not say it is. */
const entryName = (name: string): string => {
  if ([...name].some((character) => character.charCodeAt(0) > 0xff)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(strToU8(name, true));
  } catch {
    return name;
  }
};

/** The files of a ZIP file, each under its path within it. Refuses a file that is not one. */
export const unzipChosen = async (file: Blob): Promise<ChosenFile[]> => {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('ZIP ファイルとして読めませんでした。');
  }
  return Object.entries(entries)
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, bytes]) => ({ path: entryName(name), file: new Blob([bytes.slice()]) }));
};

/**
 * A folder read from elsewhere as one this screen can save: when its SKILL.md
 * names no Skill, the folder's name is written into it, so a folder made by
 * hand still reads as the Skill it is named after. Returns the folder and its
 * SKILL.md's words, or null for them when it has none that is text.
 */
export const namedFolder = async (found: FoundFolder, fallback: string): Promise<{ files: FolderFile[]; document: string | null }> => {
  const document = await documentOf(found.files, async () => new Blob());
  if (document === null) return { files: found.files, document };
  const read = readSkillDocument(document);
  if (read.name?.trim()) return { files: found.files, document };
  const folder = found.folder.split('/').at(-1) || fallback;
  // A folder's name that Agent Skills cannot take as a Skill's, such as a Japanese one, becomes its title.
  const name = isSkillName(folder) ? folder : `skill-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const written = writeSkillDocument({ name, title: read.title ?? folder, description: read.description ?? '', instructions: read.instructions, metadata: read.metadata });
  return {
    files: found.files.map((file) => isInstructionsFile(file.path) ? { path: SKILL_INSTRUCTIONS_FILE, body: { kind: 'written', content: written } } : file),
    document: written,
  };
};

/** Hands the browser a file to save. */
export const saveFile = (bytes: BlobPart, filename: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
