/**
 * The one loop every run thinks in: Operator Chat's exchange and every
 * Automation's run alike. It is Pi's agent loop (`@earendil-works/pi-agent-core`,
 * ADR 0203): the model is asked, the tools it calls are handed to the caller,
 * their answers are told back, and the loop ends when the model answers
 * without calling anything.
 *
 * What a tool call does is the caller's concern: Operator Chat performs it, an
 * Automation plans it. A refused or failed call is told to the model, which
 * can correct it; only a handler that throws `RunStopped` ends the run, which
 * is how a call the run may not make ends it rather than being retried.
 */

import type { ModelEffort, ToolRun } from '@mail/domain';

import { runAgentLoop, type AgentTool, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type AssistantMessage, type Message, type Model, type ToolCall } from '@earendil-works/pi-ai';

import type { OpenRunAccess, Rendezvous, RunAccess, RunServing } from './rendezvous';
import { logModelUsage, logToolFailure } from './logging';
import { totalTokens, type ModelUsage } from './usage';
import { callMcpTool, listMcpTools, type McpConnection, type McpFetch } from './mcp';
import { describedTools } from './tools';

/**
 * A file handed to the model as it is, as its bytes. It may be of
 * any kind: how the model opens it is the model adapter's concern, never
 * the tool's that read it.
 */
export interface TurnFile {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  /** Whether it is a picture the run took itself, such as a screenshot, which a person watching the run is shown as it is taken. */
  shown?: boolean;
}

/**
 * A tool's answer together with files it read, such as a mail's attachments.
 * The answer is told to the model as every answer is, and the files are handed
 * over beside it as they are, never as text made from them.
 */
export class FileAnswer {
  constructor(readonly answer: unknown, readonly files: readonly TurnFile[]) {}
}

/** A file the model wrote while answering, as its bytes. */
export interface GeneratedFile {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface TurnToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Pi's own record of an assistant turn, as the provider wrote it: its words,
 * its reasoning and the signatures that go with it, and its calls. It is sent
 * back as it is on the run's next request, and kept with a conversation.
 */
export interface PiReplay {
  kind: 'pi';
  message: AssistantMessage;
}

/**
 * A provider's record of an assistant turn kept before Pi: Claude's content
 * blocks, or OpenAI's or Gemini's items. It is read for nothing now; the turn
 * is sent again as its words and calls.
 */
export interface LegacyReplay {
  kind?: 'openai' | 'gemini';
  items?: unknown[];
  content?: unknown[];
  containerId?: string;
}

/** The provider's own record of an assistant turn. */
export type ModelReplay = PiReplay | LegacyReplay;

export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Files the administrator sent with a request, or a tool read and handed back with its answer. */
  attachments?: readonly TurnFile[];
  name?: string;
  toolCallId?: string;
  toolCalls?: TurnToolCall[];
  /** The provider's own record of an assistant turn, echoed back on the run's next request. */
  replay?: ModelReplay;
}

export interface ModelRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: TurnMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  /** How hard the member asked the model to think; only Claude is sent it, and only a level its model takes. */
  effort?: ModelEffort;
  /** Aborted to cancel the request, as when the administrator stops an answer. */
  signal?: AbortSignal;
}

export interface ModelCompletion {
  model: string;
  content: string;
  toolCalls: TurnToolCall[];
  usage: ModelUsage;
  /** How much the conversation holds after this completion, and the most the model reads in one request, when the adapter knows. */
  context?: { tokens: number; max: number | null };
  replay?: ModelReplay;
}

export interface ModelPort {
  /** Given `onEvent`, the answer's text and reasoning are handed over as they are written. */
  complete(request: ModelRequest, onEvent?: (event: TurnEvent) => void): Promise<ModelCompletion>;
}

export interface ModelConnection {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Performs one call; `context` says what else the run lends the call, as its Run Token. */
export type ToolHandler = (arguments_: Record<string, unknown>, context?: CallContext) => Promise<unknown>;
export type ToolHandlers = Record<string, ToolHandler>;

/** A tool one run may call: one of the product's own, or one an MCP Server lends. */
export interface RunTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  origin:
    | { kind: 'internal' }
    | { kind: 'mcp'; serverId: string; toolName: string; connection: McpConnection };
}

