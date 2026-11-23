import { afterEach, describe, expect, it } from 'vitest';

import { claimDueJobs, completeJob, enqueueJob, JOB_LEASE_MS, retryJob } from './jobs';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

const openDatabases: TestD1Database[] = [];

const accountDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  return database;
};

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Durable Jobs', () => {
  it('makes one due Job claimable when the same idempotency key is enqueued twice', async () => {
    const database = accountDatabase();

    await enqueueJob(database.binding, {
      kind: 'calendar_delivery',
      payload: { eventId: 'event-1' },
      idempotencyKey: 'calendar:event-1:recipient-1',
    });
    await enqueueJob(database.binding, {
      kind: 'calendar_delivery',
      payload: { eventId: 'event-1' },
      idempotencyKey: 'calendar:event-1:recipient-1',
    });

    const firstClaim = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');
    const duplicateClaim = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');

    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      kind: 'calendar_delivery',
      idempotencyKey: 'calendar:event-1:recipient-1',
    });
    expect(JSON.parse(firstClaim[0]!.payload)).toEqual({ eventId: 'event-1' });
    expect(duplicateClaim).toEqual([]);
  });

  it('takes over a Job a pass claimed and never finished once its lease is over, counting the pass as an attempt', async () => {
    const database = accountDatabase();
    const claimedAt = '2026-08-02T00:00:00.000Z';
    await enqueueJob(database.binding, { kind: 'reminder', payload: {}, idempotencyKey: 'left-running' });
    const [left] = await claimDueJobs(database.binding, claimedAt);
    const within = new Date(Date.parse(claimedAt) + JOB_LEASE_MS - 1).toISOString();
    const after = new Date(Date.parse(claimedAt) + JOB_LEASE_MS).toISOString();

    // The pass that claimed it may still be running it.
    expect(await claimDueJobs(database.binding, within)).toEqual([]);
    const [taken] = await claimDueJobs(database.binding, after);

    expect(taken).toEqual({ ...left, attempts: 1 });
    expect(database.rows('SELECT state, attempts, last_error, updated_at FROM jobs')).toEqual([{
      state: 'running', attempts: 1, last_error: 'The pass that claimed this Job ended before it finished it.', updated_at: after,
    }]);
    // Taken over, it is held for a lease of its own.
    expect(await claimDueJobs(database.binding, after)).toEqual([]);
  });

  it('fails a Job every pass ended on, as one that failed every attempt fails, and takes over one whose claim names no time', async () => {
    const database = accountDatabase();
    await enqueueJob(database.binding, { kind: 'reminder', payload: {}, idempotencyKey: 'ends-every-pass' });
    await enqueueJob(database.binding, { kind: 'reminder', payload: {}, idempotencyKey: 'undated' });
    database.execute("UPDATE jobs SET state = 'running', attempts = 4, updated_at = '2026-07-01T00:00:00.000Z' WHERE idempotency_key = 'ends-every-pass'");
    database.execute("UPDATE jobs SET state = 'running', updated_at = '' WHERE idempotency_key = 'undated'");

    const taken = await claimDueJobs(database.binding, '2026-08-02T00:00:00.000Z');

    expect(taken.map((job) => job.idempotencyKey)).toEqual(['undated']);
    expect(database.rows("SELECT state, attempts FROM jobs WHERE idempotency_key = 'ends-every-pass'")).toEqual([{ state: 'failed', attempts: 5 }]);
  });

  it('keeps completed work unclaimable and makes retryable work claimable only when due', async () => {
    const database = accountDatabase();
    await enqueueJob(database.binding, { kind: 'calendar_delivery', payload: {}, idempotencyKey: 'completed' });
    const [completed] = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');
    await completeJob(database.binding, completed!.id, '2026-07-25T00:00:00.000Z');

    await enqueueJob(database.binding, { kind: 'calendar_delivery', payload: {}, idempotencyKey: 'retryable' });
    const [retryable] = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');
    const retry = await retryJob(database.binding, retryable!, 'temporary failure', '2026-07-25T00:00:00.000Z');
    if (retry.state !== 'pending') throw new Error('Expected a retryable Job.');

    expect(await claimDueJobs(database.binding, '2026-07-25T00:00:59.999Z')).toEqual([]);
    await expect(claimDueJobs(database.binding, retry.availableAt)).resolves.toHaveLength(1);
    expect((await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z')).map((job) => job.idempotencyKey)).not.toContain('completed');
  });
});
