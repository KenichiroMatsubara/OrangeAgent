/**
 * One conversation of Operator Chat as its Durable Object serves
 * it (ADR 0201): the log of its events, numbered per conversation, folded
 * with t3code's own reducer into the conversation a client holds, and sent to
 * every screen following it as t3code's thread stream.
 *
 * A screen connects after the last sequence it applied and is sent the events
 * it missed when this object still holds them all and they are few, otherwise
 * a snapshot of the whole conversation; then `synchronized`, then each event
 * as it happens.
 *
 * Every event is kept in D1 before it is sent, with one exception: the words
 * and reasoning of an answer being written. Those are sent as they arrive, at
 * most every STREAM_MS, and kept at most every PERSIST_MS and whenever any
 * other event is kept, the latest state of each item replacing the ones
 * before it, so the log holds an answer's words once a second rather than
 * once a token. A screen that saw a sequence the log never kept, because the
 * object went away in between, has a sequence this object does not hold and
 * is sent a snapshot.
 */

import { CHAT_MODE_LABELS, CHAT_STOPPED_NOTE, CONVERSATION_TITLE_LENGTH, DEFAULT_CHAT_MODE, type ChatApproval, type ChatMode, type ModelEffort } from '@mail/domain';

import { modeIn, offeredModes } from './modes';
import { heldCall, type Answer, type Hold, type Pause, type Progress, type Spent } from './pause';
import type { TurnEvent, TurnFile, TurnMessage } from './turns';
import type { Notice } from './notices';
import type { NoticeKind } from './subscriptions';
import type { StoredEvent, StoredThread, ThreadActor, Upload } from './threads';
import type { Suggester } from './suggestion';
import { threadTitle } from './threads';
import {
  ABANDONED,
  answerTurn,
  attachFile,
  cancelQueued,
  editQueued,
  effortOf,
  emptyProjection,
  filesOf,
  finishTurn,
  historyOf,
  holdTurn,
  itemEvent,
  messageEvent,
  noticeOf,
  onTurnEvent,
  queuedItem,
  queuedRuns,
  queueMessage,
  readSteers,
  recordUsage,
  requestEvent,
  requestInterrupt,
  requeue,
  requeueSteer,
  resumeHeldTurn,
  restartTurn,
  resumeTurn,
  runEvent,
  startTurn,
  steerItem,
  threadEvent,
  threadOf,
  unfinishedRuns,
  unreadSteers,
  UNTITLED,
  forkOf,
  rewindTo,
  rolledBackRuns,
  type Change,
  type ForkCopy,
  type KeptFile,
  type Recalled,
  type RequestUsage,
  type Sent,
  type Turn,
  type TurnOutcome,
} from './timeline';
import { decodeEvent, decodeProjection, encodeEvent, encodeFrame, encodeProjection, foldEvent, runtimeModeOf, utc, type DomainEvent, type Projection, type Run, type TurnItem } from '@mail/t3chat/wire';

/** How often the words of an answer being written are sent to the screens following it. */
export const STREAM_MS = 100;
/** How often, at most, they are kept in the log while they are written. */
export const PERSIST_MS = 1_000;
/** How many of the latest events the object holds to send a screen that reconnects. */
const RECENT_EVENTS = 256;
/** A screen that missed more events than this is sent a snapshot instead. */
const REPLAY_LIMIT = 200;
/** The largest conversation kept on its row; a larger one is rebuilt from its events when opened. */
const PROJECTION_CHARACTERS = 1_500_000;

/** Where a conversation's log is kept. */
export interface ConversationStore {
  readThread(): Promise<StoredThread | null>;
  readEvents(afterSequence: number): Promise<StoredEvent[]>;
  /** Keeps events and, given, a new title; `keepsPlace` leaves when the conversation last changed as it was, as a rename does. */
  appendEvents(events: readonly StoredEvent[], title?: string, keepsPlace?: boolean): Promise<void>;
  saveProjection(projection: string, sequence: number): Promise<void>;
  /** Keeps the approval mode a member chose. */
  saveMode(mode: ChatMode, by: ThreadActor): Promise<void>;
  /** Keeps an answer waiting for approval, with everything it did, replacing any the conversation still kept. */
  savePause(pause: Pause): Promise<void>;
  /** The answer the conversation keeps waiting for approval, or null. */
  readPause(): Promise<Pause | null>;
  /** Takes the answer waiting for approval so it is resumed once; null when none waits under that id. */
  takePause(pauseId: string): Promise<Pause | null>;
  /** Allows a tool always for the Account. */
  allowTool(tool: string, by: ThreadActor): Promise<void>;
  /** Keeps how far an answer has got, writing its files from the `kept`th on; returns how many files it then holds. */
  saveProgress(progress: Progress, kept: number): Promise<number>;
  /** How far the answer `runId` had got, or null when nothing of it was kept. */
  readProgress(runId: string): Promise<Progress | null>;
  /** Forgets how far an answer had got. */
  dropProgress(runId: string): Promise<void>;
  /** Names the Run of the answer each file a member sent was sent to; the files' bytes are kept already. */
  recordUploads(runId: string, files: readonly Upload[]): Promise<void>;
  /** The files a member sent, by id, with their bytes, in the order asked; a file that cannot be read is left out. */
  readUploads(ids: readonly string[]): Promise<TurnFile[]>;
}


/** How a message sent while an answer is being written reaches it: handed to it at its next step, or queued after it. */
export type Delivery = 'steer' | 'queue';

/** What a member does to a queued message. */
export type QueueCommand =
  | { kind: 'start'; runId: string }
  | { kind: 'steer'; runId: string }
  | { kind: 'cancel'; runId: string }
  | { kind: 'edit'; runId: string; text: string }
  | { kind: 'move'; runId: string; beforeRunId: string | null };

