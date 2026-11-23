import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { createExecution, type RunThought } from '../execution';
import { createAutomationTestApp, seedAutomation, type AutomationTestApp } from '../../test/automation';
import type { TestD1Database } from '../../test/d1';
import { memoryProviders } from '../../test/providers';
import { seedAccountContact, seedAccountRoute } from '../../test/seed';

// A Task a run planned is created in Google Tasks, so the app is built on the in-memory Google.
const providers = memoryProviders();
const app = createApp(providers);

let fixture: AutomationTestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
  providers.google.tasks.held.length = 0;
  providers.google.tasks.writes.length = 0;
});

/** Lets the Account's Automation Inbox reach Google Tasks, as one connected since Tasks moved there does. */
const grantTasks = (database: TestD1Database): void => {
  database.execute("UPDATE google_connections SET granted_scopes = ?", JSON.stringify(['https://www.googleapis.com/auth/tasks']));
};

const TRANSCRIPT_EXPIRES_AT = '2026-08-31T00:00:00.000Z';

const ids = (...values: string[]) => (): string => values.shift() ?? crypto.randomUUID();

const thought = (transcriptKey: string | null): RunThought => ({
  model: 'test-model', skills: [], toolCalls: 1, tokens: 10, output: '会場予約のタスクを作ります。', error: null,
  transcriptKey, transcriptExpiresAt: transcriptKey ? TRANSCRIPT_EXPIRES_AT : null,
});

/**
 * Records one run of the Account's Automation that planned a Task and waits for approval,
 * with its Run Transcript kept where the Automation keeps it.
 */
const pendingRun = async (input: { app: AutomationTestApp; database: TestD1Database; accountId: string; runId: string }): Promise<void> => {
  const execution = createExecution({
    database: input.database.binding,
    writes: { apply: async () => { throw new Error('A run held for approval applies nothing until it is decided.'); } },
    id: ids(input.runId, `${input.runId}-write`),
  });
  const key = `run-transcripts/${input.accountId}/${input.runId}.json`;
  await input.app.r2.bucket.put(key, JSON.stringify({
    runId: input.runId, accountId: input.accountId, automationId: 'automation-1', automationRevision: 1,
    source: null, request: '今日のメールを処理して', messages: [{ role: 'assistant', content: '会場予約のタスクを作ります。' }],
    finalOutput: '会場予約のタスクを作ります。', error: null,
  }));
  const { id } = await execution.open({ trigger: 'schedule', automation: { id: 'automation-1', revision: 1 }, executionMode: 'approval' });
  await execution.freeze(id, {
    writes: [{ key: 'task:0', dependsOn: [], tool: 'tasks.create', arguments: { title: '会場を予約する', notes: '例会の会場を押さえる', due: '2026-08-15' } }],
    thought: thought(key),
  });
};

const runStatus = (database: TestD1Database, runId: string): string | undefined =>
  database.row<{ status: string }>('SELECT status FROM runs WHERE id = ?', runId)?.status;

const decide = (path: string, decision: string, cookie: string | null = 'session-1'): Request => new Request(`https://app.example.com${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `mail_session=${cookie}` } : {}) },
  body: JSON.stringify({ decision }),
});

const read = (path: string, cookie: string | null = 'session-1'): Request => new Request(`https://app.example.com${path}`, {
  headers: cookie ? { Cookie: `mail_session=${cookie}` } : {},
});

/** The fixture's Account, with a second Account of the same owner whose own run is also waiting. */
const twoAccounts = async (): Promise<{ app: AutomationTestApp; other: TestD1Database }> => {
  const created = await createAutomationTestApp();
  const other = created.addAccount({ id: 'organization-2', bindingName: 'ORG_ORGANIZATION2' });
  seedAutomation(other);
  await pendingRun({ app: created, database: created.account, accountId: 'organization-1', runId: 'run-1' });
  await pendingRun({ app: created, database: other, accountId: 'organization-2', runId: 'run-other' });
  return { app: created, other };
};

