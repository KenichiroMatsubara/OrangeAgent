/**
 * The Durable Object each conversation of Operator Chat lives in
 * (ADR 0201), named by its Account and its conversation. It answers the
 * conversation's messages one at a time, keeps every event in the Account's
 * D1, and sends them to every screen following it over a WebSocket it holds
 * with the hibernation API, so a screen that only watches costs nothing while
 * nothing happens. A screen connects at `/connect?afterSequence=N`; a message
 * is sent at `/dispatch`, a queued message started, handed on, removed,
 * rewritten, or moved at `/queue`, a call waiting for approval answered at `/respond`,
 * the approval mode set at `/mode`, an answer stopped at `/interrupt`, an
 * earlier message asked again at `/rewind`, the conversation renamed at
 * `/rename`, continued as a new one at `/fork`, what the member is likely
 * to write next read at `/suggestion`, and stopped before it is deleted at
 * `/close`, all by the Worker's routes, which have already checked the
 * member.
 *
 * Each socket is the member's whose screen opened it, and the screen says over
 * it whether the conversation is in view; a member with any socket in view is
 * not notified of what the conversation's answers do (notices.ts).
 *
 * The conversation's code, and with it t3code's schemas and reducer, is
 * loaded the first time the object serves a conversation, so a Worker that
 * serves anything else does not evaluate it.
 */

import { DurableObject } from 'cloudflare:workers';

import { CHAT_THREAD_GONE } from '@mail/domain';

import { decides } from './modes';
import { productionProviders } from './providers';
import { activeAccountDatabase } from './routes/request-context';
import type { Conversation } from './conversation';
import type { Suggester } from './suggestion';
import { visibilityOf, type Notice } from './notices';
import { THREAD_ACCOUNT_HEADER, THREAD_HEADER, THREAD_MEMBER_HEADER, type ThreadTarget } from './threads';
import type { Bindings } from './types';

const TARGET = 'target';

const HEARTBEAT_MS = 30_000;

/** Whose screen a socket is, and whether the screen has the conversation in view, kept with the socket through hibernation. */
interface Watcher {
  member: string | null;
  visible: boolean;
}

const watcherOf = (socket: WebSocket): Watcher | null => {
  const attached = socket.deserializeAttachment() as Partial<Watcher> | null;
  if (!attached || typeof attached !== 'object') return null;
  return { member: typeof attached.member === 'string' ? attached.member : null, visible: attached.visible !== false };
};

/** Closes a socket the screen already closed, or one that failed, without throwing for a code it may not send. */
const closeQuietly = (socket: WebSocket, code: number): void => {
  try {
    socket.close(code, 'closed');
  } catch {
    // Already closed.
  }
};

