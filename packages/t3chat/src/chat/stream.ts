/**
 * Feeds a conversation's frames into t3code's own thread state. web/state/threads.ts reads its
 * thread atoms from here instead of subscribing over Effect RPC, so everything downstream (the
 * thread selectors, the timeline, the pending approvals) is t3code's code fed by our transport.
 */
import {
  type EnvironmentId,
  OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from '@t3tools/contracts';
import {
  applyThreadStreamItem,
  initialThreadStreamState,
  type ThreadStreamState,
} from '@t3tools/client-runtime/state/threadStream.ts';
import { EMPTY_THREAD_HISTORY_META } from '@t3tools/client-runtime/state/threadHistoryMerge.ts';
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from '@t3tools/client-runtime/state/threadState.ts';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { AsyncResult, Atom } from 'effect/reactivity';

import { appAtomRegistry } from '~/rpc/atomRegistry';

import type { ChatTransport } from './api.ts';

type ThreadStateResult = AsyncResult.AsyncResult<EnvironmentThreadState, never>;

const threadKey = (environmentId: string, threadId: string): string => `${environmentId}:${threadId}`;

const family = Atom.family((key: string) =>
  Atom.make<ThreadStateResult>(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
    Atom.keepAlive,
    Atom.withLabel(`orangeagent-thread-state:${key}`),
  ),
);

/** The state atom t3code's thread selectors read, keyed as client-runtime keys it. */
export const threadStateAtom = (environmentId: EnvironmentId, threadId: ThreadId): Atom.Atom<ThreadStateResult> =>
  family(threadKey(environmentId, threadId));

const toThreadState = (stream: ThreadStreamState): EnvironmentThreadState => ({
  data: Option.fromNullishOr(stream.projection),
  status: stream.projection === null ? 'synchronizing' : 'live',
  error: Option.none(),
  history: {
    ...EMPTY_THREAD_HISTORY_META,
    historyCursor: stream.historyCursor,
    hasMoreHistory: stream.historyCursor !== null,
    latestLocalTurnOrdinal: stream.partial?.latestLocalTurnOrdinal ?? null,
  },
  sequence: stream.sequence,
});

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2ThreadStreamItem));

/** The JSON text of one stream item, as a transport carries it. */
export const encodeFrame = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ThreadStreamItem));

/** The last applied state of each connected conversation, so a reconnect resumes after it. */
const streams = new Map<string, ThreadStreamState>();

/** Forgets every conversation applied so far, as a page loaded afresh holds none; a test starts each conversation anew with it. */
export const forgetThreads = (): void => streams.clear();

/**
 * Subscribes to one conversation and applies each frame through t3code's
 * `applyThreadStreamItem`; an already applied sequence leaves the state unchanged. Returns the
 * function that stops the subscription.
 */
export const connectThread = (environmentId: EnvironmentId, threadId: ThreadId, transport: ChatTransport): (() => void) => {
  const key = threadKey(environmentId, threadId);
  const atom = family(key);
  const receive = (frame: string): void => {
    const current = streams.get(key) ?? initialThreadStreamState;
    const next = applyThreadStreamItem(current, decodeFrame(frame));
    if (next === current) return;
    streams.set(key, next);
    appAtomRegistry.set(atom, AsyncResult.success(toThreadState(next)));
  };
  return transport.subscribe(threadId, streams.get(key)?.sequence ?? 0, receive);
};
