/**
 * Execution: the one module that opens, freezes, decides, resumes, expires,
 * lists, and reads Runs for an Account.
 *
 * An Automation's run hands `freeze()` every write it planned; how each
 * Planned Write is applied once the Account is known is this module's own
 * concern and appears on no interface. Read-only retains the plan, approval
 * holds it, and unattended applies it at once; after applying begins only the
 * writes not yet done are resumed, never replanned.
 */

import { MAX_DELIVERY_ATTEMPTS, nextRetry, type ExecutionMode, type PlannedWrite, type Run, type RunStatus, type RunTrigger } from '@mail/domain';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { InboxSession } from './inbox';
import type { Providers } from './providers';
import { conflict, notFound } from './refusal';
import type { SkillRead } from './skills';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { automations, plannedWrites, runs, sourceMessages } from './storage/account-schema';
import type { Bindings } from './types';
import { decodePlannedWrite, plannedWritesFor, TransientWriteError, type PlannedWriteAdapter, type PlannedWriteCall } from './writes';

/** How long a plan held for approval waits before it expires. */
const APPROVAL_DAYS = 7;

/**
 * How long an Automation's Run may stay planning: longer than any invocation
 * of the Worker runs, so a Run still planning after it was left by a pass
 * that ended while its model thought.
 */
export const RUN_PLANNING_MS = 15 * 60_000;

const STALLED = 'This run stopped before it finished thinking, so it planned nothing. The Automation runs again at its next Trigger Time.';

/** One write a run planned, in the order it was called. */
export type PlannedWriteInput = PlannedWriteCall & {
  key: string;
  /** The keys of the writes that must succeed before this one is applied. */
  dependsOn: string[];
};

/** What the model was and did over one run, recorded on the Run. */
export interface RunThought {
  model: string | null;
  skills: readonly SkillRead[];
  toolCalls: number;
  tokens: number;
  output: string | null;
  error: string | null;
  transcriptKey: string | null;
  transcriptExpiresAt: string | null;
}

export interface Execution {
  /** Opens the Run one Automation's work at its Trigger Time, or one Operator Chat exchange, is recorded as. */
  open(input: {
    trigger: 'schedule' | 'chat';
    automation: { id: string; revision: number } | null;
    executionMode: ExecutionMode;
    /** The id the Run is opened under, as a queued chat message's was given when it was queued; a new one otherwise. */
    id?: string;
  }): Promise<{ id: string }>;
  /** Freezes what an Automation's run planned and retains, holds, or applies it by its Execution Mode. */
  freeze(runId: string, input: { writes: readonly PlannedWriteInput[]; thought: RunThought }): Promise<Run>;
  /** Closes a run that leaves nothing to apply: an Operator Chat exchange, or a run that failed before its plan froze. */
  close(runId: string, input: { outcome: 'completed' | 'failed'; thought: RunThought }): Promise<void>;
  decide(input: { runId: string; decision: 'approve' | 'reject'; actorIdentityId: string }): Promise<Run>;
  expireApprovals(): Promise<number>;
  /** Fails each Automation's Run left planning by a pass that ended, and says how many. */
  abandonStalled(): Promise<number>;
  resumeDue(): Promise<Run[]>;
  read(runId: string): Promise<Run>;
  list(input?: { automationId?: string }): Promise<Run[]>;
}

interface ExecutionDependencies {
  database: D1Database;
  writes: PlannedWriteAdapter;
  now?: () => Date;
  id?: () => string;
}

const parsed = (value: string | null): unknown | null => value === null ? null : JSON.parse(value) as unknown;

type RunRow = typeof runs.$inferSelect;
type WriteRow = typeof plannedWrites.$inferSelect;

const writeView = (row: WriteRow): PlannedWrite => ({
  id: row.id,
  key: row.key,
  tool: row.tool,
  arguments: JSON.parse(row.arguments) as Record<string, unknown>,
  dependsOn: JSON.parse(row.dependsOn) as string[],
  status: row.status,
  attempts: row.attempts,
  result: parsed(row.result),
  error: row.error,
});

/**
 * The engine, built from a write adapter. Production reaches it only through
 * `executionFor`; a test that has to watch writes being applied substitutes
 * the adapter here, which is the module's one internal seam.
 */