export interface McpServerSource {
  id: string;
  name: string;
  connection: McpConnection;
}

/**
 * What a person watching a run sees happen, in order: the answer's text as it
 * is written, the model's reasoning when it shows it, and each tool call as it
 * starts and ends. A tool event names its call by `id`, which its end repeats,
 * and carries what it was asked (`arguments`, the JSON the model sent) and
 * what it answered (`result`) where the loop knows them; a consumer that shows
 * only a tool's name and state reads neither.
 */
export type TurnEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
    type: 'tool';
    name: string;
    state: 'started' | 'finished' | 'failed';
    /** Why it failed, when it did. */
    error?: string;
    /** The call this event is about, the same on its start and its end. */
    id?: string;
    /** What the call was asked, as the JSON text of its arguments, on its start. */
    arguments?: string;
    /** What a finished call answered, as the model was told it. */
    result?: unknown;
  };

/** What the model did over one run. */
export interface Thought {
  model: string;
  output: string;
  toolCallCount: number;
  tokens: number;
  messages: TurnMessage[];
}

/** Thrown by a tool handler to end the run: the call reaches what the run may not, rather than slipped. */
export class RunStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStopped';
  }
}

/** A run that ended before the model finished, with everything it did until then. */
export class ThinkingFailed extends Error {
  constructor(message: string, readonly thought: Thought) {
    super(message);
    this.name = 'ThinkingFailed';
  }
}

/** A run whose signal was aborted, as when the administrator stops an answer: it ends where it was, with everything it did until then. */
export class ThinkingStopped extends ThinkingFailed {
  constructor(thought: Thought) {
    super('The answer was stopped.', thought);
    this.name = 'ThinkingStopped';
  }
}

/**
 * Thrown by a run's `call` to hold a call for a person before it is made:
 * the run pauses there, rather than failing the call, and can be resumed
 * from the calls it had still to make (`think`'s `resume`). Only a run a
 * person is at holds one; an Automation never does.
 */
export class CallHeld extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CallHeld';
  }
}

/**
 * A run that paused before a call a person must answer, with everything it
 * did until then: its messages end with the model's message that made the
 * call and the answers of the calls before it, and `pending` holds the held
 * call and every call of that message after it, in order. A caller that
 * does not know pauses takes it for a failure, which it extends.
 */
export class ThinkingPaused extends ThinkingFailed {
  constructor(thought: Thought, readonly pending: readonly TurnToolCall[], readonly reason: string) {
    super('The answer is waiting for approval.', thought);
    this.name = 'ThinkingPaused';
  }
}

/** What a run's `call` is told about the call besides its tool and arguments. */
export interface CallContext {
  /** The call's id, as the model named it, or one of the loop's own for a program's call. */
  id: string;
  /** Whether a program made it with the run's Run Token while the model's request is still open, so it cannot wait for a person. */
  program: boolean;
  /**
   * Issues the run's Run Token, once per run, for a call that lends it to
   * code it runs, as `code.run` does; absent where the run is offered none.
   */
  access?: () => Promise<RunAccess>;
}

/** Separates a server's name from its tool, so two servers may both offer `search`. */
const TOOL_NAMESPACE_SEPARATOR = '.';

/**
 * Gathers the tools one run may call: those of the product's one list the run
 * can call, then each connected server's its grant names.
 *
 * An external tool is performed the moment it is called, so only an
 * unattended run binds one: a read-only run must reach no third party, and an
 * approval run's approval would come after the call it was meant to gate. A
 * server that cannot be listed is reported rather than dropped, because a run
 * that silently lost half its tools looks the same as one whose model chose
 * not to use them.
 */
