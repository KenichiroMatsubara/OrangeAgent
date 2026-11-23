import { describe, expect, it } from 'vitest';

import { CHAT_STOPPED_NOTE, type ChatMode } from '@mail/domain';

import { forkTitle, ModeUnoffered, openConversation, PERSIST_MS, STREAM_MS, type AnswerInput, type AnswerSink, type Answering, type ConversationStore } from './conversation';
import { decodePause, encodePause, type Hold, type Pause, type Progress, type Spent } from './pause';
import type { Notice } from './notices';
import type { Suggester } from './suggestion';
import type { StoredEvent, StoredThread, ThreadActor, Upload } from './threads';
import { emptyProjection, threadOf, type KeptFile, type TurnOutcome } from './timeline';
import { decodeEvent, decodeFrame, foldEvent, type StreamItem, type TurnItem } from '@mail/t3chat/wire';
import { applyThreadStreamItem, initialThreadStreamState, type ThreadStreamState } from '../../../packages/t3chat/src/client-runtime/state/threadStream.ts';

const START = Date.parse('2026-11-21T01:00:00.000Z');

const ME: ThreadActor = { identityId: 'identity-1', name: '山田' };

/** A conversation's D1 rows, held in memory. */
const memoryStore = () => {
  const thread: StoredThread = {
    id: 'thread-1', accountId: 'organization-1', title: '', lastSequence: 0, projection: null, projectionSequence: 0, mode: 'auto',
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
  };
  const events: StoredEvent[] = [];
  // A pause as D1 and R2 keep it: its JSON text and its files' bytes, so reading it back builds a new one, as a new object would.
  let paused: { id: string; state: string; files: Uint8Array[] } | null = null;
  const allowed: Array<{ tool: string; by: ThreadActor }> = [];
  const uploads: Array<{ runId: string; file: Upload }> = [];
  const modes: Array<{ mode: ChatMode; by: ThreadActor }> = [];
  const progresses = new Map<string, { state: string; files: Uint8Array[] }>();
  const store: ConversationStore = {
    readThread: async () => ({ ...thread }),
    readEvents: async (after) => events.filter((event) => event.sequence > after),
    appendEvents: async (added, title) => {
      for (const event of added) {
        if (events.some((kept) => kept.sequence === event.sequence)) throw new Error(`sequence ${event.sequence} already kept`);
      }
      events.push(...added);
      events.sort((left, right) => left.sequence - right.sequence);
      thread.lastSequence = Math.max(thread.lastSequence, ...added.map((event) => event.sequence));
      if (title !== undefined) thread.title = title;
    },
    saveProjection: async (projection, sequence) => {
      thread.projection = projection;
      thread.projectionSequence = sequence;
    },
    saveMode: async (mode, by) => {
      thread.mode = mode;
      modes.push({ mode, by });
    },
    savePause: async (pause) => {
      paused = { id: pause.id, ...encodePause(pause) };
    },
    readPause: async () => paused ? decodePause(paused.state, paused.files) : null,
    takePause: async (pauseId) => {
      if (paused?.id !== pauseId) return null;
      const taken = decodePause(paused.state, paused.files);
      paused = null;
      return taken;
    },
    // Progress as R2 keeps it, so reading it back builds a new one, as a new object would.
    saveProgress: async (progress) => {
      const encoded = encodePause(progress);
      progresses.set(progress.runId, encoded);
      return encoded.files.length;
    },
    readProgress: async (runId) => {
      const kept = progresses.get(runId);
      return kept ? decodePause<Progress>(kept.state, kept.files) : null;
    },
    dropProgress: async (runId) => {
      progresses.delete(runId);
    },
    allowTool: async (tool, by) => {
      allowed.push({ tool, by });
    },
    recordUploads: async (runId, files) => {
      uploads.push(...files.map((file) => ({ runId, file })));
    },
    readUploads: async (ids) => ids.flatMap((id) => {
      const kept = uploads.find((entry) => entry.file.id === id);
      return kept ? [{ filename: kept.file.filename, mediaType: kept.file.mediaType, bytes: new TextEncoder().encode(kept.file.id) }] : [];
    }),
  };
  return { store, events, thread, allowed, modes, uploads, paused: () => paused, progresses };
};

/** The timers a conversation sets, run when the test says. */
const clock = () => {
  let now = START;
  const due: Array<{ at: number; act: () => void }> = [];
  return {
    now: () => now,
    later: (ms: number, act: () => void) => {
      due.push({ at: now + ms, act });
    },
    /** Moves time on by `ms`, running every timer that falls due, then lets the conversation finish its writes. */
    advance: async (ms: number) => {
      now += ms;
      for (const timer of due.filter((entry) => entry.at <= now)) {
        due.splice(due.indexOf(timer), 1);
        timer.act();
      }
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    },
  };
};

/** An answer the test writes event by event; `end` finishes it. */
const scripted = () => {
  let sink: AnswerSink | null = null;
  let finish: ((outcome: TurnOutcome) => void) | null = null;
  let signal: AbortSignal | null = null;
  let asked: AnswerInput | null = null;
  const abandoned: string[] = [];
  const spent: Array<Spent | undefined> = [];
  const errors: string[] = [];
  const opened: string[] = [];
  let runs = 0;
  const answering: Answering = {
    openRun: async (id) => {
      runs += 1;
      opened.push(id ?? `run-${runs}`);
      return id ?? `run-${runs}`;
    },
    answer: (input, given) => new Promise<TurnOutcome>((resolve) => {
      sink = given;
      signal = input.signal;
      asked = input;
      finish = resolve;
      input.signal.addEventListener('abort', () => resolve({ kind: 'interrupted' }));
    }),
    abandonRun: async (runId, error, used) => {
      abandoned.push(runId);
      errors.push(error);
      spent.push(used);
    },
  };
  return {
    answering,
    abandoned,
    spent,
    errors,
    opened,
    asked: (): AnswerInput => {
      if (!asked) throw new Error('Nothing was answered.');
      return asked;
    },
    sink: (): AnswerSink => {
      if (!sink) throw new Error('No answer is being written.');
      return sink;
    },
    end: (outcome: TurnOutcome = { kind: 'completed' }) => finish?.(outcome),
    aborted: () => signal?.aborted ?? false,
  };
};

/** A screen following the conversation, applying each frame with the copied client's own reducer. */
const screen = () => {
  const frames: StreamItem[] = [];
  const raw: string[] = [];
  let state: ThreadStreamState = initialThreadStreamState;
  const receive = (frame: string): void => {
    const item = decodeFrame(frame);
    raw.push(frame);
    frames.push(item);
    state = applyThreadStreamItem(state, item);
  };
  return {
    receive,
    follower: { send: receive },
    frames,
    raw,
    state: () => state,
    items: (): TurnItem[] => state.projection?.visibleTurnItems.map((row) => row.item) ?? [],
  };
};

/** A conversation's object; `decides` says whether the Worker holds an OpenRouter key, without which 自動 is not offered. */
const setup = (options: { decides?: boolean; suggest?: Suggester } = {}) => {
  const memory = memoryStore();
  const time = clock();
  const answer = scripted();
  const followers: Array<{ send: (frame: string) => void }> = [];
  // What the conversation tells the people waiting on it; whether anyone is told is notices.ts's.
  const notices: Notice[] = [];
  const conversation = openConversation({
    store: memory.store, answering: answer.answering, followers: () => followers, now: time.now, later: time.later, decides: options.decides ?? true,
    ...(options.suggest ? { suggest: options.suggest } : {}),
    notify: (notice) => {
      notices.push(notice);
    },
  });
  const join = async (afterSequence = 0) => {
    const view = screen();
    await conversation.load();
    followers.push(view.follower);
    for (const frame of conversation.frames(afterSequence)) view.receive(frame);
    return view;
  };
  return { memory, time, answer, followers, conversation, join, notices };
};

