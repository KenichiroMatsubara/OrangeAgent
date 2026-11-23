import { OPERATOR_CHAT_RUN, OPERATOR_TOKEN_RUN, TOOLS, automationRun } from '@mail/domain';
import { afterEach, describe, expect, it } from 'vitest';

import type { McpFetch } from './mcp';
import type { CalendarSession } from './scheduling';
import { describedTools, toolHandlers, type ToolContext } from './tools';
import { FileAnswer, resolveTools } from './turns';
import { decodePlannedWrite } from './writes';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { memoryGoogle } from '../test/providers';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const noServers: McpFetch = async () => new Response('{}');

const context = (db: TestD1Database, overrides: Partial<ToolContext> = {}): ToolContext => ({
  database: db.binding,
  accountId: 'organization-1',
  reach: { kind: 'anyone' },
  mail: { kind: 'none' },
  origin: { automationId: null, sourceMessageId: null },
  at: () => new Date('2026-10-12T00:00:00.000Z'),
  ...overrides,
});

/** A mailbox holding one notice whose details are only in its PDF and its Excel workbook. */
const mailbox = () => {
  const google = memoryGoogle();
  google.addMessage({
    id: 'gmail-1',
    subject: '秋季総会のご案内',
    sender: '事務局 <office@example.com>',
    body: '詳細は添付をご覧ください。',
    attachments: [
      { filename: '案内.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 notice') },
      { filename: '名簿.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new TextEncoder().encode('PK\u0003\u0004 workbook') },
    ],
  });
  google.addMessage({ id: 'gmail-2', subject: '別のお知らせ', body: '別件です。' });
  const session = async (): Promise<CalendarSession> => ({
    accessToken: 'token',
    readAttachments: (messageId, parts) => google.gmail.readAttachments('token', messageId, parts),
  });
  return { google, session };
};

describe('every entrance selects from the one list', () => {
  it('tells Operator Chat and every Automation the same thing about a Task write', async () => {
    const chat = await resolveTools({ run: OPERATOR_CHAT_RUN, servers: [], fetch: noServers });
    const unattended = await resolveTools({ run: { ...automationRun('unattended'), grant: ['tasks.create'] }, servers: [], fetch: noServers });
    const approval = await resolveTools({ run: { ...automationRun('approval'), grant: ['tasks.create'] }, servers: [], fetch: noServers });

    const described = (tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>) =>
      tools.filter((tool) => tool.name === 'tasks.create').map(({ name, description, parameters }) => ({ name, description, parameters }));

    expect(described(chat.tools)).toHaveLength(1);
    expect(described(unattended.tools)).toEqual(described(chat.tools));
    expect(described(approval.tools)).toEqual(described(chat.tools));
  });

  it('describes a send the same way to Operator Chat and an Automation', () => {
    const send = (tools: ReturnType<typeof describedTools>) => tools.find((tool) => tool.name === 'channel.send');

    expect(send(describedTools(automationRun('unattended')))).toEqual(send(describedTools(OPERATOR_CHAT_RUN)));
  });

  it.each(['mail.send', 'mail.draft'])('offers %s files to attach only to a conversation, which holds the files it wrote', (name) => {
    const files = (run: Parameters<typeof describedTools>[0]) => Object.keys((describedTools(run).find((tool) => tool.name === name)?.parameters.properties ?? {}) as Record<string, unknown>).includes('files');

    expect(files(OPERATOR_CHAT_RUN)).toBe(true);
    expect(files(OPERATOR_TOKEN_RUN)).toBe(false);
    expect(files(automationRun('unattended'))).toBe(false);
  });

  it('gives every tool a handler of its own, which every run that performs its writes shares', async () => {
    database = createMigratedTestD1('organization');
    const { google, session } = mailbox();
    const handlers = toolHandlers(context(database, { mail: { kind: 'mailbox' }, google: { provider: google, session } }));

    expect(TOOLS.filter((tool) => !handlers[tool.name]).map((tool) => tool.name)).toEqual([]);
  });
});

