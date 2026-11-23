/**
 * Planned Writes: the writes an Automation's run planned, and the one adapter
 * per Account that applies them.
 *
 * Each Planned Write is one call a run made to a write tool, read the way the
 * tool reads it and frozen as one row, so applying it is performing that call.
 * Callers of Execution never see this adapter; they hand it a plan and the
 * Account does the rest.
 */
import { and, eq } from 'drizzle-orm';

import { now } from './clock';
import { channelCredentials } from './channel';
import { openInbox, type InboxSession } from './inbox';
import { accountKeyFor } from './keys';
import { suppressionPort } from './mcp-server-store';
import type { Providers } from './providers';
import { accountDatabase } from './storage/database';
import { automationRevisions } from './storage/account-schema';
import { channelPorts, type ChannelPorts } from './sending';
import { suppressionKey } from './suppression';
import { TemporaryFailure } from './temporary';
import { isWriteTool, performWrite, writeCall, type WriteToolName } from './tools';
import type { Bindings } from './types';

/** One write a run planned: the call it made to a tool of the product's one list. */
export interface PlannedWriteCall {
  tool: WriteToolName;
  arguments: Record<string, unknown>;
}

/**
 * Restores one Planned Write from the row that froze it, read again the way
 * its tool reads every call.
 */
export const decodePlannedWrite = (tool: string, encodedArguments: string): PlannedWriteCall => {
  if (!isWriteTool(tool)) throw new Error(`${tool} is not a write a run plans.`);
  const parsed = JSON.parse(encodedArguments) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error(`The planned ${tool} has no arguments.`);
  return { tool, arguments: writeCall(tool, parsed as Record<string, unknown>) };
};

/** What the adapter is told about the run a write belongs to. */
export interface PlannedWriteRun {
  id: string;
  /** The Planned Write being applied. */
  writeId: string;
  automationId: string | null;
  automationRevision: number | null;
  sourceMessageId: string | null;
}

/**
 * A Planned Write that failed temporarily and may succeed if it is applied
 * again, carrying how long the provider asked to be left alone when it said.
 * When it is applied again is Execution's decision; any other error fails
 * the write for good.
 */
export class TransientWriteError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | null) {
    super(message);
    this.name = 'TransientWriteError';
  }
}

export interface PlannedWriteAdapter {
  /** Applies one write; throws `TransientWriteError` when the same write may succeed later. */
  apply(run: PlannedWriteRun, write: PlannedWriteCall): Promise<unknown>;
}

/**
 * The writes whose provider call carries no key of its own, so a repeat of one
 * the provider already made would make it twice: a second mail, draft,
 * folder, or Task. Each is applied again only after a failure the provider answered as
 * not made; every other write names itself to its provider (a message's retry
 * key, an event's id) or sets what it sets, so applying it again is safe.
 */
const UNKEYED_WRITES: ReadonlySet<string> = new Set(['mail.send', 'mail.draft', 'drive.create_folder', 'tasks.create']);

/** What one failed write is to Execution: transient when applying it again may succeed and cannot repeat it. */
const writeFailure = (tool: string, error: unknown): unknown => {
  if (!(error instanceof TemporaryFailure)) return error;
  if (error.performed === 'unknown' && UNKEYED_WRITES.has(tool)) {
    return new Error(`${error.message} ${tool} may already have been made, so it is not made again.`);
  }
  return new TransientWriteError(error.message, error.retryAfterSeconds);
};

/** What the revision a run ran says about how long its writes hold their repeats. */
const revisionOf = async (database: D1Database, run: PlannedWriteRun) => run.automationId && run.automationRevision !== null
  ? accountDatabase(database).select({ suppressionWindow: automationRevisions.suppressionWindow })
    .from(automationRevisions)
    .where(and(eq(automationRevisions.automationId, run.automationId), eq(automationRevisions.revision, run.automationRevision))).get()
  : undefined;

/**
 * The one adapter that applies this Account's Planned Writes: each is the
 * tool call a run planned, performed now by `performWrite` as a run that
 * performs its writes would have performed it, and recorded against its
 * Automation's Suppression Window once it succeeds. The Automation Inbox is
 * opened lazily, once, because a run whose writes only send on a Channel
 * never needs Google at all.
 */
export const plannedWritesFor = (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  inbox?: InboxSession;
}): PlannedWriteAdapter => {
  let session: Promise<InboxSession> | undefined = input.inbox ? Promise.resolve(input.inbox) : undefined;
  const inbox = (): Promise<InboxSession> => {
    session ??= openInbox({ env: input.env, accountId: input.accountId, database: input.database, google: input.providers.google });
    return session;
  };
  // A write that speaks now reaches its Channel with the Account's credentials, read when one first does.
  let opened: Promise<ChannelPorts> | undefined;
  const channels = (): Promise<ChannelPorts> => {
    opened ??= (async () => channelPorts({
      database: input.database,
      credentials: await channelCredentials({ database: input.database, accountKey: await accountKeyFor(input.env, input.accountId), accountId: input.accountId }),
      fetch: input.providers.fetch,
    }))();
    return opened;
  };
  const ports: ChannelPorts = {
    sendToContact: async (send) => (await channels()).sendToContact(send),
    sendToDestination: async (send) => (await channels()).sendToDestination(send),
  };
  return {
    apply: async (run, write) => {
      const at = new Date(now());
      const result = await performWrite({
        database: input.database,
        accountId: input.accountId,
        // Whom it reaches was bounded when it was planned.
        mail: { kind: 'none' },
        google: { provider: input.providers.google, session: inbox },
        ports,
        origin: { automationId: run.automationId, sourceMessageId: run.sourceMessageId },
        plannedWriteId: run.writeId,
        skills: { db: accountDatabase(input.database), bucket: input.env.RECOVERY_RECEIPTS, accountId: input.accountId },
        at: () => at,
      }, write.tool, write.arguments).catch((error: unknown) => { throw writeFailure(write.tool, error); });
      if (typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true) {
        throw new Error(String((result as { message?: unknown }).message ?? `${write.tool} failed.`));
      }
      const revision = await revisionOf(input.database, run);
      if (run.automationId && revision && revision.suppressionWindow !== 'none') {
        await suppressionPort({ database: input.database, scope: run.automationId, window: revision.suppressionWindow, at })
          .record(suppressionKey({ scope: run.automationId, tool: write.tool, arguments: write.arguments }));
      }
      return result;
    },
  };
};