describe('a conversation served as t3code thread stream', () => {
  it('sends a new screen a snapshot of the conversation and then synchronized', async () => {
    const { join } = setup();
    const view = await join();

    expect(view.frames.map((frame) => frame.kind)).toEqual(['snapshot', 'synchronized']);
    // The snapshot names its records' ids through one table, as t3code's own server sends it.
    expect(JSON.parse(view.raw[0] ?? '{}')).toMatchObject({ kind: 'snapshot', snapshotSequence: 0, ids: expect.arrayContaining(['thread-1']) });
    expect(view.state()).toMatchObject({ sequence: 0, projection: { thread: { id: 'thread-1', title: '新しい会話' } } });
  });

  it('keeps the message, the title, and the Run before it sends them, numbering each event', async () => {
    const { join, conversation, memory } = setup();
    const view = await join();

    expect(await conversation.dispatch({ request: '今日の予定は？', model: 'test-model', by: ME })).toBe(true);

    const events = view.frames.filter((frame) => frame.kind === 'event');
    expect(events.map((frame) => frame.kind === 'event' ? [frame.sequence, frame.event.type] : null)).toEqual([
      [1, 'thread.metadata-updated'], [2, 'turn-item.updated'], [3, 'run.created'],
    ]);
    expect(memory.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(memory.thread.title).toBe('今日の予定は？');
    expect(view.state().projection?.thread.title).toBe('今日の予定は？');
    expect(view.items()).toEqual([expect.objectContaining({ type: 'user_message', text: '今日の予定は？' })]);
  });

  it('hands a second message to the answer being written rather than answering it beside it', async () => {
    const { conversation, answer } = setup();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });

    expect(await conversation.dispatch({ request: '二つ目', model: 'm', by: ME })).toBe(true);
    expect(conversation.answering()).toBe(true);
    expect(answer.opened).toEqual(['run-1']);
  });

  it('sends the words as they are written, coalesced, and keeps them at most once a second and when anything else is kept', async () => {
    const { join, conversation, memory, time, answer } = setup();
    const view = await join();
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    const kept = memory.events.length;

    answer.sink().event({ type: 'text', text: '今日は' });
    answer.sink().event({ type: 'text', text: '2件' });
    await time.advance(STREAM_MS);
    answer.sink().event({ type: 'text', text: 'です。' });
    await time.advance(STREAM_MS);

    const streamed = view.frames.filter((frame) => frame.kind === 'event' && frame.event.type === 'turn-item.updated').slice(1);
    expect(streamed).toHaveLength(2);
    expect(view.items().at(-1)).toMatchObject({ type: 'assistant_message', text: '今日は2件です。', streaming: true });
    // Sent, not yet kept.
    expect(memory.events).toHaveLength(kept);

    await time.advance(PERSIST_MS);
    // Only the latest state of the item is kept; the state it replaced is never written.
    expect(memory.events.slice(kept).map((event) => event.sequence)).toEqual([5]);

    answer.sink().event({ type: 'text', text: '以上' });
    await time.advance(STREAM_MS);
    answer.sink().event({ type: 'tool', name: 'calendar.search', state: 'started', id: 'call-1', arguments: '{}' });
    await time.advance(0);
    // The tool call is kept with the words streamed before it, which it closes.
    expect(memory.events.slice(kept).map((event) => event.sequence)).toEqual([5, 6, 7, 8]);
    expect(view.items().map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'], ['dynamic_tool', 'running'],
    ]);
  });

  it('ends the answer, keeps everything, and keeps the conversation on its row so it opens from there', async () => {
    const { join, conversation, memory, time, answer } = setup();
    const view = await join();
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    answer.sink().event({ type: 'tool', name: 'calendar.search', state: 'started', id: 'call-1', arguments: '{"day":"today"}' });
    answer.sink().event({ type: 'tool', name: 'calendar.search', state: 'finished', id: 'call-1', result: [{ title: '定例' }] });
    answer.sink().event({ type: 'text', text: '定例が1件です。' });
    answer.sink().file({ id: 'file-1', filename: 'screen.png', mediaType: 'image/png', size: 10 });
    answer.end();
    await time.advance(0);
    await conversation.settled();

    expect(conversation.answering()).toBe(false);
    expect(memory.thread.lastSequence).toBe(conversation.sequence());
    expect(memory.thread.projectionSequence).toBe(conversation.sequence());
    expect(view.state().sequence).toBe(conversation.sequence());
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'completed' })]);
    expect(view.items()).toEqual([
      expect.objectContaining({ type: 'user_message' }),
      expect.objectContaining({ type: 'dynamic_tool', status: 'completed', input: { day: 'today' }, output: [{ title: '定例' }] }),
      expect.objectContaining({ type: 'assistant_message', text: '定例が1件です。', streaming: false, attachments: [expect.objectContaining({ type: 'image', id: 'file-1' })] }),
    ]);

    // Opened again, as after the object went away, the conversation is the one the screen holds.
    const reopened = openConversation({ store: memory.store, answering: answer.answering, followers: () => [], now: time.now, later: time.later, decides: true });
    await reopened.load();
    expect(reopened.sequence()).toBe(conversation.sequence());
    const again = screen();
    for (const frame of reopened.frames(0)) again.receive(frame);
    expect(again.items()).toEqual(view.items());
    expect(answer.abandoned).toEqual([]);
  });

  it('shows what each model request of an answer consumed on its Run as it is written, and keeps it when the answer ends and the conversation is opened again', async () => {
    const { join, conversation, memory, time, answer } = setup();
    const view = await join();
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    answer.sink().usage({ promptTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 150, completionTokens: 40, context: { tokens: 1_040, max: 200_000 } });
    await time.advance(0);
    expect(view.state().projection?.runs[0]?.usage).toEqual({
      requests: 1, inputTokens: 1_000, cachedInputTokens: 800, cacheWriteTokens: 150, outputTokens: 40,
      firstInputTokens: 1_000, firstCachedInputTokens: 800, contextTokens: 1_040, maxContextTokens: 200_000,
    });
    // A request whose adapter says nothing of the context counts its prompt and output, keeping the most the model reads.
    answer.sink().usage({ promptTokens: 1_200, cachedTokens: 1_040, completionTokens: 60 });
    answer.end();
    await time.advance(0);
    await conversation.settled();

    const used = {
      requests: 2, inputTokens: 2_200, cachedInputTokens: 1_840, cacheWriteTokens: 150, outputTokens: 100,
      firstInputTokens: 1_000, firstCachedInputTokens: 800, contextTokens: 1_260, maxContextTokens: 200_000,
    };
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ status: 'completed', usage: used })]);
    const reopened = openConversation({ store: memory.store, answering: answer.answering, followers: () => [], now: time.now, later: time.later, decides: true });
    await reopened.load();
    const again = screen();
    for (const frame of reopened.frames(0)) again.receive(frame);
    expect(again.state().projection?.runs[0]?.usage).toEqual(used);
  });

  it('sends a screen that reconnects only the events it missed, or a snapshot when it holds a sequence the conversation does not', async () => {
    const { join, conversation, time, answer } = setup();
    const first = await join();
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    const seen = first.state().sequence;
    answer.sink().event({ type: 'text', text: '2件です。' });
    answer.end();
    await time.advance(STREAM_MS);
    await conversation.settled();

    const missed = conversation.frames(seen).map((frame) => decodeFrame(frame));
    expect(missed.at(-1)).toEqual({ kind: 'synchronized' });
    expect(missed.slice(0, -1).every((frame) => frame.kind === 'event' && frame.sequence > seen)).toBe(true);
    expect(conversation.frames(conversation.sequence()).map((frame) => decodeFrame(frame).kind)).toEqual(['synchronized']);
    expect(conversation.frames(conversation.sequence() + 5).map((frame) => decodeFrame(frame).kind)).toEqual(['snapshot', 'synchronized']);

    // A screen that applies what it missed holds the same conversation as one that followed throughout.
    const late = screen();
    for (const frame of conversation.frames(0)) late.receive(frame);
    const resumed = screen();
    const upTo = first.frames.findIndex((frame) => frame.kind === 'event' && frame.sequence === seen);
    for (const frame of first.raw.slice(0, upTo + 1)) resumed.receive(frame);
    for (const frame of conversation.frames(seen)) resumed.receive(frame);
    expect(resumed.items()).toEqual(late.items());
  });

  it('stops the answer being written: its words stay, and it ends with the interrupt and its result', async () => {
    const { join, conversation, time, answer } = setup();
    const view = await join();
    await conversation.dispatch({ request: '長い答え', model: 'm', by: ME });
    answer.sink().event({ type: 'text', text: '書きかけ' });
    await time.advance(STREAM_MS);

    expect(await conversation.interrupt()).toBe(true);
    await time.advance(0);
    await conversation.settled();

    expect(answer.aborted()).toBe(true);
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(view.items().map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'],
      ['assistant_message', 'interrupted'],
      ['run_interrupt_request', 'completed'],
      ['run_interrupt_result', 'completed'],
    ]);
    expect(await conversation.interrupt()).toBe(false);
  });

  it('fails an answer an object that went away left running, and closes its Run', async () => {
    const { conversation, memory, time, answer } = setup();
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    answer.sink().event({ type: 'tool', name: 'drive.read', state: 'started', id: 'call-1' });
    await time.advance(0);

    // The object went away: a new one opens the same log while nothing writes the answer.
    const reopened = openConversation({ store: memory.store, answering: answer.answering, followers: () => [], now: time.now, later: time.later, decides: true });
    await reopened.load();
    await reopened.settled();

    const view = screen();
    for (const frame of reopened.frames(0)) view.receive(frame);
    expect(answer.abandoned).toEqual(['run-1']);
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(view.items().map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'], ['dynamic_tool', 'failed'], ['error', 'failed'],
    ]);
  });
});