describe('one way to read a mail', () => {
  it('hands every attachment of a mail to the model as the file itself, named in the answer', async () => {
    database = createMigratedTestD1('organization');
    const { google, session } = mailbox();
    const handlers = toolHandlers(context(database, { mail: { kind: 'mailbox' }, google: { provider: google, session } }));

    const read = await handlers['mail.read']?.({ messageId: 'gmail-1' });

    expect(read).toBeInstanceOf(FileAnswer);
    const { answer, files } = read as FileAnswer;
    expect(answer).toMatchObject({
      body: expect.stringContaining('詳細は添付をご覧ください。'),
      attachments: [
        { filename: '案内.pdf', mimeType: 'application/pdf' },
        { filename: '名簿.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      ],
    });
    expect(files).toEqual([
      { filename: '案内.pdf', mediaType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 notice') },
      { filename: '名簿.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new TextEncoder().encode('PK\u0003\u0004 workbook') },
    ]);
  });

  it('leaves a mail readable when its attachments cannot be, and says why', async () => {
    database = createMigratedTestD1('organization');
    const { google } = mailbox();
    const session = async (): Promise<CalendarSession> => ({ accessToken: 'token', readAttachments: async () => { throw new Error('unreadable'); } });
    const handlers = toolHandlers(context(database, { mail: { kind: 'mailbox' }, google: { provider: google, session } }));

    const read = await handlers['mail.read']?.({ messageId: 'gmail-1' }) as FileAnswer;

    expect(read.files).toEqual([]);
    expect(read.answer).toMatchObject({ body: expect.stringContaining('詳細は添付'), attachments: [], unreadAttachments: [{ filename: '案内.pdf' }, { filename: '名簿.xlsx' }], attachmentError: 'unreadable' });
  });
});

describe('one way to reach the Drive', () => {
  const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /** A Drive holding a folder, a Google Docs file inside it, a PDF, and a shortcut to the PDF, under a grant that holds the scopes given. */
  const drive = (db: TestD1Database, scopes: readonly string[]) => {
    db.execute(
      `INSERT INTO google_connections (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
       VALUES ('google-1', 'automation_inbox', 'subject-1', 'owner@example.com', ?, '{}', 'history-1', 1, 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      JSON.stringify(scopes),
    );
    const { google, session } = mailbox();
    google.drive.held.push(
      { id: 'folder-1', name: '2026-27 例会', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'doc-1', name: '11月例会 次第', mimeType: 'application/vnd.google-apps.document', parents: ['folder-1'], exports: { [WORD]: new TextEncoder().encode('PK\u0003\u0004 agenda') } },
      { id: 'pdf-1', name: '案内.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 notice') },
      { id: 'shortcut-1', name: '案内への近道', mimeType: 'application/vnd.google-apps.shortcut', shortcutTo: 'pdf-1' },
      { id: 'form-1', name: '出欠フォーム', mimeType: 'application/vnd.google-apps.form' },
    );
    return { google, handlers: toolHandlers(context(db, { mail: { kind: 'mailbox' }, google: { provider: google, session } })) };
  };

  it('lists what a folder holds, folders first, never what is in the trash', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);

    const found = await handlers['drive.search']?.({ folderId: 'folder-1' });

    expect(found).toMatchObject({ files: [{ id: 'doc-1', name: '11月例会 次第', folder: false, parents: ['folder-1'] }], nextPageToken: null });
    expect(google.drive.searches).toEqual([{ query: "trashed = false and 'folder-1' in parents", orderBy: 'folder,name', pageSize: 100, pageToken: null }]);
  });

  it('answers one page at a time, and leaves contents searches unsorted as Drive requires', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);

    const first = await handlers['drive.search']?.({ maxResults: 2 }) as { files: unknown[]; nextPageToken: string | null };
    expect(first.files).toHaveLength(2);
    expect(first.nextPageToken).toBe('2');
    await handlers['drive.search']?.({ query: "fullText contains '登録用紙'", pageToken: '2' });

    expect(google.drive.searches.map(({ query, orderBy, pageToken }) => ({ query, orderBy, pageToken }))).toEqual([
      { query: 'trashed = false', orderBy: 'modifiedTime desc', pageToken: null },
      { query: "trashed = false and (fullText contains '登録用紙')", orderBy: null, pageToken: '2' },
    ]);
  });

  it('hands a Google Docs file to the model as Word, and a shortcut as the file it points at', async () => {
    database = createMigratedTestD1('organization');
    const { handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);

    const document = await handlers['drive.read']?.({ fileId: 'doc-1' }) as FileAnswer;
    expect(document).toBeInstanceOf(FileAnswer);
    expect(document.answer).toMatchObject({ id: 'doc-1', exportedAs: WORD, file: { filename: '11月例会 次第.docx', mimeType: WORD } });
    expect(document.files).toEqual([{ filename: '11月例会 次第.docx', mediaType: WORD, bytes: new TextEncoder().encode('PK\u0003\u0004 agenda') }]);

    const shortcut = await handlers['drive.read']?.({ fileId: 'shortcut-1' }) as FileAnswer;
    expect(shortcut.files).toEqual([{ filename: '案内.pdf', mediaType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 notice') }]);
  });

  it('refuses a folder and a file Drive cannot hand over, saying what to do instead', async () => {
    database = createMigratedTestD1('organization');
    const { handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);

    await expect(handlers['drive.read']?.({ fileId: 'folder-1' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('drive.search') });
    await expect(handlers['drive.read']?.({ fileId: 'form-1' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('https://drive.example/form-1') });
  });

  it('reads only beneath the folders the Account names, however deep, and says which they are', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);
    google.drive.held.push(
      { id: 'root', name: 'マイドライブ', mimeType: 'application/vnd.google-apps.folder', parents: [] },
      { id: 'folder-2', name: '11月', mimeType: 'application/vnd.google-apps.folder', parents: ['folder-1'] },
      { id: 'xlsx-1', name: '登録用紙.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['folder-2'], bytes: new TextEncoder().encode('PK') },
      { id: 'shortcut-2', name: '外への近道', mimeType: 'application/vnd.google-apps.shortcut', parents: ['folder-1'], shortcutTo: 'pdf-1' },
    );
    database.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('drive_folders', ?, '2026-10-01T00:00:00.000Z')",
      JSON.stringify([{ id: 'folder-1', name: '2026-27 例会', url: 'https://drive.example/folder-1' }]),
    );

    const everywhere = await handlers['drive.search']?.({}) as { files: Array<{ id: string }>; reachableFolders: unknown };
    expect(everywhere.files.map((file) => file.id).sort()).toEqual(['doc-1', 'folder-1', 'folder-2', 'shortcut-2', 'xlsx-1']);
    expect(everywhere.reachableFolders).toEqual([{ id: 'folder-1', name: '2026-27 例会' }]);
    await expect(handlers['drive.search']?.({ folderId: 'folder-2' })).resolves.toMatchObject({ files: [{ id: 'xlsx-1' }] });
    await expect(handlers['drive.read']?.({ fileId: 'xlsx-1' })).resolves.toBeInstanceOf(FileAnswer);

    for (const call of [handlers['drive.search']?.({ folderId: 'root' }), handlers['drive.read']?.({ fileId: 'pdf-1' }), handlers['drive.read']?.({ fileId: 'shortcut-2' })]) {
      await expect(call).resolves.toMatchObject({ isError: true, message: expect.stringContaining('2026-27 例会 (folder-1)') });
    }
  });

  it('tells the run to have the Inbox reconnected when its grant reaches only FlareChat’s own files', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = drive(database, ['https://www.googleapis.com/auth/drive.file']);

    for (const call of [
      handlers['drive.search']?.({}), handlers['drive.read']?.({ fileId: 'pdf-1' }),
      handlers['drive.move']?.({ fileId: 'pdf-1', fileName: '案内.pdf', folderId: 'folder-1', folderName: '2026-27 例会' }),
    ]) {
      await expect(call).resolves.toMatchObject({ isError: true, message: expect.stringContaining('reconnects the mail inbox') });
    }
    expect(google.drive.searches).toEqual([]);
    expect(google.drive.held.find((file) => file.id === 'pdf-1')?.parents).toBeUndefined();
  });

  it('makes a folder, moves a file into it, and renames it, each named by the name Drive holds', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);

    const made = await handlers['drive.create_folder']?.({ name: '案内', folderId: 'folder-1', folderName: '2026-27 例会' }) as { folder: { id: string } };
    expect(made).toMatchObject({ created: true, folder: { name: '案内', folder: true, parents: ['folder-1'] } });
    await expect(handlers['drive.move']?.({ fileId: 'pdf-1', fileName: '案内.pdf', folderId: made.folder.id, folderName: '案内' }))
      .resolves.toMatchObject({ moved: true, file: { id: 'pdf-1', parents: [made.folder.id] } });
    await expect(handlers['drive.rename']?.({ fileId: 'pdf-1', fileName: '案内.pdf', name: '2026-11 例会案内.pdf' }))
      .resolves.toMatchObject({ renamed: true, file: { name: '2026-11 例会案内.pdf' } });

    // A name that no longer matches what Drive holds is refused, so a write approved by its names moves what the approver read.
    await expect(handlers['drive.move']?.({ fileId: 'pdf-1', fileName: '案内.pdf', folderId: 'folder-1', folderName: '2026-27 例会' }))
      .resolves.toMatchObject({ isError: true, message: expect.stringContaining('2026-11 例会案内.pdf') });
    await expect(handlers['drive.move']?.({ fileId: 'pdf-1', fileName: '2026-11 例会案内.pdf', folderId: 'doc-1', folderName: '11月例会 次第' }))
      .resolves.toMatchObject({ isError: true, message: expect.stringContaining('not a folder') });
    await expect(handlers['drive.rename']?.({ fileId: 'pdf-1', name: '別名' })).rejects.toThrow('drive.rename requires fileName.');
    google.drive.held.push({ id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder', parents: [] });
    await expect(handlers['drive.create_folder']?.({ name: '整理', folderId: 'root', folderName: 'マイドライブ' })).resolves.toMatchObject({ created: true, folder: { parents: ['root'] } });
    expect(google.drive.held.find((file) => file.id === 'pdf-1')).toMatchObject({ name: '2026-11 例会案内.pdf', parents: [made.folder.id] });
  });

  it('saves a file Claude wrote into the folder it names, checked as any folder a write names', async () => {
    database = createMigratedTestD1('organization');
    const { google } = drive(database, ['https://www.googleapis.com/auth/drive']);
    const saved: Array<{ filename: string; folderId: string | undefined }> = [];
    const handlers = toolHandlers(context(database, {
      mail: { kind: 'mailbox' },
      google: { provider: google, session: async () => ({ accessToken: 'token', readAttachments: async () => [] }) },
      generatedFiles: {
        saveToDrive: async (filename, folderId) => { saved.push({ filename, folderId }); return { saved: true }; },
        read: async () => null,
        makePdf: async () => ({ made: true }),
        hand: async () => ({ handed: true }),
      },
    }));

    await handlers['drive.save_file']?.({ filename: '名簿.xlsx', folderId: 'folder-1', folderName: '2026-27 例会' });
    await expect(handlers['drive.save_file']?.({ filename: '名簿.xlsx' })).rejects.toThrow('a folder you choose');
    await expect(handlers['drive.save_file']?.({ filename: '名簿.xlsx', folderId: 'pdf-1', folderName: '案内.pdf' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('not a folder') });
    await expect(handlers['drive.save_file']?.({ filename: '名簿.xlsx', folderId: 'folder-1' })).rejects.toThrow('folderName');

    expect(saved).toEqual([{ filename: '名簿.xlsx', folderId: 'folder-1' }]);
  });

  it('hands the member a file the answer holds, by the name a tool handed it under, only in a conversation that holds its files', async () => {
    database = createMigratedTestD1('organization');
    const handed: Array<{ filename: string; name: string | undefined }> = [];
    const handlers = toolHandlers(context(database, {
      generatedFiles: {
        saveToDrive: async () => ({ saved: true }),
        read: async () => null,
        makePdf: async () => ({ made: true }),
        hand: async (filename, name) => { handed.push({ filename, name }); return { handed: { filename } }; },
      },
    }));

    await handlers['file.hand']?.({ filename: ' screenshot-1.jpg ', name: 'ウィキペディア' });
    await handlers['file.hand']?.({ filename: 'screenshot-2.jpg', name: ' ' });
    await expect(handlers['file.hand']?.({})).resolves.toMatchObject({ isError: true, message: expect.stringContaining('requires filename') });
    expect(handed).toEqual([{ filename: 'screenshot-1.jpg', name: 'ウィキペディア' }, { filename: 'screenshot-2.jpg', name: undefined }]);

    const elsewhere = toolHandlers(context(database));
    await expect(elsewhere['file.hand']?.({ filename: 'screenshot-1.jpg' })).resolves.toMatchObject({ isError: true });
  });

  it('puts a file away in FlareChat’s trash folder instead of deleting it, and moves it back from there', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = drive(database, ['https://www.googleapis.com/auth/drive']);
    database.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('drive_folders', ?, '2026-10-01T00:00:00.000Z')",
      JSON.stringify([{ id: 'folder-1', name: '2026-27 例会', url: 'https://drive.example/folder-1' }]),
    );

    const putAway = await handlers['drive.trash']?.({ fileId: 'doc-1', fileName: '11月例会 次第' });

    expect(putAway).toMatchObject({ putAway: true, deleted: false, from: ['folder-1'], trashFolder: { id: 'folder:FlareChat のゴミ箱', name: 'FlareChat のゴミ箱' } });
    expect(google.drive.held.find((file) => file.id === 'doc-1')).toMatchObject({ parents: ['folder:FlareChat のゴミ箱'], appProperties: { flarechatPutAwayFrom: 'folder-1' } });
    expect(database.rows<{ value: string }>("SELECT value FROM settings WHERE key = 'drive_trash_folder'")).toEqual([{ value: 'folder:FlareChat のゴミ箱' }]);
    // The trash folder lies outside the Account's folders, yet a run bounded to them still finds what it put away there.
    await expect(handlers['drive.search']?.({ folderId: 'folder:FlareChat のゴミ箱' })).resolves.toMatchObject({ files: [{ id: 'doc-1' }] });
    await expect(handlers['drive.trash']?.({ fileId: 'doc-1', fileName: '11月例会 次第' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('already') });
    await expect(handlers['drive.trash']?.({ fileId: 'folder:FlareChat のゴミ箱', fileName: 'FlareChat のゴミ箱' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('never moved') });
    await expect(handlers['drive.trash']?.({ fileId: 'pdf-1', fileName: '案内.pdf' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('2026-27 例会 (folder-1)') });

    await expect(handlers['drive.move']?.({ fileId: 'doc-1', fileName: '11月例会 次第', folderId: 'folder-1', folderName: '2026-27 例会' }))
      .resolves.toMatchObject({ moved: true, file: { parents: ['folder-1'] } });
    expect(google.drive.held.map((file) => file.id)).toContain('doc-1');
  });
});

describe('a planned write is the same call, performed later', () => {
  it('restores a planned write as the call its tool reads, and refuses a tool the product no longer has', () => {
    expect(decodePlannedWrite('channel.send', JSON.stringify({ channel: 'line', destination: 'line-group-1', text: '会費は5,000円です。' })))
      .toEqual({ tool: 'channel.send', arguments: { channel: 'line', destination: 'line-group-1', contactId: null, text: '会費は5,000円です。' } });
    expect(() => decodePlannedWrite('report', JSON.stringify({ summary: '総会' }))).toThrow('not a write a run plans');
    expect(() => decodePlannedWrite('morning.send', JSON.stringify({ texts: [] }))).toThrow('not a write a run plans');
  });

  it('refuses a write that names a mail when the run reads none', async () => {
    database = createMigratedTestD1('organization');
    const handlers = toolHandlers(context(database));

    await expect(handlers.record_event_response?.({ messageId: 'gmail-1', eventId: 'event-1', guests: [] }))
      .resolves.toMatchObject({ isError: true, message: 'This run reads no mail, so it cannot name one.' });
  });

  it('bounds a send by whom the run may reach, the same way however it applies its writes', async () => {
    database = createMigratedTestD1('organization');
    const bounded = toolHandlers(context(database, { reach: { kind: 'contact_list', holder: 'This Automation', contactIds: ['contact-1'], emails: [], roster: 'account' } }));

    await expect(bounded['channel.send']?.({ channel: 'line', contactId: 'contact-9', text: 'こんにちは' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('outside the Contact List') });
    await expect(bounded['channel.send']?.({ channel: 'line', destination: 'line-group-1', text: 'こんにちは' }))
      .resolves.toMatchObject({ isError: true, message: 'This Automation reaches only its Contact List; name one of its Contacts by contactId.' });
    await expect(bounded['mail.send']?.({ to: 'outside@example.com', subject: '件名', body: '本文' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('outside@example.com') });
  });
});

describe('one way to reach the Tasks, which are kept in Google Tasks', () => {
  const TASKS = ['https://www.googleapis.com/auth/tasks'];

  /** Google Tasks with the list a person keeps for themselves, under a grant that holds the scopes given. */
  const tasks = (scopes: readonly string[] = TASKS) => {
    const db = database = createMigratedTestD1('organization');
    db.execute(
      `INSERT INTO google_connections (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
       VALUES ('google-1', 'automation_inbox', 'subject-1', 'owner@example.com', ?, '{}', 'history-1', 1, 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      JSON.stringify(scopes),
    );
    const { google, session } = mailbox();
    return { db, google, handlers: toolHandlers(context(db, { google: { provider: google, session } })) };
  };

  // The suite's clock stands at 2026-08-01, so sixty days ago is 2026-06-02.
  it('lists every open Task and those completed lately from every list, soonest due first, and names the lists', async () => {
    const { google, handlers } = tasks();
    google.tasks.lists.push({ id: 'list-own', title: 'FlareChat' });
    google.tasks.held.push(
      { id: 'open-due', listId: 'list-own', title: '会費を払う', notes: '口座へ振り込む\n\n担当: 田中', status: 'needsAction', due: '2026-08-10T00:00:00.000Z', updated: '2026-07-01T00:00:00.000Z', webViewLink: 'https://tasks.example/open-due' },
      { id: 'own-todo', listId: 'list-default', title: '牛乳を買う', status: 'needsAction', updated: '2026-01-05T00:00:00.000Z' },
      { id: 'done-lately', listId: 'list-own', title: '会場を予約する', status: 'completed', due: '2026-07-15T00:00:00.000Z', completed: '2026-07-14T03:00:00.000Z', updated: '2026-07-14T03:00:00.000Z' },
      { id: 'done-long-ago', listId: 'list-own', title: '春の総会の報告書を出す', status: 'completed', due: '2026-03-31T00:00:00.000Z', completed: '2026-03-30T03:00:00.000Z', updated: '2026-03-30T03:00:00.000Z' },
      { id: 'removed', listId: 'list-own', title: '消したタスク', status: 'needsAction', deleted: true, updated: '2026-07-20T00:00:00.000Z' },
    );

    const found = await handlers['tasks.search']?.({}) as { lists: unknown[]; tasks: Array<{ id: string }> };

    expect(found.lists).toEqual([{ id: 'list-default', name: 'マイタスク' }, { id: 'list-own', name: 'FlareChat' }]);
    expect(found.tasks.map(({ id }) => id)).toEqual(['done-lately', 'open-due', 'own-todo']);
    expect(found.tasks[1]).toEqual({
      id: 'open-due', listId: 'list-own', title: '会費を払う', notes: '口座へ振り込む\n\n担当: 田中', due: '2026-08-10', status: 'open',
      completedAt: null, updatedAt: '2026-07-01T00:00:00.000Z', url: 'https://tasks.example/open-due',
    });
    // An older one is found by a phrase or a due range, and a status or a list narrows any search.
    await expect(handlers['tasks.search']?.({ text: '総会' })).resolves.toMatchObject({ tasks: [{ id: 'done-long-ago', status: 'completed', completedAt: '2026-03-30T03:00:00.000Z' }] });
    await expect(handlers['tasks.search']?.({ from: '2026-03-01', to: '2026-03-31' })).resolves.toMatchObject({ tasks: [{ id: 'done-long-ago' }] });
    expect(((await handlers['tasks.search']?.({ status: 'open' })) as typeof found).tasks.map(({ id }) => id)).toEqual(['open-due', 'own-todo']);
    expect(((await handlers['tasks.search']?.({ listId: 'list-default' })) as typeof found).tasks.map(({ id }) => id)).toEqual(['own-todo']);
    await expect(handlers['tasks.search']?.({ listId: 'list-9' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('list-9') });
    await expect(handlers['tasks.search']?.({ from: '3/1' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('YYYY-MM-DD') });
  });

  it('puts a new Task in the list named FlareChat, making the list the first time and using it again the second', async () => {
    const { google, handlers } = tasks();

    const first = await handlers['tasks.create']?.({ title: '登録用紙を返送', due: '2026-10-30', notes: '氏名を記入して返送\n\n担当: 田中' });
    await handlers['tasks.create']?.({ title: '名簿を整える', due: null });

    const own = google.tasks.lists.find((list) => list.title === 'FlareChat');
    expect(google.tasks.lists.map(({ title }) => title)).toEqual(['マイタスク', 'FlareChat']);
    expect(first).toMatchObject({ created: true, task: { listId: own?.id, title: '登録用紙を返送', notes: '氏名を記入して返送\n\n担当: 田中', due: '2026-10-30', status: 'open' } });
    expect(google.tasks.writes).toEqual([
      { operation: 'create', listId: own?.id, id: 'task-1', body: { title: '登録用紙を返送', notes: '氏名を記入して返送\n\n担当: 田中', due: '2026-10-30T00:00:00.000Z' } },
      { operation: 'create', listId: own?.id, id: 'task-2', body: { title: '名簿を整える' } },
    ]);
    // A list the run names takes the Task instead, and one Google Tasks does not hold is answered, not thrown.
    await expect(handlers['tasks.create']?.({ title: '牛乳を買う', due: null, listId: 'list-default' })).resolves.toMatchObject({ created: true, task: { listId: 'list-default' } });
    await expect(handlers['tasks.create']?.({ title: '別件', due: null, listId: 'list-9' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('list-9') });
    // FlareChat keeps no copy.
    expect(database?.rows('SELECT id FROM tasks')).toEqual([]);
  });

  it('refuses a due day that is not a date and a Task with no title, with the reason, and writes nothing', async () => {
    const { google, handlers } = tasks();

    await expect(handlers['tasks.create']?.({ title: '返送', due: '10/30 17:00' })).rejects.toThrow(/tasks\.create: .*YYYY-MM-DD/u);
    await expect(handlers['tasks.create']?.({ title: '返送' })).rejects.toThrow('tasks.create requires due');
    await expect(handlers['tasks.create']?.({ title: ' ', due: null })).rejects.toThrow('tasks.create requires a title');
    expect(google.tasks.writes).toEqual([]);
    expect(google.tasks.lists.map(({ title }) => title)).toEqual(['マイタスク']);
  });

  it('completes a Task and changes only what it names, but never reopens one', async () => {
    const { google, handlers } = tasks();
    google.tasks.held.push({ id: 'task-a', listId: 'list-default', title: '会費を払う', notes: '担当: 田中', status: 'needsAction', due: '2026-08-10T00:00:00.000Z' });

    await expect(handlers['tasks.update']?.({ listId: 'list-default', taskId: 'task-a', status: 'completed' }))
      .resolves.toMatchObject({ updated: true, task: { id: 'task-a', status: 'completed', title: '会費を払う', notes: '担当: 田中', due: '2026-08-10' } });
    await expect(handlers['tasks.update']?.({ listId: 'list-default', taskId: 'task-a', status: 'open' })).rejects.toThrow('Only a person reopens a Task');
    await expect(handlers['tasks.update']?.({ listId: 'list-default', taskId: 'task-a', due: null, notes: '担当: 佐藤' }))
      .resolves.toMatchObject({ updated: true, task: { due: null, notes: '担当: 佐藤', status: 'completed' } });

    expect(google.tasks.writes).toEqual([
      { operation: 'patch', listId: 'list-default', id: 'task-a', body: { status: 'completed' } },
      { operation: 'patch', listId: 'list-default', id: 'task-a', body: { notes: '担当: 佐藤', due: null } },
    ]);
    expect(google.tasks.held[0]?.status).toBe('completed');
  });

  it('answers a Task that is not in the list named rather than failing, and refuses a change that names no list or nothing to change', async () => {
    const { google, handlers } = tasks();

    await expect(handlers['tasks.update']?.({ listId: 'list-default', taskId: 'task-9', title: '別件' }))
      .resolves.toMatchObject({ isError: true, message: expect.stringContaining('Task task-9 is not in task list list-default') });
    await expect(handlers['tasks.update']?.({ taskId: 'task-9', title: '別件' })).rejects.toThrow('tasks.update requires the taskId and the listId');
    await expect(handlers['tasks.update']?.({ listId: 'list-default', taskId: 'task-9' })).rejects.toThrow('tasks.update requires at least one of');
    expect(google.tasks.writes).toEqual([]);
  });

  it('reaches Google Tasks only under a grant that holds it, and asks for the inbox to be reconnected otherwise', async () => {
    const { db, google, handlers } = tasks(['https://www.googleapis.com/auth/drive']);
    google.tasks.held.push({ id: 'task-a', listId: 'list-default', title: '会費を払う', status: 'needsAction' });

    await expect(handlers['tasks.search']?.({})).resolves.toMatchObject({ isError: true, message: expect.stringContaining('reconnect') });
    await expect(handlers['tasks.create']?.({ title: '返送', due: null })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('reconnect') });
    await expect(handlers['tasks.update']?.({ listId: 'list-default', taskId: 'task-a', status: 'completed' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('reconnect') });
    expect(google.tasks.writes).toEqual([]);
    expect(google.tasks.lists.map(({ title }) => title)).toEqual(['マイタスク']);
    // A run that holds no Google grant at all, as an Access Token's does not, reaches no Task either.
    await expect(toolHandlers(context(db))['tasks.create']?.({ title: '返送', due: null })).rejects.toThrow('needs the Automation Inbox');
  });
});

describe('one way to reach Google Meet', () => {
  const MEET = ['https://www.googleapis.com/auth/meetings.space.readonly', 'https://www.googleapis.com/auth/meetings.space.settings'];

  /** Two meetings, the first of them transcribed, in a space the Account owns, and one space someone else owns, under a grant that holds the scopes given. */
  const meet = (db: TestD1Database, scopes: readonly string[]) => {
    db.execute(
      `INSERT INTO google_connections (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
       VALUES ('google-1', 'automation_inbox', 'subject-1', 'owner@example.com', ?, '{}', 'history-1', 1, 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      JSON.stringify(scopes),
    );
    const { google, session } = mailbox();
    google.meet.spaces.push(
      { name: 'spaces/owned', meetingCode: 'abc-defg-hij', meetingUri: 'https://meet.google.com/abc-defg-hij' },
      { name: 'spaces/theirs', meetingCode: 'xyz-wxyz-xyz', meetingUri: 'https://meet.google.com/xyz-wxyz-xyz' },
    );
    google.meet.owned.add('spaces/owned');
    google.meet.conferences.push(
      { name: 'conferenceRecords/c1', space: 'spaces/owned', startTime: '2026-10-11T01:00:00Z', endTime: '2026-10-11T02:00:00Z' },
      { name: 'conferenceRecords/c2', space: 'spaces/owned', startTime: '2026-10-11T05:00:00Z', endTime: '2026-10-11T05:30:00Z' },
    );
    google.meet.participants.set('conferenceRecords/c1', [
      { name: 'conferenceRecords/c1/participants/p1', signedinUser: { displayName: '山田 太郎' } },
      { name: 'conferenceRecords/c1/participants/p2', anonymousUser: { displayName: 'ゲスト' } },
    ]);
    google.meet.transcripts.set('conferenceRecords/c1', [
      { name: 'conferenceRecords/c1/transcripts/t1', state: 'FILE_GENERATED', startTime: '2026-10-11T01:00:05Z', endTime: '2026-10-11T02:00:00Z', docsDestination: { exportUri: 'https://docs.google.com/document/d/doc/export?format=txt' } },
    ]);
    google.meet.entries.set('conferenceRecords/c1/transcripts/t1', [
      { participant: 'conferenceRecords/c1/participants/p1', text: '始めます。', startTime: '2026-10-11T01:00:10Z' },
      { participant: 'conferenceRecords/c1/participants/p2', text: 'よろしくお願いします。', startTime: '2026-10-11T01:00:15Z' },
    ]);
    return { google, handlers: toolHandlers(context(db, { mail: { kind: 'mailbox' }, google: { provider: google, session } })) };
  };

  it('lists the meetings that started in a window read in Asia/Tokyo, newest first, with whether each was transcribed', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = meet(database, MEET);

    const found = await handlers['meet.search']?.({ from: '2026-10-11', to: '2026-10-12' });

    expect(google.meet.listed).toEqual([{ startFrom: '2026-10-10T15:00:00.000Z', startTo: '2026-10-11T15:00:00.000Z' }]);
    expect(found).toEqual({
      meetings: [
        { meetingId: 'conferenceRecords/c2', meetingCode: 'abc-defg-hij', start: '2026-10-11T05:00:00Z', end: '2026-10-11T05:30:00Z', transcripts: [] },
        { meetingId: 'conferenceRecords/c1', meetingCode: 'abc-defg-hij', start: '2026-10-11T01:00:00Z', end: '2026-10-11T02:00:00Z', transcripts: ['file_generated'] },
      ],
    });
  });

  it('reads a transcript as who said what when, in Asia/Tokyo, and says when a meeting was not transcribed', async () => {
    database = createMigratedTestD1('organization');
    const { handlers } = meet(database, MEET);

    await expect(handlers['meet.read']?.({ meetingId: 'conferenceRecords/c1' })).resolves.toMatchObject({
      meetingCode: 'abc-defg-hij',
      participants: ['山田 太郎', 'ゲスト'],
      transcripts: [{ state: 'file_generated', lines: ['10:00:10 山田 太郎: 始めます。', '10:00:15 ゲスト: よろしくお願いします。'] }],
    });
    await expect(handlers['meet.read']?.({ meetingId: 'conferenceRecords/c2' })).resolves.toMatchObject({ transcripts: [], note: 'This meeting was not transcribed.' });
    await expect(handlers['meet.read']?.({ meetingId: 'conferenceRecords/gone' })).resolves.toMatchObject({ isError: true });
    await expect(handlers['meet.read']?.({ meetingId: 'spaces/owned' })).resolves.toMatchObject({ isError: true });
  });

  it('turns on a meeting’s automatic transcription by its link, and refuses one someone else owns', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = meet(database, MEET);

    await expect(handlers['meet.transcribe']?.({ meeting: 'https://meet.google.com/abc-defg-hij', title: '定例会' })).resolves.toEqual({ transcribed: true, meetingCode: 'abc-defg-hij' });
    expect(google.meet.spaces[0]?.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration).toBe('ON');
    await expect(handlers['meet.transcribe']?.({ meeting: 'abc-defg-hij', title: '定例会' })).resolves.toMatchObject({ transcribed: true, message: 'Automatic transcription was already on.' });
    await expect(handlers['meet.transcribe']?.({ meeting: 'xyz-wxyz-xyz', title: '先方の会議' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('owner') });
    await expect(handlers['meet.transcribe']?.({ meeting: 'https://example.com/abc-defg-hij', title: '定例会' })).rejects.toThrow('meet.transcribe requires meeting');
  });

  it('reaches Meet only under a grant that holds it, and asks for the inbox to be reconnected otherwise', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = meet(database, ['https://www.googleapis.com/auth/drive']);

    await expect(handlers['meet.search']?.({ from: '2026-10-11', to: '2026-10-12' })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('reconnect') });
    await expect(handlers['meet.transcribe']?.({ meeting: 'abc-defg-hij', title: '定例会' })).resolves.toMatchObject({ isError: true });
    expect(google.meet.listed).toEqual([]);
  });

  it('names the Meet meeting of each Calendar event that has one', async () => {
    database = createMigratedTestD1('organization');
    const { google, handlers } = meet(database, MEET);
    google.addEvent({ id: 'event-1', summary: '定例会', start: { dateTime: '2026-10-11T10:00:00+09:00' }, end: { dateTime: '2026-10-11T11:00:00+09:00' }, hangoutLink: 'https://meet.google.com/abc-defg-hij' });

    await expect(handlers['calendar.search']?.({ from: '2026-10-11', to: '2026-10-12' })).resolves.toMatchObject({ events: [{ title: '定例会', meetingCode: 'abc-defg-hij' }] });
  });
});
