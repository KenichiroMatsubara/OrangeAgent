/**
 * Operator Chat: the Account's interactive entrance to the engine every
 * Automation runs on. One exchange is one Run; it thinks in the same loop with
 * tools selected from the product's one list, and performs each write when it
 * is called, because the administrator asking decides each one.
 */

import type { McpFetch } from './mcp';
import { withRendezvous, type Rendezvous } from './rendezvous';
import { think, toolCaller, type CallContext, type ModelConnection, type ModelPort, type RunTool, type Thought, type ToolHandlers, type TurnEvent, type TurnFile, type TurnMessage, type TurnToolCall } from './turns';

/**
 * Decides each call before it is made: `undefined` makes it, any other value
 * is the call's answer instead, such as a refusal, and throwing `CallHeld`
 * holds it for a person.
 */
export type CallGuard = (name: string, arguments_: Record<string, unknown>, context: CallContext) => Promise<unknown>;

/** An exchange that paused, resumed: what it said and was told after the member's message, and the calls it had still to make. */
export interface ChatResume {
  messages: readonly TurnMessage[];
  calls: readonly TurnToolCall[];
}

/** What an exchange said and was told after the member's message, from everything a run of `runChatTurn` thought. */
export const exchangeMessages = (thought: Thought, history: readonly TurnMessage[]): TurnMessage[] =>
  // The instructions, the history, and the member's message come first, as runChatTurn lays them out.
  thought.messages.slice(history.length + 2);

/**
 * Runs one exchange. A failed tool call is told to the model, which can say
 * so or try another way, rather than ending an exchange a person is waiting on.
 */
export const runChatTurn = async (input: {
  model: ModelPort;
  connection: ModelConnection;
  instructions: string;
  request: string;
  /**
   * What OrangeAgent writes after the member's words in their message, such as
   * the time it is now. It follows them, so the first words the model reads
   * in the message are the member's own and it answers in their language.
   */
  postscript?: string;
  attachments?: readonly TurnFile[];
  history: readonly TurnMessage[];
  tools: readonly RunTool[];
  fetch: McpFetch;
  handlers: ToolHandlers;
  onEvent?: (event: TurnEvent) => void;
  /** What names this exchange in the log a failed tool call writes. */
  trace?: Readonly<Record<string, string>>;
  /** Aborted when the administrator stops the answer. */
  signal?: AbortSignal;
  /** Where the answer issues a Run Token, so a program elsewhere can call its tools. */
  rendezvous?: Rendezvous;
  /** Decides each call before it is made; without it every call is made. */
  guard?: CallGuard;
  /** The exchange paused before a call, resumed from where it stopped. */
  resume?: ChatResume;
  /** What the member said while the exchange ran, handed to the model before its next request. */
  steer?: () => Promise<readonly TurnMessage[]>;
  /** Keeps what the exchange has said and been told after the member's message, before each request and each call (`think`'s `checkpoint`). */
  checkpoint?: (messages: TurnMessage[], thought: Thought) => Promise<void>;
}): Promise<Thought> => {
  const perform = toolCaller({ tools: input.tools, handlers: input.handlers, fetch: input.fetch });
  const { guard, checkpoint } = input;
  return think({
    model: input.model,
    connection: input.connection,
    messages: [
      // Everything the model is told is in the instructions, which a member's CLI is given on the MCP Server too (`guidance.ts`).
      { role: 'system', content: input.instructions },
      ...input.history,
      { role: 'user', content: input.postscript ? `${input.request}\n\n${input.postscript}` : input.request, ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
      ...input.resume?.messages ?? [],
    ],
    tools: input.tools,
    call: guard
      ? async (name, arguments_, context) => {
        const answered = await guard(name, arguments_, context);
        return answered === undefined ? perform(name, arguments_, context) : answered;
      }
      : perform,
    ...(input.resume ? { resume: { calls: input.resume.calls } } : {}),
    ...(input.steer ? { steer: input.steer } : {}),
    ...(checkpoint ? { checkpoint: (thought: Thought) => checkpoint(exchangeMessages(thought, input.history), thought) } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...withRendezvous(input.rendezvous),
  });
};
