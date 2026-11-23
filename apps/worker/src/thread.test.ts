import { beforeEach, describe, expect, it } from 'vitest';

import type { Conversation } from './conversation';
import { ChatThreads } from './thread';

/** Each conversation the object opens, and whether it is answering when the object asks. */
const opened: Array<{ loaded: boolean; answering: boolean }> = [];
let answering = false;

/** The object, building a conversation that only records being read and says whether it is answering. */
class Observed extends ChatThreads {
  protected override async build(): Promise<Conversation> {
    const entry = { loaded: false, answering };
    opened.push(entry);
    const conversation: Partial<Conversation> = {
      load: async () => {
        entry.loaded = true;
      },
      answering: () => entry.answering,
    };
    return conversation as Conversation;
  }
}

/** The object's own storage and alarm, held in memory as the runtime keeps them across an eviction. */
const state = (stored: Record<string, unknown>) => {
  const alarms: number[] = [];
  const ctx = {
    storage: {
      get: async (key: string) => stored[key],
      put: async (key: string, value: unknown) => {
        stored[key] = value;
      },
      setAlarm: async (at: number) => {
        alarms.push(at);
      },
      deleteAlarm: async () => undefined,
      deleteAll: async () => undefined,
    },
    getWebSockets: () => [],
    waitUntil: () => undefined,
    acceptWebSocket: () => undefined,
  };
  return { ctx, alarms };
};

const objectOf = (ctx: ReturnType<typeof state>['ctx']) =>
  new Observed(ctx as unknown as DurableObjectState, { RECOVERY_RECEIPTS: {} } as unknown as ConstructorParameters<typeof ChatThreads>[1]);

describe('a conversation\'s Durable Object woken by its heartbeat', () => {
  beforeEach(() => {
    opened.length = 0;
    answering = false;
  });

  it('opens the conversation it served when it wakes having gone away, which fails the answer nothing writes and closes its Run', async () => {
    const { ctx, alarms } = state({ target: { accountId: 'organization-1', threadId: 'thread-1' } });

    await objectOf(ctx).alarm();

    // Opening reads the conversation, and reading fails every answer left being written (conversation.ts `read`).
    expect(opened).toEqual([{ loaded: true, answering: false }]);
    expect(alarms).toEqual([]);
  });

  it('wakes again while an answer is being written, and does nothing for an object that served no conversation', async () => {
    answering = true;
    const writing = state({ target: { accountId: 'organization-1', threadId: 'thread-1' } });
    await objectOf(writing.ctx).alarm();
    expect(writing.alarms).toHaveLength(1);

    const empty = state({});
    await objectOf(empty.ctx).alarm();
    expect(empty.alarms).toEqual([]);
    expect(opened).toHaveLength(1);
  });
});