/** What an answer hands the conversation as it is written. */
export interface AnswerSink {
  event(event: TurnEvent): void;
  /** A file the answer kept, already stored, to show beside its words. */
  file(file: KeptFile): void;
  /** Something the member should know about the answer, such as a server whose tools it does not hold. */
  notice(message: string): void;
  /** What one of the answer's model requests consumed, shown with the answer as it is written. */
  usage(used: RequestUsage): void;
  /** Keeps how far the answer has got, before each model request and each call, so it goes on if its object goes away. */
  checkpoint?(progress: Pick<Progress, 'messages' | 'spent'>): Promise<void>;
}

/** The engine that answers: it opens and closes each answer's Run and performs the exchange. */
export interface Answering {
  /** Opens the Run one answer is recorded as, under `id` when given, and returns its id. */
  openRun(id?: string): Promise<string>;
  /**
   * Answers one message and closes its Run, whatever happens: it never throws,
   * and returns how the answer ended.
   */
  answer(input: AnswerInput, sink: AnswerSink): Promise<TurnOutcome>;
  /** Closes the Run of an answer nothing is writing any longer, as failed with `error`, recording what it spent when that is known. */
  abandonRun(runId: string, error: string, spent?: Spent): Promise<void>;
}

/** One answer to write: a message, or an answer that paused, resumed with the member's answer. */
export interface AnswerInput {
  runId: string;
  request: string;
  model: string;
  /** The level of effort the member named; left out, the model's own. */
  effort?: ModelEffort;
  history: TurnMessage[];
  /** The files the member sent with the message. */
  files: TurnFile[];
  signal: AbortSignal;
  /** The conversation's approval mode as it is now, read at every call. */
  mode: () => ChatMode;
  /** What the member said to the answer since it last asked, as the model is to be told it. */
  steer: () => Promise<TurnMessage[]>;
  resume?: { pause: Pause; answer: Answer };
  /** An answer whose object went away while it was written, taken up again from how far it had got. */
  restart?: Progress;
  /** The answers a rewind took back, whose files the answer's sandbox does not start with. */
  discarded: readonly string[];
}

/** A screen following the conversation. */
export interface Follower {
  send(frame: string): void;
}

export interface ConversationPorts {
  store: ConversationStore;
  answering: Answering;
  followers: () => Iterable<Follower>;
  now: () => number;
  /** Runs `act` after `ms`, as `setTimeout` does. */
  later: (ms: number, act: () => void) => void;
  /** Whether a Decider can be asked, without which 自動 is not offered and a conversation kept in it is 無制限. */
  decides: boolean;
  /**
   * Tells the people waiting on an answer what it did: a call waits for
   * approval, or it completed or failed. Who is told, and whether they are
   * looking, is the caller's concern (notices.ts); it never throws.
   */
  notify?: (notice: Notice) => void;
  /** Predicts the member's next message once an answer completes; left out, as where Workers AI is not bound, nothing is suggested. */
  suggest?: Suggester;
}

/** What the member is likely to write next after the answer `runId`, or null; `runId` is null when no answer has ended. */
export interface Suggestion {
  runId: string | null;
  text: string | null;
}

export class ThreadMissing extends Error {
  constructor() {
    super('この会話は見つかりませんでした。');
    this.name = 'ThreadMissing';
  }
}

/** A mode the conversation does not offer, as 自動 is not where no Decider can be asked. */
export class ModeUnoffered extends Error {
  constructor(mode: ChatMode) {
    super(`${CHAT_MODE_LABELS[mode]}は選べません。`);
    this.name = 'ModeUnoffered';
  }
}

export interface Conversation {
  /** Reads the conversation from its log once; later calls wait for the same read. */
  load(): Promise<void>;
  /** What a screen that applied everything up to `afterSequence` is sent first, once loaded. */
  frames(afterSequence: number): string[];
  /**
   * Starts answering a message. A message sent while an answer is being
   * written is handed to it at its next step (`steer`, the default) or
   * queued after it (`queue`); one sent while a call waits for approval
   * declines it, and the model is told the message, unless it is queued or
   * carries files, which are queued.
   */
  dispatch(input: { request: string; model: string; effort?: ModelEffort; by: ThreadActor; files?: readonly Upload[]; delivery?: Delivery }): Promise<boolean>;
  /** Starts, hands on, removes, rewrites, or moves a queued message; false when it is not queued or cannot be now. */
  queue(command: QueueCommand, by?: ThreadActor): Promise<boolean>;
  /** Answers the call waiting for approval and resumes its answer; false when no call waits under that request. */
  respond(input: { requestId: string; decision: ChatApproval; feedback?: string; by: ThreadActor }): Promise<boolean>;
  /** Sets the approval mode, which the next call reads; throws `ModeUnoffered` for a mode the conversation does not offer. */
  setMode(mode: ChatMode, by: ThreadActor): Promise<void>;
  /** Stops the answer being written, or declines the call waiting for approval and ends its answer; false when neither is. */
  interrupt(): Promise<boolean>;
  /**
   * Rewinds the conversation to an earlier message of a member's and answers
   * it again as `request` says, with the files it was sent with: the answer
   * it began and every answer after it are rolled back. False while an answer
   * is being written or waits for approval, which is stopped first, or when
   * the message began no answer that ended.
   */
  rewind(input: { messageId: string; request: string; model: string; effort?: ModelEffort; by: ThreadActor; drop?: readonly string[]; files?: readonly Upload[] }): Promise<boolean>;
  /** Renames the conversation; its place in the list stays. */
  rename(title: string): Promise<void>;
  /** A new conversation `threadId` holding this one up to the answer `runId` ended with; null when it names no answer that ended. */
  fork(runId: string, threadId: string): Promise<Forked | null>;
  /** Stops the answer being written, declines a call waiting for approval, and takes nothing more, as before the conversation is deleted. */
  close(): Promise<void>;
  /** Resolves once the answer being written has ended and everything is kept; a queued message it hands on to has started by then. */
  settled(): Promise<void>;
  /** The latest sequence the conversation holds. */
  sequence(): number;
  /** Whether an answer is being written or about to be; an answer waiting for approval is not. */
  answering(): boolean;
  /** Whether a call waits for approval. */
  waiting(): boolean;
  /**
   * What the member is likely to write next: predicted once for the latest
   * answer, when it completed and nothing is being written, waits for
   * approval, or is queued, and kept for as long as it stays the latest.
   */
  suggestion(): Promise<Suggestion>;
}