describe('a conversation whose object went away while an answer was written', () => {
  /** A conversation whose answer kept how far it had got, before `drive.read`, then lost its object while making it. */
  const leftRunning = async () => {
    const context = setup();
    await context.conversation.dispatch({ request: '資料を読んで', model: 'm', effort: 'high', by: ME });
    const sink = context.answer.sink();
    sink.event({ type: 'text', text: '読みます。' });
    await sink.checkpoint?.({ messages: [{ role: 'assistant', content: '読みます。', toolCalls: [{ id: 'call-1', name: 'drive.read', arguments: '{}' }] }], spent: { model: 'm', tokens: 50, toolCalls: 1, output: '読みます。' } });
    sink.event({ type: 'tool', name: 'drive.read', state: 'started', id: 'call-1', arguments: '{}' });
    await context.time.advance(0);
    return context;
  };

  /** A new object opening the same conversation. */
  const reopened = async (context: Awaited<ReturnType<typeof leftRunning>>) => {
    const answer = scripted();
    const conversation = openConversation({ store: context.memory.store, answering: answer.answering, followers: () => [], now: context.time.now, later: context.time.later, decides: true });
    await conversation.load();
    await context.time.advance(0);
    const view = screen();
    for (const frame of conversation.frames(0)) view.receive(frame);
    return { conversation, answer, view };
  };

  it('goes on from how far the answer had got: the call it was making shows its result unknown, and the member is told', async () => {
    const context = await leftRunning();
    const fresh = await reopened(context);

    expect(fresh.answer.abandoned).toEqual([]);
    expect(fresh.conversation.answering()).toBe(true);
    expect(fresh.answer.asked()).toMatchObject({
      runId: 'run-1', request: '資料を読んで', model: 'm', effort: 'high',
      restart: { runId: 'run-1', restarts: 1, spent: { tokens: 50 }, messages: [{ role: 'assistant', toolCalls: [{ id: 'call-1' }] }] },
    });
    expect(fresh.view.state().projection?.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'running' })]);
    expect(fresh.view.items().map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'], ['dynamic_tool', 'failed'], ['system_notice', 'completed'],
    ]);

    fresh.answer.sink().event({ type: 'text', text: '読みました。' });
    fresh.answer.end();
    await context.time.advance(STREAM_MS);
    await fresh.conversation.settled();

    const reread = screen();
    for (const frame of fresh.conversation.frames(0)) reread.receive(frame);
    expect(reread.state().projection?.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'completed' })]);
    // Ended, the answer keeps no progress to be taken up from.
    expect(context.memory.progresses.size).toBe(0);
  });

  it('ends the answer as before once objects took it up again twice without it getting further', async () => {
    const context = await leftRunning();
    await reopened(context);
    await reopened(context);
    const third = await reopened(context);

    expect(third.answer.abandoned).toEqual(['run-1']);
    expect(third.answer.spent).toEqual([expect.objectContaining({ tokens: 50 })]);
    expect(third.view.state().projection?.runs).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(third.view.items().at(-1)).toMatchObject({ type: 'error' });
    expect(context.memory.progresses.size).toBe(0);
  });

  it('counts restarts afresh once the answer taken up gets further', async () => {
    const context = await leftRunning();
    const fresh = await reopened(context);
    const restart = fresh.answer.asked().restart;
    await fresh.answer.sink().checkpoint?.({ messages: restart?.messages ?? [], spent: restart?.spent ?? { model: 'm', tokens: 0, toolCalls: 0, output: '' } });
    expect((await context.memory.store.readProgress('run-1'))?.restarts).toBe(1);

    await fresh.answer.sink().checkpoint?.({ messages: [...restart?.messages ?? [], { role: 'assistant', content: '読み直します。' }], spent: restart?.spent ?? { model: 'm', tokens: 0, toolCalls: 0, output: '' } });
    expect((await context.memory.store.readProgress('run-1'))?.restarts).toBe(0);
  });
});

/** An answer that paused before `mail.send`, with what it did until then. */
const sendHold = (): Hold => ({
  messages: [
    { role: 'assistant', content: '送ります。', toolCalls: [{ id: 'call-1', name: 'mail.send', arguments: '{"to":"a@example.com"}' }, { id: 'call-2', name: 'calendar.search', arguments: '{}' }] },
  ],
  calls: [{ id: 'call-1', name: 'mail.send', arguments: '{"to":"a@example.com"}' }, { id: 'call-2', name: 'calendar.search', arguments: '{}' }],
  reason: '要承認の会話なので、実行する前に確認します。',
  label: 'メールを送る',
  description: 'メールを送る\nto: a@example.com',
  preview: null,
  spent: { model: 'm', tokens: 120, toolCalls: 2, output: '送ります。' },
});

