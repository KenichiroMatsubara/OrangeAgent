/**
 * What one answer of Operator Chat looks like in t3code's terms
 * (ADR 0201): the engine's TurnEvents turned into turn items, and the answer
 * into a Run whose status follows it. An answer is an ordered list of items,
 * each with its own status: the member's message, the model's reasoning, its
 * text between tool calls, one item per tool call with what it was asked and
 * answered, and, when it ends otherwise than by answering, why.
 *
 * Every function here is pure apart from the clock it is handed: the caller
 * turns each change into an event, numbers it, and keeps it.
 */

import { CHAT_APPROVAL_LABELS, DEFAULT_CHAT_MODE, isModelEffort, toolLabel, type ChatMode, type ModelEffort } from '@mail/domain';

import { STOPPED_NOTE, writtenNote } from './chat-store';
import type { Hold } from './pause';
import type { TurnEvent, TurnMessage } from './turns';
import type { ModelUsage } from './usage';
import { ids, runtimeModeOf, utc, utcMillis, type ChatAttachment, type DomainEvent, type Projection, type Run, type RunUsage, type RuntimeRequest, type Thread, type TurnItem } from '@mail/t3chat/wire';

type Item<T extends TurnItem['type']> = Extract<TurnItem, { readonly type: T }>;
type AssistantItem = Item<'assistant_message'>;
type ReasoningItem = Item<'reasoning'>;
type ToolItem = Item<'dynamic_tool'>;
type UserItem = Item<'user_message'>;
type MessageRecord = Projection['messages'][number];
type EventOf<T extends DomainEvent['type']> = Extract<DomainEvent, { readonly type: T }>;

/** The provider every record names: FlareChat's own engine, whichever model it thinks with. */
const PROVIDER = 'flarechat';
/** The option of a Run's model selection that keeps the level of effort the member named for it. */
const EFFORT_OPTION = 'effort';

/** What a Run records of the model it is answered by, and of the level of effort the member named, if any. */
const selectionOf = (model: string, effort: ModelEffort | undefined): Run['modelSelection'] => ({
  instanceId: ids.provider(PROVIDER),
  model: model || PROVIDER,
  ...(effort ? { options: [{ id: EFFORT_OPTION, value: effort }] } : {}),
});

/** The level of effort the member named for a Run, or none; a Run kept before effort could be named names none. */
export const effortOf = (run: Run): ModelEffort | undefined => {
  const value = run.modelSelection.options?.find((option) => option.id === EFFORT_OPTION)?.value;
  return isModelEffort(value) ? value : undefined;
};

/** What a conversation is called until its first message names it. */
export const UNTITLED = '新しい会話';

/** What a tool call still running when its answer ended is told to have failed with. */
const UNFINISHED = '回答が終わる前にこのツールは終わりませんでした。';

/** What a call being made when its answer's object went away shows; the answer goes on, and the model is told its result is unknown. */
const RESTARTED_CALL = '処理が途中で止まったため、このツールの結果は分かりません。続きでは結果を確かめてから進めます。';

/** What an answer taken up again after its object went away tells the member. */
const RESTARTED = '処理が途中で止まったため、止まる前のところから続けます。';

/** What the item that ends a stopped answer says. */
const STOPPED = '回答を停止しました。';
const STOPPING = '停止を依頼しました。';

/** What a call the member declined shows. */
const DECLINED = '拒否したので実行しませんでした。';

/** What an answer that nothing finished writing says, as when its Durable Object went away. */
export const ABANDONED = '答えを書き終える前に処理が止まりました。もう一度送ってください。';

/**
 * How much of a tool's arguments or answer an item keeps for the screen. The
 * model is told the whole answer; the log keeps what a person reads, so one
 * long mail does not make a conversation too large to keep.
 */
const SHOWN_CHARACTERS = 16_000;

/** The longest failure message t3code's error item carries. */
const FAILURE_CHARACTERS = 4_096;

export interface ThreadFacts {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Its approval mode, which the composer shows as t3code's runtime mode. */
  mode?: ChatMode;
}