describe('deciding a run held for approval', () => {
  it('applies the plan the owner approves and records who decided', async () => {
    fixture = await createAutomationTestApp();
    grantTasks(fixture.account);
    await pendingRun({ app: fixture, database: fixture.account, accountId: 'organization-1', runId: 'run-1' });

    const response = await app.fetch(decide('/api/organizations/organization-1/runs/run-1/decision', 'approve'), fixture.environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { id: 'run-1', status: 'completed', writes: [{ tool: 'tasks.create', status: 'succeeded' }] } });
    expect(providers.google.tasks.held).toMatchObject([{ title: '会場を予約する', notes: '例会の会場を押さえる', due: '2026-08-15T00:00:00.000Z', status: 'needsAction' }]);
    expect(fixture.account.row('SELECT decided_by FROM runs WHERE id = ?', 'run-1')).toEqual({ decided_by: 'identity-1' });
  });

  it('rejects a plan without applying it, and refuses a decision that is neither', async () => {
    fixture = await createAutomationTestApp();
    grantTasks(fixture.account);
    await pendingRun({ app: fixture, database: fixture.account, accountId: 'organization-1', runId: 'run-1' });

    const unclear = await app.fetch(decide('/api/organizations/organization-1/runs/run-1/decision', 'maybe'), fixture.environment);
    const rejected = await app.fetch(decide('/api/organizations/organization-1/runs/run-1/decision', 'reject'), fixture.environment);

    expect(unclear.status).toBe(400);
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({ data: { id: 'run-1', status: 'rejected', writes: [{ status: 'rejected' }] } });
    expect(providers.google.tasks.held).toEqual([]);
  });

  it('does not find another Account’s run under this Account, and leaves it waiting', async () => {
    const { app: created, other } = await twoAccounts();
    fixture = created;
    grantTasks(fixture.account);
    grantTasks(other);

    const response = await app.fetch(decide('/api/organizations/organization-1/runs/run-other/decision', 'approve'), fixture.environment);

    expect(response.status).toBe(404);
    expect(runStatus(other, 'run-other')).toBe('pending_approval');
    expect(providers.google.tasks.held).toEqual([]);
  });

  it('refuses someone who does not own the Account, and a browser signed in as nobody', async () => {
    fixture = await createAutomationTestApp();
    grantTasks(fixture.account);
    await pendingRun({ app: fixture, database: fixture.account, accountId: 'organization-1', runId: 'run-1' });
    seedAccountRoute(fixture.control, { id: 'organization-3', bindingName: 'ORG_THREE' });
    seedAccountContact(fixture.control, { accountId: 'organization-3', identityId: 'identity-3', email: 'third@example.com', sessionId: 'session-3' });

    const stranger = await app.fetch(decide('/api/organizations/organization-1/runs/run-1/decision', 'approve', 'session-3'), fixture.environment);
    const signedOut = await app.fetch(decide('/api/organizations/organization-1/runs/run-1/decision', 'approve', null), fixture.environment);

    expect(stranger.status).toBe(403);
    expect(signedOut.status).toBe(401);
    expect(runStatus(fixture.account, 'run-1')).toBe('pending_approval');
    expect(providers.google.tasks.held).toEqual([]);
  });
});

describe('reading a run’s transcript', () => {
  it('returns the Run Transcript kept for the run', async () => {
    fixture = await createAutomationTestApp();
    await pendingRun({ app: fixture, database: fixture.account, accountId: 'organization-1', runId: 'run-1' });

    const response = await app.fetch(read('/api/organizations/organization-1/runs/run-1/transcript'), fixture.environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        runId: 'run-1', source: null, request: '今日のメールを処理して',
        messages: [{ role: 'assistant', content: '会場予約のタスクを作ります。' }], finalOutput: '会場予約のタスクを作ります。', error: null,
      },
    });
  });

  it('says the transcript is gone once its retention has passed', async () => {
    fixture = await createAutomationTestApp();
    await pendingRun({ app: fixture, database: fixture.account, accountId: 'organization-1', runId: 'run-1' });
    fixture.account.execute("UPDATE runs SET transcript_expires_at = '2026-07-31T00:00:00.000Z' WHERE id = 'run-1'");

    const response = await app.fetch(read('/api/organizations/organization-1/runs/run-1/transcript'), fixture.environment);

    expect(response.status).toBe(404);
  });

  it('does not find another Account’s run under this Account', async () => {
    const { app: created } = await twoAccounts();
    fixture = created;

    const response = await app.fetch(read('/api/organizations/organization-1/runs/run-other/transcript'), fixture.environment);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('今日のメールを処理して');
  });

  it('refuses someone who does not own the Account, and a browser signed in as nobody', async () => {
    fixture = await createAutomationTestApp();
    await pendingRun({ app: fixture, database: fixture.account, accountId: 'organization-1', runId: 'run-1' });
    seedAccountRoute(fixture.control, { id: 'organization-3', bindingName: 'ORG_THREE' });
    seedAccountContact(fixture.control, { accountId: 'organization-3', identityId: 'identity-3', email: 'third@example.com', sessionId: 'session-3' });

    const stranger = await app.fetch(read('/api/organizations/organization-1/runs/run-1/transcript', 'session-3'), fixture.environment);
    const signedOut = await app.fetch(read('/api/organizations/organization-1/runs/run-1/transcript', null), fixture.environment);

    expect(stranger.status).toBe(403);
    expect(await stranger.text()).not.toContain('今日のメールを処理して');
    expect(signedOut.status).toBe(401);
  });
});
