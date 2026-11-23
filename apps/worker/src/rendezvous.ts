/**
 * Run Tokens: how a program that runs elsewhere calls a run's tools.
 *
 * A run that thinks in FlareChat — an Operator Chat answer, an Automation's
 * run, or its trial — issues one when its model asks. The token names one
 * Durable Object by its hash, and the run holds a WebSocket to that object for
 * as long as it thinks. A call made with the token at the MCP Server is put to
 * the object, which hands it to the run, and the run answers it with the very
 * handlers its own calls go through: the same tools, the same grant, the same
 * reach, and, in an Automation, the same Planned Writes. Nothing but the run
 * answers, so the token works only while the run does, and never longer than
 * fifteen minutes (ADR 0199). No Google credential leaves the Worker.
 */

import { mcpUrl } from './authorization';
import { fromBase64Url, randomToken, sha256, toBase64Url } from './encoding';
import { FileAnswer } from './turns';
import type { Bindings } from './types';

/** How long a Run Token works at most, however long its run goes on. */
export const RUN_TOKEN_LIFETIME_MS = 15 * 60_000;

/** How long a call made with a Run Token waits on its run before it is refused. */
export const RUN_CALL_TIMEOUT_MS = 5 * 60_000;

/** What every Run Token starts with, so the MCP Server tells one from an Access Token without a lookup. */
const RUN_TOKEN_PREFIX = 'run_';

/** A tool as the run offers it: as its model is offered it. */
export interface RunCallTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What a run hands over to be called from elsewhere. */
export interface RunServing {
  tools: readonly RunCallTool[];
  call: (name: string, arguments_: Record<string, unknown>) => Promise<unknown>;
}

/** What `run.token` answers the model. */
export interface RunAccess {
  url: string;
  token: string;
  expiresAt: string;
}

/** An open Run Token, which stops working when it is closed. */
export interface OpenRunAccess extends RunAccess {
  close: () => void;
}

/** Where a run that thinks in FlareChat issues its Run Token. */
export interface Rendezvous {
  open: (serving: RunServing) => Promise<OpenRunAccess>;
}

/** A tool's answer as it crosses the socket: a value, a value with the files it read, or why it failed. */
export type WireAnswer =
  | { kind: 'value'; value: unknown }
  | { kind: 'files'; answer: unknown; files: Array<{ filename: string; mediaType: string; bytes: string }> }
  | { kind: 'error'; message: string };

/** What the run tells the object: who it is, then each answer. */
export type RunMessage =
  | { type: 'hello'; accountId: string; expiresAt: string; tools: readonly RunCallTool[] }
  | { type: 'answer'; id: string; answer: WireAnswer };

/** What the object tells the run: that it is ready, then each call. */
export type ObjectMessage =
  | { type: 'ready' }
  | { type: 'call'; id: string; name: string; arguments: Record<string, unknown> };

/** What the MCP Server asks the object, for the Account in whose URL the token was presented. */
export type EntranceRequest =
  | { kind: 'list'; accountId: string }
  | { kind: 'call'; accountId: string; name: string; arguments: Record<string, unknown> };

export const isRunToken = (presented: string): boolean => presented.startsWith(RUN_TOKEN_PREFIX);

/** The name of the object a Run Token reaches; only the token's hash names it, so the token is never stored. */
export const rendezvousName = (token: string): Promise<string> => sha256(`run-token:${token}`);

export const toWire = (value: unknown): WireAnswer => value instanceof FileAnswer
  ? { kind: 'files', answer: value.answer, files: value.files.map((file) => ({ filename: file.filename, mediaType: file.mediaType, bytes: toBase64Url(file.bytes) })) }
  : { kind: 'value', value };

export const fromWire = (wire: WireAnswer): unknown => {
  if (wire.kind === 'error') return { isError: true, message: wire.message };
  if (wire.kind === 'value') return wire.value;
  return new FileAnswer(wire.answer, wire.files.map((file) => ({ filename: file.filename, mediaType: file.mediaType, bytes: fromBase64Url(file.bytes) })));
};

/** The part of a WebSocket a run serves its calls over. */
export interface RunSocket {
  send: (data: string) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
}

