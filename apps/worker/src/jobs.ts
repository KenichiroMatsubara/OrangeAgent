import { nextRetry } from '@mail/domain';
import { and, asc, eq, lte } from 'drizzle-orm';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { jobs } from './storage/account-schema';

export interface DurableJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  state: 'pending';
  attempts: number;
  availableAt: string;
  idempotencyKey: string;
  /** False when the same idempotency key was already queued, so the caller counts what it actually added. */
  created: boolean;
}

/**
 * Adds a durable Account Job, due now or at the stated time; a duplicate
 * wake-up cannot duplicate its external effect because the key refuses it.
 */
export const enqueueJob = async (
  database: D1Database,
  input: { kind: string; payload: Record<string, unknown>; idempotencyKey: string; availableAt?: string },
): Promise<DurableJob> => {
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    kind: input.kind,
    payload: input.payload,
    state: 'pending' as const,
    attempts: 0,
    availableAt: input.availableAt ?? now,
    idempotencyKey: input.idempotencyKey,
  };
  const result = await drizzleAccountDatabase(database).insert(jobs).values({
    ...job,
    payload: JSON.stringify(job.payload),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run();
  return { ...job, created: result.meta.changes > 0 };
};

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
  idempotencyKey: string;
}

/**
 * How long a pass holds the Jobs it claimed. No invocation of the Worker runs
 * longer, so a claim older than this was left by a pass that ended before it
 * finished, and the next pass takes it over.
 */
export const JOB_LEASE_MS = 15 * 60_000;

const ABANDONED = 'The pass that claimed this Job ended before it finished it.';

/** How many Jobs one pass claims at most. */
const CLAIM_LIMIT = 50;

const claimColumns = {
  id: jobs.id,
  kind: jobs.kind,
  payload: jobs.payload,
  attempts: jobs.attempts,
  idempotencyKey: jobs.idempotencyKey,
};

/** Whether a claim made at `claimedAt` is over by `dueAt`; a claim that names no time is. */
const leaseOver = (claimedAt: string, dueAt: string): boolean => {
  const at = Date.parse(claimedAt);
  return !Number.isFinite(at) || at + JOB_LEASE_MS <= Date.parse(dueAt);
};

/**
 * Takes over each Job a pass claimed and never finished, once its lease is
 * over, counting that pass as one attempt: a Job every pass ended on fails as
 * one that failed every attempt does, and any other is claimed again now.
 */
const takeOverAbandoned = async (database: D1Database, dueAt: string): Promise<ClaimedJob[]> => {
  const db = drizzleAccountDatabase(database);
  const running = await db.select({ ...claimColumns, updatedAt: jobs.updatedAt }).from(jobs).where(eq(jobs.state, 'running'))
    .orderBy(asc(jobs.updatedAt)).all();
  const taken: ClaimedJob[] = [];
  for (const { updatedAt, ...row } of running.filter((job) => leaseOver(job.updatedAt, dueAt))) {
    if (taken.length >= CLAIM_LIMIT) break;
    const attempts = row.attempts + 1;
    const terminal = 'terminal' in nextRetry({ attempts, now: dueAt });
    // Taken only from the claim that was read, so two passes never both take the same Job.
    const result = await db.update(jobs).set({ ...(terminal ? { state: 'failed' as const } : {}), attempts, lastError: ABANDONED, updatedAt: dueAt })
      .where(and(eq(jobs.id, row.id), eq(jobs.state, 'running'), eq(jobs.updatedAt, updatedAt))).run();
    if (!terminal && result.meta.changes > 0) taken.push({ ...row, attempts });
  }
  return taken;
};

/** Claims the Jobs due by `dueAt`, the abandoned ones a pass left first, each held by this pass for JOB_LEASE_MS. */
export const claimDueJobs = async (database: D1Database, dueAt: string): Promise<ClaimedJob[]> => {
  const db = drizzleAccountDatabase(database);
  const claimed = await takeOverAbandoned(database, dueAt);
  if (claimed.length >= CLAIM_LIMIT) return claimed;
  const rows = await db.select(claimColumns).from(jobs).where(and(eq(jobs.state, 'pending'), lte(jobs.availableAt, dueAt)))
    .orderBy(asc(jobs.availableAt)).limit(CLAIM_LIMIT - claimed.length).all();
  for (const row of rows) {
    const result = await db.update(jobs).set({ state: 'running', updatedAt: dueAt })
      .where(and(eq(jobs.id, row.id), eq(jobs.state, 'pending'))).run();
    if (result.meta.changes > 0) claimed.push(row);
  }
  return claimed;
};

/** Finalizes a claimed Job once its idempotent external effect has succeeded. */
export const completeJob = async (database: D1Database, id: string, completedAt: string): Promise<void> => {
  await drizzleAccountDatabase(database).update(jobs).set({ state: 'succeeded', updatedAt: completedAt })
    .where(and(eq(jobs.id, id), eq(jobs.state, 'running'))).run();
};

export type JobRetryResult = { state: 'pending'; attempts: number; availableAt: string } | { state: 'failed'; attempts: number };

/** Returns a failed claim to the durable queue or records its bounded terminal failure. */
export const retryJob = async (
  database: D1Database,
  job: Pick<ClaimedJob, 'id' | 'attempts'>,
  error: string,
  failedAt: string,
): Promise<JobRetryResult> => {
  const attempts = job.attempts + 1;
  const retry = nextRetry({ attempts, now: failedAt });
  if ('terminal' in retry) {
    await drizzleAccountDatabase(database).update(jobs).set({ state: 'failed', attempts, lastError: error, updatedAt: failedAt })
      .where(and(eq(jobs.id, job.id), eq(jobs.state, 'running'))).run();
    return { state: 'failed', attempts };
  }
  await drizzleAccountDatabase(database).update(jobs).set({ state: 'pending', attempts, availableAt: retry.retryAt, lastError: error, updatedAt: failedAt })
    .where(and(eq(jobs.id, job.id), eq(jobs.state, 'running'))).run();
  return { state: 'pending', attempts, availableAt: retry.retryAt };
};