/** A conversation whose answer reached `mail.send` and paused there. */
const pausedConversation = async () => {
  const context = setup();
  const view = await context.join();
  await context.conversation.dispatch({ request: 'a@example.com に送って', model: 'm', by: ME });
  context.answer.sink().event({ type: 'text', text: '送ります。' });
  context.answer.sink().event({ type: 'tool', name: 'mail.send', state: 'started', id: 'call-1', arguments: '{"to":"a@example.com"}' });
  context.answer.end({ kind: 'waiting', hold: sendHold() });
  await context.time.advance(0);
  await context.conversation.settled();
  return { ...context, view };
};

/** A new object opening the same conversation, as after the one that asked was evicted. */
const reopen = async (context: Awaited<ReturnType<typeof pausedConversation>>) => {
  const answer = scripted();
  const conversation = openConversation({ store: context.memory.store, answering: answer.answering, followers: () => [], now: context.time.now, later: context.time.later, decides: true });
  await conversation.load();
  const view = screen();
  for (const frame of conversation.frames(0)) view.receive(frame);
  return { conversation, answer, view };
};

describe('a conversation whose answer waits for approval', () => {
  it('keeps the pause, then asks with three answers while its call and its Run wait, and lets the object rest', async () => {
    const { conversation, memory, view } = await pausedConversation();

    const kept = memory.paused();
    expect(kept).not.toBeNull();
    expect(conversation.answering()).toBe(false);
    expect(conversation.waiting()).toBe(true);
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'waiting' })]);
    const items = view.items();
    expect(items.map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'], ['dynamic_tool', 'waiting'], ['approval_request', 'waiting'],
    ]);
    const approval = items.at(-1);
    expect(approval).toMatchObject({
      type: 'approval_request', requestId: kept?.id, prompt: 'メールを送る\nto: a@example.com', reason: '要承認の会話なので、実行する前に確認します。',
      parentItemId: items[2]?.id,
      options: [{ decision: 'accept', label: '今回だけ許可' }, { decision: 'acceptAlways', label: '今後も許可' }, { decision: 'decline', label: '拒否' }],
    });
    expect(view.state().projection?.runtimeRequests).toEqual([expect.objectContaining({ id: kept?.id, status: 'pending', kind: 'permission' })]);
    expect(memory.thread.projectionSequence).toBe(conversation.sequence());
  });

  it('resumes in a new object after the one that asked was evicted: the approved call is made and the answer goes on', async () => {
    const context = await pausedConversation();
    const pause = (await context.memory.store.readPause()) as Pause;
    const fresh = await reopen(context);

    // The new object still asks, and closes nothing.
    expect(fresh.answer.abandoned).toEqual([]);
    expect(fresh.conversation.waiting()).toBe(true);
    expect(fresh.view.items().at(-1)).toMatchObject({ type: 'approval_request', status: 'waiting' });

    expect(await fresh.conversation.respond({ requestId: 'not-this-one', decision: 'accept', by: ME })).toBe(false);
    expect(await fresh.conversation.respond({ requestId: pause.id, decision: 'accept', by: ME })).toBe(true);
    const asked = fresh.answer.asked();
    expect(asked).toMatchObject({ runId: 'run-1', request: 'a@example.com に送って', model: 'm', resume: { answer: { decision: 'accept' }, pause: { id: pause.id, calls: pause.calls, messages: pause.messages, spent: pause.spent } } });
    expect(asked.history).toEqual([]);
    expect(context.memory.paused()).toBeNull();
    // Answered once: a second answer finds nothing waiting.
    expect(await fresh.conversation.respond({ requestId: pause.id, decision: 'accept', by: ME })).toBe(false);

    const follower = screen();
    for (const frame of fresh.conversation.frames(0)) follower.receive(frame);
    fresh.answer.sink().event({ type: 'tool', name: 'mail.send', state: 'started', id: 'call-1', arguments: '{"to":"a@example.com"}' });
    fresh.answer.sink().event({ type: 'tool', name: 'mail.send', state: 'finished', id: 'call-1', result: { sent: true } });
    fresh.answer.sink().event({ type: 'text', text: '送りました。' });
    fresh.answer.end();
    await context.time.advance(STREAM_MS);
    await fresh.conversation.settled();

    const reread = screen();
    for (const frame of fresh.conversation.frames(0)) reread.receive(frame);
    expect(reread.state().projection?.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'completed' })]);
    expect(reread.state().projection?.runtimeRequests).toEqual([expect.objectContaining({ id: pause.id, status: 'resolved', decision: 'accept' })]);
    // The call is the same item, now done, not a second one.
    expect(reread.items().map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'], ['dynamic_tool', 'completed'], ['approval_request', 'completed'], ['assistant_message', 'completed'],
    ]);
    expect(reread.items()[2]).toMatchObject({ output: { sent: true } });
  });

  it('declines with what the member typed: the model is told it, and the call ends as cancelled', async () => {
    const { conversation, answer, time, view, memory } = await pausedConversation();
    const pause = memory.paused();

    // A message sent while the call waits is the member's answer to it.
    expect(await conversation.dispatch({ request: '宛先は b@example.com にして', model: 'm', by: ME })).toBe(true);
    expect(answer.asked().resume?.answer).toEqual({ decision: 'decline', feedback: '宛先は b@example.com にして' });
    answer.sink().event({ type: 'tool', name: 'mail.send', state: 'started', id: 'call-1', arguments: '{}' });
    answer.sink().event({ type: 'tool', name: 'mail.send', state: 'failed', id: 'call-1', error: 'The member declined this call' });
    answer.end();
    await time.advance(0);
    await conversation.settled();

    expect(view.state().projection?.runtimeRequests).toEqual([expect.objectContaining({ id: pause?.id, status: 'resolved', decision: 'decline', feedback: '宛先は b@example.com にして' })]);
    expect(view.items().filter((item) => item.type === 'dynamic_tool').map((item) => item.status)).toEqual(['cancelled']);
    // The message declined the call; it is not another message of the conversation.
    expect(view.items().filter((item) => item.type === 'user_message')).toHaveLength(1);
  });

  it('allows the tool always for the Account when the member says so', async () => {
    const { conversation, answer, memory } = await pausedConversation();
    const pause = memory.paused();

    expect(await conversation.respond({ requestId: pause?.id ?? '', decision: 'acceptAlways', by: ME })).toBe(true);
    expect(memory.allowed).toEqual([{ tool: 'mail.send', by: ME }]);
    expect(answer.asked().resume?.answer).toEqual({ decision: 'accept' });
  });

  it('stops while waiting: the call is declined, the answer ends stopped, and its Run closes with what it spent', async () => {
    const { conversation, answer, time, view, memory } = await pausedConversation();

    expect(await conversation.interrupt()).toBe(true);
    await time.advance(0);
    await conversation.settled();

    expect(memory.paused()).toBeNull();
    expect(conversation.waiting()).toBe(false);
    expect(answer.abandoned).toEqual(['run-1']);
    expect(answer.spent).toEqual([sendHold().spent]);
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(view.state().projection?.runtimeRequests).toEqual([expect.objectContaining({ status: 'resolved', decision: 'decline' })]);
    expect(view.items().map((item) => [item.type, item.status])).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'], ['dynamic_tool', 'interrupted'], ['approval_request', 'completed'],
      ['run_interrupt_request', 'completed'], ['run_interrupt_result', 'completed'],
    ]);
    expect(answer.errors).toEqual([CHAT_STOPPED_NOTE]);
  });

  it('shows a pause an object kept but went away before showing, when the next object opens it', async () => {
    const context = setup();
    await context.conversation.dispatch({ request: '送って', model: 'm', by: ME });
    context.answer.sink().event({ type: 'tool', name: 'mail.send', state: 'started', id: 'call-1', arguments: '{}' });
    await context.time.advance(0);
    // Kept as the pause, as `pauseAnswer` keeps it, before anything shows it.
    const items = context.memory.events.length;
    const tool = (await context.join()).items().find((item) => item.type === 'dynamic_tool');
    await context.memory.store.savePause({ ...sendHold(), id: 'request-1', runId: 'run-1', request: '送って', model: 'm', itemId: tool?.id ?? '', createdAt: new Date(START).toISOString() });
    expect(context.memory.events.length).toBe(items);

    const fresh = await reopen({ ...context, view: screen() });
    expect(fresh.answer.abandoned).toEqual([]);
    expect(fresh.view.state().projection?.runs).toEqual([expect.objectContaining({ status: 'waiting' })]);
    expect(fresh.view.items().at(-1)).toMatchObject({ type: 'approval_request', requestId: 'request-1', status: 'waiting' });
  });

  it('keeps the mode a member chooses, shows it as t3code\'s runtime mode, and the answer reads it at its next call', async () => {
    const { conversation, join, memory, answer } = setup();
    const view = await join();
    expect(view.state().projection?.thread.runtimeMode).toBe('auto');
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    expect(answer.asked().mode()).toBe('auto');

    await conversation.setMode('ask', ME);

    expect(memory.modes).toEqual([{ mode: 'ask', by: ME }]);
    expect(view.state().projection?.thread.runtimeMode).toBe('approval-required');
    expect(answer.asked().mode()).toBe('ask');
    await conversation.setMode('read_only', ME);
    expect(view.state().projection?.thread.runtimeMode).toBe('auto-accept-edits');
  });

  it('without an OpenRouter key, shows and answers a conversation kept in 自動 as 無制限, and refuses to set 自動', async () => {
    const { conversation, join, memory, answer } = setup({ decides: false });
    const view = await join();
    expect(view.state().projection?.thread.runtimeMode).toBe('full-access');
    await conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    expect(answer.asked().mode()).toBe('unrestricted');

    await expect(conversation.setMode('auto', ME)).rejects.toThrow(ModeUnoffered);
    expect(memory.modes).toEqual([]);
    expect(view.state().projection?.thread.runtimeMode).toBe('full-access');
    await conversation.setMode('ask', ME);
    expect(answer.asked().mode()).toBe('ask');
  });
});