/** The latest answer that started, which a suggestion follows; a queued message that never started is not one. */
const latestStartedRun = (projection: Projection): Run | null => projection.runs
  .filter((run) => run.startedAt !== null)
  .reduce<Run | null>((latest, run) => latest === null || run.ordinal > latest.ordinal ? run : latest, null);

/** A conversation continued from one of this one's answers: its title, its events as they are kept, and each file it names under its own id. */
export interface Forked {
  title: string;
  events: StoredEvent[];
  files: ForkCopy['files'];
}

/** What a conversation continued from another is called: the other's title, marked as its continuation, within the length a title keeps. */
export const forkTitle = (title: string): string => {
  const mark = '（続き）';
  return `${threadTitle(title || UNTITLED).slice(0, CONVERSATION_TITLE_LENGTH - mark.length)}${mark}`;
};

/** The call a conversation waits on, as the object holds it between the pause and the answer. */
interface Waiting {
  id: string;
  runId: string;
  callId: string;
  itemId: string;
  createdAt: number;
}

const waitingOf = (pause: Pause): Waiting =>
  ({ id: pause.id, runId: pause.runId, callId: heldCall(pause).id, itemId: pause.itemId, createdAt: Date.parse(pause.createdAt) });

/** What a pause that could not be kept fails its answer with. */
const UNKEPT = '承認を待つ間の状態を保存できなかったため、回答を終えました。もう一度送ってください。';

const SYNCHRONIZED = encodeFrame({ kind: 'synchronized' });

/**
 * How many objects in a row may take an answer up again without it getting
 * further, so an answer whose own work takes its object down ends rather than
 * being taken up for ever.
 */
const RESTARTS = 2;

/** How many times the model has answered among an answer's messages, which is how far it has got. */
const replies = (messages: readonly TurnMessage[]): number => messages.filter((message) => message.role === 'assistant').length;

interface Unsaved extends StoredEvent {
  itemId: string | null;
}

