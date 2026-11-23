/**
 * The seam between FlareChat and the chat copied from t3code. FlareChat owns this file and
 * everything under `src/chat`; the rest of `src` is the copy (NOTICE.md).
 *
 * A conversation is a log of events numbered per conversation (ADR 0201). The transport
 * delivers that log as frames, each the JSON text of one t3code
 * `OrchestrationV2ThreadStreamItem`: a `snapshot` of the whole conversation, `synchronized` once
 * the snapshot is current, then one `event` per change with the next `sequence`. A frame the
 * client has already applied is skipped, so a transport may replay freely.
 */

import type { ModelEffort, ModelEfforts } from '@mail/domain';

/** How a person answers a write that waits for approval. */
export type ChatDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';

/** A conversation's approval mode: no writes offered, ask before each, let a judge decide (where the server can ask one), or never ask. */
export type ChatMode = 'read_only' | 'ask' | 'auto' | 'unrestricted';

/** How a message sent while an answer is being written reaches it: handed to it at its next step, or queued after it. */
export type ChatDelivery = 'steer' | 'queue';

/** What a person does to a queued message: send it now, remove it, rewrite it, or move it before another (or last). */
export type ChatQueueChange =
  | { readonly action: 'send'; readonly runId: string }
  | { readonly action: 'remove'; readonly runId: string }
  | { readonly action: 'edit'; readonly runId: string; readonly text: string }
  | { readonly action: 'move'; readonly runId: string; readonly beforeRunId: string | null };

/** What a message carries besides its words. */
export interface ChatSendOptions {
  /** Left out, a message sent while an answer is being written is handed to it. */
  readonly delivery?: ChatDelivery;
  /** Files and pictures sent with the message. */
  readonly files?: ReadonlyArray<File>;
  /** One of the models the server offers to answer with; left out, its default. */
  readonly model?: string;
  /** One of the levels of effort the server says the model takes; left out, the model's own. */
  readonly effort?: ModelEffort;
}

/** What the chat offers a person besides writing, as the server says. */
export interface ChatCapabilities {
  /** The models a message may be answered by, the default first; a choice is offered only among two or more. */
  readonly models: ReadonlyArray<string>;
  /** The levels of effort each model takes, the lightest first, and the one it thinks at when none is named; a model left out offers no choice of effort. */
  readonly efforts: Readonly<Record<string, ModelEfforts>>;
  /** Whether Google Picker is configured: a Drive file can be attached, and a file saved in a Drive folder the person chooses. */
  readonly drivePicker: boolean;
}

/** What the person is likely to write next after the answer `runId`, or null; `runId` is null when no answer has ended. */
export interface ChatSuggestion {
  readonly runId: string | null;
  readonly text: string | null;
}

/** What the chat needs from the server, whatever carries it (a Durable Object, a mock). */
export interface ChatTransport {
  /**
   * Starts delivering one conversation's frames to `onFrame`, beginning after `afterSequence`
   * (0 for a fresh snapshot), and returns the function that stops them.
   */
  subscribe(threadId: string, afterSequence: number, onFrame: (frame: string) => void): () => void;
  /**
   * Answers the approval request `requestId`; `feedback`, given with a decline when the person
   * typed a message instead, is told to the model. Rejects, in words a person reads, when it was
   * not taken.
   */
  respond(requestId: string, decision: ChatDecision, feedback?: string): Promise<void>;
  /**
   * The approval modes the server offers the conversation, read-only first; the composer offers
   * these and no other. Rejects, in words a person reads, when they could not be read.
   */
  modes(): Promise<ReadonlyArray<ChatMode>>;
  /** Sets the conversation's approval mode, from its next tool call; rejects, in words a person reads, when it was not set. */
  setMode(mode: ChatMode): Promise<void>;
  /**
   * Sends what the person wrote, with any files: as the next message, or, while an answer is
   * being written, handed to it or queued after it. Rejects, in words a person reads, when it
   * was not sent.
   */
  send(text: string, options?: ChatSendOptions): Promise<void>;
  /** Changes a queued message; rejects, in words a person reads, when it was not changed. */
  changeQueue(change: ChatQueueChange): Promise<void>;
  /** Stops the answer being written; rejects, in words a person reads, when it could not. */
  interrupt(): Promise<void>;
  /**
   * Rewinds the conversation to an earlier message of the person's, by the id its item's message
   * carries, and asks it again as `text`, with the files it was sent with but those `drop` names
   * and then the `files` added: the answer it began and every answer after it are taken back.
   * Rejects, in words a person reads, when it was not.
   */
  rewind(messageId: string, text: string, options?: { readonly model?: string; readonly effort?: ModelEffort; readonly drop?: ReadonlyArray<string>; readonly files?: ReadonlyArray<File> }): Promise<void>;
  /** Continues the conversation from the answer of `runId` as a new conversation, and resolves with its id. */
  fork(runId: string): Promise<string>;
  /**
   * What the person is likely to write next after the conversation's latest answer, greyed in the
   * empty composer until they type, or null text when nothing is suggested; `runId` names the answer
   * it follows. Left out, nothing is suggested.
   */
  suggestion?(): Promise<ChatSuggestion>;
  /** What the chat offers besides writing; left out, no model is chosen and nothing reaches Drive. */
  capabilities?(): Promise<ChatCapabilities>;
  /** The model this browser last chose to answer with, or null. */
  chosenModel?(): string | null;
  /** Remembers the model chosen, for the next message and the next screen. */
  chooseModel?(model: string): void;
  /** The level of effort this browser last chose, or null. */
  chosenEffort?(): ModelEffort | null;
  /** Remembers the level of effort chosen, for the next message and the next screen. */
  chooseEffort?(effort: ModelEffort): void;
  /**
   * Saves a file of the conversation to Drive: in a folder the person chooses when `choose`, or in
   * the default one. Resolves with where it was saved, or null when the person chose nothing.
   */
  saveToDrive?(fileId: string, choose: boolean): Promise<{ readonly url: string } | null>;
  /** Lets the person choose files in Drive and resolves with them, to attach as files from their computer; none when they chose nothing. */
  pickDriveFiles?(): Promise<ReadonlyArray<File>>;
  /** Where each attachment of a message can be read, by its id, when the transport knows. */
  readonly attachmentUrls?: ReadonlyMap<string, string>;
}

export interface ChatSurfaceProps {
  readonly threadId: string;
  readonly transport: ChatTransport;
  /** Opens another conversation, as one continued from this one. */
  readonly onOpenThread?: (threadId: string) => void;
  /** Says what the conversation is called whenever that changes, as its first message or a rename names it. */
  readonly onTitle?: (title: string) => void;
  /** Opens the screen where the models a message may be answered by are added and ordered. */
  readonly onManageModels?: () => void;
}