export const resolveTools = async (input: {
  run: ToolRun;
  servers: readonly McpServerSource[];
  fetch: McpFetch;
}): Promise<{ tools: RunTool[]; failures: Array<{ server: string; error: string }> }> => {
  const permitted = (name: string): boolean => !input.run.grant || input.run.grant.includes(name);
  const tools: RunTool[] = describedTools(input.run).map((tool) => ({ ...tool, origin: { kind: 'internal' } }));
  const failures: Array<{ server: string; error: string }> = [];
  if (input.run.executionMode !== 'unattended') return { tools, failures };
  for (const server of input.servers) {
    if (input.run.grant && !input.run.grant.some((name) => name.startsWith(`${server.name}${TOOL_NAMESPACE_SEPARATOR}`))) continue;
    try {
      const listed = await listMcpTools({ connection: server.connection, fetch: input.fetch });
      for (const tool of listed) {
        const name = `${server.name}${TOOL_NAMESPACE_SEPARATOR}${tool.name}`;
        if (!permitted(name)) continue;
        // A server registered before its name was reserved keeps it, but the product's own tool keeps its name.
        if (tools.some((kept) => kept.name === name)) {
          failures.push({ server: server.name, error: `${name} is the name of one of FlareChat's own tools, so the server's tool is not offered. Rename the server.` });
          continue;
        }
        tools.push({
          name,
          description: tool.description,
          parameters: tool.inputSchema,
          origin: { kind: 'mcp', serverId: server.id, toolName: tool.name, connection: server.connection },
        });
      }
    } catch (error) {
      failures.push({ server: server.name, error: error instanceof Error ? error.message : 'MCP Server could not be listed.' });
    }
  }
  return { tools, failures };
};

/** Calls one tool: a product tool through its handler, a server's tool on that server. */
export const toolCaller = (input: { tools: readonly RunTool[]; handlers: ToolHandlers; fetch: McpFetch }) =>
  async (name: string, arguments_: Record<string, unknown>, context?: CallContext): Promise<unknown> => {
    const tool = input.tools.find((entry) => entry.name === name);
    if (!tool) return { isError: true, message: `${name} is not one of the tools you were given. Use only those.` };
    if (tool.origin.kind === 'mcp') {
      return callMcpTool({ connection: tool.origin.connection, fetch: input.fetch, name: tool.origin.toolName, arguments: arguments_ });
    }
    const handler = input.handlers[name];
    if (!handler) throw new Error(`No handler performs ${name}.`);
    return handler(arguments_, context);
  };

/**
 * Why a tool call failed, in words that name what refused it: an HTTP
 * failure keeps its status, and an error of its own kind keeps its kind.
 */
export const failureText = (error: unknown, name: string): string => {
  if (!(error instanceof Error)) return `${name} failed.`;
  const status = (error as { status?: unknown }).status;
  const kind = error.name && error.name !== 'Error' ? error.name : '';
  const prefix = [kind, typeof status === 'number' ? String(status) : ''].filter(Boolean).join(' ');
  return prefix ? `${prefix}: ${error.message}` : error.message;
};

/** The refusal a tool answered with instead of throwing, as `{ isError: true, message }` or an MCP Server's `{ isError: true, text }`. */
const refusalOf = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || (value as { isError?: unknown }).isError !== true) return null;
  const { message, text } = value as { message?: unknown; text?: unknown };
  if (typeof message === 'string' && message) return message;
  if (typeof text === 'string' && text) return text;
  return 'The tool reported an error without saying why.';
};

/** The tool a run issues its Run Token by, which the loop answers itself. */
const RUN_TOKEN = 'run.token';

/** The provider's host, which names it in the log; a Base URL that is not one is logged as it is. */
const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
};

const wireTool = (tool: RunTool): ModelRequest['tools'][number] => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
});

