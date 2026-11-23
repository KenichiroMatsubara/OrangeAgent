import { CHAT_MODE_LABELS, CHAT_THREAD_FORM, isChatApproval, isChatDelivery, isChatMode, isChatShownType, isModelEffort, type ChatCapabilities, type ChatDelivery, type ChatDrivePicker, type ChatDriveSave, type ChatDriveSaved, type ChatThread, type ChatThreadApproval, type ChatThreadDeleted, type ChatThreadDispatch, type ChatThreadFork, type ChatThreadMessage, type ChatThreadMode, type ChatThreadModes, type ChatThreadQueue, type ChatThreadRename, type ChatThreadSuggestion, type ModelEffort, type ModelEfforts } from '@mail/domain';

import { aiConnection, requiredAiConnection, withModel, type AiConnection } from '../ai';
import { modelEfforts } from '../effort';
import { CHAT_DRIVE_FOLDER_NAME, DRIVE_ID, pickedDriveFiles, pickerConfigured, PICKER_SCOPES, PickedFileRefused, uploadFileToDrive } from '../chat-drive';
import { readChatUploads } from '../chat-store';
import { now } from '../clock';
import type { Forked } from '../conversation';
import { hasAutomationInbox, narrowedInboxAccessToken, openInbox } from '../inbox';
import type { Providers } from '../providers';
import { toArrayBuffer } from '../encoding';
import { decides, offeredModes } from '../modes';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { createThread, deleteThread, dropUploads, forkThread, listThreads, putUploads, readFile, readThread, THREAD_ACCOUNT_HEADER, THREAD_HEADER, THREAD_MEMBER_HEADER, threadObjectName, threadTitle, type ThreadActor } from '../threads';
import type { Bindings } from '../types';
import { accountRoute, created, type AccountRequest } from './account';

/** The longest message Operator Chat sends to its model at once. */
const MESSAGE_CHARACTERS = 120_000;

/** Where the object that serves a conversation is reached, once the conversation is known to be the Account's. */
const threadObject = async (request: AccountRequest<unknown>): Promise<{ fetch: (path: string, init?: RequestInit) => Promise<Response> }> => {
  const threadId = request.params.threadId ?? '';
  if (!await readThread(request.database, threadId)) throw notFound('この会話は見つかりませんでした。');
  const namespace = request.env.CHAT_THREADS;
  if (!namespace) throw invalid('新しいチャットはこの環境では使えません。');
  const object = namespace.get(namespace.idFromName(threadObjectName({ accountId: request.accountId, threadId })));
  return {
    fetch: (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set(THREAD_ACCOUNT_HEADER, request.accountId);
      headers.set(THREAD_HEADER, threadId);
      return object.fetch(`https://chat-thread.internal${path}`, { ...init, headers });
    },
  };
};

/** The member a route acts for, as a conversation records who did what. */
const actorOf = (request: AccountRequest<unknown>): ThreadActor => ({
  identityId: request.session.identity_id,
  name: request.session.display_name.trim() || request.session.email,
});

/** The longest feedback a declined call tells the model. */
const FEEDBACK_CHARACTERS = 20_000;

/** A WebSocket opened from another site is refused, whatever cookie it carries. */
const sameOrigin = (env: Bindings, raw: Request): boolean => {
  const origin = raw.headers.get('Origin');
  if (!origin) return true;
  return origin === new URL(raw.url).origin || origin === env.WEB_ORIGIN;
};

/**
 * Operator Chat, built on t3code's chat (ADR 0201): its conversations,
 * each served by a Durable Object of its own. A message is sent and an answer
 * stopped here; everything that follows reaches the screen over the
 * conversation's stream.
 */
/** What a member sent, read the same whether it came as a form or as JSON: one field, a field given many times, and its files. */
interface SentFields {
  field(name: string): string;
  list(name: string): string[];
  files: File[];
}

/** The level of effort a message names, none when it names none; a value that names no level is refused. */
const askedEffort = (value: unknown): ModelEffort | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isModelEffort(value)) throw invalid('考える深さを読み取れませんでした。');
  return value;
};

