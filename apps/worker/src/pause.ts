/**
 * An answer of Operator Chat (ADR 0201) waiting for a person to
 * approve a call. Everything the answer did until then is kept, so the answer
 * resumes from it whichever Durable Object receives the person's answer, even
 * one that was started after the one that asked had gone.
 *
 * Its state is kept as one JSON text and each file a tool handed the model as
 * its own bytes beside it (`encodePause`), so no file becomes base64 on its way.
 */

import type { ModelEffort } from '@mail/domain';

import type { TurnFile, TurnMessage, TurnToolCall } from './turns';

/** What an answer spent until it paused, which its Run records once it ends. */
export interface Spent {
  model: string;
  tokens: number;
  toolCalls: number;
  /** The words it had written. */
  output: string;
}

/** What an answer that paused hands its conversation: everything needed to resume it, and how the waiting call is shown. */
export interface Hold {
  /** What the answer said and was told after the member's message, ending with the message that made the held call. */
  messages: TurnMessage[];
  /** The held call, then every call of the same message after it. */
  calls: TurnToolCall[];
  /** Why the person is asked, in words the screen shows. */
  reason: string;
  /** What the held call's tool does, in the words the screen names it by. */
  label: string;
  /** The held call as the person reads it: its tool, its arguments, and its preview. */
  description: string;
  /** What the call will change, where OrangeAgent can show it; null until a tool has one. */
  preview: string | null;
  spent: Spent;
}

/** A Hold as its conversation keeps it. */
export interface Pause extends Hold {
  /** The runtime request the screen answers. */
  id: string;
  runId: string;
  /** The member's message the answer answers. */
  request: string;
  /** The model the member chose for it. */
  model: string;
  /** The level of effort the member named for it; a pause kept before effort could be named names none. */
  effort?: ModelEffort;
  /** The turn item that shows the held call. */
  itemId: string;
  createdAt: string;
}

/**
 * An answer being written, as it stood before its latest model request or
 * tool call. It is kept each time, so an object started after the one
 * writing it went away, as when the platform restarts it, goes on from there
 * rather than failing the answer.
 */
export interface Progress {
  runId: string;
  /** The member's message the answer answers. */
  request: string;
  model: string;
  effort?: ModelEffort;
  /** What the answer said and was told after the member's message. */
  messages: TurnMessage[];
  spent: Spent;
  /** How many objects took the answer up again since it last moved on; past a few, it ends as it always did. */
  restarts: number;
}

/** How a person answered the held call. */
export interface Answer {
  decision: 'accept' | 'decline';
  /** What the person said with a decline, told to the model. */
  feedback?: string;
}

/** The held call: the first of the calls still to make. */
export const heldCall = (hold: { calls: readonly TurnToolCall[] }): TurnToolCall => {
  const call = hold.calls[0];
  if (!call) throw new Error('A paused answer holds no call.');
  return call;
};

interface KeptFile {
  filename: string;
  mediaType: string;
  /** Which of the pause's files holds the bytes. */
  file: number;
  sandbox?: boolean;
  path?: string;
  shown?: boolean;
}

type KeptMessage = Omit<TurnMessage, 'attachments'> & { attachments?: KeptFile[] };

type KeptState<T> = Omit<T, 'messages'> & { messages: KeptMessage[] };

/** A pause, or an answer's progress, as one JSON text and the bytes of every file its messages hold, in the order the text names them. */
export const encodePause = <T extends { messages: TurnMessage[] }>(pause: T): { state: string; files: Uint8Array[] } => {
  const files: Uint8Array[] = [];
  const keep = (file: TurnFile): KeptFile => {
    files.push(file.bytes);
    return {
      filename: file.filename, mediaType: file.mediaType, file: files.length - 1,
      ...(file.shown ? { shown: true } : {}),
    };
  };
  const messages = pause.messages.map(({ attachments, ...message }): KeptMessage =>
    attachments?.length ? { ...message, attachments: attachments.map(keep) } : message);
  const state: KeptState<T> = { ...pause, messages };
  return { state: JSON.stringify(state), files };
};

/** The pause, or progress, `encodePause` wrote, its files read back by index. */
export const decodePause = <T extends { messages: TurnMessage[] } = Pause>(state: string, files: readonly Uint8Array[]): T => {
  const kept = JSON.parse(state) as KeptState<T>;
  const messages = kept.messages.map(({ attachments, ...message }): TurnMessage => attachments?.length
    ? {
      ...message,
      attachments: attachments.map(({ file, ...rest }): TurnFile => {
        const bytes = files[file];
        if (!bytes) throw new Error(`The paused answer's file ${rest.filename} is missing.`);
        return { ...rest, bytes };
      }),
    }
    : message);
  return { ...kept, messages } as unknown as T;
};

/** How many files a kept state names. */
export const pauseFileCount = (state: string): number => {
  const kept = JSON.parse(state) as KeptState<Pause>;
  return kept.messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0);
};
