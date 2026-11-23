/**
 * Which calls of Operator Chat (ADR 0201) wait for a person, by
 * the conversation's approval mode, and how a waiting call is shown.
 *
 * A tool writes or acts when the product's one list says so (`asksApproval`),
 * and every MCP Server's tool acts. `read_only` offers no such tool. Of them,
 * every call waits but opening a page in the browser or reading it, which a
 * conversation makes without asking: `ask` asks before each call that waits;
 * `auto` asks the Decider and, unless it lets the call through, the person;
 * `unrestricted` asks nobody. A tool the Account allowed always is made
 * without asking in `ask` and `auto`. The mode is read at every call, so a
 * change applies from the next one.
 *
 * `auto` exists only where a Decider can be asked (modes.ts).
 */

import { asksApproval, callPreview, CHAT_MODE_LABELS, EVENT_TOOLS, PREVIEWED_TOOLS, TOOL_LABELS, type ChatMode, type PreviewEvent } from '@mail/domain';

import type { CallGuard } from './chat';
import { judge, type Decider } from './decider';
import type { Answer } from './pause';
import { CallHeld, type RunTool } from './turns';

/** Whether a tool writes or acts, which `read_only` offers not. */
export const acts = (tool: RunTool): boolean => tool.origin.kind === 'mcp' || asksApproval(tool.name);

/**
 * The browser tools a conversation calls without asking: opening a page and
 * reading what it shows change nothing a person would be asked about, while
 * clicking, typing, choosing, and pressing a key on a site still wait. This
 * is the chat's rule alone; an Automation's runs keep the browser as acting.
 */
const UNASKED: ReadonlySet<string> = new Set(['browser.open', 'browser.read']);

/** Whether a call of the tool waits for a person in a conversation that asks. */
export const waits = (tool: RunTool): boolean => acts(tool) && !(tool.origin.kind === 'internal' && UNASKED.has(tool.name));

/** The tools a conversation in `mode` offers its model. */
export const offeredTools = (tools: readonly RunTool[], mode: ChatMode): RunTool[] =>
  mode === 'read_only' ? tools.filter((tool) => !acts(tool)) : [...tools];

/** What becomes of one call: made, refused with words the model is told, or held for the person with why. */
export type Gate =
  | { kind: 'make' }
  | { kind: 'refuse'; message: string }
  | { kind: 'ask'; reason: string };

export const ASKED = `${CHAT_MODE_LABELS.ask}の会話なので、実行する前に確認します。`;

/** Decides one call by the conversation's mode as it is now. */
export const gate = async (input: {
  mode: ChatMode;
  /** The tool the call names, or undefined when it names none the answer holds, which the tool caller refuses. */
  tool: RunTool | undefined;
  arguments: Readonly<Record<string, unknown>>;
  request: string;
  /** Whether the Account allowed this tool always. */
  allowed: (tool: string) => Promise<boolean>;
  decider: Decider;
}): Promise<Gate> => {
  const { tool, mode } = input;
  if (!tool || !acts(tool) || mode === 'unrestricted') return { kind: 'make' };
  if (mode === 'read_only') {
    return { kind: 'refuse', message: `This conversation is read-only now, so ${tool.name} was not called. Tell the member what you would have done instead.` };
  }
  if (!waits(tool)) return { kind: 'make' };
  if (await input.allowed(tool.name)) return { kind: 'make' };
  if (mode === 'ask') return { kind: 'ask', reason: ASKED };
  const verdict = await judge(input.decider, { tool: tool.name, label: labelOf(tool), arguments: input.arguments, request: input.request });
  return verdict.allow ? { kind: 'make' } : { kind: 'ask', reason: verdict.reason };
};

/** What a program calling with the Run Token is told of a call that would wait: it cannot, so the model makes it itself. */
export const programRefusal = (name: string): { isError: true; message: string } => ({
  isError: true,
  message: `${name} waits for the member's approval in this conversation, which a program's call cannot. Call it yourself instead, not from a program.`,
});