/**
 * The levels of effort each model of the Connection takes (effort.ts); a
 * model that takes no choice, or whose levels cannot be read, is left out.
 */
const connectionEfforts = async (connection: AiConnection | null): Promise<Record<string, ModelEfforts>> => {
  if (!connection) return {};
  const read = await Promise.all(connection.models.map(async (model) => [model, await modelEfforts({ ...connection, model })] as const));
  return Object.fromEntries(read.flatMap(([model, efforts]) => efforts && efforts.levels.length > 1 ? [[model, efforts]] : []));
};

export const threadRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/chat-threads', accountRoute(async ({ database }): Promise<ChatThread[]> => listThreads(database)));

  routes.post('/organizations/:accountId/chat-threads', accountRoute(async (request) => created(await createThread({
    database: request.database,
    accountId: request.accountId,
    createdBy: actorOf(request),
    timestamp: now(),
  }))));

  /** A message as a member sends it: its form's fields, each file a part of its own, or, without files, JSON. */
  const sentFields = async (request: AccountRequest<unknown>): Promise<SentFields> => {
    if (!request.header('Content-Type')?.toLowerCase().startsWith('multipart/form-data')) {
      const parsed: unknown = await request.raw.json().catch(() => ({}));
      const body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
      return {
        field: (name) => typeof body[name] === 'string' ? body[name] : '',
        list: (name) => {
          const value = body[name];
          if (value === undefined) return [];
          if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) throw invalid('メッセージを読み取れませんでした。');
          return value;
        },
        files: [],
      };
    }
    const form = await request.raw.formData().catch((): never => { throw invalid('メッセージを読み取れませんでした。'); });
    const parts = form.getAll(CHAT_THREAD_FORM.attachment);
    const files = parts.filter((part): part is File => typeof part !== 'string');
    if (files.length !== parts.length) throw invalid('添付ファイルを読み取れませんでした。');
    return {
      field: (name) => {
        const value = form.get(name);
        return typeof value === 'string' ? value : '';
      },
      list: (name) => form.getAll(name).filter((value): value is string => typeof value === 'string'),
      files,
    };
  };

  const sentMessage = async (request: AccountRequest<unknown>): Promise<ChatThreadMessage & { files: File[] }> => {
    const { field, files } = await sentFields(request);
    const delivery = field(CHAT_THREAD_FORM.delivery);
    const effort = askedEffort(field(CHAT_THREAD_FORM.effort));
    return {
      text: field(CHAT_THREAD_FORM.text),
      ...(field(CHAT_THREAD_FORM.model) ? { model: field(CHAT_THREAD_FORM.model) } : {}),
      ...(effort ? { effort } : {}),
      ...(isChatDelivery(delivery) ? { delivery } : {}),
      files,
    };
  };

  /**
   * Sends a message, with any files, to the conversation. While an answer is
   * written it is handed to that answer at its next step, or queued after it
   * when the member asks; each file is kept as it is before the message is.
   */
  routes.post('/organizations/:accountId/chat-threads/:threadId/messages', accountRoute(async (request): Promise<ChatThreadDispatch> => {
    const sent = await sentMessage(request);
    const text = sent.text.trim();
    const uploads = await readChatUploads(sent.files);
    if (!text && !uploads.length) throw invalid('メッセージを入力するか、ファイルを添付してください。');
    if (text.length > MESSAGE_CHARACTERS) throw invalid(`メッセージは ${MESSAGE_CHARACTERS.toLocaleString('ja-JP')} 文字までです。`);
    const asked = sent.model?.trim() || undefined;
    // Refused before anything is kept, as is a model the Connection does not name.
    const { model } = withModel(await requiredAiConnection(request.env, request.accountId, request.database), asked);
    const object = await threadObject(request);
    const files = await putUploads({ bucket: request.env.RECOVERY_RECEIPTS, accountId: request.accountId, files: uploads });
    const delivery: ChatDelivery = sent.delivery ?? 'steer';
    const answered = await object.fetch('/dispatch', { method: 'POST', body: JSON.stringify({ request: text, model, ...(sent.effort ? { effort: sent.effort } : {}), by: actorOf(request), files, delivery }) });
    if (!answered.ok) {
      await dropUploads(request.env.RECOVERY_RECEIPTS, files);
      throw invalid(await answered.text());
    }
    const { accepted } = await answered.json() as { accepted: boolean };
    if (!accepted) await dropUploads(request.env.RECOVERY_RECEIPTS, files);
    return { threadId: request.params.threadId ?? '', accepted };
  }, { body: 'file' }));

  /** What the conversation's object is asked to do to a queued message, from what the member asked. */
  const queueCommand = (body: Partial<ChatThreadQueue>): Record<string, unknown> => {
    const runId = typeof body.runId === 'string' ? body.runId : '';
    if (!runId) throw invalid('どのメッセージかが分かりません。');
    if (body.action === 'send') return { kind: 'steer', runId };
    if (body.action === 'remove') return { kind: 'cancel', runId };
    if (body.action === 'edit') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw invalid('メッセージを入力してください。');
      if (text.length > MESSAGE_CHARACTERS) throw invalid(`メッセージは ${MESSAGE_CHARACTERS.toLocaleString('ja-JP')} 文字までです。`);
      return { kind: 'edit', runId, text };
    }
    if (body.action === 'move') {
      const before = body.beforeRunId;
      if (before !== null && typeof before !== 'string') throw invalid('どこへ動かすかが分かりません。');
      return { kind: 'move', runId, beforeRunId: before };
    }
    throw invalid('待っているメッセージに何をするかを選んでください。');
  };

  /** Sends a queued message now, removes it, rewrites it, or moves it in the queue. */
  routes.post('/organizations/:accountId/chat-threads/:threadId/queue', accountRoute<Partial<ChatThreadQueue>>(async (request): Promise<ChatThreadDispatch> => {
    const command = queueCommand(request.body);
    const object = await threadObject(request);
    const answered = await object.fetch('/queue', { method: 'POST', body: JSON.stringify({ ...command, by: actorOf(request) }) });
    if (!answered.ok) throw invalid(await answered.text());
    const { accepted } = await answered.json() as { accepted: boolean };
    return { threadId: request.params.threadId ?? '', accepted };
  }));

  /** Answers the call waiting for approval: once, always for the Account, or not, with what the member said. */
  routes.post('/organizations/:accountId/chat-threads/:threadId/approvals', accountRoute<Partial<ChatThreadApproval>>(async (request): Promise<ChatThreadDispatch> => {
    const { requestId, decision, feedback } = request.body;
    if (typeof requestId !== 'string' || !requestId) throw invalid('どの確認に答えるかが分かりません。');
    if (!isChatApproval(decision)) throw invalid('許可するか拒否するかを選んでください。');
    if (feedback !== undefined && typeof feedback !== 'string') throw invalid('伝える言葉は文字で書いてください。');
    if (feedback && feedback.length > FEEDBACK_CHARACTERS) throw invalid(`伝える言葉は ${FEEDBACK_CHARACTERS.toLocaleString('ja-JP')} 文字までです。`);
    const object = await threadObject(request);
    const answered = await object.fetch('/respond', {
      method: 'POST',
      body: JSON.stringify({ requestId, decision, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}), by: actorOf(request) }),
    });
    if (!answered.ok) throw invalid(await answered.text());
    const { accepted } = await answered.json() as { accepted: boolean };
    return { threadId: request.params.threadId ?? '', accepted };
  }));

  /** The approval modes the conversation's composer offers: 自動 only where the Worker can ask a Decider. */
  routes.get('/organizations/:accountId/chat-threads/:threadId/mode', accountRoute(async ({ env, database, params }): Promise<ChatThreadModes> => {
    if (!await readThread(database, params.threadId ?? '')) throw notFound('この会話は見つかりませんでした。');
    return { modes: offeredModes(decides(env)) };
  }));

  /** Sets the conversation's approval mode, which its next call reads; a mode the composer does not offer is refused. */
  routes.put('/organizations/:accountId/chat-threads/:threadId/mode', accountRoute<Partial<ChatThreadMode>>(async (request): Promise<ChatThreadDispatch> => {
    const { mode } = request.body;
    if (!isChatMode(mode)) throw invalid('承認のしかたを選んでください。');
    if (!offeredModes(decides(request.env)).includes(mode)) throw invalid(`${CHAT_MODE_LABELS[mode]}は選べません。この FlareChat には、自動で判定するための OpenRouter の鍵が設定されていません。`);
    const object = await threadObject(request);
    const answered = await object.fetch('/mode', { method: 'POST', body: JSON.stringify({ mode, by: actorOf(request) }) });
    if (!answered.ok) throw invalid(await answered.text());
    return { threadId: request.params.threadId ?? '', accepted: true };
  }));

  routes.post('/organizations/:accountId/chat-threads/:threadId/interrupt', accountRoute(async (request): Promise<ChatThreadDispatch> => {
    const object = await threadObject(request);
    const answered = await object.fetch('/interrupt', { method: 'POST' });
    if (!answered.ok) throw invalid(await answered.text());
    const { accepted } = await answered.json() as { accepted: boolean };
    return { threadId: request.params.threadId ?? '', accepted };
  }));

  /** What the member is likely to write next after the conversation's latest answer, which its composer shows greyed until they type. */
  routes.get('/organizations/:accountId/chat-threads/:threadId/suggestion', accountRoute(async (request): Promise<ChatThreadSuggestion> => {
    const object = await threadObject(request);
    const answered = await object.fetch('/suggestion');
    if (!answered.ok) return { runId: null, text: null };
    const { runId, text } = await answered.json() as Partial<ChatThreadSuggestion>;
    return { runId: typeof runId === 'string' ? runId : null, text: typeof text === 'string' ? text : null };
  }));

  /** The conversation's stream: a WebSocket to its object, which sends t3code thread stream items. */
  routes.get('/organizations/:accountId/chat-threads/:threadId/stream', accountRoute(async (request): Promise<Response> => {
    if (request.header('Upgrade')?.toLowerCase() !== 'websocket') throw invalid('この会話は WebSocket で開いてください。');
    if (!sameOrigin(request.env, request.raw)) return new Response('Cross-site WebSocket refused.', { status: 403 });
    const object = await threadObject(request);
    const after = request.query('afterSequence') ?? '0';
    // The socket is the member's, so their screen being in view keeps them from being notified of this conversation.
    return object.fetch(`/connect?afterSequence=${encodeURIComponent(after)}`, { headers: { Upgrade: 'websocket', [THREAD_MEMBER_HEADER]: request.session.identity_id } });
  }));

  /** A conversation as its list shows it, once it is known to be the Account's. */
  const listedThread = async (database: D1Database, threadId: string): Promise<ChatThread> => {
    const row = await readThread(database, threadId);
    if (!row) throw notFound('この会話は見つかりませんでした。');
    return { id: row.id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt };
  };

  /** Renames the conversation, from its screen or the list of conversations; its place in the list stays. */
  routes.patch('/organizations/:accountId/chat-threads/:threadId', accountRoute<Partial<ChatThreadRename>>(async (request): Promise<ChatThread> => {
    const title = typeof request.body.title === 'string' ? threadTitle(request.body.title) : '';
    if (!title) throw invalid('会話の名前を入力してください。');
    const object = await threadObject(request);
    const answered = await object.fetch('/rename', { method: 'POST', body: JSON.stringify({ title }) });
    if (!answered.ok) throw invalid(await answered.text());
    return listedThread(request.database, request.params.threadId ?? '');
  }));

  /**
   * Deletes the conversation: its object stops the answer being written and
   * declines a call waiting, and only then are its rows and the R2 objects
   * nothing else names deleted. The Runs its answers were recorded as stay.
   */
  routes.delete('/organizations/:accountId/chat-threads/:threadId', accountRoute(async (request): Promise<ChatThreadDeleted> => {
    const threadId = request.params.threadId ?? '';
    const object = await threadObject(request);
    const closed = await object.fetch('/close', { method: 'POST' });
    if (!closed.ok && closed.status !== 404) throw invalid(await closed.text());
    await deleteThread({ database: request.database, bucket: request.env.RECOVERY_RECEIPTS, threadId });
    return { id: threadId, deleted: true };
  }));

  /**
   * Rewinds the conversation to an earlier message of a member's and asks it
   * again as rewritten: the answer it began and every answer after it are taken
   * back. It keeps the files it was sent with but those `drop` names, and any
   * file sent with the rewrite is kept as a message's is and added after them.
   * Refused while an answer is being written or waits for approval.
   */
  routes.post('/organizations/:accountId/chat-threads/:threadId/rewind', accountRoute(async (request): Promise<ChatThreadDispatch> => {
    const { field, list, files: parts } = await sentFields(request);
    const messageId = field(CHAT_THREAD_FORM.messageId);
    if (!messageId) throw invalid('どのメッセージから編集するかが分かりません。');
    const text = field(CHAT_THREAD_FORM.text).trim();
    if (text.length > MESSAGE_CHARACTERS) throw invalid(`メッセージは ${MESSAGE_CHARACTERS.toLocaleString('ja-JP')} 文字までです。`);
    const drop = list(CHAT_THREAD_FORM.drop);
    const uploads = await readChatUploads(parts);
    const asked = field(CHAT_THREAD_FORM.model).trim() || undefined;
    const effort = askedEffort(field(CHAT_THREAD_FORM.effort) || undefined);
    // Refused before anything is kept, as is a model the Connection does not name.
    const { model } = withModel(await requiredAiConnection(request.env, request.accountId, request.database), asked);
    const object = await threadObject(request);
    const files = await putUploads({ bucket: request.env.RECOVERY_RECEIPTS, accountId: request.accountId, files: uploads });
    const answered = await object.fetch('/rewind', { method: 'POST', body: JSON.stringify({ messageId, request: text, model, ...(effort ? { effort } : {}), by: actorOf(request), ...(drop.length ? { drop } : {}), ...(files.length ? { files } : {}) }) });
    if (!answered.ok) {
      await dropUploads(request.env.RECOVERY_RECEIPTS, files);
      throw invalid(await answered.text());
    }
    const { accepted } = await answered.json() as { accepted: boolean };
    if (!accepted) await dropUploads(request.env.RECOVERY_RECEIPTS, files);
    return { threadId: request.params.threadId ?? '', accepted };
  }, { body: 'file' }));

  /**
   * Continues the conversation from one of its answers as a new conversation
   * holding everything up to it, its files naming the same bytes. The new one
   * starts in the mode the member's next conversation would.
   */
  routes.post('/organizations/:accountId/chat-threads/:threadId/fork', accountRoute<Partial<ChatThreadFork>>(async (request) => {
    const { runId } = request.body;
    if (typeof runId !== 'string' || !runId) throw invalid('どの答えから続けるかが分かりません。');
    const object = await threadObject(request);
    const threadId = crypto.randomUUID();
    const answered = await object.fetch('/fork', { method: 'POST', body: JSON.stringify({ runId, threadId }) });
    if (!answered.ok) throw invalid(await answered.text());
    const { fork } = await answered.json() as { fork: Forked | null };
    if (!fork) throw invalid('この答えからは続けられません。書き終えた答えを選んでください。');
    return created(await forkThread({
      database: request.database,
      accountId: request.accountId,
      source: request.params.threadId ?? '',
      threadId,
      title: fork.title,
      createdBy: actorOf(request),
      events: fork.events,
      files: fork.files,
      timestamp: now(),
    }));
  }));

  /** The models a message may be answered by, the default first, the levels of effort each takes, and whether Google Picker is configured here. */
  routes.get('/organizations/:accountId/chat-capabilities', accountRoute(async ({ env, accountId, database }): Promise<ChatCapabilities> => {
    const connection = await aiConnection(env, accountId, database);
    return {
      models: connection?.models ?? [],
      efforts: await connectionEfforts(connection),
      drivePicker: pickerConfigured(env),
    };
  }));

  /**
   * What the screen needs to open Google Picker, or null when it is not
   * configured: a token of the Automation Inbox narrowed to `drive.file`, so
   * the browser holding it reaches no mail and no calendar, only the files
   * this application made and those a member picks.
   */
  routes.post('/organizations/:accountId/chat-drive-picker', accountRoute(async ({ env, accountId, database }): Promise<ChatDrivePicker | null> => {
    const apiKey = env.GOOGLE_PICKER_API_KEY?.trim();
    const appId = env.GOOGLE_PICKER_APP_ID?.trim();
    if (!apiKey || !appId) return null;
    if (!await hasAutomationInbox(database)) throw invalid('Drive を使うには、「接続」でメールボックスを接続してください。');
    const accessToken = await narrowedInboxAccessToken({ env, accountId, database, google: providers.google, scopes: PICKER_SCOPES });
    return { apiKey, appId, accessToken };
  }));

  /**
   * A Drive file a member picked with Google Picker to attach to a message,
   * as the file itself: read as `drive.read` reads one, a Google Docs, Sheets,
   * or Slides file as its export, and handed to the composer, which attaches
   * it as a file from the member's computer, so it is checked and kept as any
   * other is when the message is sent. The member chose the file, so the Drive
   * Folders that bound what a run reaches do not bound it.
   */
  routes.get('/organizations/:accountId/chat-drive-files/:fileId', accountRoute(async ({ env, accountId, database, params }): Promise<Response> => {
    const fileId = params.fileId ?? '';
    if (!DRIVE_ID.test(fileId)) throw invalid('Drive のファイルを読み取れませんでした。');
    if (!await hasAutomationInbox(database)) throw invalid('Drive のファイルを添付するには、「接続」でメールボックスを接続してください。');
    const { accessToken } = await openInbox({ env, accountId, database, google: providers.google });
    const [file] = await pickedDriveFiles({ google: providers.google, accessToken, fileIds: [fileId] }).catch((error: unknown) => {
      if (error instanceof PickedFileRefused) throw invalid(error.message);
      throw error;
    });
    if (!file) throw notFound('このファイルは見つかりませんでした。');
    return new Response(await file.arrayBuffer(), {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }));

  /**
   * Saves a file of the conversation to the Automation Inbox's Drive: in the
   * folder the member chose with Google Picker, or, without one, in FlareChat's
   * AI に聞く folder at the top of My Drive.
   */
  routes.post('/organizations/:accountId/chat-threads/:threadId/files/:fileId/drive', accountRoute<Partial<ChatDriveSave>>(async (request): Promise<ChatDriveSaved> => {
    const folderId = typeof request.body.folderId === 'string' ? request.body.folderId.trim() : undefined;
    if (folderId !== undefined && !DRIVE_ID.test(folderId)) throw invalid('保存先のフォルダを読み取れませんでした。');
    const { env, accountId, database, key, params } = request;
    const file = await readFile({ database, bucket: env.RECOVERY_RECEIPTS, key, threadId: params.threadId ?? '', fileId: params.fileId ?? '' });
    if (!file) throw notFound('このファイルは見つかりませんでした。');
    if (!await hasAutomationInbox(database)) throw invalid('Drive に保存するには、「接続」でメールボックスを接続してください。');
    const { accessToken } = await openInbox({ env, accountId, database, google: providers.google });
    const folder = folderId ?? await providers.google.drive.ensureFolderPath(accessToken, [CHAT_DRIVE_FOLDER_NAME]);
    const saved = await uploadFileToDrive({ file, folderId: folder, google: providers.google, accessToken: async () => accessToken });
    return { fileId: saved.driveFileId, url: saved.url };
  }));

  /** A file an answer kept: an image or a PDF is shown in the browser; any other file, which could run script here, is downloaded. */
  routes.get('/organizations/:accountId/chat-threads/:threadId/files/:fileId', accountRoute(async ({ env, database, params, key }): Promise<Response> => {
    const file = await readFile({ database, bucket: env.RECOVERY_RECEIPTS, key, threadId: params.threadId ?? '', fileId: params.fileId ?? '' });
    if (!file) throw notFound('このファイルは見つかりませんでした。');
    const disposition = isChatShownType(file.mediaType) ? 'inline' : 'attachment';
    return new Response(toArrayBuffer(file.bytes), {
      headers: {
        'Content-Type': file.mediaType,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }));

  return routes;
};