const upload = (id: string, filename = `${id}.png`): Upload => ({ id, filename, mediaType: 'image/png', size: 4, objectKey: `chat-files/organization-1/${id}` });

/** The queued messages a screen holds, first first: their words, and whether they are held. */
const queuedOn = (view: ReturnType<typeof screen>) => {
  const projection = view.state().projection;
  if (!projection) return [];
  return projection.runs
    .filter((run) => run.status === 'queued')
    .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
    .map((run) => [projection.messages.find((message) => message.id === run.userMessageId)?.text ?? '', run.queueHeld ?? false]);
};

describe('a message sent while an answer is being written', () => {
  it('is handed to the answer at its next step, shown waiting to be read until then, and the words after it follow it', async () => {
    const { conversation, join, answer, time } = setup();
    const view = await join();
    await conversation.dispatch({ request: '予定を調べて', model: 'm', by: ME });
    answer.sink().event({ type: 'text', text: '調べます。' });
    answer.sink().event({ type: 'tool', name: 'calendar.search', state: 'started', id: 'call-1', arguments: '{}' });
    await time.advance(0);

    expect(await conversation.dispatch({ request: '来週の分も', model: 'm', by: ME, files: [upload('photo')] })).toBe(true);
    expect(view.items().at(-1)).toMatchObject({ type: 'user_message', text: '来週の分も', inputIntent: 'steer', status: 'pending', runId: 'run-1' });

    // The answer asks before its next request, once its call is made.
    answer.sink().event({ type: 'tool', name: 'calendar.search', state: 'finished', id: 'call-1', result: [] });
    const said = await answer.asked().steer();
    expect(said).toEqual([{ role: 'user', content: '来週の分も', attachments: [{ filename: 'photo.png', mediaType: 'image/png', bytes: new TextEncoder().encode('photo') }] }]);
    // Asked again, it is not handed the same message twice.
    expect(await answer.asked().steer()).toEqual([]);
    answer.sink().event({ type: 'text', text: '来週も確認しました。' });
    answer.end();
    await time.advance(STREAM_MS);
    await conversation.settled();

    expect(view.items().map((item) => [item.type, item.status, 'text' in item ? item.text : null])).toEqual([
      ['user_message', 'completed', '予定を調べて'],
      ['assistant_message', 'completed', '調べます。'],
      ['dynamic_tool', 'completed', null],
      ['user_message', 'completed', '来週の分も'],
      ['assistant_message', 'completed', '来週も確認しました。'],
    ]);
    expect(view.items()[3]).toMatchObject({ inputIntent: 'steer', attachments: [expect.objectContaining({ type: 'image', id: 'photo' })] });
    expect(view.state().projection?.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'completed' })]);
  });

  it('is answered on its own, first, when the answer ended before reading it', async () => {
    const { conversation, join, answer, time } = setup();
    const view = await join();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    await conversation.dispatch({ request: '二つ目', model: 'm', by: ME });
    answer.end();
    await time.advance(0);
    await conversation.settled();

    const asked = answer.asked();
    expect(asked.request).toBe('二つ目');
    expect(asked.runId).not.toBe('run-1');
    expect(asked.history.map((message) => message.content)).toEqual(['一つ目', '']);
    expect(view.items().filter((item) => item.type === 'user_message').map((item) => [item.runId, 'text' in item ? item.text : null, item.status])).toEqual([
      ['run-1', '一つ目', 'completed'], [asked.runId, '二つ目', 'completed'],
    ]);
  });

  it('waits in the queue when asked to, as its own Run in order, and each starts once the answer before it ends', async () => {
    const { conversation, join, answer, time, memory } = setup();
    const view = await join();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    await conversation.dispatch({ request: '二つ目', model: 'm', by: ME, delivery: 'queue', files: [upload('memo', 'memo.png')] });
    await conversation.dispatch({ request: '三つ目', model: 'm', by: ME, delivery: 'queue' });

    expect(queuedOn(view)).toEqual([['二つ目', false], ['三つ目', false]]);
    // A queued message is not shown among the conversation's messages until it starts.
    expect(view.items().filter((item) => item.type === 'user_message').map((item) => 'text' in item ? item.text : null)).toEqual(['一つ目']);
    const second = view.state().projection?.runs.find((run) => run.status === 'queued' && run.queuePosition === 1);
    expect(memory.uploads).toEqual([{ runId: second?.id, file: upload('memo', 'memo.png') }]);

    answer.sink().event({ type: 'text', text: '一つ目の答え' });
    answer.end();
    await time.advance(STREAM_MS);
    await conversation.settled();

    // The next starts as its own Run, opened under the id it was queued with, and is told the answer before it.
    expect(answer.opened).toEqual(['run-1', second?.id]);
    expect(answer.asked()).toMatchObject({ runId: second?.id, request: '二つ目' });
    expect(answer.asked().files).toEqual([{ filename: 'memo.png', mediaType: 'image/png', bytes: new TextEncoder().encode('memo') }]);
    expect(answer.asked().history.map((message) => message.content)).toEqual(['一つ目', '一つ目の答え']);
    expect(queuedOn(view)).toEqual([['三つ目', false]]);
    const users = view.items().filter((item) => item.type === 'user_message');
    expect(users.map((item) => 'text' in item ? item.text : null)).toEqual(['一つ目', '二つ目']);
    // Shown after the answer before it, not where it was queued.
    expect(view.items().map((item) => item.type)).toEqual(['user_message', 'assistant_message', 'user_message']);

    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(answer.asked().request).toBe('三つ目');
    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(queuedOn(view)).toEqual([]);
    expect(view.state().projection?.runs.map((run) => [run.ordinal, run.status])).toEqual([[1, 'completed'], [4, 'completed'], [5, 'completed']]);
  });

  it('answers each message at the level of effort it was sent with, a queued one when it starts and one resumed after approval', async () => {
    const { conversation, join, answer, time, memory } = setup();
    const view = await join();
    await conversation.dispatch({ request: '一つ目', model: 'm', effort: 'low', by: ME });
    await conversation.dispatch({ request: '二つ目', model: 'm', effort: 'max', by: ME, delivery: 'queue' });
    await conversation.dispatch({ request: '三つ目', model: 'm', by: ME, delivery: 'queue' });

    expect(answer.asked()).toMatchObject({ request: '一つ目', effort: 'low' });
    // The queued Run keeps the level it was sent with, so a new object starts it at that level too.
    expect(view.state().projection?.runs.map((run) => run.modelSelection.options ?? [])).toEqual([[{ id: 'effort', value: 'low' }], [{ id: 'effort', value: 'max' }], []]);
    answer.sink().event({ type: 'tool', name: 'mail.send', state: 'started', id: 'call-1', arguments: '{"to":"a@example.com"}' });
    answer.end({ kind: 'waiting', hold: sendHold() });
    await time.advance(0);
    await conversation.settled();
    expect(JSON.parse(memory.paused()?.state ?? '{}')).toMatchObject({ effort: 'low' });
    expect(await conversation.respond({ requestId: memory.paused()?.id ?? '', decision: 'accept', by: ME })).toBe(true);
    expect(answer.asked()).toMatchObject({ request: '一つ目', effort: 'low', resume: { answer: { decision: 'accept' } } });

    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(answer.asked()).toMatchObject({ request: '二つ目', effort: 'max' });
    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(answer.asked().request).toBe('三つ目');
    expect(answer.asked()).not.toHaveProperty('effort');
  });

  it('lets the member move, rewrite, and remove a queued message, and send one now into the answer being written', async () => {
    const { conversation, join, answer, time } = setup();
    const view = await join();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    for (const request of ['A', 'B', 'C']) await conversation.dispatch({ request, model: 'm', by: ME, delivery: 'queue' });
    const idOf = (text: string): string => {
      const projection = view.state().projection;
      const message = projection?.messages.find((entry) => entry.text === text);
      return projection?.runs.find((run) => run.userMessageId === message?.id)?.id ?? '';
    };

    expect(await conversation.queue({ kind: 'move', runId: idOf('C'), beforeRunId: idOf('A') })).toBe(true);
    expect(queuedOn(view).map(([text]) => text)).toEqual(['C', 'A', 'B']);
    expect(await conversation.queue({ kind: 'move', runId: idOf('C'), beforeRunId: null })).toBe(true);
    expect(queuedOn(view).map(([text]) => text)).toEqual(['A', 'B', 'C']);

    expect(await conversation.queue({ kind: 'edit', runId: idOf('B'), text: 'B（直した）' })).toBe(true);
    expect(queuedOn(view).map(([text]) => text)).toEqual(['A', 'B（直した）', 'C']);

    const removed = idOf('A');
    expect(await conversation.queue({ kind: 'cancel', runId: removed })).toBe(true);
    expect(queuedOn(view).map(([text]) => text)).toEqual(['B（直した）', 'C']);
    expect(await conversation.queue({ kind: 'cancel', runId: removed })).toBe(false);

    // Sent now: handed to the answer being written, read at its next step.
    expect(await conversation.queue({ kind: 'steer', runId: idOf('C') })).toBe(true);
    expect(queuedOn(view).map(([text]) => text)).toEqual(['B（直した）']);
    expect(view.items().at(-1)).toMatchObject({ type: 'user_message', text: 'C', inputIntent: 'promoted_queued_to_steer', status: 'pending', runId: 'run-1' });
    expect((await answer.asked().steer()).map((message) => message.content)).toEqual(['C']);

    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(answer.asked().request).toBe('B（直した）');
    expect(answer.opened).toHaveLength(2);
  });

  it('holds the queue when the answer is stopped, until the member sends one of its messages', async () => {
    const { conversation, join, answer, time } = setup();
    const view = await join();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    await conversation.dispatch({ request: 'A', model: 'm', by: ME, delivery: 'queue' });
    await conversation.dispatch({ request: 'B', model: 'm', by: ME, delivery: 'queue' });

    await conversation.interrupt();
    await time.advance(0);
    await conversation.settled();

    expect(answer.opened).toEqual(['run-1']);
    expect(conversation.answering()).toBe(false);
    expect(queuedOn(view)).toEqual([['A', true], ['B', true]]);

    const b = view.state().projection?.runs.find((run) => run.status === 'queued' && run.queuePosition === 2)?.id ?? '';
    expect(await conversation.queue({ kind: 'steer', runId: b })).toBe(true);
    expect(answer.asked().request).toBe('B');
    expect(queuedOn(view)).toEqual([['A', false]]);
    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(answer.asked().request).toBe('A');
  });

  it('keeps the queue through eviction, held, and queues a message the answer never read', async () => {
    const { conversation, memory, time, answer } = setup();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    await conversation.dispatch({ request: '読まれない', model: 'm', by: ME });
    await conversation.dispatch({ request: 'A', model: 'm', by: ME, delivery: 'queue' });
    await time.advance(0);

    // The object went away while it answered: a new one opens the same log.
    const fresh = scripted();
    const reopened = openConversation({ store: memory.store, answering: fresh.answering, followers: () => [], now: time.now, later: time.later, decides: true });
    await reopened.load();
    await reopened.settled();
    const view = screen();
    for (const frame of reopened.frames(0)) view.receive(frame);

    expect(fresh.abandoned).toEqual(['run-1']);
    expect(answer.opened).toEqual(['run-1']);
    expect(queuedOn(view)).toEqual([['読まれない', true], ['A', true]]);
    expect(fresh.opened).toEqual([]);
  });

  it('declines a call waiting for approval with what the member typed, but queues a message asked to wait', async () => {
    const { conversation, answer, view } = await pausedConversation();
    expect(await conversation.dispatch({ request: 'あとでこれも', model: 'm', by: ME, delivery: 'queue' })).toBe(true);
    expect(conversation.waiting()).toBe(true);
    expect(queuedOn(view)).toEqual([['あとでこれも', false]]);

    expect(await conversation.dispatch({ request: 'やめて', model: 'm', by: ME })).toBe(true);
    expect(answer.asked().resume?.answer).toEqual({ decision: 'decline', feedback: 'やめて' });
  });
});