/** What the model is told of a call the member declined, with what the member said when they said something. */
export const declined = (name: string, feedback: string | undefined): { isError: true; message: string } => ({
  isError: true,
  message: `The member declined this call, so ${name} was not made.${feedback?.trim() ? ` They said: ${feedback.trim()}` : ''} Do not make it again unless they ask for it.`,
});

/** What the tool does, in the words the screen names it by: a product tool by its label, a server's by the server and the tool. */
export const labelOf = (tool: Pick<RunTool, 'name' | 'origin'>): string => {
  if (tool.origin.kind === 'mcp') return `${tool.name.slice(0, tool.name.length - tool.origin.toolName.length - 1)} の ${tool.origin.toolName}`;
  return TOOL_LABELS[tool.name] ?? tool.name;
};

/** One argument's value as a person reads it: words as they are, a list of words joined, anything else as indented JSON. */
const valueText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(', ');
  return JSON.stringify(value, null, 2) ?? 'null';
};

/** The longest description of a call an approval keeps. */
const DESCRIBED_CHARACTERS = 8_000;

/**
 * How a waiting call is shown: what its tool does, then what it will do in
 * words when FlareChat can say it for its tool (the mail it sends, the event
 * it changes), and otherwise each argument on a line of its own.
 */
export const describeCall = (input: { label: string; arguments: unknown; preview: string | null }): string => {
  const values = typeof input.arguments === 'object' && input.arguments !== null && !Array.isArray(input.arguments)
    ? Object.entries(input.arguments as Record<string, unknown>).map(([key, value]) => {
      const text = valueText(value);
      return text.includes('\n') ? `${key}:\n${text.replace(/^/gmu, '  ')}` : `${key}: ${text}`;
    })
    : [valueText(input.arguments)];
  const text = [input.label, ...(input.preview ? [input.preview] : values)].join('\n');
  return text.length > DESCRIBED_CHARACTERS ? `${text.slice(0, DESCRIBED_CHARACTERS)}…` : text;
};

/**
 * What a call will do, for a tool FlareChat can show it for, such as the
 * mail it sends or the change to an event; null shows only its arguments.
 */
export type Preview = (name: string, arguments_: Readonly<Record<string, unknown>>) => Promise<string | null>;

export const NO_PREVIEW: Preview = async () => null;

/**
 * The previews of Operator Chat's mail and calendar writes (domain
 * `callPreview`): a change or cancellation names an event, read as FlareChat
 * recorded it so the change shows before and after. An event that cannot be
 * read shows only what changes.
 */
export const chatPreview = (event: (eventId: string) => Promise<PreviewEvent | null>): Preview => async (name, arguments_) => {
  if (!PREVIEWED_TOOLS.includes(name)) return null;
  const eventId = typeof arguments_.eventId === 'string' ? arguments_.eventId.trim() : '';
  const before = EVENT_TOOLS.includes(name) && eventId ? await event(eventId).catch(() => null) : null;
  return callPreview(name, arguments_, before);
};

/**
 * Decides every call of one answer: the held call of an answer resumed by the
 * member's answer to it, once; every other call by the conversation's mode
 * as it is at that call. A call held for the member throws `CallHeld`, and a
 * program's call that would be held is refused, since a program cannot wait.
 */
export const chatGuard = (input: {
  tools: readonly RunTool[];
  mode: () => ChatMode;
  request: string;
  allowed: (tool: string) => Promise<boolean>;
  decider: Decider;
  answered?: { callId: string; answer: Answer };
}): CallGuard => {
  let answered = input.answered ?? null;
  return async (name, arguments_, context) => {
    if (answered && !context.program && context.id === answered.callId) {
      const { answer } = answered;
      answered = null;
      return answer.decision === 'accept' ? undefined : declined(name, answer.feedback);
    }
    const decided = await gate({
      mode: input.mode(),
      tool: input.tools.find((tool) => tool.name === name),
      arguments: arguments_,
      request: input.request,
      allowed: input.allowed,
      decider: input.decider,
    });
    if (decided.kind === 'make') return undefined;
    if (decided.kind === 'refuse') return { isError: true, message: decided.message };
    if (context.program) return programRefusal(name);
    throw new CallHeld(decided.reason);
  };
};