export const openConversation = (ports: ConversationPorts): Conversation => {
  const { store, answering } = ports;
  let projection: Projection = emptyProjection(threadOf({ id: 'unloaded', title: '', createdAt: 0, updatedAt: 0 }));
  let sequence = 0;
  let titled = false;
  // The latest events, and the sequence after which every event the log keeps is among them.
  let recent: Array<{ sequence: number; frame: string }> = [];
  let recentFloor = 0;
  // Events sent but not yet kept: the words of an answer being written.
  let unsaved: Unsaved[] = [];
  // The latest state of each item being written, waiting to be sent.
  const streaming = new Map<string, TurnItem>();
  let streamScheduled = false;
  let persistScheduled = false;
  let loading: Promise<void> | null = null;
  let active: { controller: AbortController; turn: Turn; done: Promise<void> } | null = null;
  let busy = false;
  // The mode the conversation is in, which is the one kept unless that is 自動 where no Decider can be asked.
  let mode: ChatMode = DEFAULT_CHAT_MODE;
  let waiting: Waiting | null = null;
  // A queued message being started, which no command may change meanwhile.
  let starting: { runId: string; done: Promise<void> } | null = null;
  // Once the conversation is being deleted, it takes nothing more.
  let closed = false;
  // Messages an answer has read, so none is handed to it twice while its being read is kept.
  const heard = new Set<string>();
  // How many files each answer's kept progress holds, so each is written once.
  const progressFiles = new Map<string, number>();
  // The members each answer was asked by: who sent its message, handed it one, started it from the queue, or answered its approval.
  const askers = new Map<string, Set<string>>();

  const asked = (runId: string, by: ThreadActor | undefined): void => {
    if (!by?.identityId) return;
    const members = askers.get(runId) ?? new Set<string>();
    members.add(by.identityId);
    askers.set(runId, members);
  };

  /** Tells the people waiting on the answer what it did. */
  const tell = (kind: NoticeKind, runId: string, label?: string): void => {
    if (!ports.notify) return;
    try {
      ports.notify({
        kind, runId, threadId: projection.thread.id, title: titled ? projection.thread.title : '',
        askedBy: [...askers.get(runId) ?? []], ...(label ? { label } : {}),
      });
    } catch {
      // A notification that cannot be sent changes nothing of the conversation.
    }
  };

  // Every change to the log runs in order, so events are numbered, kept, and sent in sequence.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task);
    chain = run.catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'chat_thread_failed', message: error instanceof Error ? error.message : String(error) }));
    });
    return run;
  };

  const send = (frame: string): void => {
    for (const follower of ports.followers()) {
      try {
        follower.send(frame);
      } catch {
        // A screen that went away is dropped by the object; the others still follow.
      }
    }
  };

  const remember = (entry: { sequence: number; frame: string }): void => {
    recent.push(entry);
    if (recent.length <= RECENT_EVENTS) return;
    const dropped = recent.shift();
    if (dropped) recentFloor = dropped.sequence;
  };

  /** Gives the event the next sequence and folds it into the conversation. */
  const numbered = (event: DomainEvent, itemId: string | null): { stored: Unsaved; frame: string } => {
    sequence += 1;
    projection = foldEvent(projection, event);
    const frame = encodeFrame({ kind: 'event', sequence, event });
    remember({ sequence, frame });
    return { stored: { sequence, type: event.type, payload: encodeEvent(event), createdAt: new Date(ports.now()).toISOString(), itemId }, frame };
  };

  const write = async (events: readonly Unsaved[], title?: string, keepsPlace?: boolean): Promise<void> => {
    if (!events.length) return;
    try {
      await store.appendEvents(events.map(({ itemId: _itemId, ...event }) => event), title, keepsPlace);
    } catch (error) {
      // Kept again with the next events, so a passing failure loses nothing the screens were sent.
      unsaved = [...events, ...unsaved].toSorted((left, right) => left.sequence - right.sequence);
      throw error;
    }
  };

  const flush = async (): Promise<void> => {
    const pending = unsaved;
    unsaved = [];
    await write(pending);
  };

  /** Keeps events, together with every streamed one not kept yet, and only then sends them. */
  const keep = (events: readonly DomainEvent[], title?: string, keepsPlace?: boolean): Promise<void> => enqueue(async () => {
    const entries = events.map((event) => numbered(event, null));
    const pending = unsaved;
    unsaved = [];
    try {
      await write([...pending, ...entries.map((entry) => entry.stored)], title, keepsPlace && !pending.length);
    } finally {
      for (const entry of entries) send(entry.frame);
    }
  });

  const sendStreamed = (): Promise<void> => enqueue(async () => {
    streamScheduled = false;
    const items = [...streaming.values()];
    streaming.clear();
    for (const item of items) {
      const entry = numbered(itemEvent(item, ports.now()), item.id);
      // The latest state of an item replaces the ones before it that were not kept yet.
      unsaved = [...unsaved.filter((event) => event.itemId !== item.id), entry.stored];
      send(entry.frame);
    }
    if (persistScheduled || !unsaved.length) return;
    persistScheduled = true;
    ports.later(PERSIST_MS, () => {
      persistScheduled = false;
      void enqueue(flush);
    });
  });

  /** Sends and keeps each change: streamed words coalesced, anything else kept before it is sent. */
  const apply = (changes: readonly Change[]): void => {
    const kept: DomainEvent[] = [];
    for (const change of changes) {
      if (change.streaming) {
        streaming.set(change.item.id, change.item);
        continue;
      }
      // A kept state supersedes any streamed one still waiting to be sent.
      streaming.delete(change.item.id);
      kept.push(itemEvent(change.item, ports.now()));
    }
    if (kept.length) void keep(kept).catch(() => undefined);
    if (streaming.size && !streamScheduled) {
      streamScheduled = true;
      ports.later(STREAM_MS, () => {
        void sendStreamed();
      });
    }
  };

  /** Keeps the conversation as it now stands on its row, once everything before it is kept. */
  const saveProjection = (): Promise<void> => enqueue(async () => {
    await flush();
    const text = encodeProjection(projection);
    if (text.length > PROJECTION_CHARACTERS) return;
    await store.saveProjection(text, sequence);
  });

  // The snapshot's records name their ids through one table, as t3code's own server sends it.
  const snapshot = (): string => encodeFrame({ kind: 'snapshot', snapshotSequence: sequence, projection, idTable: true });

  const read = async (): Promise<void> => {
    const row = await store.readThread();
    if (!row) throw new ThreadMissing();
    titled = row.title.trim() !== '';
    projection = row.projection
      ? decodeProjection(row.projection)
      : emptyProjection(threadOf({ id: row.id, title: row.title, createdAt: Date.parse(row.createdAt), updatedAt: Date.parse(row.updatedAt), mode: modeIn(row.mode, ports.decides) }));
    recent = [];
    recentFloor = row.projectionSequence;
    let last = row.projectionSequence;
    for (const stored of await store.readEvents(row.projectionSequence)) {
      const event = decodeEvent(stored.payload);
      projection = foldEvent(projection, event);
      remember({ sequence: stored.sequence, frame: encodeFrame({ kind: 'event', sequence: stored.sequence, event }) });
      last = stored.sequence;
    }
    sequence = Math.max(row.lastSequence, last);
    mode = modeIn(row.mode, ports.decides);
    if (projection.thread.runtimeMode !== runtimeModeOf(mode)) {
      await keep([threadEvent({ ...projection.thread, runtimeMode: runtimeModeOf(mode) }, ports.now())]);
    }
    // A call kept waiting for approval waits still, whichever object asked; it is the record, so it is read before the runs.
    const pause = await store.readPause().catch(() => null);
    waiting = null;
    let restarting: { turn: Turn; progress: Progress } | null = null;
    for (const run of unfinishedRuns(projection)) {
      if (pause?.runId === run.id) {
        waiting = waitingOf(pause);
        // An object that went away after keeping the pause but before showing it is shown now.
        if (run.status !== 'waiting') await showHold(resumeHeldTurn(projection, run, { callId: waiting.callId, itemId: pause.itemId }), pause, waiting.id);
        continue;
      }
      // An answer recorded as being written that this object is not writing was left by an object that went away:
      // it goes on from how far it had got, unless it was taken up again too often without getting further.
      const progress = restarting ? null : await store.readProgress(run.id).catch(() => null);
      if (progress && progress.restarts < RESTARTS) {
        const taken: Progress = { ...progress, restarts: progress.restarts + 1 };
        progressFiles.set(run.id, await store.saveProgress(taken, Number.MAX_SAFE_INTEGER));
        const turn = resumeTurn(projection, run);
        await keep(restartTurn(turn, ports.now()).map((change) => itemEvent(change.item, ports.now())));
        restarting = { turn, progress: taken };
        continue;
      }
      const ended = finishTurn(resumeTurn(projection, run), { kind: 'failed', message: ABANDONED }, ports.now());
      await keep([...ended.changes.map((change) => itemEvent(change.item, ports.now())), runEvent('run.updated', ended.run, ports.now())]);
      await answering.abandonRun(run.id, ABANDONED, progress?.spent).catch(() => undefined);
      await forgetProgress(run.id);
      await requeueUnread(run.id, run.modelSelection.model, effortOf(run));
    }
    // A pause whose answer has ended waits for nothing.
    if (pause && !waiting) await store.takePause(pause.id).catch(() => null);
    // Nothing starts a queued message left by an object that went away but the member, so it waits held; one behind an answer that goes on waits for it.
    if (!waiting && !restarting) await holdQueue();
    // A screen still connected from before may hold a sequence the log never kept, so it is sent the conversation again.
    send(snapshot());
    send(SYNCHRONIZED);
    if (restarting) {
      const { turn, progress } = restarting;
      busy = true;
      try {
        const [files, history] = await Promise.all([filesFor(turn.runId), recall(historyOf(projection))]);
        writeAnswer(turn, { request: progress.request, model: progress.model, ...(progress.effort ? { effort: progress.effort } : {}), files, history, restart: progress });
      } catch (error) {
        busy = false;
        throw error;
      }
    }
  };

  /** Forgets how far an answer had got, once it has ended or waits for approval. */
  const forgetProgress = async (runId: string): Promise<void> => {
    progressFiles.delete(runId);
    await store.dropProgress(runId).catch(() => undefined);
  };

  const load = (): Promise<void> => {
    loading ??= read().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };

  const frames = (afterSequence: number): string[] => {
    if (afterSequence <= 0 || afterSequence > sequence || afterSequence < recentFloor) return [snapshot(), SYNCHRONIZED];
    if (afterSequence === sequence) return [SYNCHRONIZED];
    const missed = recent.filter((entry) => entry.sequence > afterSequence);
    if (missed.length > REPLAY_LIMIT) return [snapshot(), SYNCHRONIZED];
    return [...missed.map((entry) => entry.frame), SYNCHRONIZED];
  };

  /** Keeps changes to the queue, numbered and folded like every other event. */
  const keepRuns = async (runs: readonly Run[]): Promise<void> => {
    if (runs.length) await keep(runs.map((run) => runEvent('run.updated', run, ports.now())));
  };

  /** Holds every queued message, so none starts until the member starts one. */
  const holdQueue = async (): Promise<void> => {
    await keepRuns(requeue(projection, queuedRuns(projection).map((run) => run.id), true));
  };

  /**
   * Messages handed to an answer that ended before reading them are queued
   * first instead, in the order they were sent.
   */
  async function requeueUnread(runId: string, model: string, effort: ModelEffort | undefined): Promise<void> {
    const unread = unreadSteers(projection, runId).filter((item) => !heard.has(item.id));
    if (!unread.length) return;
    const events: DomainEvent[] = [];
    let current = projection;
    const front: string[] = [];
    for (const item of unread) {
      const queued = requeueSteer(current, item, { runId: crypto.randomUUID(), model, ...(effort ? { effort } : {}), at: ports.now() });
      const created = [itemEvent(queued.user, ports.now()), messageEvent(queued.message, ports.now()), runEvent('run.created', queued.run, ports.now())];
      for (const event of created) current = foldEvent(current, event);
      events.push(...created);
      front.push(queued.run.id);
    }
    await keep(events);
    const rest = queuedRuns(projection).map((run) => run.id).filter((id) => !front.includes(id));
    await keepRuns(requeue(projection, [...front, ...rest]));
  }

  const finish = async (turn: Turn, outcome: Exclude<TurnOutcome, { kind: 'waiting' }>): Promise<void> => {
    const ended = finishTurn(turn, outcome, ports.now());
    for (const change of ended.changes) streaming.delete(change.item.id);
    await keep([...ended.changes.map((change) => itemEvent(change.item, ports.now())), runEvent('run.updated', ended.run, ports.now())]).catch(() => undefined);
    await requeueUnread(turn.runId, turn.model, turn.effort).catch(() => undefined);
    await forgetProgress(turn.runId);
    // Stopping an answer holds the queue behind it; the member starts it again.
    if (outcome.kind === 'interrupted') await holdQueue().catch(() => undefined);
    await saveProjection().catch(() => undefined);
    // A stopped answer was stopped by someone looking at it, and tells nobody.
    if (outcome.kind === 'completed' || outcome.kind === 'failed') tell(outcome.kind, turn.runId);
  };

  /** Shows a kept pause: the call waits, the member is asked, and the Run waits. */
  async function showHold(turn: Turn, hold: Pick<Hold, 'calls' | 'description' | 'reason'>, requestId: string, createdAt = ports.now()): Promise<string> {
    const held = holdTurn(turn, { callId: heldCall(hold).id, requestId, description: hold.description, reason: hold.reason, createdAt }, ports.now());
    for (const change of held.changes) streaming.delete(change.item.id);
    await keep([
      ...held.changes.map((change) => itemEvent(change.item, ports.now())),
      requestEvent(turn.threadId, held.request, ports.now()),
      runEvent('run.updated', held.run, ports.now()),
    ]);
    return held.itemId;
  }

  /**
   * An answer that paused before a call: everything it did is kept first, so
   * it resumes from there whichever object receives the member's answer, and
   * only then is the member asked. An answer whose pause cannot be kept ends.
   */
  const pauseAnswer = async (turn: Turn, hold: Hold, answer: { request: string; model: string; effort?: ModelEffort }): Promise<void> => {
    const requestId = crypto.randomUUID();
    const call = heldCall(hold);
    const createdAt = ports.now();
    const itemId = turn.tools.get(call.id)?.id;
    const pause: Pause = { ...hold, id: requestId, runId: turn.runId, request: answer.request, model: answer.model, ...(answer.effort ? { effort: answer.effort } : {}), itemId: itemId ?? '', createdAt: new Date(createdAt).toISOString() };
    try {
      if (!itemId) throw new Error('The held call has no item.');
      await store.savePause(pause);
    } catch {
      await finish(turn, { kind: 'failed', message: UNKEPT });
      await answering.abandonRun(turn.runId, UNKEPT, hold.spent).catch(() => undefined);
      return;
    }
    // The pause holds everything the answer did, so how far it had got is not kept beside it.
    await forgetProgress(turn.runId);
    await showHold(turn, hold, requestId, createdAt).catch(() => undefined);
    waiting = waitingOf(pause);
    await saveProjection().catch(() => undefined);
    tell('approval', turn.runId, hold.label);
  };

  /** What the model is told of the conversation so far, each member's message with the files sent with it. */
  const recall = (history: readonly Recalled[]): Promise<TurnMessage[]> => Promise.all(history.map(async ({ message, files }) => {
    if (!files.length) return message;
    const attachments = await store.readUploads(files).catch(() => []);
    return attachments.length ? { ...message, attachments } : message;
  }));

  /** The files sent with the message a Run answers. */
  const filesFor = async (runId: string): Promise<TurnFile[]> => {
    const item = queuedItem(projection, runId);
    const ids = item ? filesOf(item).map((file) => file.id) : [];
    return ids.length ? store.readUploads(ids).catch(() => []) : [];
  };

  /** Hands the answer the messages sent to it since it last asked, and shows them read. */
  const steersFor = (turn: Turn) => async (): Promise<TurnMessage[]> => {
    const unread = unreadSteers(projection, turn.runId).filter((item) => !heard.has(item.id));
    if (!unread.length) return [];
    for (const item of unread) heard.add(item.id);
    apply(readSteers(turn, unread, ports.now()));
    return Promise.all(unread.map(async (item): Promise<TurnMessage> => {
      const ids = filesOf(item).map((file) => file.id);
      const attachments = ids.length ? await store.readUploads(ids).catch(() => []) : [];
      return { role: 'user', content: item.text, ...(attachments.length ? { attachments } : {}) };
    }));
  };

  /** Writes one answer, a new one or one resumed, until it ends or waits for the member; then the next queued message starts. */
  const writeAnswer = (turn: Turn, input: Omit<AnswerInput, 'runId' | 'signal' | 'mode' | 'steer' | 'discarded'>): void => {
    const controller = new AbortController();
    const sink: AnswerSink = {
      event: (event) => apply(onTurnEvent(turn, event, ports.now())),
      file: (file) => apply(attachFile(turn, file, ports.now())),
      notice: (message) => apply(noticeOf(turn, message, ports.now())),
      usage: (used) => {
        void keep([runEvent('run.updated', recordUsage(turn, used), ports.now())]).catch(() => undefined);
      },
      checkpoint: async ({ messages, spent }) => {
        // Taken up again, an answer counts its restarts until it gets further than where it was taken up.
        const further = replies(messages) > replies(input.restart?.messages ?? []);
        const progress: Progress = {
          runId: turn.runId, request: input.request, model: input.model, ...(input.effort ? { effort: input.effort } : {}),
          messages, spent, restarts: further ? 0 : input.restart?.restarts ?? 0,
        };
        progressFiles.set(turn.runId, await store.saveProgress(progress, progressFiles.get(turn.runId) ?? 0));
      },
    };
    let next = false;
    const done = (async () => {
      const outcome = await answering.answer({ ...input, runId: turn.runId, signal: controller.signal, mode: () => mode, steer: steersFor(turn), discarded: rolledBackRuns(projection) }, sink)
        .catch((error: unknown): TurnOutcome => ({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }));
      if (outcome.kind === 'waiting') await pauseAnswer(turn, outcome.hold, input);
      else await finish(turn, outcome);
      next = outcome.kind === 'completed' || outcome.kind === 'failed';
    })().finally(() => {
      active = null;
      busy = false;
      if (next) startNext();
    });
    active = { controller, turn, done };
  };

  /**
   * Starts one answer: its Run, the member's message, and its Run's record,
   * kept before anything the model does. A queued message's Run is opened
   * under the id it was queued with, and its message moves to where its
   * answer starts. `busy` is claimed by the caller.
   */
  const begin = async (input: { runId?: string; sent: Sent; model: string; effort?: ModelEffort; queued?: Run; uploads?: readonly Upload[]; by?: ThreadActor }): Promise<void> => {
    let turn: Turn;
    try {
      const runId = await answering.openRun(input.runId);
      asked(runId, input.by);
      if (input.uploads?.length) await store.recordUploads(runId, input.uploads);
      const started = startTurn({
        projection, runId, request: input.sent.text, model: input.model, ...(input.effort ? { effort: input.effort } : {}), at: ports.now(), files: input.sent.files,
        ...(input.queued ? { intent: 'queued_turn' as const, itemId: input.queued.userMessageId } : {}),
      });
      turn = started.turn;
      const events: DomainEvent[] = [];
      let title: string | undefined;
      if (!titled) {
        title = threadTitle(input.sent.text);
        titled = true;
        events.push(threadEvent({ ...projection.thread, title: title || UNTITLED, updatedAt: utc(ports.now()) }, ports.now()));
      }
      // A queued message moves before its Run leaves the queue, so it is never shown where it was queued.
      events.push(itemEvent(started.user, ports.now()), runEvent(input.queued ? 'run.updated' : 'run.created', input.queued ? { ...started.run, requestedAt: input.queued.requestedAt } : started.run, ports.now()));
      await keep(events, title);
    } catch (error) {
      busy = false;
      throw error;
    }
    const [files, history] = await Promise.all([filesFor(turn.runId), recall(historyOf(projection))]);
    writeAnswer(turn, { request: input.sent.text, model: input.model, ...(input.effort ? { effort: input.effort } : {}), files, history });
  };

  /** Starts a queued message now, whatever its place. */
  const startQueued = (run: Run, by?: ThreadActor): Promise<void> => {
    const item = queuedItem(projection, run.id);
    asked(run.id, by);
    busy = true;
    const effort = effortOf(run);
    const done = begin({ runId: run.id, sent: { text: item?.text ?? '', files: item ? filesOf(item) : [] }, model: run.modelSelection.model, ...(effort ? { effort } : {}), queued: run })
      .finally(() => {
        if (starting?.runId === run.id) starting = null;
      });
    starting = { runId: run.id, done: done.catch(() => undefined) };
    return done;
  };

  /** Starts the first queued message not held, once nothing is being written or waits. */
  function startNext(): void {
    if (busy || waiting || closed) return;
    const run = queuedRuns(projection).find((candidate) => !candidate.queueHeld);
    if (!run) return;
    void startQueued(run).catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'chat_queue_failed', message: error instanceof Error ? error.message : String(error) }));
    });
  }

  /** Queues a message after every other, its files named as sent to the Run it will be. */
  const enqueueMessage = async (input: { sent: Sent; model: string; effort?: ModelEffort; files: readonly Upload[]; by?: ThreadActor }): Promise<void> => {
    const runId = crypto.randomUUID();
    asked(runId, input.by);
    if (input.files.length) await store.recordUploads(runId, input.files);
    const queued = queueMessage({ projection, runId, model: input.model, ...(input.effort ? { effort: input.effort } : {}), sent: input.sent, position: queuedRuns(projection).length + 1, at: ports.now() });
    await keep([itemEvent(queued.user, ports.now()), messageEvent(queued.message, ports.now()), runEvent('run.created', queued.run, ports.now())]);
  };

  /** Hands a message to the answer being written, shown where it was sent until the answer reads it. */
  const steer = async (turn: Turn, input: { id: string; sent: Sent; intent: 'steer' | 'promoted_queued_to_steer'; files: readonly Upload[] }): Promise<void> => {
    if (input.files.length) await store.recordUploads(turn.runId, input.files);
    await keep(steerItem(turn, { id: input.id, sent: input.sent, intent: input.intent, at: ports.now() }).map((change) => itemEvent(change.item, ports.now())));
  };

  const dispatch = async (input: { request: string; model: string; effort?: ModelEffort; by: ThreadActor; files?: readonly Upload[]; delivery?: Delivery }): Promise<boolean> => {
    await load();
    if (closed) return false;
    const files = input.files ?? [];
    const sent: Sent = { text: input.request, files };
    const delivery = input.delivery ?? 'steer';
    // A message sent while a call waits declines it, and the model is told the message; one queued, or carrying files, waits its turn.
    if (waiting && !busy && delivery === 'steer' && !files.length) return respond({ requestId: waiting.id, decision: 'decline', feedback: input.request, by: input.by });
    if (busy || waiting) {
      const turn = active && !active.controller.signal.aborted ? active.turn : null;
      if (delivery === 'steer' && turn && !waiting) {
        asked(turn.runId, input.by);
        await steer(turn, { id: `${turn.runId}:steer:${crypto.randomUUID()}`, sent, intent: 'steer', files });
      } else await enqueueMessage({ sent, model: input.model, ...(input.effort ? { effort: input.effort } : {}), files, by: input.by });
      return true;
    }
    // Claimed before the first await, so a second message sent at once is handed to this one rather than answered beside it.
    busy = true;
    await begin({ sent, model: input.model, ...(input.effort ? { effort: input.effort } : {}), uploads: files, by: input.by });
    return true;
  };

  const queue = async (command: QueueCommand, by?: ThreadActor): Promise<boolean> => {
    await load();
    if (closed) return false;
    const run = queuedRuns(projection).find((candidate) => candidate.id === command.runId);
    if (!run || starting?.runId === run.id) return false;
    if (command.kind === 'cancel') {
      await keepRuns([cancelQueued(run, ports.now())]);
      await keepRuns(requeue(projection, queuedRuns(projection).map((entry) => entry.id)));
      return true;
    }
    if (command.kind === 'edit') {
      const edited = editQueued(projection, run.id, command.text, ports.now());
      if (!edited) return false;
      await keep([itemEvent(edited.user, ports.now()), messageEvent(edited.message, ports.now())]);
      return true;
    }
    if (command.kind === 'move') {
      const rest = queuedRuns(projection).map((entry) => entry.id).filter((id) => id !== run.id);
      const at = command.beforeRunId === null ? rest.length : rest.findIndex((id) => id === command.beforeRunId);
      if (at < 0) return false;
      await keepRuns(requeue(projection, [...rest.slice(0, at), run.id, ...rest.slice(at)]));
      return true;
    }
    const turn = active && !active.controller.signal.aborted ? active.turn : null;
    // Sent now: handed to the answer being written, or started when nothing is.
    if (command.kind === 'steer' && turn && !waiting) {
      const item = queuedItem(projection, run.id);
      if (!item) return false;
      asked(turn.runId, by);
      await keepRuns([cancelQueued(run, ports.now())]);
      await steer(turn, { id: item.id, sent: { text: item.text, files: filesOf(item) }, intent: 'promoted_queued_to_steer', files: [] });
      await keepRuns(requeue(projection, queuedRuns(projection).map((entry) => entry.id)));
      return true;
    }
    if (busy || waiting) return false;
    busy = true;
    try {
      // Starting one message lets the queue go on after it.
      await keepRuns(requeue(projection, queuedRuns(projection).map((entry) => entry.id), false));
    } catch (error) {
      busy = false;
      throw error;
    }
    const current = queuedRuns(projection).find((candidate) => candidate.id === run.id) ?? run;
    await startQueued(current, by);
    return true;
  };

  /**
   * Takes the waiting call's pause, so it is answered once, and the answer it
   * belongs to rebuilt; null when it was taken or its answer is gone, which
   * then ends.
   */
  const takeWaiting = async (current: Waiting): Promise<{ pause: Pause; turn: Turn } | null> => {
    waiting = null;
    const pause = await store.takePause(current.id);
    const run = projection.runs.find((entry) => entry.id === current.runId);
    if (!run) return null;
    const turn = resumeHeldTurn(projection, run, { callId: current.callId, itemId: current.itemId });
    if (pause) return { pause, turn };
    // A waiting answer whose pause is gone cannot go on.
    await finish(turn, { kind: 'failed', message: ABANDONED });
    await answering.abandonRun(run.id, ABANDONED).catch(() => undefined);
    return null;
  };

  async function respond(input: { requestId: string; decision: ChatApproval; feedback?: string; by: ThreadActor }): Promise<boolean> {
    await load();
    if (closed) return false;
    const current = waiting;
    if (!current || current.id !== input.requestId || busy) return false;
    busy = true;
    let taken: { pause: Pause; turn: Turn } | null;
    try {
      taken = await takeWaiting(current);
      if (!taken) {
        busy = false;
        return false;
      }
      const { pause, turn } = taken;
      asked(turn.runId, input.by);
      const call = heldCall(pause);
      const feedback = input.decision === 'decline' ? input.feedback?.trim() || undefined : undefined;
      // An allowance not kept leaves this call allowed and the next one asked about.
      if (input.decision === 'acceptAlways') await store.allowTool(call.name, input.by).catch(() => undefined);
      const answered = answerTurn(turn, { callId: call.id, requestId: pause.id, createdAt: current.createdAt, decision: input.decision, ...(feedback ? { feedback } : {}) }, ports.now());
      await keep([
        ...answered.changes.map((change) => itemEvent(change.item, ports.now())),
        requestEvent(turn.threadId, answered.request, ports.now()),
        runEvent('run.updated', answered.run, ports.now()),
      ]);
      const answer: Answer = { decision: input.decision === 'decline' ? 'decline' : 'accept', ...(feedback ? { feedback } : {}) };
      const [files, history] = await Promise.all([filesFor(turn.runId), recall(historyOf(projection))]);
      writeAnswer(turn, { request: pause.request, model: pause.model, ...(pause.effort ? { effort: pause.effort } : {}), files, history, resume: { pause, answer } });
      return true;
    } catch (error) {
      if (!active) busy = false;
      throw error;
    }
  }

  const setMode = async (next: ChatMode, by: ThreadActor): Promise<void> => {
    if (!offeredModes(ports.decides).includes(next)) throw new ModeUnoffered(next);
    await load();
    await store.saveMode(next, by);
    mode = next;
    await keep([threadEvent({ ...projection.thread, runtimeMode: runtimeModeOf(next), updatedAt: utc(ports.now()) }, ports.now())]);
  };

  const interrupt = async (): Promise<boolean> => {
    await load();
    // Stopping while a call waits declines it and ends the answer where it stopped.
    if (waiting && !busy) {
      busy = true;
      try {
        const taken = await takeWaiting(waiting);
        if (!taken) return false;
        const { pause, turn } = taken;
        const call = heldCall(pause);
        const answered = answerTurn(turn, { callId: call.id, requestId: pause.id, createdAt: Date.parse(pause.createdAt), decision: 'decline' }, ports.now());
        await keep([...answered.changes.map((change) => itemEvent(change.item, ports.now())), requestEvent(turn.threadId, answered.request, ports.now())]);
        apply(requestInterrupt(turn, ports.now()));
        await finish(turn, { kind: 'interrupted' });
        await answering.abandonRun(turn.runId, CHAT_STOPPED_NOTE, pause.spent).catch(() => undefined);
        return true;
      } finally {
        busy = false;
      }
    }
    if (!active || active.controller.signal.aborted) return false;
    apply(requestInterrupt(active.turn, ports.now()));
    active.controller.abort();
    return true;
  };

  /** Resolves once the answer being written has ended, and the queued message it hands on to, if any, has started. */
  const settled = async (): Promise<void> => {
    await active?.done;
    await starting?.done;
    await chain;
  };

  const rewind = async (input: { messageId: string; request: string; model: string; effort?: ModelEffort; by: ThreadActor; drop?: readonly string[]; files?: readonly Upload[] }): Promise<boolean> => {
    await load();
    // An answer being written, or waiting for approval, is stopped first: the screen offers no rewind until then.
    if (closed || busy || waiting || starting) return false;
    const rewound = rewindTo(projection, input.messageId, ports.now());
    if (!rewound) return false;
    const drop = new Set(input.drop ?? []);
    const added = input.files ?? [];
    // The files it was sent with that the member kept, then those sent with the rewrite.
    const files = [...filesOf(rewound.item).filter((file) => !drop.has(file.id)), ...added];
    if (!input.request.trim() && !files.length) return false;
    // Claimed before the first await, as a message is, so nothing starts beside the answer asked again.
    busy = true;
    try {
      await keep(rewound.rolledBack.map((run) => runEvent('run.updated', run, ports.now())));
    } catch (error) {
      busy = false;
      throw error;
    }
    // The files it was sent with go with it again, the same files the conversation already keeps; only those added are named to the new answer.
    await begin({ sent: { text: input.request, files }, model: input.model, ...(input.effort ? { effort: input.effort } : {}), uploads: added, by: input.by });
    return true;
  };

  const rename = async (title: string): Promise<void> => {
    await load();
    if (closed) return;
    titled = true;
    // A rename changes what the conversation is called, not when it last changed, so its place in the list stays.
    await keep([threadEvent({ ...projection.thread, title: title || UNTITLED }, ports.now())], title, true);
  };

  const fork = async (runId: string, threadId: string): Promise<Forked | null> => {
    await load();
    if (closed) return null;
    const at = ports.now();
    const copy = forkOf(projection, runId, { threadId, at, fileId: () => crypto.randomUUID() });
    if (!copy) return null;
    const createdAt = new Date(at).toISOString();
    return {
      title: forkTitle(titled ? projection.thread.title : ''),
      events: copy.events.map((event, index) => ({ sequence: index + 1, type: event.type, payload: encodeEvent(event), createdAt })),
      files: copy.files,
    };
  };

  const close = async (): Promise<void> => {
    await load().catch(() => undefined);
    closed = true;
    // Nothing queued starts; an answer being written stops, and a call waiting for approval is declined.
    await interrupt().catch(() => false);
    await settled().catch(() => undefined);
  };

  // The suggestion for the latest answer, asked for once however many screens read it.
  let suggested: { runId: string; text: Promise<string | null> } | null = null;

  const suggestion = async (): Promise<Suggestion> => {
    await load();
    const run = latestStartedRun(projection);
    if (!run) return { runId: null, text: null };
    const suggest = ports.suggest;
    if (!suggest || closed || busy || waiting !== null || run.status !== 'completed' || queuedRuns(projection).length > 0) return { runId: run.id, text: null };
    if (suggested?.runId !== run.id) {
      const history = historyOf(projection).map(({ message }) => message);
      suggested = { runId: run.id, text: suggest(history).catch(() => null) };
    }
    return { runId: run.id, text: await suggested.text };
  };

  return { load, frames, dispatch, queue, respond, setMode, interrupt, rewind, rename, fork, close, settled, sequence: () => sequence, answering: () => busy, waiting: () => waiting !== null, suggestion };
};