describe('what a conversation tells the people waiting on its answers', () => {
  const OTHER: ThreadActor = { identityId: 'identity-2', name: '佐藤' };

  it('tells of a call waiting for approval by its tool in words, with the conversation\'s title and who asked', async () => {
    const { notices } = await pausedConversation();

    expect(notices).toEqual([{ kind: 'approval', threadId: 'thread-1', runId: 'run-1', title: 'a@example.com に送って', label: 'メールを送る', askedBy: ['identity-1'] }]);
  });

  it('tells of an answer that completed or failed, and says nothing of one that was stopped', async () => {
    const { conversation, answer, time, notices } = setup();
    await conversation.dispatch({ request: '今日の予定は？', model: 'm', by: ME });
    answer.end();
    await time.advance(0);
    await conversation.settled();
    await conversation.dispatch({ request: 'もう一度', model: 'm', by: OTHER });
    answer.end({ kind: 'failed', message: 'モデルに届きませんでした。' });
    await time.advance(0);
    await conversation.settled();
    await conversation.dispatch({ request: '三つ目', model: 'm', by: ME });
    expect(await conversation.interrupt()).toBe(true);
    await time.advance(0);
    await conversation.settled();

    expect(notices.map((notice) => [notice.kind, notice.runId, notice.title, notice.askedBy])).toEqual([
      ['completed', 'run-1', '今日の予定は？', ['identity-1']],
      ['failed', 'run-2', '今日の予定は？', ['identity-2']],
    ]);
  });

  it('counts whoever handed the answer a message or answered its approval among those who asked', async () => {
    const context = await pausedConversation();
    const pause = context.memory.paused();

    expect(await context.conversation.respond({ requestId: pause?.id ?? '', decision: 'accept', by: OTHER })).toBe(true);
    context.answer.end();
    await context.time.advance(0);
    await context.conversation.settled();

    expect(context.notices.map((notice) => [notice.kind, notice.askedBy])).toEqual([
      ['approval', ['identity-1']],
      ['completed', ['identity-1', 'identity-2']],
    ]);

    const steered = setup();
    await steered.conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    await steered.conversation.dispatch({ request: 'それと', model: 'm', by: OTHER });
    steered.answer.end();
    await steered.time.advance(0);
    await steered.conversation.settled();
    expect(steered.notices.map((notice) => notice.askedBy)).toEqual([['identity-1', 'identity-2']]);
  });

  it('tells nothing of an answer an object that went away left running, failed only when the conversation is opened again', async () => {
    const { conversation, memory, time, notices } = setup();
    await conversation.dispatch({ request: '一つ目', model: 'm', by: ME });
    await time.advance(0);
    const reopened = openConversation({
      store: memory.store, answering: scripted().answering, followers: () => [], now: time.now, later: time.later, decides: true,
      notify: (notice) => {
        notices.push(notice);
      },
    });
    await reopened.load();
    await reopened.settled();

    expect(notices).toEqual([]);
  });
});