/**
 * Answers each call the object hands over with the run's own handler, and
 * resolves once the object has said it holds the run's tools.
 */
export const serveRun = (socket: RunSocket, serving: RunServing, hello: Omit<Extract<RunMessage, { type: 'hello' }>, 'type' | 'tools'>): Promise<void> =>
  new Promise((resolve) => {
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as ObjectMessage;
      if (message.type === 'ready') {
        resolve();
        return;
      }
      const answered = (answer: WireAnswer) => socket.send(JSON.stringify({ type: 'answer', id: message.id, answer } satisfies RunMessage));
      serving.call(message.name, message.arguments).then(
        (value) => answered(toWire(value)),
        (error: unknown) => answered({ kind: 'error', message: error instanceof Error ? error.message : `${message.name} failed.` }),
      );
    });
    socket.send(JSON.stringify({ type: 'hello', ...hello, tools: serving.tools } satisfies RunMessage));
  });

/** The part of a Durable Object namespace a Run Token's object is reached through. */
export interface RendezvousNamespace {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => { fetch: (input: string, init?: RequestInit) => Promise<Response> };
}

const READY_TIMEOUT_MS = 10_000;

/** Where the runs of one Account issue their Run Tokens. */
export const rendezvous = (input: { namespace: RendezvousNamespace; accountId: string; url: string; now?: () => number }): Rendezvous => ({
  open: async (serving) => {
    const token = `${RUN_TOKEN_PREFIX}${randomToken()}`;
    const object = input.namespace.get(input.namespace.idFromName(await rendezvousName(token)));
    const response = await object.fetch('https://run-calls.internal/serve', { headers: { Upgrade: 'websocket' } });
    const socket = response.webSocket;
    if (!socket) throw new Error('The run could not be opened to programs elsewhere.');
    socket.accept();
    const expiresAt = new Date((input.now ?? Date.now)() + RUN_TOKEN_LIFETIME_MS).toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        serveRun(socket, serving, { accountId: input.accountId, expiresAt }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The run could not be opened to programs elsewhere in time.')), READY_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      socket.close(1011, 'The run could not be opened.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return { url: input.url, token, expiresAt, close: () => socket.close(1000, 'The run ended.') };
  },
});

/** Where the runs of one Account issue Run Tokens, or nothing where the object is not bound. */
export const accountRendezvous = (env: Bindings, accountId: string): Rendezvous | undefined =>
  env.RUN_CALLS ? rendezvous({ namespace: env.RUN_CALLS, accountId, url: mcpUrl(env, accountId) }) : undefined;

/** Spreads a rendezvous into a run's input only when there is one, as an optional field requires. */
export const withRendezvous = (value: Rendezvous | undefined): { rendezvous?: Rendezvous } => value ? { rendezvous: value } : {};

/** The calls the MCP Server makes with a Run Token, or null when no run answers it. */
export interface RunCalls {
  tools: readonly RunCallTool[];
  call: (name: string, arguments_: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Reaches the run a Run Token was issued by. It is null when the token names
 * no run: one never issued, one whose run has ended or that has expired, or
 * one presented for another Account.
 */
export const reachRun = async (input: { namespace: RendezvousNamespace; presented: string; accountId: string }): Promise<RunCalls | null> => {
  const object = input.namespace.get(input.namespace.idFromName(await rendezvousName(input.presented)));
  const ask = (request: EntranceRequest) => object.fetch('https://run-calls.internal/entrance', { method: 'POST', body: JSON.stringify(request) });
  const listed = await ask({ kind: 'list', accountId: input.accountId });
  if (!listed.ok) return null;
  const { tools } = await listed.json() as { tools: RunCallTool[] };
  return {
    tools,
    call: async (name, arguments_) => {
      const answered = await ask({ kind: 'call', accountId: input.accountId, name, arguments: arguments_ });
      if (answered.status === 404) return { isError: true, message: 'The run this token was issued by has ended, or the token has expired, so the call was not made.' };
      if (!answered.ok) return { isError: true, message: 'The run did not answer this call in time; it may still make it, so search before calling again.' };
      return fromWire((await answered.json() as { answer: WireAnswer }).answer);
    },
  };
};
