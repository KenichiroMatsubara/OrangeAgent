import type { AutomationStatus, DriveFolders } from '@mail/domain';

import { now } from '../clock';
import { driveFolderIdOf, driveFolders, saveDriveFolders } from '../drive-folders';
import { beginInboxConnection, entryConfigurationError } from '../entry';
import { openInbox } from '../inbox';
import { GoogleApiError, type DriveFileResource, type Providers } from '../providers';
import { invalid, upstream } from '../refusal';
import { resource } from '../response';
import { createAccountStore } from '../storage/account-store';
import { accountRoute, created } from './account';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** The Automation Inbox, and where in its Drive runs reach. */
export const inboxRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/automation', accountRoute(async ({ db, session }): Promise<AutomationStatus | null> => {
    const automation = await createAccountStore(db).currentAutomation();
    return automation ? { ...automation, displayName: session.display_name } : null;
  }));

  routes.post('/organizations/:accountId/automation/reauthorize', accountRoute(async (request) => {
    const misconfigured = entryConfigurationError(request.env);
    if (misconfigured) throw upstream(misconfigured);
    return created({
      authorizationUrl: await beginInboxConnection(request.env, request.accountId),
    });
  }));

  routes.get('/organizations/:accountId/drive-folders', accountRoute(async ({ db }): Promise<DriveFolders> => ({ folders: await driveFolders(db) })));

  // A folder is added by its link and read from Drive once, so only a folder the grant can read is ever named, under the name it had.
  routes.post('/organizations/:accountId/drive-folders', accountRoute<{ link?: unknown }>(async ({ env, accountId, database, db, body }): Promise<DriveFolders> => {
    const folderId = typeof body.link === 'string' ? driveFolderIdOf(body.link) : null;
    if (!folderId) throw invalid('Google Drive のフォルダのリンクを貼ってください。');
    const automation = await createAccountStore(db).currentAutomation();
    if (!automation?.driveGranted) throw invalid('Drive を読み書きする許可がまだありません。接続画面でメールの受信箱をつなぎ直してください。');
    const folders = await driveFolders(db);
    if (folders.some((folder) => folder.id === folderId)) return { folders };
    const inbox = await openInbox({ env, accountId, database, google: providers.google });
    let found: DriveFileResource;
    try {
      found = await providers.google.drive.readFile(inbox.accessToken, folderId);
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) throw invalid('このフォルダは見つかりません。受信箱の Google アカウントで開けるフォルダか確かめてください。');
      throw error;
    }
    if (found.mimeType !== FOLDER_MIME_TYPE) throw invalid('このリンクはフォルダではありません。');
    const next = [...folders, { id: folderId, name: found.name ?? folderId, url: found.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}` }];
    await saveDriveFolders(db, next, now());
    return { folders: next };
  }));

  routes.delete('/organizations/:accountId/drive-folders/:folderId', accountRoute(async ({ db, params }): Promise<DriveFolders> => {
    const next = (await driveFolders(db)).filter((folder) => folder.id !== params.folderId);
    await saveDriveFolders(db, next, now());
    return { folders: next };
  }));

  return routes;
};