describe('rewinding a conversation, continuing it as a new one, renaming it, and closing it', () => {
  /** A conversation with two answers that ended: 一つ目 (with a picture) answered A, then 二つ目 answered B. */
  const answered = async () => {
    const context = setup();
    const view = await context.join();
    const answerWith = async (request: string, text: string, files: Upload[] = [], written?: KeptFile): Promise<void> => {
      await context.conversation.dispatch({ request, model: 'm', by: ME, files });
      context.answer.sink().event({ type: 'text', text });
      if (written) context.answer.sink().file(written);
      context.answer.end();
      await context.time.advance(STREAM_MS);
      await context.conversation.settled();
    };
    await answerWith('一つ目', 'A', [upload('photo')], { id: 'sheet', filename: '表.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 9 });
    await answerWith('二つ目', 'B');
    return { ...context, view, answerWith };
  };
  const shown = (items: TurnItem[]) => items.map((item) => item.type === 'user_message' || item.type === 'assistant_message' ? [item.type, item.text] : [item.type]);

  it('rolls back the answer an earlier message began and every one after it, and answers the message as rewritten, with its files', async () => {
    const { conversation, view, answer, memory } = await answered();
    const kept = memory.events.length;

    expect(await conversation.rewind({ messageId: 'run-1:user', request: '一つ目（直した）', model: 'm', by: ME })).toBe(true);

    // The answers taken back stay in the log as they were; only events were added.
    expect(memory.events.length).toBeGreaterThan(kept);
    expect(view.state().projection?.runs.map((run) => [run.id, run.status])).toEqual([['run-1', 'rolled_back'], ['run-2', 'rolled_back'], ['run-3', 'running']]);
    expect(shown(view.items())).toEqual([['user_message', '一つ目（直した）']]);
    // The model is told nothing of the answers taken back, and given the picture the message was sent with.
    expect(answer.asked()).toMatchObject({ request: '一つ目（直した）', history: [], discarded: ['run-1', 'run-2'] });
    expect(answer.asked().files.map((file) => file.filename)).toEqual(['photo.png']);
    expect(view.items()[0]).toMatchObject({ attachments: [expect.objectContaining({ id: 'photo' })] });
  });

  it('answers a rewritten message with the files it kept and those added to it, and with none when every file is left out', async () => {
    const { conversation, view, answer } = await answered();

    // Left with neither words nor files, it is no message.
    expect(await conversation.rewind({ messageId: 'run-1:user', request: '  ', model: 'm', by: ME, drop: ['photo'] })).toBe(false);
    expect(await conversation.rewind({ messageId: 'run-1:user', request: 'こちらで', model: 'm', by: ME, drop: ['photo'], files: [upload('other')] })).toBe(true);

    expect(answer.asked().files.map((file) => file.filename)).toEqual(['other.png']);
    expect(view.items()[0]).toMatchObject({ text: 'こちらで', attachments: [expect.objectContaining({ id: 'other' })] });
  });

  it('keeps every answer before the message rewound to, as the model is told it', async () => {
    const { conversation, view, answer, time, memory } = await answered();

    expect(await conversation.rewind({ messageId: 'run-2:user', request: '二つ目を別の聞き方で', model: 'm', by: ME })).toBe(true);
    answer.sink().event({ type: 'text', text: 'C' });
    answer.end();
    await time.advance(STREAM_MS);
    await conversation.settled();

    expect(shown(view.items())).toEqual([['user_message', '一つ目'], ['assistant_message', 'A'], ['user_message', '二つ目を別の聞き方で'], ['assistant_message', 'C']]);
    expect(answer.asked().history.map((message) => [message.role, message.content])).toEqual([['user', '一つ目'], ['assistant', expect.stringContaining('A')]]);
    // Opened again, as by another object, the conversation is the rewound one.
    const reopened = openConversation({ store: memory.store, answering: answer.answering, followers: () => [], now: time.now, later: time.later, decides: true });
    await reopened.load();
    const again = screen();
    for (const frame of reopened.frames(0)) again.receive(frame);
    expect(again.items()).toEqual(view.items());
    expect(answer.abandoned).toEqual([]);
  });

  it('rewinds nothing while an answer is being written or waits, nor to a message that began no answer', async () => {
    const { conversation, answer, time } = await answered();
    await conversation.dispatch({ request: '三つ目', model: 'm', by: ME });

    expect(await conversation.rewind({ messageId: 'run-1:user', request: '一つ目', model: 'm', by: ME })).toBe(false);
    answer.end();
    await time.advance(0);
    await conversation.settled();
    expect(await conversation.rewind({ messageId: 'nothing:user', request: '一つ目', model: 'm', by: ME })).toBe(false);
    // A message with neither words nor files is no message.
    expect(await conversation.rewind({ messageId: 'run-2:user', request: '  ', model: 'm', by: ME })).toBe(false);
    expect(await conversation.rewind({ messageId: 'run-1:user', request: '  ', model: 'm', by: ME })).toBe(true);
  });

  it('continues the conversation from one of its answers as a new one holding everything up to it, each file under an id of its own', async () => {
    const { conversation, memory } = await answered();
    memory.thread.title = '週末の予定';
    const forked = await conversation.fork('run-1', 'thread-2');

    expect(forked?.title).toBe('一つ目（続き）');
    let projection = emptyProjection(threadOf({ id: 'thread-2', title: forked?.title ?? '', createdAt: START, updatedAt: START }));
    for (const stored of forked?.events ?? []) projection = foldEvent(projection, decodeEvent(stored.payload));
    expect(forked?.events.map((event) => event.sequence)).toEqual(forked?.events.map((_, index) => index + 1));
    expect(projection.runs.map((run) => [run.id, run.status, run.threadId])).toEqual([['run-1', 'completed', 'thread-2']]);
    const items = projection.visibleTurnItems.map((row) => row.item);
    expect(items.every((item) => item.threadId === 'thread-2')).toBe(true);
    expect(shown(items)).toEqual([['user_message', '一つ目'], ['assistant_message', 'A']]);
    const copies = new Map(forked?.files.map((file) => [file.id, file.copy]));
    expect([...copies.keys()].toSorted()).toEqual(['photo', 'sheet']);
    expect(items[0]).toMatchObject({ attachments: [expect.objectContaining({ id: copies.get('photo') })] });
    expect(items[1]).toMatchObject({ attachments: [expect.objectContaining({ id: copies.get('sheet'), name: '表.xlsx' })] });
    expect(copies.get('photo')).not.toBe('photo');

    // An answer taken back, or none at all, is continued from by no new conversation.
    await conversation.rewind({ messageId: 'run-2:user', request: '別の二つ目', model: 'm', by: ME });
    expect(await conversation.fork('run-2', 'thread-3')).toBeNull();
    expect(await conversation.fork('nothing', 'thread-3')).toBeNull();
  });

  it('names a continued conversation after the one it continues, within the length a title keeps', () => {
    expect(forkTitle('週末の予定')).toBe('週末の予定（続き）');
    expect(forkTitle('')).toBe('新しい会話（続き）');
    expect(forkTitle('あ'.repeat(200))).toHaveLength(80);
  });

  it('renames the conversation without changing when it last changed, and its first message names it no longer', async () => {
    const { conversation, memory, time, answer } = setup();
    const places: Array<boolean | undefined> = [];
    const append = memory.store.appendEvents;
    memory.store.appendEvents = async (events, title, keepsPlace) => {
      places.push(keepsPlace);
      await append(events, title, keepsPlace);
    };
    const view = screen();
    await conversation.load();

    await conversation.rename('請求の確認');
    await conversation.dispatch({ request: '今日の予定は？', model: 'm', by: ME });
    answer.end();
    await time.advance(0);
    await conversation.settled();

    expect(memory.thread.title).toBe('請求の確認');
    expect(places[0]).toBe(true);
    for (const frame of conversation.frames(0)) view.receive(frame);
    expect(view.state().projection?.thread.title).toBe('請求の確認');
  });

  it('stops the answer being written when it is closed, and takes nothing more', async () => {
    const { conversation, answer, time, view } = await answered();
    await conversation.dispatch({ request: '三つ目', model: 'm', by: ME });

    const closing = conversation.close();
    await time.advance(0);
    await closing;

    expect(answer.aborted()).toBe(true);
    expect(view.state().projection?.runs.at(-1)).toMatchObject({ id: 'run-3', status: 'interrupted' });
    expect(await conversation.dispatch({ request: '四つ目', model: 'm', by: ME })).toBe(false);
    expect(await conversation.rewind({ messageId: 'run-1:user', request: '一つ目', model: 'm', by: ME })).toBe(false);
  });
});

describe('what a member is likely to write next', () => {
  /** A suggester that answers `text` and records the conversation it was told each time it was asked. */
  const suggester = (text: string | null = '送れ') => {
    const asked: Array<ReadonlyArray<{ role: string; content: string }>> = [];
    const suggest: Suggester = async (history) => {
      asked.push(history.map(({ role, content }) => ({ role, content })));
      return text;
    };
    return { suggest, asked };
  };

  /** Sends `request`, answers it with `words`, and ends the answer as `outcome` says. */
  const answered = async (context: ReturnType<typeof setup>, request: string, words: string, outcome: TurnOutcome = { kind: 'completed' }) => {
    await context.conversation.dispatch({ request, model: 'm', by: ME });
    context.answer.sink().event({ type: 'text', text: words });
    context.answer.end(outcome);
    await context.time.advance(0);
    await context.conversation.settled();
  };

  it('is predicted from the conversation once its latest answer completes, once however often it is read', async () => {
    const { suggest, asked } = suggester('送れ');
    const context = setup({ suggest });
    await answered(context, '通知文を作って', '作りました。送ってよいですか。');

    expect(await context.conversation.suggestion()).toEqual({ runId: 'run-1', text: '送れ' });
    expect(await context.conversation.suggestion()).toEqual({ runId: 'run-1', text: '送れ' });
    expect(asked).toEqual([[{ role: 'user', content: '通知文を作って' }, { role: 'assistant', content: '作りました。送ってよいですか。' }]]);
  });

  it('is predicted again for the next answer', async () => {
    const { suggest, asked } = suggester('送れ');
    const context = setup({ suggest });
    await answered(context, '通知文を作って', '作りました。送ってよいですか。');
    await context.conversation.suggestion();
    await answered(context, '送れ', '送りました。');

    expect(await context.conversation.suggestion()).toEqual({ runId: 'run-2', text: '送れ' });
    expect(asked).toHaveLength(2);
    expect(asked[1]?.at(-1)).toEqual({ role: 'assistant', content: '送りました。' });
  });

  it('is nothing while an answer is being written, after one that was stopped or failed, or before any answer', async () => {
    const { suggest, asked } = suggester('送れ');
    const context = setup({ suggest });

    expect(await context.conversation.suggestion()).toEqual({ runId: null, text: null });
    await context.conversation.dispatch({ request: '予定は？', model: 'm', by: ME });
    expect(await context.conversation.suggestion()).toEqual({ runId: 'run-1', text: null });
    context.answer.end({ kind: 'interrupted' });
    await context.time.advance(0);
    await context.conversation.settled();
    expect(await context.conversation.suggestion()).toEqual({ runId: 'run-1', text: null });
    await answered(context, 'もう一度', '途中まで', { kind: 'failed', message: '止まりました' });
    expect(await context.conversation.suggestion()).toEqual({ runId: 'run-2', text: null });
    expect(asked).toEqual([]);
  });

  it('is nothing where nothing can predict it, or when the suggester fails or predicts nothing', async () => {
    const plain = setup();
    await answered(plain, '予定は？', '定例が1件です。');
    expect(await plain.conversation.suggestion()).toEqual({ runId: 'run-1', text: null });

    const failing = setup({ suggest: async () => {
      throw new Error('Workers AI is unavailable.');
    } });
    await answered(failing, '予定は？', '定例が1件です。');
    expect(await failing.conversation.suggestion()).toEqual({ runId: 'run-1', text: null });

    const silent = setup({ suggest: suggester(null).suggest });
    await answered(silent, '予定は？', '定例が1件です。');
    expect(await silent.conversation.suggestion()).toEqual({ runId: 'run-1', text: null });
  });
});
