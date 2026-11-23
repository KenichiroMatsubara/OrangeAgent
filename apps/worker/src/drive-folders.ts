import type { DriveFolder } from '@mail/domain';
import { eq } from 'drizzle-orm';

import { settings } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';

export const DRIVE_FOLDERS_SETTING = 'drive_folders';

/** The folder FlareChat keeps as the Account's trash, recorded once it has made one. */
export const DRIVE_TRASH_SETTING = 'drive_trash_folder';

const isFolder = (value: unknown): value is DriveFolder => {
  const folder = value as Partial<DriveFolder> | null;
  return typeof folder === 'object' && folder !== null && typeof folder.id === 'string' && typeof folder.name === 'string' && typeof folder.url === 'string';
};

/** The Drive folders runs reach beneath; none, as when nothing is stored, means the whole Drive. */
export const driveFolders = async (database: AccountDatabase): Promise<DriveFolder[]> => {
  const stored = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, DRIVE_FOLDERS_SETTING)).get();
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored.value);
    return Array.isArray(parsed) ? parsed.filter(isFolder) : [];
  } catch {
    return [];
  }
};

export const saveDriveFolders = async (database: AccountDatabase, folders: readonly DriveFolder[], updatedAt: string): Promise<void> => {
  const value = JSON.stringify(folders);
  await database.insert(settings).values({ key: DRIVE_FOLDERS_SETTING, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
};

/** The id of the folder FlareChat made as the Account's trash, or null before it has made one. */
export const driveTrashFolderId = async (database: AccountDatabase): Promise<string | null> =>
  (await database.select({ value: settings.value }).from(settings).where(eq(settings.key, DRIVE_TRASH_SETTING)).get())?.value ?? null;

export const saveDriveTrashFolderId = async (database: AccountDatabase, folderId: string, updatedAt: string): Promise<void> => {
  await database.insert(settings).values({ key: DRIVE_TRASH_SETTING, value: folderId, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value: folderId, updatedAt } }).run();
};

/**
 * The folder id a pasted Drive link names, such as one Drive's "リンクをコピー"
 * gives, or the id itself; null when it names none.
 */
export const driveFolderIdOf = (value: string): string | null => {
  const text = value.trim();
  if (/^[A-Za-z0-9_-]{10,}$/u.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname !== 'drive.google.com') return null;
  const id = /\/folders\/([A-Za-z0-9_-]+)/u.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
  return id && /^[A-Za-z0-9_-]{10,}$/u.test(id) ? id : null;
};
