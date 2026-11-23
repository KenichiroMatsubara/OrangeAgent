import { CHAT_ATTACHMENT_TYPES, type ChatDrivePicker } from '@mail/domain';

/**
 * Google Picker, with which a member of Operator Chat chooses a Drive file to
 * attach to a message or the Drive folder a file of a conversation is saved
 * in. Choosing a file or folder there is what lets this application, whose
 * token for Picker holds only `drive.file`, reach it.
 */

/** Google's loader for Picker; the only script the chat loads from elsewhere, and only when Picker is opened. */
const GAPI_URL = 'https://apis.google.com/js/api.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface PickedDocument {
  id: string;
  name?: string;
}

interface PickerResponse {
  action: string;
  docs?: PickedDocument[];
}

/** The kinds a message may carry, and Google's own documents, which Drive hands over as Word, Excel, or PDF. */
const ATTACHABLE_MIME_TYPES = [
  ...CHAT_ATTACHMENT_TYPES,
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
].join(',');

/** The part of Google Picker's API this screen uses. */
interface PickerApi {
  Action: { PICKED: string; CANCEL: string };
  ViewId: { FOLDERS: string; DOCS: string };
  Feature: { MULTISELECT_ENABLED: string };
  DocsView: new (viewId: string) => {
    setIncludeFolders(include: boolean): PickerView;
    setSelectFolderEnabled(enabled: boolean): PickerView;
    setMimeTypes(types: string): PickerView;
  };
  PickerBuilder: new () => PickerBuilder;
}

interface PickerView {
  setIncludeFolders(include: boolean): PickerView;
  setSelectFolderEnabled(enabled: boolean): PickerView;
  setMimeTypes(types: string): PickerView;
}

interface PickerBuilder {
  addView(view: PickerView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

interface GoogleWindow {
  gapi?: { load(name: string, callback: () => void): void };
  google?: { picker?: PickerApi };
}

let loading: Promise<PickerApi> | undefined;

const loadPicker = (): Promise<PickerApi> => {
  loading ??= new Promise<PickerApi>((resolve, reject) => {
    const scope = window as unknown as GoogleWindow;
    const ready = (): void => {
      if (!scope.gapi) return reject(new Error('Google Picker を読み込めませんでした。'));
      scope.gapi.load('picker', () => scope.google?.picker ? resolve(scope.google.picker) : reject(new Error('Google Picker を読み込めませんでした。')));
    };
    if (scope.gapi) return ready();
    const script = document.createElement('script');
    script.src = GAPI_URL;
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error('Google Picker を読み込めませんでした。'));
    document.head.append(script);
  });
  loading.catch(() => { loading = undefined; });
  return loading;
};

/**
 * Opens Google Picker on the Account's Drive folders and resolves with the
 * folder chosen, or null when the person closed it. Choosing a folder there is
 * what lets this application, holding only `drive.file`, save into it.
 */
export const chooseDriveFolder = async (config: ChatDrivePicker): Promise<PickedDocument | null> => {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME_TYPE);
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setTitle('保存先のフォルダを選ぶ')
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) resolve(response.docs?.[0] ?? null);
        else if (response.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
};

/**
 * Opens Google Picker on the Account's Drive files of the kinds a message may
 * carry, several at once, and resolves with those chosen, or none when the
 * person closed it.
 */
export const chooseDriveFiles = async (config: ChatDrivePicker): Promise<PickedDocument[]> => {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMimeTypes(ATTACHABLE_MIME_TYPES);
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setTitle('添付する Drive のファイルを選ぶ')
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) resolve(response.docs ?? []);
        else if (response.action === picker.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
};