/** Pi's record of an answer FlareChat's model port gave, as the loop reads it. */
const assistantOf = (completion: ModelCompletion, api: Api, provider: string): AssistantMessage => {
  const calls: ToolCall[] = completion.toolCalls.map((call) => {
    try {
      const parsed = JSON.parse(call.arguments || '{}') as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { type: 'toolCall', id: call.id, name: call.name, arguments: parsed as ToolCall['arguments'] };
    } catch {
      // Told to the model below, as Pi tells any call whose arguments are not an object.
    }
    return { type: 'toolCall', id: call.id, name: call.name, arguments: {}, argumentsError: `The arguments of ${call.name} are not JSON.` };
  });
  return {
    role: 'assistant',
    content: [...(completion.content ? [{ type: 'text' as const, text: completion.content }] : []), ...calls],
    api, provider, model: completion.model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: calls.length ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
};

/** What a message the person said while the run went reads as in Pi's loop, which only counts it. */
const toPiUser = (message: TurnMessage): Message => ({ role: 'user', content: message.content, timestamp: Date.now() });

/** The text of a tool answer Pi made itself, for a call it could not make. */
const resultText = (result: AgentToolResult<unknown>): string =>
  result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') || 'The call could not be made.';

/**
 * Runs the model until it answers without calling a tool. Nothing counts
 * against it: neither its tool calls, nor its turns, nor its tokens; the
 * provider's own context window is the only limit on one request.
 *
 * The loop is Pi's. FlareChat keeps the run's messages as its own
 * (`TurnMessage`), so a tool's files stay its bytes and a conversation keeps
 * what it always kept, and hands Pi each answer and each tool's result as
 * they happen: Pi decides when to ask the model again, validates each call's
 * arguments against its tool, makes the calls in order, and reads what a
 * person said while the run went.
 */
export const think = async (input: {
  model: ModelPort;
  connection: ModelConnection;
  messages: readonly TurnMessage[];
  tools: readonly RunTool[];
  call: (name: string, arguments_: Record<string, unknown>, context: CallContext) => Promise<unknown>;
  /**
   * A paused run resumed: the calls it had still to make, held one first,
   * made before the model is asked again. `messages` then end where the
   * paused run's ended. They are not counted again, since the paused run
   * counted every call of the message that made them.
   */
  resume?: { calls: readonly TurnToolCall[] };
  onEvent?: (event: TurnEvent) => void;
  /** What names this run in the log a failed tool call writes, such as its Run's id. */
  trace?: Readonly<Record<string, string>>;
  /** Aborted to stop the run: the model's request is cancelled, no further tool is called, and `ThinkingStopped` is thrown. */
  signal?: AbortSignal;
  /** Where the run issues a Run Token when its model asks; without it the run is offered none. */
  rendezvous?: Rendezvous;
  /**
   * What a person watching the run said to it while it ran: asked before
   * each request to the model, once the calls before it are made, and once
   * more when the model answers without calling a tool, so words that came
   * during that last request are read rather than lost. The messages it
   * returns follow the run's messages, and the model is asked again. Without
   * it, as for every Automation, the run thinks as it always has.
   */
  steer?: () => Promise<readonly TurnMessage[]>;
  /**
   * Keeps how far the run has got, before each request to the model and each
   * call, so a run whose object goes away can go on from there. Awaited, so
   * no call is made that it does not know was about to be; a failure to keep
   * it never fails the run.
   */
  checkpoint?: (thought: Thought) => Promise<void>;
}): Promise<Thought> => {
  const { onEvent, signal } = input;
  const checkpoint = async (): Promise<void> => {
    await input.checkpoint?.(thought()).catch(() => undefined);
  };
  const messages: TurnMessage[] = [...input.messages];
  let toolCallCount = 0;
  // Every token the run processed, cache hits included, is what it records.
  let tokens = 0;
  let model = input.connection.model;
  // Which request of the run the next one is, as the log counts them.
  let requests = 0;
  const thought = (output = ''): Thought => ({ model, output, toolCallCount, tokens, messages: [...messages] });
  const offered = input.rendezvous ? input.tools : input.tools.filter((tool) => tool.name !== RUN_TOKEN);
  // A call a program made with the Run Token that the run may not make ends the run, as the model's own would.
  let stopped: RunStopped | null = null;
  // A call that reaches the run after it ended, while its socket is still closing, is not made.
  let ended = false;
  /** A program's call with the Run Token: made as the run's own, shown and logged as one, but not part of what the model said. */
  const serving: RunServing = {
    tools: offered.filter((tool) => tool.name !== RUN_TOKEN).map(({ name, description, parameters }) => ({ name, description, parameters })),
    call: async (name, arguments_) => {
      if (name === RUN_TOKEN) return { isError: true, message: 'A Run Token does not issue another.' };
      if (ended || signal?.aborted || stopped) return { isError: true, message: 'This run has stopped, so the call was not made.' };
      toolCallCount += 1;
      const id = crypto.randomUUID();
      onEvent?.({ type: 'tool', name, state: 'started', id, arguments: JSON.stringify(arguments_) });
      try {
        const answer = await input.call(name, arguments_, { id, program: true });
        const value = answer instanceof FileAnswer ? answer.answer : answer;
        const refusal = refusalOf(value);
        if (refusal !== null) logToolFailure({ tool: name, arguments: JSON.stringify(arguments_), error: refusal, ...(input.trace ? { trace: input.trace } : {}) });
        onEvent?.(refusal === null ? { type: 'tool', name, state: 'finished', id, result: value } : { type: 'tool', name, state: 'failed', error: refusal, id });
        return answer;
      } catch (error) {
        const message = error instanceof RunStopped ? error.message : failureText(error, name);
        if (error instanceof RunStopped) stopped ??= error;
        logToolFailure({ tool: name, arguments: JSON.stringify(arguments_), error: message, ...(input.trace ? { trace: input.trace } : {}) });
        onEvent?.({ type: 'tool', name, state: 'failed', error: message, id });
        return { isError: true, message };
      }
    },
  };
  let access: Promise<OpenRunAccess> | undefined;
  /** The run's one Run Token; a failure to issue it is not kept, so the next ask tries again. */
  const openAccess = async (): Promise<RunAccess> => {
    if (!input.rendezvous) throw new Error('This run is offered no Run Token.');
    const rendezvous = input.rendezvous;
    access ??= rendezvous.open(serving).catch((error: unknown) => {
      access = undefined;
      throw error;
    });
    const { url, token, expiresAt } = await access;
    return { url, token, expiresAt };
  };
  const perform = async (name: string, arguments_: Record<string, unknown>, id: string): Promise<unknown> => {
    if (name === RUN_TOKEN && input.rendezvous) return openAccess();
    return input.call(name, arguments_, { id, program: false, ...(input.rendezvous ? { access: openAccess } : {}) });
  };

  // What ended the run other than the model answering: a call held for a person, a call that stopped it, or the model failing.
  let held: { calls: readonly TurnToolCall[]; reason: string } | null = null;
  let failed: ThinkingFailed | null = null;
  let modelError: string | null = null;
  let steerError: unknown = null;
  const over = (): boolean => held !== null || failed !== null || stopped !== null || signal?.aborted === true;

  /**
   * Makes one call the model asked for and tells the model its answer. A call
   * held for a person, or one that stops the run, ends the run there, and the
   * calls after it in the same message are not made.
   */
  const performOne = async (call: TurnToolCall, arguments_: Record<string, unknown>, remaining: readonly TurnToolCall[]): Promise<string | null> => {
    await checkpoint();
    onEvent?.({ type: 'tool', name: call.name, state: 'started', id: call.id, arguments: call.arguments });
    let content: string;
    let files: readonly TurnFile[] = [];
    try {
      const answer = await perform(call.name, arguments_, call.id);
      if (answer instanceof FileAnswer) files = answer.files;
      const value = answer instanceof FileAnswer ? answer.answer : answer;
      // A tool that answers in words, as mcp-memory's do, is handed over as those words.
      content = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      // A tool that refused rather than threw failed all the same, and is shown and logged as failed.
      const refusal = refusalOf(value);
      // A Run Token is a credential, so what issued it is not shown.
      if (refusal === null) onEvent?.({ type: 'tool', name: call.name, state: 'finished', id: call.id, ...(call.name === RUN_TOKEN ? {} : { result: value }) });
      else {
        logToolFailure({ tool: call.name, arguments: call.arguments, error: refusal, ...(input.trace ? { trace: input.trace } : {}) });
        onEvent?.({ type: 'tool', name: call.name, state: 'failed', error: refusal, id: call.id });
      }
    } catch (error) {
      // A call held for a person pauses the run before it is made, with the calls still to make.
      if (error instanceof CallHeld) {
        held = { calls: remaining, reason: error.reason };
        return null;
      }
      // A run stopped on purpose says so in its own words; any other failure names what refused it.
      const message = error instanceof RunStopped ? error.message : failureText(error, call.name);
      content = JSON.stringify({ isError: true, message });
      logToolFailure({ tool: call.name, arguments: call.arguments, error: message, ...(input.trace ? { trace: input.trace } : {}) });
      onEvent?.({ type: 'tool', name: call.name, state: 'failed', error: message, id: call.id });
      if (error instanceof RunStopped) {
        messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content });
        failed = new ThinkingFailed(message, thought());
        return null;
      }
    }
    messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content, ...(files.length ? { attachments: files } : {}) });
    return content;
  };

  /** The calls of the model's latest message from this one on, which a held call leaves to make. */
  const callsFrom = (id: string): readonly TurnToolCall[] => {
    const calls = [...messages].reverse().find((message) => message.role === 'assistant')?.toolCalls ?? [];
    const index = calls.findIndex((call) => call.id === id);
    return index < 0 ? [] : calls.slice(index);
  };

  // The model as Pi names it; the port behind it knows its connection.
  const environment: Model<Api> = {
    id: input.connection.model, name: input.connection.model, api: 'flarechat', provider: 'flarechat', baseUrl: input.connection.baseUrl,
    input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 0, maxTokens: 0,
  };

  // Each tool the run may call, as Pi calls it. The model is told each tool's
  // parameters by the port; Pi is given any object, so each handler reads its
  // own arguments and refuses in words that say what to correct, as it always has.
  const executed = new Set<string>();
  const tools: AgentTool[] = offered.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: { type: 'object' },
    executionMode: 'sequential',
    execute: async (id, params) => {
      executed.add(id);
      const remaining = callsFrom(id);
      const call = remaining[0] ?? { id, name: tool.name, arguments: JSON.stringify(params ?? {}) };
      const content = await performOne(call, (params ?? {}) as Record<string, unknown>, remaining);
      if (content === null) return { content: [], details: null, terminate: true };
      return { content: [{ type: 'text', text: content }], details: null, ...(over() ? { terminate: true } : {}) };
    },
  }));

  /** One request to the model, answered to Pi as a stream it reads to its end. */
  const ask = (): AssistantMessageEventStream => {
    const answered = createAssistantMessageEventStream();
    const fail = (reason: 'error' | 'aborted', text: string): void => {
      const message: AssistantMessage = { ...assistantOf({ model, content: '', toolCalls: [], usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 } }, environment.api, environment.provider), stopReason: reason, errorMessage: text };
      answered.push({ type: 'error', reason, error: message });
    };
    void (async () => {
      if (over()) return fail(signal?.aborted ? 'aborted' : 'error', 'The run has stopped.');
      await checkpoint();
      const sending = messages.length;
      requests += 1;
      let completion: ModelCompletion;
      try {
        completion = await input.model.complete({ ...input.connection, messages: [...messages], tools: offered.map(wireTool), ...(signal ? { signal } : {}) }, onEvent);
      } catch (error) {
        if (signal?.aborted) return fail('aborted', 'The answer was stopped.');
        const text = error instanceof Error ? error.message : 'The model could not be called.';
        if (!stopped) modelError = text;
        return fail('error', text);
      }
      // A program's call that stopped the run while the model was answering ends it before the answer is kept.
      if (stopped) return fail('error', stopped.message);
      model = completion.model;
      tokens += totalTokens(completion.usage);
      logModelUsage({ model: completion.model, host: hostOf(input.connection.baseUrl), request: requests, messages: sending, usage: completion.usage, ...(input.trace ? { trace: input.trace } : {}) });
      messages.push({
        role: 'assistant',
        content: completion.content,
        ...(completion.toolCalls.length ? { toolCalls: completion.toolCalls } : {}),
        ...(completion.replay ? { replay: completion.replay } : {}),
      });
      toolCallCount += completion.toolCalls.length;
      const message = assistantOf(completion, environment.api, environment.provider);
      answered.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    })().finally(() => answered.end());
    return answered;
  };

  /** Makes the calls a paused run had still to make, in order, before the model is asked again. */
  const resumeCalls = async (calls: readonly TurnToolCall[]): Promise<void> => {
    for (const [index, call] of calls.entries()) {
      if (signal?.aborted) throw new ThinkingStopped(thought());
      let arguments_: Record<string, unknown> | null = null;
      try {
        arguments_ = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        arguments_ = null;
      }
      if (arguments_ === null) {
        const message = `The arguments of ${call.name} are not JSON.`;
        onEvent?.({ type: 'tool', name: call.name, state: 'failed', error: message, id: call.id });
        messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify({ isError: true, message }) });
        continue;
      }
      await performOne(call, arguments_, calls.slice(index));
      if (held !== null || failed !== null || stopped !== null) return;
    }
  };

  /** Throws what ended the run, if anything did. */
  const settle = (): void => {
    if (steerError !== null) throw steerError;
    if (signal?.aborted) throw new ThinkingStopped(thought());
    if (held !== null) {
      const { calls, reason } = held;
      throw new ThinkingPaused(thought(), calls, reason);
    }
    if (failed !== null) throw failed;
    if (stopped !== null) throw new ThinkingFailed((stopped as RunStopped).message, thought());
    if (modelError !== null) throw new ThinkingFailed(modelError, thought());
  };

  try {
    if (input.resume?.calls.length) {
      await resumeCalls(input.resume.calls);
      settle();
    }
    await runAgentLoop([], { messages: [], tools }, {
      model: environment,
      convertToLlm: (all) => all as Message[],
      toolExecution: 'sequential',
      // A call after one that paused or stopped the run is not made, nor is any call once the run is over.
      beforeToolCall: async () => over() ? { block: true, reason: 'The run stopped before this call.', terminate: true } : undefined,
      getSteeringMessages: async () => {
        if (!input.steer || over()) return [];
        try {
          const said = await input.steer();
          messages.push(...said);
          return said.map(toPiUser);
        } catch (error) {
          steerError = error;
          return [];
        }
      },
    }, (event) => {
      // A call Pi refused without making it, as one whose arguments do not fit its tool, is told to the model as a failed call.
      if (event.type !== 'tool_execution_end' || executed.has(event.toolCallId) || over()) return;
      const said = resultText(event.result as AgentToolResult<unknown>);
      const error = /^Tool .+ not found$/u.test(said) ? `${event.toolName} is not one of the tools you were given. Use only those.` : said;
      const call = callsFrom(event.toolCallId)[0];
      onEvent?.({ type: 'tool', name: event.toolName, state: 'started', id: event.toolCallId, arguments: call?.arguments ?? '{}' });
      logToolFailure({ tool: event.toolName, arguments: call?.arguments ?? '', error, ...(input.trace ? { trace: input.trace } : {}) });
      onEvent?.({ type: 'tool', name: event.toolName, state: 'failed', error, id: event.toolCallId });
      messages.push({ role: 'tool', name: event.toolName, toolCallId: event.toolCallId, content: JSON.stringify({ isError: true, message: error }) });
    }, signal, () => ask());
    settle();
    const last = messages.at(-1);
    return thought(last?.role === 'assistant' ? last.content : '');
  } finally {
    // The token stops working with the run, whichever way it ends.
    ended = true;
    void access?.then((opened) => opened.close(), () => undefined);
  }
};
