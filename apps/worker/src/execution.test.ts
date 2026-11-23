import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExecution, type Execution, type PlannedWriteInput, type RunThought } from './execution';
import { TemporaryFailure } from './temporary';
import { plannedWritesFor, type PlannedWriteRun } from './writes';
import { createTestApp, type TestApp } from '../test/app';
import { createAutomationTestApp, seedAutomation } from '../test/automation';
import { memoryProviders, type MemoryProviders } from '../test/providers';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const lineWrite = (key: string, dependsOn: string[] = []): PlannedWriteInput => ({
  key, dependsOn, tool: 'channel.send', arguments: { channel: 'line', destination: 'line-user-1', text: key },
});

const thought: RunThought = { model: 'test-model', skills: [], toolCalls: 1, tokens: 10, output: 'Done.', error: null, transcriptKey: null, transcriptExpiresAt: null };

const seed = (): void => {
  seedAutomation(fixture!.account);
};

const ids = (...values: string[]) => () => values.shift() ?? 'unexpected-id';

const timedRun = { trigger: 'schedule' as const, automation: { id: 'automation-1', revision: 1 } };

const lineAccepted = (requestId: string): Response => new Response('{}', { status: 200, headers: { 'x-line-request-id': requestId } });

/** An Account with a LINE Connection whose writes the production writer applies, against the provider twins, on a clock the test moves. */
interface WriterApp {
  providers: MemoryProviders;
  clock: Date;
  execution(): Execution;
  /** Makes LINE answer each push with the next of these responses, then accept every push after them. */
  answerLine(...responses: Response[]): void;
  /** Each LINE push, in order: the text it carried and the retry key it named. */
  pushed(): Array<{ text: string; retryKey: string | null }>;
  nextAttemptAt(key: string): string | null;
}

const writerApp = async (): Promise<WriterApp> => {
  const app = await createAutomationTestApp({ lineSecret: 'line-secret' });
  fixture = app;
  const providers = memoryProviders();
  const writer: WriterApp = {
    providers,
    clock: new Date('2026-08-06T02:00:00.000Z'),
    execution: () => createExecution({
      database: app.account.binding,
      writes: plannedWritesFor({ env: app.environment, database: app.account.binding, accountId: 'organization-1', providers }),
      now: () => writer.clock,
    }),
    answerLine: (...responses) => {
      providers.transport.answers.push({ match: 'api.line.me', respond: () => responses.shift() ?? lineAccepted('line-request-later') });
    },
    pushed: () => providers.transport.sends.filter(({ url }) => url.includes('api.line.me')).map(({ headers, body }) => ({
      text: (body as { messages: Array<{ text: string }> }).messages[0]?.text ?? '',
      retryKey: headers['x-line-retry-key'] ?? null,
    })),
    nextAttemptAt: (key) => app.account.row<{ next_attempt_at: string | null }>('SELECT next_attempt_at FROM planned_writes WHERE key = ?', key)?.next_attempt_at ?? null,
  };
  return writer;
};