/** A suggester whose failure is logged and suggests nothing, as a suggestion is never worth an error on the screen. */
const suggesting = (suggest: Suggester, threadId: string): Suggester => async (history) => {
  const started = Date.now();
  try {
    return await suggest(history);
  } catch (error) {
    console.error(JSON.stringify({ event: 'chat_suggestion_failed', threadId, ms: Date.now() - started, message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
};

export class ChatThreads extends DurableObject<Bindings> {
  private conversation: Promise<Conversation> | null = null;

  override async fetch(request: Request): Promise<Response> {
    const target = await this.target(request);
    if (!target) return new Response('No conversation is named.', { status: 400 });
    const path = new URL(request.url).pathname;
    try {
      const conversation = await this.open(target);
      if (path === '/connect') return this.follow(conversation, request);
      if (path === '/dispatch') {
        const input = await request.json() as Parameters<Conversation['dispatch']>[0];
        return Response.json({ accepted: await this.writing(conversation.dispatch(input)) });
      }
      if (path === '/queue') {
        const { by, ...command } = await request.json() as Parameters<Conversation['queue']>[0] & { by?: Parameters<Conversation['queue']>[1] };
        return Response.json({ accepted: await this.writing(conversation.queue(command, by)) });
      }
      if (path === '/respond') {
        const input = await request.json() as Parameters<Conversation['respond']>[0];
        return Response.json({ accepted: await this.writing(conversation.respond(input)) });
      }
      if (path === '/mode') {
        const input = await request.json() as { mode: Parameters<Conversation['setMode']>[0]; by: Parameters<Conversation['setMode']>[1] };
        await conversation.setMode(input.mode, input.by);
        return Response.json({ accepted: true });
      }
      if (path === '/interrupt') return Response.json({ accepted: await conversation.interrupt() });
      if (path === '/rewind') {
        const input = await request.json() as Parameters<Conversation['rewind']>[0];
        return Response.json({ accepted: await this.writing(conversation.rewind(input)) });
      }
      if (path === '/rename') {
        const { title } = await request.json() as { title: string };
        await conversation.rename(title);
        return Response.json({ accepted: true });
      }
      if (path === '/fork') {
        const { runId, threadId } = await request.json() as { runId: string; threadId: string };
        return Response.json({ fork: await conversation.fork(runId, threadId) });
      }
      if (path === '/suggestion') return Response.json(await conversation.suggestion());
      if (path === '/close') return Response.json({ accepted: await this.close(conversation) });
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof Error && error.name === 'ThreadMissing') return new Response(error.message, { status: 404 });
      if (error instanceof Error && error.name === 'ModeUnoffered') return new Response(error.message, { status: 400 });
      throw error;
    }
  }

  /** Sets the heartbeat once an answer starts being written, so the object stays awake while it writes. */
  private async writing(started: Promise<boolean>): Promise<boolean> {
    const accepted = await started;
    if (accepted) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return accepted;
  }

  /** A screen follows the conversation from after the last sequence it applied. */
  private follow(conversation: Conversation, request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const after = Number(new URL(request.url).searchParams.get('afterSequence') ?? '0');
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // Accepted and sent what it missed in one step, so no event falls between the two.
    this.ctx.acceptWebSocket(server);
    // A screen is taken to be in view until it says otherwise, so one that never says is never notified over.
    server.serializeAttachment({ member: request.headers.get(THREAD_MEMBER_HEADER), visible: true } satisfies Watcher);
    for (const frame of conversation.frames(Number.isSafeInteger(after) && after > 0 ? after : 0)) server.send(frame);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A screen says over its socket only whether the conversation is in view; what it does goes through the routes. */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const visible = visibilityOf(message);
    const watcher = watcherOf(socket);
    if (visible === null || !watcher) return;
    socket.serializeAttachment({ ...watcher, visible } satisfies Watcher);
  }

  /** The members with a screen that has the conversation open and in view. */
  private watching(): Set<string> {
    const members = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const watcher = watcherOf(socket);
      if (watcher?.visible && watcher.member) members.add(watcher.member);
    }
    return members;
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    closeQuietly(socket, 1000);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    closeQuietly(socket, 1011);
  }

  /**
   * While an answer is written the object is woken every HEARTBEAT_MS, so
   * nothing takes it for idle. An answer waiting for approval is not being
   * written: its pause is kept in D1, the heartbeat stops, and the object may
   * hibernate or go away until the member answers.
   */
  override async alarm(): Promise<void> {
    // An object that went away while an answer was written is woken anew here: opening the
    // conversation takes the answer up again from how far it had got, or fails it and closes its
    // Run when nothing of it was kept, whether or not anyone opens the conversation again.
    const target = this.conversation ? null : await this.ctx.storage.get<ThreadTarget>(TARGET);
    const opened = this.conversation ?? (target ? this.open(target) : null);
    const conversation = await opened?.catch(() => null);
    if (conversation?.answering()) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  /**
   * Stops the conversation before its rows are deleted: the answer being
   * written stops and a call waiting is declined, nothing more is taken, every
   * screen following it is told it is gone (4404), and the object forgets it.
   */
  private async close(conversation: Conversation): Promise<boolean> {
    await conversation.close();
    for (const socket of this.ctx.getWebSockets()) closeQuietly(socket, CHAT_THREAD_GONE);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return true;
  }

  private async target(request: Request): Promise<ThreadTarget | null> {
    const accountId = request.headers.get(THREAD_ACCOUNT_HEADER);
    const threadId = request.headers.get(THREAD_HEADER);
    if (accountId && threadId) {
      const known = await this.ctx.storage.get<ThreadTarget>(TARGET);
      if (!known) await this.ctx.storage.put(TARGET, { accountId, threadId });
      return known ?? { accountId, threadId };
    }
    return await this.ctx.storage.get<ThreadTarget>(TARGET) ?? null;
  }

  private open(target: ThreadTarget): Promise<Conversation> {
    this.conversation ??= this.load(target).catch((error: unknown) => {
      this.conversation = null;
      throw error;
    });
    return this.conversation;
  }

  /** Builds the conversation the object serves and reads it, which takes up again, or fails, every answer left being written. */
  private async load(target: ThreadTarget): Promise<Conversation> {
    const conversation = await this.build(target);
    await conversation.load();
    return conversation;
  }

  /** Builds the conversation `target` names over the Account's database; a test builds one of its own instead. */
  protected async build(target: ThreadTarget): Promise<Conversation> {
    const database = await activeAccountDatabase(this.env, target.accountId);
    if (!database) throw new Error('Account database is unavailable.');
    const [{ openConversation }, { abandonThreadRun, answerThread, openThreadRun }, threads, notices, subscriptions, push, { workersAiSuggester }] = await Promise.all([
      import('./conversation'), import('./answer'), import('./threads'), import('./notices'), import('./subscriptions'), import('./push'), import('./suggestion'),
    ]);
    const env = this.env;
    const vapid = push.vapidOf(env);
    const providers = productionProviders();
    const { accountId, threadId } = target;
    // A conversation copied from the chat before ADR 0201 may name a file kept there as an envelope, which the Account's key opens.
    let accountKey: Promise<CryptoKey> | null = null;
    const key = (): Promise<CryptoKey> => {
      accountKey ??= import('./keys').then(({ accountKeyFor }) => accountKeyFor(env, accountId));
      return accountKey;
    };
    return openConversation({
      store: {
        readThread: () => threads.readThread(database, threadId),
        readEvents: (after) => threads.readEvents(database, threadId, after),
        appendEvents: (events, title, keepsPlace) => threads.appendEvents({ database, threadId, events, ...(title === undefined ? {} : { title }), ...(keepsPlace ? { keepsPlace } : {}), timestamp: new Date().toISOString() }),
        saveProjection: (projection, sequence) => threads.saveProjection({ database, threadId, projection, sequence }),
        saveMode: (mode, by) => threads.saveMode({ database, threadId, mode, by, timestamp: new Date().toISOString() }),
        savePause: (pause) => threads.savePause({ database, bucket: env.RECOVERY_RECEIPTS, accountId, threadId, pause }),
        readPause: () => threads.readPause({ database, bucket: env.RECOVERY_RECEIPTS, threadId }),
        takePause: (pauseId) => threads.takePause({ database, bucket: env.RECOVERY_RECEIPTS, threadId, pauseId }),
        saveProgress: (progress, kept) => threads.saveProgress({ bucket: env.RECOVERY_RECEIPTS, accountId, threadId, progress, kept }),
        readProgress: (runId) => threads.readProgress({ bucket: env.RECOVERY_RECEIPTS, accountId, threadId, runId }),
        dropProgress: (runId) => threads.dropProgress({ bucket: env.RECOVERY_RECEIPTS, accountId, threadId, runId }),
        allowTool: (tool, by) => threads.allowTool({ database, tool, by, timestamp: new Date().toISOString() }),
        recordUploads: (runId, files) => threads.recordUploads({ database, threadId, runId, files, timestamp: new Date().toISOString() }),
        readUploads: (ids) => threads.readUploads({ database, bucket: env.RECOVERY_RECEIPTS, key, threadId, ids }),
      },
      answering: {
        openRun: (id) => openThreadRun({ env, providers, database, accountId, ...(id ? { id } : {}) }),
        answer: (answer, sink) => {
          const task = answerThread({ env, providers, database, answer: { ...answer, accountId, threadId }, sink });
          // The answer outlives the request that sent the message, as an exchange outlives its screen.
          this.ctx.waitUntil(task);
          return task;
        },
        abandonRun: (runId, error, spent) => abandonThreadRun({ env, providers, database, accountId, runId, error, ...(spent ? { spent } : {}) }),
      },
      followers: () => this.ctx.getWebSockets(),
      now: () => Date.now(),
      later: (ms, act) => {
        setTimeout(act, ms);
      },
      decides: decides(env),
      ...(env.AI ? { suggest: suggesting(workersAiSuggester(env.AI), threadId) } : {}),
      ...(vapid ? { notify: (notice: Notice) => {
        const delivered = notices.deliverNotice(notice, {
          starter: () => subscriptions.threadStarter(database, threadId),
          watching: () => this.watching(),
          claim: (claimed) => subscriptions.claimNotice({ database, threadId, runId: claimed.runId, kind: claimed.kind, timestamp: new Date().toISOString() }),
          subscriptions: (members) => subscriptions.subscriptionsOf(database, members),
          push: (target, payload, options) => push.sendPush({ target, payload, vapid, now: Date.now(), ...options }),
          forget: (endpoint) => subscriptions.forgetEndpoint(database, endpoint),
        }).then((delivery) => {
          console.info(JSON.stringify({ event: 'chat_notice', kind: notice.kind, threadId, runId: notice.runId, ...delivery }));
        }, (error: unknown) => {
          console.error(JSON.stringify({ event: 'chat_notice_failed', kind: notice.kind, threadId, message: error instanceof Error ? error.message : String(error) }));
        });
        this.ctx.waitUntil(delivered);
      } } : {}),
    });
  }
}