export const createExecution = (dependencies: ExecutionDependencies): Execution => {
  const database = drizzleAccountDatabase(dependencies.database);
  const currentTime = dependencies.now ?? (() => new Date());
  const nextId = dependencies.id ?? (() => crypto.randomUUID());
  const timestamp = (): string => currentTime().toISOString();

  const views = async (rows: readonly RunRow[]): Promise<Run[]> => {
    if (!rows.length) return [];
    const runIds = rows.map(({ id }) => id);
    const automationIds = [...new Set(rows.flatMap(({ automationId }) => automationId ? [automationId] : []))];
    const sourceIds = [...new Set(rows.flatMap(({ sourceMessageId }) => sourceMessageId ? [sourceMessageId] : []))];
    const [writes, named, sources] = await Promise.all([
      database.select().from(plannedWrites).where(inArray(plannedWrites.runId, runIds)).orderBy(asc(plannedWrites.createdAt)).all(),
      automationIds.length ? database.select({ id: automations.id, name: automations.name }).from(automations).where(inArray(automations.id, automationIds)).all() : [],
      sourceIds.length ? database.select({ id: sourceMessages.id, subject: sourceMessages.subject, sender: sourceMessages.sender, receivedAt: sourceMessages.receivedAt })
        .from(sourceMessages).where(inArray(sourceMessages.id, sourceIds)).all() : [],
    ]);
    return rows.map((row): Run => ({
      id: row.id,
      trigger: row.trigger,
      automation: row.automationId && row.automationRevision !== null
        ? { id: row.automationId, name: named.find(({ id }) => id === row.automationId)?.name ?? '', revision: row.automationRevision }
        : null,
      sourceMessage: sources.find(({ id }) => id === row.sourceMessageId) ?? null,
      executionMode: row.executionMode,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      expiresAt: row.expiresAt,
      model: row.model,
      toolCalls: row.toolCalls,
      tokens: row.tokens,
      output: row.output,
      error: row.error,
      transcript: row.transcriptKey !== null && row.transcriptExpiresAt !== null && Date.parse(row.transcriptExpiresAt) > currentTime().getTime(),
      writes: writes.filter(({ runId }) => runId === row.id).map(writeView),
    }));
  };

  const read = async (runId: string): Promise<Run> => {
    const row = await database.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) throw notFound('Run was not found.');
    return (await views([row]))[0]!;
  };

  const settle = async (runId: string, status: RunStatus): Promise<void> => {
    const at = timestamp();
    const finished = status === 'completed' || status === 'failed' || status === 'rejected' || status === 'expired';
    await database.update(runs).set({ status, updatedAt: at, ...(finished ? { finishedAt: at } : {}) }).where(eq(runs.id, runId)).run();
  };

  /** Applies every write not yet done, in order, each once its dependencies succeeded. */
  const apply = async (row: RunRow): Promise<Run> => {
    await database.update(runs).set({ status: 'applying', updatedAt: timestamp() }).where(eq(runs.id, row.id)).run();
    const planned = await database.select().from(plannedWrites).where(eq(plannedWrites.runId, row.id)).orderBy(asc(plannedWrites.createdAt)).all();
    const statuses = new Map(planned.map((write) => [write.key, write.status]));
    let permanentlyFailed = false;
    let waiting = false;
    for (const write of planned) {
      if (write.status === 'succeeded' || write.status === 'permanent_failed' || write.status === 'rejected' || write.status === 'expired') {
        if (write.status === 'permanent_failed') permanentlyFailed = true;
        continue;
      }
      if (write.status === 'transient_failed' && write.nextAttemptAt && Date.parse(write.nextAttemptAt) > currentTime().getTime()) {
        waiting = true;
        continue;
      }
      const dependsOn = JSON.parse(write.dependsOn) as string[];
      if (dependsOn.some((key) => statuses.get(key) !== 'succeeded')) {
        if (dependsOn.some((key) => statuses.get(key) === 'permanent_failed')) permanentlyFailed = true;
        else waiting = true;
        statuses.set(write.key, 'blocked');
        await database.update(plannedWrites).set({ status: 'blocked', updatedAt: timestamp() }).where(eq(plannedWrites.id, write.id)).run();
        continue;
      }
      await database.update(plannedWrites).set({ status: 'applying', attempts: write.attempts + 1, updatedAt: timestamp() }).where(eq(plannedWrites.id, write.id)).run();
      try {
        const result = await dependencies.writes.apply(
          { id: row.id, writeId: write.id, automationId: row.automationId, automationRevision: row.automationRevision, sourceMessageId: row.sourceMessageId },
          decodePlannedWrite(write.tool, write.arguments),
        );
        await database.update(plannedWrites).set({ status: 'succeeded', result: JSON.stringify(result ?? null), error: null, updatedAt: timestamp() }).where(eq(plannedWrites.id, write.id)).run();
        statuses.set(write.key, 'succeeded');
      } catch (error) {
        // A transient failure waits as the domain's retry policy says: the Retry-After the provider named, or a doubling back-off, for five attempts in all.
        const transient = error instanceof TransientWriteError ? error : null;
        const retry = transient
          ? nextRetry({ attempts: write.attempts + 1, now: timestamp(), ...(transient.retryAfterSeconds === null ? {} : { retryAfterSeconds: transient.retryAfterSeconds }) })
          : null;
        if (transient && retry && 'retryAt' in retry) {
          waiting = true;
          statuses.set(write.key, 'transient_failed');
          await database.update(plannedWrites).set({
            status: 'transient_failed', error: transient.message, nextAttemptAt: retry.retryAt, updatedAt: timestamp(),
          }).where(eq(plannedWrites.id, write.id)).run();
        } else {
          permanentlyFailed = true;
          statuses.set(write.key, 'permanent_failed');
          const message = error instanceof Error ? error.message : 'The write failed.';
          await database.update(plannedWrites).set({
            status: 'permanent_failed',
            error: retry ? `${message} It failed ${MAX_DELIVERY_ATTEMPTS} times and is not tried again.` : message,
            nextAttemptAt: null,
            updatedAt: timestamp(),
          }).where(eq(plannedWrites.id, write.id)).run();
        }
      }
    }
    await settle(row.id, waiting ? 'applying' : permanentlyFailed ? 'failed' : 'completed');
    return read(row.id);
  };

  const claimDecision = async (runId: string, values: Partial<typeof runs.$inferInsert>): Promise<void> => {
    const claimed = await database.update(runs).set(values)
      .where(and(eq(runs.id, runId), eq(runs.status, 'pending_approval'))).run();
    if (claimed.meta.changes === 0) throw conflict('Run was already decided.');
  };

  const recorded = (thought: RunThought) => ({
    model: thought.model,
    skills: JSON.stringify(thought.skills),
    toolCalls: thought.toolCalls,
    tokens: thought.tokens,
    output: thought.output,
    error: thought.error,
    transcriptKey: thought.transcriptKey,
    transcriptExpiresAt: thought.transcriptExpiresAt,
  });

  return {
    open: async (input) => {
      const id = input.id ?? nextId();
      const at = timestamp();
      await database.insert(runs).values({
        id,
        trigger: input.trigger,
        automationId: input.automation?.id ?? null,
        automationRevision: input.automation?.revision ?? null,
        sourceMessageId: null,
        executionMode: input.executionMode,
        status: 'planning',
        startedAt: at,
        updatedAt: at,
      }).run();
      return { id };
    },
    freeze: async (runId, input) => {
      const row = await database.select().from(runs).where(eq(runs.id, runId)).get();
      if (!row) throw notFound('Run was not found.');
      if (row.status !== 'planning') throw conflict(`Run is already ${row.status}.`);
      const at = timestamp();
      const status: RunStatus = !input.writes.length
        ? 'completed'
        : row.executionMode === 'read_only' ? 'read_only' : row.executionMode === 'approval' ? 'pending_approval' : 'applying';
      const expiresAt = status === 'pending_approval' ? new Date(currentTime().getTime() + APPROVAL_DAYS * 86_400_000).toISOString() : null;
      const writeStatus = row.executionMode === 'approval' ? 'pending' as const : 'planned' as const;
      await database.batch([
        database.update(runs).set({
          ...recorded(input.thought), status, plannedAt: at, expiresAt, updatedAt: at,
          ...(status === 'completed' || status === 'read_only' ? { finishedAt: at } : {}),
        }).where(eq(runs.id, runId)),
        ...input.writes.map((write) => database.insert(plannedWrites).values({
          id: nextId(),
          runId,
          key: write.key,
          tool: write.tool,
          arguments: JSON.stringify(write.arguments),
          dependsOn: JSON.stringify(write.dependsOn),
          idempotencyKey: `${runId}:${write.key}`,
          status: writeStatus,
          createdAt: at,
          updatedAt: at,
        })),
      ]);
      if (status !== 'applying') return read(runId);
      return apply({ ...row, status });
    },
    close: async (runId, input) => {
      const at = timestamp();
      await database.update(runs).set({ ...recorded(input.thought), status: input.outcome, finishedAt: at, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.status, 'planning'))).run();
    },
    decide: async (input) => {
      const row = await database.select().from(runs).where(eq(runs.id, input.runId)).get();
      if (!row) throw notFound('Run was not found.');
      if (row.status !== 'pending_approval') throw conflict(`Run is already ${row.status}.`);
      const decidedAt = timestamp();
      if (!row.expiresAt || Date.parse(row.expiresAt) <= Date.parse(decidedAt)) {
        await claimDecision(row.id, { status: 'expired', decidedAt, finishedAt: decidedAt, updatedAt: decidedAt });
        await database.update(plannedWrites).set({ status: 'expired', updatedAt: decidedAt }).where(eq(plannedWrites.runId, row.id)).run();
        throw conflict('The approval has expired.');
      }
      if (input.decision === 'reject') {
        await claimDecision(row.id, { status: 'rejected', decidedAt, decidedBy: input.actorIdentityId, finishedAt: decidedAt, updatedAt: decidedAt });
        await database.update(plannedWrites).set({ status: 'rejected', updatedAt: decidedAt }).where(eq(plannedWrites.runId, row.id)).run();
        return read(row.id);
      }
      await claimDecision(row.id, { status: 'applying', decidedAt, decidedBy: input.actorIdentityId, updatedAt: decidedAt });
      return apply(row);
    },
    expireApprovals: async () => {
      const pending = await database.select().from(runs).where(eq(runs.status, 'pending_approval')).all();
      let count = 0;
      for (const row of pending) {
        if (!row.expiresAt || Date.parse(row.expiresAt) > currentTime().getTime()) continue;
        const at = timestamp();
        const claimed = await database.update(runs).set({ status: 'expired', decidedAt: at, finishedAt: at, updatedAt: at })
          .where(and(eq(runs.id, row.id), eq(runs.status, 'pending_approval'))).run();
        if (claimed.meta.changes === 0) continue;
        await database.update(plannedWrites).set({ status: 'expired', updatedAt: at }).where(eq(plannedWrites.runId, row.id)).run();
        count += 1;
      }
      return count;
    },
    abandonStalled: async () => {
      // Only an Automation's Run: an Operator Chat answer waiting for approval stays planning for as long as it waits.
      const planning = await database.select({ id: runs.id, updatedAt: runs.updatedAt }).from(runs)
        .where(and(eq(runs.status, 'planning'), isNotNull(runs.automationId))).all();
      const cutoff = currentTime().getTime() - RUN_PLANNING_MS;
      let count = 0;
      for (const row of planning) {
        const changed = Date.parse(row.updatedAt);
        if (Number.isFinite(changed) && changed > cutoff) continue;
        const at = timestamp();
        const closed = await database.update(runs).set({ status: 'failed', error: STALLED, finishedAt: at, updatedAt: at })
          .where(and(eq(runs.id, row.id), eq(runs.status, 'planning'), eq(runs.updatedAt, row.updatedAt))).run();
        count += closed.meta.changes;
      }
      return count;
    },
    resumeDue: async () => {
      const due = await database.select().from(runs).where(eq(runs.status, 'applying')).orderBy(asc(runs.updatedAt)).all();
      const resumed: Run[] = [];
      for (const row of due) resumed.push(await apply(row));
      return resumed;
    },
    read,
    list: async (input = {}) => views(await database.select().from(runs)
      .where(input.automationId ? eq(runs.automationId, input.automationId) : undefined)
      .orderBy(desc(runs.startedAt)).all()),
  };
};

/**
 * Execution for one Account: the interface every entrance uses. The intake
 * passes the Inbox session it already opened, so the attachments it read are
 * not read again when its writes publish them; every other caller lets the
 * module open the Inbox itself.
 */
export const executionFor = (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  inbox?: InboxSession;
}): Execution => createExecution({
  database: input.database,
  writes: plannedWritesFor(input),
});