export const threadOf = (facts: ThreadFacts): Thread => ({
  id: ids.thread(facts.id),
  projectId: ids.project(PROVIDER),
  title: facts.title.trim() || UNTITLED,
  providerInstanceId: ids.provider(PROVIDER),
  modelSelection: { instanceId: ids.provider(PROVIDER), model: PROVIDER },
  runtimeMode: runtimeModeOf(facts.mode ?? DEFAULT_CHAT_MODE),
  interactionMode: 'default',
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: ids.thread(facts.id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: 'user',
  creationSource: 'web',
  createdAt: utc(facts.createdAt),
  updatedAt: utc(facts.updatedAt),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** A conversation with nothing in it yet. */
export const emptyProjection = (thread: Thread): Projection => ({
  thread,
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: thread.updatedAt,
});

const envelope = (threadId: string, at: number) => ({ id: ids.event(crypto.randomUUID()), threadId: ids.thread(threadId), occurredAt: utc(at) });

export const itemEvent = (item: TurnItem, at: number): EventOf<'turn-item.updated'> =>
  ({ ...envelope(item.threadId, at), type: 'turn-item.updated', payload: item });

export const runEvent = (type: 'run.created' | 'run.updated', run: Run, at: number): EventOf<'run.created' | 'run.updated'> =>
  ({ ...envelope(run.threadId, at), type, payload: run });

export const messageEvent = (message: MessageRecord, at: number): EventOf<'message.updated'> =>
  ({ ...envelope(message.threadId, at), type: 'message.updated', payload: message });

export const threadEvent = (thread: Thread, at: number): DomainEvent => {
  const event: DomainEvent = { ...envelope(thread.id, at), type: 'thread.metadata-updated', payload: thread };
  return event;
};

/** What a run whose model the connection names records of it. */
const runOf = (turn: Turn, status: Run['status'], completedAt: number | null): Run => ({
  id: ids.run(turn.runId),
  threadId: ids.thread(turn.threadId),
  ordinal: turn.runOrdinal,
  providerInstanceId: ids.provider(PROVIDER),
  modelSelection: selectionOf(turn.model, turn.effort),
  providerThreadId: null,
  userMessageId: ids.message(turn.userMessageId),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: utc(turn.startedAt),
  startedAt: utc(turn.startedAt),
  completedAt: completedAt === null ? null : utc(completedAt),
  checkpointId: null,
  contextHandoffId: null,
  ...(turn.usage ? { usage: turn.usage } : {}),
});

/** One answer being written: its open items and its tool calls, by call id. */
export interface Turn {
  readonly threadId: string;
  readonly runId: string;
  /** The item, and message, of the member's message the answer answers. */
  readonly userMessageId: string;
  readonly runOrdinal: number;
  readonly model: string;
  /** The level of effort the member named; left out, the model's own. */
  readonly effort?: ModelEffort;
  readonly startedAt: number;
  /** The ordinal the next item takes, counted across the conversation so items keep their order. */
  ordinal: number;
  text: AssistantItem | null;
  reasoning: ReasoningItem | null;
  interrupt: Item<'run_interrupt_request'> | null;
  readonly tools: Map<string, ToolItem>;
  /** Every item of the answer by id, as it last changed. */
  readonly items: Map<string, TurnItem>;
  /** The calls the member declined, by id, which end as cancelled rather than failed. */
  readonly declined: Set<string>;
  /** What the answer's model requests consumed so far, across a wait for approval too; none before its first. */
  usage?: RunUsage;
}

/** One item as it changed: streamed text and reasoning may be coalesced, anything else is kept as it is. */
export interface Change {
  item: TurnItem;
  streaming: boolean;
}

const base = (turn: Turn, id: string, at: number, status: TurnItem['status']) => {
  const ordinal = turn.ordinal;
  turn.ordinal += 1;
  return {
    id: ids.item(id),
    threadId: ids.thread(turn.threadId),
    runId: ids.run(turn.runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status,
    title: null,
    startedAt: utc(at),
    completedAt: status === 'running' ? null : utc(at),
    updatedAt: utc(at),
  };
};

const changed = <T extends TurnItem>(turn: Turn, item: T, streaming: boolean): Change => {
  turn.items.set(item.id, item);
  return { item, streaming };
};

/** The ordinal after every item and run the conversation holds. */
const nextOrdinal = (projection: Projection): number =>
  projection.turnItems.reduce((highest, item) => Math.max(highest, item.ordinal + 1), 0);

/** The ordinal after every run the conversation holds, so a run started later reads later, whenever it was queued. */
const nextRunOrdinal = (projection: Projection): number =>
  projection.runs.reduce((highest, run) => Math.max(highest, run.ordinal + 1), 1);

/** How a member's message came to its answer: it began it, waited in the queue for it, or was handed to it while it ran. */
export type SentIntent = UserItem['inputIntent'];

/** A message a member sent: its words and the files sent with it, already kept. */
export interface Sent {
  text: string;
  files: readonly KeptFile[];
}

/** The id of the item that shows a member's message, and of the message it shows. */
export const userItemId = (runId: string): string => `${runId}:user`;

const userItem = (input: { threadId: string; runId: string; id: string; ordinal: number; sent: Sent; intent: SentIntent; status: TurnItem['status']; at: number }): UserItem => ({
  id: ids.item(input.id),
  threadId: ids.thread(input.threadId),
  runId: ids.run(input.runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: input.ordinal,
  status: input.status,
  title: null,
  startedAt: utc(input.at),
  completedAt: input.status === 'pending' ? null : utc(input.at),
  updatedAt: utc(input.at),
  type: 'user_message',
  messageId: ids.message(input.id),
  text: input.sent.text,
  attachments: input.sent.files.map(attachmentOf),
  inputIntent: input.intent,
  createdBy: 'user',
  creationSource: 'web',
});

/**
 * Starts one answer: the member's message as a finished item and its Run as
 * running. The caller keeps both before anything the model does.
 */
export const startTurn = (input: {
  projection: Projection;
  runId: string;
  request: string;
  model: string;
  effort?: ModelEffort;
  at: number;
  /** The files sent with the message. */
  files?: readonly KeptFile[];
  /** A message that waited in the queue starts the answer it waited for. */
  intent?: SentIntent;
  /** The item a queued message was shown by, which moves to where its answer starts. */
  itemId?: string;
}): { turn: Turn; run: Run; user: TurnItem } => {
  const turn: Turn = {
    threadId: input.projection.thread.id,
    runId: input.runId,
    userMessageId: input.itemId ?? userItemId(input.runId),
    runOrdinal: nextRunOrdinal(input.projection),
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    startedAt: input.at,
    ordinal: nextOrdinal(input.projection),
    text: null,
    reasoning: null,
    interrupt: null,
    tools: new Map(),
    items: new Map(),
    declined: new Set(),
  };
  const ordinal = turn.ordinal;
  turn.ordinal += 1;
  const user = userItem({
    threadId: turn.threadId, runId: input.runId, id: input.itemId ?? userItemId(input.runId), ordinal,
    sent: { text: input.request, files: input.files ?? [] }, intent: input.intent ?? 'turn_start', status: 'completed', at: input.at,
  });
  turn.items.set(user.id, user);
  return { turn, run: runOf(turn, 'running', null), user };
};

/** Shows a value as JSON-able data, cut to what an item keeps. */
const shown = (value: unknown): unknown => {
  if (value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  if (text.length <= SHOWN_CHARACTERS) return value;
  return `${text.slice(0, SHOWN_CHARACTERS)}…（残り ${text.length - SHOWN_CHARACTERS} 文字は画面に表示しません）`;
};

/** A tool's arguments as the model sent them: the object, or the text when it is not JSON. */
const argumentsOf = (text: string | undefined): unknown => {
  if (text === undefined || text === '') return {};
  try {
    return shown(JSON.parse(text) as unknown);
  } catch {
    return shown(text);
  }
};

const closeText = (turn: Turn, at: number, status: TurnItem['status'] = 'completed'): Change[] => {
  const open = turn.text;
  if (!open) return [];
  turn.text = null;
  return [changed(turn, { ...open, status, streaming: false, completedAt: utc(at), updatedAt: utc(at) }, false)];
};

const closeReasoning = (turn: Turn, at: number, status: TurnItem['status'] = 'completed'): Change[] => {
  const open = turn.reasoning;
  if (!open) return [];
  turn.reasoning = null;
  return [changed(turn, { ...open, status, streaming: false, completedAt: utc(at), updatedAt: utc(at) }, false)];
};

const openText = (turn: Turn, at: number): AssistantItem => {
  const id = `${turn.runId}:text:${turn.ordinal}`;
  const item: AssistantItem = { ...base(turn, id, at, 'running'), type: 'assistant_message', messageId: ids.message(id), text: '', streaming: true };
  turn.text = item;
  return item;
};

/** The item a tool event is about: its call by id, else the latest running call of that name. */
const toolFor = (turn: Turn, event: Extract<TurnEvent, { type: 'tool' }>): ToolItem | null => {
  if (event.id !== undefined) return turn.tools.get(event.id) ?? null;
  const running = [...turn.tools.values()].filter((item) => item.toolName === event.name && item.status === 'running');
  return running.at(-1) ?? null;
};

/** Turns one TurnEvent into the items it changes. */
export const onTurnEvent = (turn: Turn, event: TurnEvent, at: number): Change[] => {
  if (event.type === 'text') {
    const closed = closeReasoning(turn, at);
    const open = turn.text ?? openText(turn, at);
    const item: AssistantItem = { ...open, text: `${open.text}${event.text}`, updatedAt: utc(at) };
    turn.text = item;
    return [...closed, changed(turn, item, true)];
  }
  if (event.type === 'reasoning') {
    const closed = closeText(turn, at);
    const open = turn.reasoning ?? { ...base(turn, `${turn.runId}:reasoning:${turn.ordinal}`, at, 'running'), type: 'reasoning' as const, text: '', streaming: true };
    const item: ReasoningItem = { ...open, text: `${open.text}${event.text}`, updatedAt: utc(at) };
    turn.reasoning = item;
    return [...closed, changed(turn, item, true)];
  }
  const closed = [...closeReasoning(turn, at), ...closeText(turn, at)];
  if (event.state === 'started') {
    const key = event.id ?? `${event.name}:${turn.ordinal}`;
    // A held call made once its answer came is the same call, shown by the same item.
    const held = event.id === undefined ? undefined : turn.tools.get(event.id);
    if (held) {
      const resumed: ToolItem = { ...held, status: 'running', updatedAt: utc(at) };
      turn.tools.set(key, resumed);
      return [...closed, changed(turn, resumed, false)];
    }
    const item: ToolItem = {
      ...base(turn, `${turn.runId}:tool:${turn.ordinal}`, at, 'running'),
      // What the tool does, in the words every screen names it by; a server's tool by the server and its tool.
      title: toolLabel(event.name),
      type: 'dynamic_tool',
      toolName: event.name,
      input: argumentsOf(event.arguments),
    };
    turn.tools.set(key, item);
    return [...closed, changed(turn, item, false)];
  }
  // A call whose start was never seen is still shown, rather than lost.
  const known = toolFor(turn, event);
  const started: ToolItem = known ?? {
    ...base(turn, `${turn.runId}:tool:${turn.ordinal}`, at, 'running'),
    title: toolLabel(event.name),
    type: 'dynamic_tool',
    toolName: event.name,
    input: {},
  };
  const output = event.state === 'failed' ? event.error ?? `${event.name} が失敗しました。` : shown(event.result);
  const declined = event.state === 'failed' && event.id !== undefined && turn.declined.has(event.id);
  const status: TurnItem['status'] = declined ? 'cancelled' : event.state === 'failed' ? 'failed' : 'completed';
  const item: ToolItem = { ...started, status, output: declined ? DECLINED : output, completedAt: utc(at), updatedAt: utc(at) };
  const key = [...turn.tools.entries()].find(([, value]) => value.id === started.id)?.[0] ?? event.id ?? item.id;
  turn.tools.set(key, item);
  return [...closed, changed(turn, item, false)];
};

/** A file an answer keeps, as the screen shows it beside the answer's words. */
export interface KeptFile {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
}

/** t3code shows an image under this size inline; any other file, as a file. */
const IMAGE_BYTES = 10 * 1024 * 1024;

const attachmentOf = (file: KeptFile): ChatAttachment => {
  const name = file.filename.trim().slice(0, 255) || 'file';
  return file.mediaType.startsWith('image/') && file.size <= IMAGE_BYTES
    ? { type: 'image', id: ids.attachment(file.id), name, mimeType: file.mediaType, sizeBytes: file.size }
    : { type: 'file', id: ids.attachment(file.id), name, mimeType: file.mediaType.slice(0, 100) || 'application/octet-stream', sizeBytes: Math.max(1, file.size) };
};

/** Shows a kept file with the answer's words being written, or with new words when none are. */
export const attachFile = (turn: Turn, file: KeptFile, at: number): Change[] => {
  const closed = closeReasoning(turn, at);
  const open = turn.text ?? openText(turn, at);
  const item: AssistantItem = { ...open, attachments: [...open.attachments ?? [], attachmentOf(file)], updatedAt: utc(at) };
  turn.text = item;
  return [...closed, changed(turn, item, false)];
};

/** A notice beside the answer, such as an MCP Server whose tools could not be listed. */
/** What one model request consumed, and how much the conversation holds after it, when the adapter knows. */
export type RequestUsage = ModelUsage & { context?: { tokens: number; max: number | null } };

/**
 * Adds one model request to what the answer consumed and returns its Run as it
 * now stands: every request summed, its first kept apart, whose cache read is
 * the conversation before the message served again, and its last, which says
 * how much the conversation holds. Its cost is the sum of every request whose
 * cost is known, a bill only when every one of them was billed.
 */
export const recordUsage = (turn: Turn, used: RequestUsage): Run => {
  const before = turn.usage;
  const cost = before?.costUsd === undefined && used.costUsd === undefined
    ? {}
    : {
      costUsd: (before?.costUsd ?? 0) + (used.costUsd ?? 0),
      costBilled: (before?.costUsd === undefined || before.costBilled === true) && (used.costUsd === undefined || used.costBilled === true),
    };
  turn.usage = {
    ...cost,
    requests: (before?.requests ?? 0) + 1,
    inputTokens: (before?.inputTokens ?? 0) + used.promptTokens,
    cachedInputTokens: (before?.cachedInputTokens ?? 0) + used.cachedTokens,
    cacheWriteTokens: (before?.cacheWriteTokens ?? 0) + (used.cacheWriteTokens ?? 0),
    outputTokens: (before?.outputTokens ?? 0) + used.completionTokens,
    firstInputTokens: before?.firstInputTokens ?? used.promptTokens,
    firstCachedInputTokens: before?.firstCachedInputTokens ?? used.cachedTokens,
    contextTokens: used.context?.tokens ?? used.promptTokens + used.completionTokens,
    maxContextTokens: used.context?.max ?? before?.maxContextTokens ?? null,
  };
  return runOf(turn, 'running', null);
};

export const noticeOf = (turn: Turn, message: string, at: number): Change[] => {
  const item: Item<'system_notice'> = { ...base(turn, `${turn.runId}:notice:${turn.ordinal}`, at, 'completed'), type: 'system_notice', message, level: 'warning' };
  return [changed(turn, item, false)];
};

/** The item that says a stop was asked for, shown until the answer stops. */
export const requestInterrupt = (turn: Turn, at: number): Change[] => {
  if (turn.interrupt) return [];
  const item: Item<'run_interrupt_request'> = { ...base(turn, `${turn.runId}:interrupt`, at, 'running'), type: 'run_interrupt_request', message: STOPPING };
  turn.interrupt = item;
  return [changed(turn, item, false)];
};

/** How an answer ended. */
export type TurnEnd =
  | { kind: 'completed' }
  | { kind: 'interrupted' }
  | { kind: 'failed'; message: string };

/** How an answer stopped being written: it ended, or it waits for the member to approve a call. */
export type TurnOutcome = TurnEnd | { kind: 'waiting'; hold: Hold };

/**
 * Ends an answer: every open item is closed, a call still running fails, a
 * failure is said in an error item, a stop in the interrupt's result, and the
 * Run takes the status the answer ended with.
 */
export const finishTurn = (turn: Turn, outcome: TurnEnd, at: number): { changes: Change[]; run: Run } => {
  const closing: TurnItem['status'] = outcome.kind === 'interrupted' ? 'interrupted' : 'completed';
  const changes: Change[] = [...closeReasoning(turn, at, closing), ...closeText(turn, at, closing)];
  for (const [key, tool] of turn.tools) {
    if (tool.status !== 'running' && tool.status !== 'waiting') continue;
    const item: ToolItem = outcome.kind === 'interrupted'
      ? { ...tool, status: 'interrupted', completedAt: utc(at), updatedAt: utc(at) }
      : { ...tool, status: 'failed', output: UNFINISHED, completedAt: utc(at), updatedAt: utc(at) };
    turn.tools.set(key, item);
    changes.push(changed(turn, item, false));
  }
  if (outcome.kind === 'failed') {
    const message = outcome.message.trim().slice(0, FAILURE_CHARACTERS) || ABANDONED;
    const item: Item<'error'> = {
      ...base(turn, `${turn.runId}:error`, at, 'failed'),
      type: 'error',
      failure: { class: 'provider_error', message, code: null, retryable: null },
    };
    changes.push(changed(turn, item, false));
  }
  if (outcome.kind === 'interrupted') {
    if (turn.interrupt) {
      changes.push(changed(turn, { ...turn.interrupt, status: 'completed', completedAt: utc(at), updatedAt: utc(at) }, false));
    }
    const item: Item<'run_interrupt_result'> = { ...base(turn, `${turn.runId}:stopped`, at, 'completed'), type: 'run_interrupt_result', message: STOPPED };
    changes.push(changed(turn, item, false));
  }
  const status: Run['status'] = outcome.kind === 'completed' ? 'completed' : outcome.kind === 'interrupted' ? 'interrupted' : 'failed';
  return { changes, run: runOf(turn, status, at) };
};

/**
 * An answer taken up again after its object went away: what was being written
 * ends where it was kept, a call being made then shows its result unknown, and
 * the member is told the answer goes on. Its Run keeps running.
 */
export const restartTurn = (turn: Turn, at: number): Change[] => {
  const changes: Change[] = [...closeReasoning(turn, at), ...closeText(turn, at)];
  for (const [key, tool] of turn.tools) {
    if (tool.status !== 'running') continue;
    const item: ToolItem = { ...tool, status: 'failed', output: RESTARTED_CALL, completedAt: utc(at), updatedAt: utc(at) };
    turn.tools.set(key, item);
    changes.push(changed(turn, item, false));
  }
  return [...changes, ...noticeOf(turn, RESTARTED, at)];
};

/** Runs of a conversation still recorded as being answered; a queued message is not being answered yet. */
const UNFINISHED_RUNS: ReadonlySet<Run['status']> = new Set(['preparing', 'starting', 'running', 'waiting']);

/** The runs a conversation records as being answered, which nothing answers once its object has gone. */
export const unfinishedRuns = (projection: Projection): Run[] => projection.runs.filter((run) => UNFINISHED_RUNS.has(run.status));

/**
 * The answer a run left unfinished, rebuilt from the conversation so it can be
 * ended: its items as they were last kept, its tool calls among them.
 */
export const resumeTurn = (projection: Projection, run: Run): Turn => {
  const items = projection.turnItems.filter((item) => item.runId === run.id);
  const effort = effortOf(run);
  const turn: Turn = {
    threadId: projection.thread.id,
    runId: run.id,
    userMessageId: run.userMessageId,
    runOrdinal: run.ordinal,
    model: run.modelSelection.model,
    ...(effort ? { effort } : {}),
    startedAt: utcMillis(run.startedAt ?? run.requestedAt),
    ordinal: nextOrdinal(projection),
    text: null,
    reasoning: null,
    interrupt: null,
    tools: new Map(),
    items: new Map(items.map((item) => [item.id, item])),
    declined: new Set(),
    ...(run.usage ? { usage: run.usage } : {}),
  };
  for (const item of items) {
    if (item.type === 'dynamic_tool') turn.tools.set(item.id, item);
    if (item.type === 'assistant_message' && item.status === 'running') turn.text = item;
    if (item.type === 'reasoning' && item.status === 'running') turn.reasoning = item;
    if (item.type === 'run_interrupt_request' && item.status === 'running') turn.interrupt = item;
  }
  return turn;
};

/** One message of the conversation as the model is told it, and the files a member sent with it, by id. */
export interface Recalled {
  message: TurnMessage;
  files: readonly string[];
}

/**
 * What the model continues from: each earlier answer that ended by answering
 * or by being stopped, as the member's message and the answer's words, a
 * stopped one with a note that it was unfinished and one that kept files with
 * a note naming them, as the chat before ADR 0201 replayed its exchanges. A message
 * the member handed an answer while it ran follows the words written before
 * it, as the model was told it. Each member's message names the files sent
 * with it, which the caller reads.
 */
export const historyOf = (projection: Projection): Recalled[] => projection.runs
  .filter((run) => run.status === 'completed' || run.status === 'interrupted')
  .toSorted((left, right) => left.ordinal - right.ordinal)
  .flatMap((run) => {
    const items = projection.turnItems.filter((item) => item.runId === run.id).toSorted((left, right) => left.ordinal - right.ordinal);
    if (!items.some((item) => item.type === 'user_message')) return [];
    const recalled: Recalled[] = [];
    let words: string[] = [];
    let files: Array<{ filename: string; size: number; drive: null }> = [];
    const answered = (last: boolean): void => {
      const content = words.filter((text) => text.trim()).join('\n\n');
      words = [];
      if (!last && !content) return;
      const note = last ? `${run.status === 'interrupted' ? STOPPED_NOTE : ''}${writtenNote(files)}` : '';
      recalled.push({ message: { role: 'assistant', content: `${content}${note}` }, files: [] });
    };
    for (const item of items) {
      if (item.type === 'user_message') {
        // A message handed to the answer but never read was not told to the model.
        if (item.status === 'pending') continue;
        if (recalled.length) answered(false);
        recalled.push({ message: { role: 'user', content: item.text }, files: item.attachments.map((file) => file.id) });
        continue;
      }
      if (item.type !== 'assistant_message') continue;
      words.push(item.text);
      files = [...files, ...(item.attachments ?? []).map((file) => ({ filename: file.name, size: file.sizeBytes, drive: null }))];
    }
    answered(true);
    return recalled;
  });

/** What a person may answer a held call with, labelled as the screen shows them. */
const APPROVAL_OPTIONS: Item<'approval_request'>['options'] = [
  { decision: 'accept', label: CHAT_APPROVAL_LABELS.accept },
  { decision: 'acceptAlways', label: CHAT_APPROVAL_LABELS.acceptAlways },
  { decision: 'decline', label: CHAT_APPROVAL_LABELS.decline },
];

/** The id of the item that asks the member about a held call. */
const approvalItemId = (runId: string, requestId: string): string => `${runId}:approval:${requestId}`;

/** The one session a runtime request names: FlareChat answers every request itself, whichever object holds it. */
const SESSION = 'flarechat';

const requestOf = (turn: Pick<Turn, 'runId'>, requestId: string, createdAt: number, answer: { at: number; decision: 'accept' | 'acceptAlways' | 'decline'; feedback?: string } | null): RuntimeRequest => ({
  id: ids.request(requestId),
  nodeId: ids.node(turn.runId),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: 'permission',
  status: answer ? 'resolved' : 'pending',
  responseCapability: { type: 'live', providerSessionId: ids.session(SESSION), supportsFeedback: true },
  createdAt: utc(createdAt),
  resolvedAt: answer ? utc(answer.at) : null,
  ...(answer ? { decision: answer.decision, ...(answer.feedback ? { feedback: answer.feedback } : {}) } : {}),
});

export const requestEvent = (threadId: string, request: RuntimeRequest, at: number): EventOf<'runtime-request.updated'> =>
  ({ ...envelope(threadId, at), type: 'runtime-request.updated', payload: request });

/** A call held for the member, as the turn shows it. */
export interface HeldCall {
  /** The call's id, as the model named it. */
  callId: string;
  requestId: string;
  /** The call as the member reads it. */
  description: string;
  reason: string;
  /** When it was held. */
  createdAt: number;
}

/**
 * Holds an answer for the member: the call waits, an approval item below it
 * asks with the three answers, the request is pending, and the Run waits.
 * The caller keeps all of it, and only then may the object go away.
 */
export const holdTurn = (turn: Turn, held: HeldCall, at: number): { changes: Change[]; request: RuntimeRequest; run: Run; itemId: string } => {
  const changes: Change[] = [...closeReasoning(turn, at), ...closeText(turn, at)];
  const tool = turn.tools.get(held.callId);
  if (!tool) throw new Error('The held call has no item.');
  const waiting: ToolItem = { ...tool, status: 'waiting', updatedAt: utc(at) };
  turn.tools.set(held.callId, waiting);
  changes.push(changed(turn, waiting, false));
  const approval: Item<'approval_request'> = {
    ...base(turn, approvalItemId(turn.runId, held.requestId), at, 'waiting'),
    completedAt: null,
    parentItemId: waiting.id,
    type: 'approval_request',
    requestId: ids.request(held.requestId),
    requestKind: 'permission',
    prompt: held.description,
    reason: held.reason,
    options: APPROVAL_OPTIONS,
  };
  changes.push(changed(turn, approval, false));
  return { changes, request: requestOf(turn, held.requestId, held.createdAt, null), run: runOf(turn, 'waiting', null), itemId: waiting.id };
};

/**
 * The member answered a held call: the request is resolved with the answer
 * and what they said, the approval item is done, and the Run runs again. The
 * call itself shows what came of it as the answer goes on; a declined one
 * ends as cancelled.
 */
export const answerTurn = (turn: Turn, input: { callId: string; requestId: string; createdAt: number; decision: 'accept' | 'acceptAlways' | 'decline'; feedback?: string }, at: number): { changes: Change[]; request: RuntimeRequest; run: Run } => {
  const changes: Change[] = [];
  const approval = turn.items.get(approvalItemId(turn.runId, input.requestId));
  if (approval) changes.push(changed(turn, { ...approval, status: 'completed', completedAt: utc(at), updatedAt: utc(at) }, false));
  if (input.decision === 'decline') turn.declined.add(input.callId);
  const answer = { at, decision: input.decision, ...(input.feedback ? { feedback: input.feedback } : {}) };
  return { changes, request: requestOf(turn, input.requestId, input.createdAt, answer), run: runOf(turn, 'running', null) };
};

/**
 * The answer a run left waiting, rebuilt so it can go on: as `resumeTurn`
 * rebuilds it, with the held call's item found again by its call id.
 */
export const resumeHeldTurn = (projection: Projection, run: Run, held: { callId: string; itemId: string }): Turn => {
  const turn = resumeTurn(projection, run);
  const item = turn.items.get(held.itemId);
  if (item?.type !== 'dynamic_tool') return turn;
  // Keyed by its call id alone, as while the answer was written, so its next event finds it.
  turn.tools.delete(item.id);
  turn.tools.set(held.callId, item);
  return turn;
};

/** A queued message: its Run waits in the conversation's queue, and its item stays hidden until the Run starts. */
export const queueMessage = (input: { projection: Projection; runId: string; model: string; effort?: ModelEffort; sent: Sent; position: number; at: number; itemId?: string }): { run: Run; message: MessageRecord; user: TurnItem } => {
  const { projection, runId, at } = input;
  const itemId = input.itemId ?? userItemId(runId);
  const run: Run = {
    id: ids.run(runId),
    threadId: projection.thread.id,
    ordinal: nextRunOrdinal(projection),
    providerInstanceId: ids.provider(PROVIDER),
    modelSelection: selectionOf(input.model, input.effort),
    providerThreadId: null,
    userMessageId: ids.message(itemId),
    rootNodeId: null,
    activeAttemptId: null,
    status: 'queued',
    queuePosition: input.position,
    requestedAt: utc(at),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const user = userItem({ threadId: projection.thread.id, runId, id: itemId, ordinal: nextOrdinal(projection), sent: input.sent, intent: 'queued_turn', status: 'completed', at });
  return { run, message: messageOf(user, at), user };
};

/** The conversation's record of a member's message, which the queue reads its words and files from. */
export const messageOf = (user: UserItem, at: number): MessageRecord => ({
  id: user.messageId,
  threadId: user.threadId,
  runId: user.runId,
  nodeId: null,
  role: 'user',
  text: user.text,
  attachments: user.attachments,
  streaming: false,
  createdAt: user.startedAt ?? utc(at),
  updatedAt: utc(at),
  createdBy: 'user',
  creationSource: 'web',
});

/** The conversation's queued messages, first to start first. */
export const queuedRuns = (projection: Projection): Run[] => projection.runs
  .filter((run) => run.status === 'queued')
  .toSorted((left, right) => (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) || left.ordinal - right.ordinal);

/** The item that shows a queued message, which it keeps from the moment it was queued. */
export const queuedItem = (projection: Projection, runId: string): UserItem | null => {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const item = projection.turnItems.find((candidate) => candidate.id === (run?.userMessageId ?? userItemId(runId)));
  return item?.type === 'user_message' ? item : null;
};

/** The files a member's item names, as the answer's files are kept. */
export const filesOf = (item: UserItem): KeptFile[] =>
  item.attachments.map((file) => ({ id: file.id, filename: file.name, mediaType: file.mimeType, size: file.sizeBytes }));

/**
 * The queue in a new order: each queued Run whose place changed, numbered
 * from one, and held or not as `held` says, or as it was.
 */
export const requeue = (projection: Projection, order: readonly string[], held?: boolean): Run[] => {
  const runs = queuedRuns(projection);
  return order.flatMap((runId, index) => {
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) return [];
    const queueHeld = held ?? run.queueHeld ?? false;
    if (run.queuePosition === index + 1 && (run.queueHeld ?? false) === queueHeld) return [];
    return [{ ...run, queuePosition: index + 1, queueHeld }];
  });
};

/** A queued message taken out of the queue: its Run is cancelled, and its item stays hidden. */
export const cancelQueued = (run: Run, at: number): Run => ({ ...run, status: 'cancelled', queuePosition: null, queueHeld: false, completedAt: utc(at) });

/** A queued message's words changed: its item and its record, the files it was sent with kept. */
export const editQueued = (projection: Projection, runId: string, text: string, at: number): { user: TurnItem; message: MessageRecord } | null => {
  const item = queuedItem(projection, runId);
  if (!item) return null;
  const user: UserItem = { ...item, text, updatedAt: utc(at) };
  return { user, message: messageOf(user, at) };
};

/**
 * A message handed to the answer being written: shown where it was sent,
 * waiting to be read until the answer reaches its next step.
 */
export const steerItem = (turn: Turn, input: { id: string; sent: Sent; intent: 'steer' | 'promoted_queued_to_steer'; at: number }): Change[] => {
  const ordinal = turn.ordinal;
  turn.ordinal += 1;
  const item = userItem({ threadId: turn.threadId, runId: turn.runId, id: input.id, ordinal, sent: input.sent, intent: input.intent, status: 'pending', at: input.at });
  return [changed(turn, item, false)];
};

/** The messages handed to an answer that it has not read yet, in the order they were sent. */
export const unreadSteers = (projection: Projection, runId: string): UserItem[] => projection.turnItems
  .flatMap((item) => item.type === 'user_message' && item.runId === runId && item.status === 'pending' ? [item] : [])
  .toSorted((left, right) => left.ordinal - right.ordinal);

/**
 * The answer read the messages handed to it: each is shown as read, and the
 * words written before them end, so what the model writes next follows them.
 */
export const readSteers = (turn: Turn, items: readonly UserItem[], at: number): Change[] => [
  ...closeReasoning(turn, at),
  ...closeText(turn, at),
  ...items.map((item) => changed(turn, { ...item, status: 'completed', completedAt: utc(at), updatedAt: utc(at) }, false)),
];

/**
 * A message handed to an answer that ended before reading it is queued
 * instead, first: its item becomes the queued message of a Run of its own,
 * hidden until that Run starts.
 */
export const requeueSteer = (projection: Projection, item: UserItem, input: { runId: string; model: string; effort?: ModelEffort; at: number }): { run: Run; message: MessageRecord; user: TurnItem } =>
  queueMessage({ projection, runId: input.runId, model: input.model, ...(input.effort ? { effort: input.effort } : {}), sent: { text: item.text, files: filesOf(item) }, position: 1, at: input.at, itemId: item.id });

/** The statuses of an answer that ended, which a member may rewind to or continue from as a new conversation. */
const ENDED_RUNS: ReadonlySet<Run['status']> = new Set(['completed', 'failed', 'interrupted']);

/** The member's message that began an answer, found by the message id the screen names it by, or by its item's id. */
const startingItem = (projection: Projection, messageId: string): UserItem | null => {
  const item = projection.turnItems.find((candidate) => candidate.type === 'user_message' && (candidate.messageId === messageId || candidate.id === messageId));
  if (item?.type !== 'user_message' || item.runId === null) return null;
  // A message handed to an answer while it ran began no answer of its own.
  return item.inputIntent === 'turn_start' || item.inputIntent === 'queued_turn' ? item : null;
};

/**
 * Rewinding to an earlier message: the answer it began and every answer that
 * ended after it are rolled back, t3code's own run status for answers taken
 * back, which its reducer folds by hiding their items, so the log keeps them
 * and loses nothing. Null when the message began no answer that ended, as a
 * queued message or one still being answered.
 */
export const rewindTo = (projection: Projection, messageId: string, at: number): { item: UserItem; rolledBack: Run[] } | null => {
  const item = startingItem(projection, messageId);
  const run = item ? projection.runs.find((candidate) => candidate.id === item.runId) : undefined;
  if (!item || !run || !ENDED_RUNS.has(run.status)) return null;
  const rolledBack = projection.runs
    .filter((candidate) => ENDED_RUNS.has(candidate.status) && candidate.ordinal >= run.ordinal)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((candidate): Run => ({ ...candidate, status: 'rolled_back', completedAt: candidate.completedAt ?? utc(at) }));
  return { item, rolledBack };
};

/** The answers a rewind took back, whose files an answer's sandbox no longer starts with. */
export const rolledBackRuns = (projection: Projection): string[] =>
  projection.runs.flatMap((run) => run.status === 'rolled_back' ? [run.id] : []);

/** A conversation continued from one of its answers: the events of the new one, and each file it names under the id it is kept by there. */
export interface ForkCopy {
  events: DomainEvent[];
  files: Array<{ id: string; copy: string }>;
}

/**
 * A new conversation holding this one up to and including the answer `runId`
 * ended with: every answer shown before it and that answer, their messages,
 * the approvals they asked for, and the files they hold, each kept there
 * under an id of its own (`fileId`) naming the same bytes. Nothing rolled
 * back, queued, or being answered goes with it. Null when `runId` names no
 * answer that ended.
 */
export const forkOf = (projection: Projection, runId: string, input: { threadId: string; at: number; fileId: (id: string) => string }): ForkCopy | null => {
  const target = projection.runs.find((run) => run.id === runId);
  if (!target || !ENDED_RUNS.has(target.status)) return null;
  const runs = projection.runs
    .filter((run) => ENDED_RUNS.has(run.status) && run.ordinal <= target.ordinal)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const threadId = ids.thread(input.threadId);
  const files = new Map<string, string>();
  const copyOf = (attachment: ChatAttachment): ChatAttachment => {
    const copy = files.get(attachment.id) ?? input.fileId(attachment.id);
    files.set(attachment.id, copy);
    return { ...attachment, id: ids.attachment(copy) };
  };
  const moved = (item: TurnItem): TurnItem => {
    if (item.type === 'user_message') return { ...item, threadId, attachments: item.attachments.map(copyOf) };
    if (item.type === 'assistant_message') return item.attachments ? { ...item, threadId, attachments: item.attachments.map(copyOf) } : { ...item, threadId };
    return { ...item, threadId };
  };
  const events: DomainEvent[] = [];
  for (const run of runs) {
    const items = projection.turnItems.filter((item) => item.runId === run.id).toSorted((left, right) => left.ordinal - right.ordinal);
    events.push(...items.map((item) => itemEvent(moved(item), input.at)));
    events.push(...projection.messages.filter((message) => message.runId === run.id)
      .map((message) => messageEvent({ ...message, threadId, attachments: message.attachments.map(copyOf) }, input.at)));
    events.push(...projection.runtimeRequests.filter((request) => request.nodeId === ids.node(run.id))
      .map((request) => requestEvent(input.threadId, request, input.at)));
    events.push(runEvent('run.created', { ...run, threadId, queuePosition: null, queueHeld: false }, input.at));
  }
  return { events, files: [...files].map(([id, copy]) => ({ id, copy })) };
};