describe('Execution', () => {
  it('opens a run, then freezes and applies an unattended plan', async () => {
    fixture = createTestApp();
    seed();
    const apply = vi.fn().mockResolvedValue({ externalId: 'line-1' });
    const execution = createExecution({
      database: fixture.account.binding,
      writes: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: ids('run-1', 'write-1'),
    });

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    const run = await execution.freeze(id, { writes: [lineWrite('line:0')], thought });

    expect(run).toMatchObject({
      id: 'run-1',
      trigger: 'schedule',
      automation: { id: 'automation-1', name: '毎朝のメール処理', revision: 1 },
      sourceMessage: null,
      executionMode: 'unattended',
      status: 'completed',
      model: 'test-model',
      output: 'Done.',
      writes: [{ id: 'write-1', key: 'line:0', tool: 'channel.send', status: 'succeeded', result: { externalId: 'line-1' } }],
    });
    expect(apply.mock.calls[0]?.[0]).toEqual({ id: 'run-1', writeId: 'write-1', automationId: 'automation-1', automationRevision: 1, sourceMessageId: null } satisfies PlannedWriteRun);
    expect(apply.mock.calls[0]?.[1]).toMatchObject({ tool: 'channel.send', arguments: { channel: 'line', destination: 'line-user-1', text: 'line:0' } });
  });

  it('completes a run that planned nothing without applying anything', async () => {
    fixture = createTestApp();
    seed();
    const apply = vi.fn();
    const execution = createExecution({ database: fixture.account.binding, writes: { apply } });

    const { id } = await execution.open({ ...timedRun, executionMode: 'approval' });

    await expect(execution.freeze(id, { writes: [], thought })).resolves.toMatchObject({ status: 'completed', writes: [] });
    expect(apply).not.toHaveBeenCalled();
  });

  it('retains a read-only plan without applying any write', async () => {
    fixture = createTestApp();
    seed();
    const apply = vi.fn();
    const execution = createExecution({ database: fixture.account.binding, writes: { apply } });

    const { id } = await execution.open({ ...timedRun, executionMode: 'read_only' });

    await expect(execution.freeze(id, { writes: [lineWrite('line:0')], thought }))
      .resolves.toMatchObject({ status: 'read_only', writes: [{ status: 'planned', attempts: 0 }] });
    expect(apply).not.toHaveBeenCalled();
  });

  it('holds one approval batch for seven days and applies it without replanning', async () => {
    fixture = createTestApp();
    seed();
    const apply = vi.fn().mockResolvedValue({ ok: true });
    const execution = createExecution({
      database: fixture.account.binding,
      writes: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: ids('run-approval', 'write-0', 'write-1'),
    });

    const { id } = await execution.open({ ...timedRun, executionMode: 'approval' });
    const pending = await execution.freeze(id, { writes: [lineWrite('line:0'), lineWrite('line:1')], thought });

    expect(pending).toMatchObject({ status: 'pending_approval', expiresAt: '2026-08-13T02:00:00.000Z', writes: [{ status: 'pending' }, { status: 'pending' }] });
    expect(apply).not.toHaveBeenCalled();

    const approved = await execution.decide({ runId: 'run-approval', decision: 'approve', actorIdentityId: 'identity-1' });

    expect(approved).toMatchObject({ status: 'completed', writes: [{ status: 'succeeded' }, { status: 'succeeded' }] });
    expect(apply).toHaveBeenCalledTimes(2);
    await expect(execution.decide({ runId: 'run-approval', decision: 'reject', actorIdentityId: 'identity-2' }))
      .rejects.toThrow('Run is already completed.');
  });

  it('expires an approval nobody decided within seven days', async () => {
    fixture = createTestApp();
    seed();
    let now = new Date('2026-08-06T02:00:00.000Z');
    const execution = createExecution({ database: fixture.account.binding, writes: { apply: vi.fn() }, now: () => now });

    const { id } = await execution.open({ ...timedRun, executionMode: 'approval' });
    await execution.freeze(id, { writes: [lineWrite('line:0')], thought });
    now = new Date('2026-08-13T02:00:00.000Z');

    await expect(execution.expireApprovals()).resolves.toBe(1);
    await expect(execution.read(id)).resolves.toMatchObject({ status: 'expired', writes: [{ status: 'expired' }] });
  });

  it('fails an Automation\'s Run its pass left planning once no pass can still be thinking it, and no Run of Operator Chat', async () => {
    fixture = createTestApp();
    seed();
    let now = new Date('2026-08-06T02:00:00.000Z');
    const execution = createExecution({ database: fixture.account.binding, writes: { apply: vi.fn() }, now: () => now, id: ids('run-left', 'run-chat', 'run-new') });
    await execution.open({ ...timedRun, executionMode: 'unattended' });
    // An answer waiting for approval keeps its Run planning for as long as it waits (CONTEXT.md, Operator Chat).
    await execution.open({ trigger: 'chat', automation: null, executionMode: 'unattended' });
    now = new Date('2026-08-06T02:14:59.999Z');
    await expect(execution.abandonStalled()).resolves.toBe(0);
    await execution.open({ ...timedRun, executionMode: 'unattended' });

    now = new Date('2026-08-06T02:15:00.000Z');
    await expect(execution.abandonStalled()).resolves.toBe(1);

    await expect(execution.read('run-left')).resolves.toMatchObject({
      status: 'failed', error: 'This run stopped before it finished thinking, so it planned nothing. The Automation runs again at its next Trigger Time.',
      finishedAt: '2026-08-06T02:15:00.000Z',
    });
    await expect(execution.read('run-chat')).resolves.toMatchObject({ status: 'planning' });
    await expect(execution.read('run-new')).resolves.toMatchObject({ status: 'planning' });
  });

  it('resumes a LINE push LINE could not take, delivering it once under one retry key, without resending independent writes', async () => {
    const app = await writerApp();
    app.answerLine(new Response('', { status: 503 }));
    const execution = app.execution();

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    const waiting = await execution.freeze(id, { writes: [lineWrite('first'), lineWrite('second', ['first']), lineWrite('third')], thought });

    expect(waiting).toMatchObject({ status: 'applying', writes: [{ status: 'transient_failed', attempts: 1 }, { status: 'blocked' }, { status: 'succeeded' }] });
    expect(app.nextAttemptAt('first')).toBe('2026-08-06T02:01:00.000Z');
    expect(app.pushed().map(({ text }) => text)).toEqual(['first', 'third']);

    app.clock = new Date('2026-08-06T02:30:00.000Z');
    const [completed] = await execution.resumeDue();

    expect(completed).toMatchObject({ status: 'completed', writes: [{ status: 'succeeded', attempts: 2 }, { status: 'succeeded' }, { status: 'succeeded', attempts: 1 }] });
    const pushes = app.pushed();
    expect(pushes.map(({ text }) => text)).toEqual(['first', 'third', 'first', 'second']);
    expect(pushes[0]?.retryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(pushes[2]?.retryKey).toBe(pushes[0]?.retryKey);
    expect(new Set(pushes.map(({ retryKey }) => retryKey)).size).toBe(3);
  });

  it('counts a repeat LINE answers as already accepted as the delivery it was', async () => {
    const app = await writerApp();
    app.answerLine(
      new Response('', { status: 504 }),
      new Response(JSON.stringify({ message: 'The retry key is already accepted' }), { status: 409, headers: { 'x-line-accepted-request-id': 'line-request-1' } }),
    );
    const execution = app.execution();

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    await execution.freeze(id, { writes: [lineWrite('line:0')], thought });
    app.clock = new Date('2026-08-06T02:30:00.000Z');

    await expect(execution.resumeDue()).resolves.toMatchObject([{ status: 'completed', writes: [{ status: 'succeeded', attempts: 2 }] }]);
    expect(app.pushed()).toHaveLength(2);
    expect(fixture!.account.rows('SELECT outcome, external_id FROM deliveries ORDER BY created_at, outcome'))
      .toEqual([{ outcome: 'failed', external_id: null }, { outcome: 'succeeded', external_id: 'line-request-1' }]);
  });

  it('fails a LINE push LINE refuses for good without trying it again', async () => {
    const app = await writerApp();
    app.answerLine(new Response(JSON.stringify({ message: 'The request body has 1 error(s)' }), { status: 400 }));
    const execution = app.execution();

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    const failed = await execution.freeze(id, { writes: [lineWrite('line:0')], thought });

    expect(failed).toMatchObject({ status: 'failed', writes: [{ status: 'permanent_failed', attempts: 1, error: 'LINE refused the message.' }] });
    app.clock = new Date('2026-08-06T03:00:00.000Z');
    await execution.resumeDue();
    expect(app.pushed()).toHaveLength(1);
  });

  it('waits as long as a 429 Retry-After asks before trying a write again', async () => {
    const app = await writerApp();
    app.answerLine(new Response('', { status: 429, headers: { 'Retry-After': '600' } }));
    const execution = app.execution();

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    await execution.freeze(id, { writes: [lineWrite('line:0')], thought });

    expect(app.nextAttemptAt('line:0')).toBe('2026-08-06T02:10:00.000Z');
    app.clock = new Date('2026-08-06T02:05:00.000Z');
    await expect(execution.resumeDue()).resolves.toMatchObject([{ status: 'applying', writes: [{ status: 'transient_failed', attempts: 1 }] }]);
    expect(app.pushed()).toHaveLength(1);

    app.clock = new Date('2026-08-06T02:10:00.000Z');
    await expect(execution.resumeDue()).resolves.toMatchObject([{ status: 'completed', writes: [{ status: 'succeeded', attempts: 2 }] }]);
  });

  it('gives a write up for good after five temporary failures', async () => {
    const app = await writerApp();
    app.providers.transport.answers.push({ match: 'api.line.me', respond: () => { throw new TypeError('Network connection lost.'); } });
    const execution = app.execution();

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    await execution.freeze(id, { writes: [lineWrite('line:0')], thought });
    const retries: Array<string | null> = [];
    for (let hour = 1; hour <= 3; hour += 1) {
      retries.push(app.nextAttemptAt('line:0'));
      app.clock = new Date(Date.parse('2026-08-06T02:00:00.000Z') + hour * 3_600_000);
      await expect(execution.resumeDue()).resolves.toMatchObject([{ status: 'applying', writes: [{ status: 'transient_failed', attempts: hour + 1 }] }]);
    }
    retries.push(app.nextAttemptAt('line:0'));
    app.clock = new Date('2026-08-06T06:00:00.000Z');
    const [given] = await execution.resumeDue();

    // One, two, four, then eight minutes after each failure.
    expect(retries).toEqual(['2026-08-06T02:01:00.000Z', '2026-08-06T03:02:00.000Z', '2026-08-06T04:04:00.000Z', '2026-08-06T05:08:00.000Z']);
    expect(given).toMatchObject({ status: 'failed', writes: [{ status: 'permanent_failed', attempts: 5 }] });
    expect(given?.writes[0]?.error).toBe('LINE did not answer: Network connection lost. It failed 5 times and is not tried again.');
    expect(app.nextAttemptAt('line:0')).toBeNull();
    await execution.resumeDue();
    expect(app.pushed()).toHaveLength(5);
  });

  it('creates a Scheduled Event once when Google created it but its answer was lost', async () => {
    const app = await writerApp();
    const create = app.providers.google.calendar.createEvent;
    let answers = 0;
    app.providers.google.calendar.createEvent = async (token, body) => {
      const created = await create(token, body);
      answers += 1;
      if (answers === 1) throw new TemporaryFailure('Google did not answer: Network connection lost.', null, null, 'unknown');
      return created;
    };
    const execution = app.execution();
    const write: PlannedWriteInput = {
      key: 'create_scheduled_event:0', dependsOn: [], tool: 'create_scheduled_event',
      arguments: { title: '例会', startsAt: '2026-08-20T19:00:00+09:00', endsAt: '2026-08-20T21:00:00+09:00' },
    };

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });
    await expect(execution.freeze(id, { writes: [write], thought })).resolves.toMatchObject({ writes: [{ status: 'transient_failed' }] });
    app.clock = new Date('2026-08-06T02:30:00.000Z');
    const [completed] = await execution.resumeDue();

    expect(completed).toMatchObject({ status: 'completed', writes: [{ status: 'succeeded', attempts: 2 }] });
    expect(app.providers.google.events.size).toBe(1);
    const [googleEventId] = [...app.providers.google.events.keys()];
    expect(googleEventId).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture!.account.rows('SELECT google_event_id FROM events')).toEqual([{ google_event_id: googleEventId }]);
    expect(completed?.writes[0]?.result).toMatchObject({ created: true, googleEventId });
  });

  it('never sends a mail again when Gmail may have sent it, but tries again one Gmail refused for now', async () => {
    const app = await writerApp();
    const mail = (key: string): PlannedWriteInput => ({ key, dependsOn: [], tool: 'mail.send', arguments: { to: 'office@example.com', subject: key, body: '本文' } });
    const execution = app.execution();
    app.providers.google.failNext('sendMail', new TemporaryFailure('Google did not answer: Network connection lost.', null, null, 'unknown'));

    const lost = await execution.open({ ...timedRun, executionMode: 'unattended' });
    await expect(execution.freeze(lost.id, { writes: [mail('lost')], thought })).resolves.toMatchObject({
      status: 'failed',
      writes: [{ status: 'permanent_failed', error: 'Google did not answer: Network connection lost. mail.send may already have been made, so it is not made again.' }],
    });

    app.providers.google.failNext('sendMail', new TemporaryFailure('Google could not take the request now (HTTP 429).', 429, 30, 'no'));
    const throttled = await execution.open({ ...timedRun, executionMode: 'unattended' });
    await expect(execution.freeze(throttled.id, { writes: [mail('throttled')], thought })).resolves.toMatchObject({ writes: [{ status: 'transient_failed' }] });
    expect(app.nextAttemptAt('throttled')).toBe('2026-08-06T02:00:30.000Z');
    app.clock = new Date('2026-08-06T02:30:00.000Z');
    await execution.resumeDue();

    expect(app.providers.google.mailbox.sent.map(({ subject }) => subject)).toEqual(['throttled']);
  });

  it('fails a run whose write fails for good', async () => {
    fixture = createTestApp();
    seed();
    const execution = createExecution({ database: fixture.account.binding, writes: { apply: vi.fn().mockRejectedValue(new Error('LINE refused the message.')) } });

    const { id } = await execution.open({ ...timedRun, executionMode: 'unattended' });

    await expect(execution.freeze(id, { writes: [lineWrite('line:0')], thought }))
      .resolves.toMatchObject({ status: 'failed', writes: [{ status: 'permanent_failed', error: 'LINE refused the message.' }] });
  });

  it('records one Operator Chat exchange as one Run that the exchange closes', async () => {
    fixture = createTestApp();
    const execution = createExecution({ database: fixture.account.binding, writes: { apply: vi.fn() }, id: () => 'chat-run' });

    await expect(execution.open({ trigger: 'chat', automation: null, executionMode: 'unattended' })).resolves.toEqual({ id: 'chat-run' });
    expect(fixture.account.row("SELECT status, trigger FROM runs WHERE id = 'chat-run'")).toEqual({ status: 'planning', trigger: 'chat' });

    await execution.close('chat-run', { outcome: 'completed', thought });
    await expect(execution.read('chat-run')).resolves.toMatchObject({ status: 'completed', automation: null, model: 'test-model', toolCalls: 1 });
  });

  it('lists the runs of one Automation, newest first', async () => {
    fixture = createTestApp();
    seed();
    let now = new Date('2026-08-06T02:00:00.000Z');
    const execution = createExecution({ database: fixture.account.binding, writes: { apply: vi.fn() }, now: () => now });
    const first = await execution.open({ ...timedRun, executionMode: 'unattended' });
    now = new Date('2026-08-06T03:00:00.000Z');
    const chat = await execution.open({ trigger: 'chat', automation: null, executionMode: 'unattended' });

    await expect(execution.list({ automationId: 'automation-1' })).resolves.toMatchObject([{ id: first.id }]);
    await expect(execution.list()).resolves.toMatchObject([{ id: chat.id }, { id: first.id }]);
  });
});
