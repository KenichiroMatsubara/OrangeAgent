import { afterEach, describe, expect, it } from 'vitest';

import { runDueAutomations } from './timed';
import type { ModelCompletion } from './turns';
import { createAutomationTestApp, type AutomationTestApp } from '../test/automation';
import { memoryProviders, type MemoryProviders } from '../test/providers';
import { seedContact } from '../test/seed';

let fixture: AutomationTestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

// TEST_NOW is 09:00 on Saturday 1 August in Tokyo.
const AT = new Date('2026-08-01T00:00:00.000Z');

const usage = { promptTokens: 5, cachedTokens: 0, completionTokens: 0 };

const call = (name: string, args: Record<string, unknown>): ModelCompletion => ({
  model: 'test-model', content: '', usage, toolCalls: [{ id: `${name}-${crypto.randomUUID()}`, name, arguments: JSON.stringify(args) }],
});

const answer = (content: string): ModelCompletion => ({ model: 'test-model', content, toolCalls: [], usage });

/**
 * Gives the Account one more Automation, daily at 09:00, granted the given
 * tools, beside one LINE Contact its Skill may tell.
 */
const seedTimedAutomation = (overrides: { enabled?: boolean; nextRunAt?: string; window?: string; executionMode?: string; tools?: string[] } = {}): void => {
  const account = fixture!.account;
  const tools = overrides.tools ?? ['query_attendance', 'channel.send'];
  seedContact(account, { id: 'contact-1', name: '田中', email: 'tanaka@example.com', lineDestinationId: 'line-user-1' });
  account.execute(
    `INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at)
     VALUES ('reminding', 'organization-1', 'リマインド', '', '未回答の Contact にリマインドしてください。', 1, '2026-07-25', '2026-07-25')`,
  );
  account.execute("INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES ('reminding', 1, '未回答の Contact にリマインドしてください。', '2026-07-25')");
  account.execute(
    `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, schedule, next_run_at, created_at, updated_at)
     VALUES ('timed', 'organization-1', '朝の確認', 'schedule', ?, ?, ?, 1, 'daily 09:00', ?, '2026-07-25', '2026-07-25')`,
    overrides.enabled === false ? 0 : 1,
    overrides.executionMode ?? 'unattended',
    overrides.window ?? 'day',
    overrides.nextRunAt ?? AT.toISOString(),
  );
  account.execute("INSERT INTO automation_skills (automation_id, skill_id, position) VALUES ('timed', 'reminding', 0)");
  for (const tool of tools) account.execute("INSERT INTO automation_tools (automation_id, tool) VALUES ('timed', ?)", tool);
  account.execute(
    `INSERT INTO automation_revisions (automation_id, revision, skill_ids, tools, execution_mode, suppression_window, created_at)
     VALUES ('timed', 1, '["reminding"]', ?, ?, ?, '2026-07-25')`,
    JSON.stringify(tools),
    overrides.executionMode ?? 'unattended',
    overrides.window ?? 'day',
  );
};

const providersAnswering = (...turns: ModelCompletion[]): MemoryProviders => {
  const providers = memoryProviders();
  providers.ai.turns = turns;
  return providers;
};

const lineSends = (providers: MemoryProviders) => providers.transport.sends.filter(({ url }) => url.includes('api.line.me'));

const runs = () => fixture!.account.rows<{ trigger: string; automation_id: string; source_message_id: string | null; status: string; output: string | null; error: string | null }>(
  'SELECT trigger, automation_id, source_message_id, status, output, error FROM runs ORDER BY started_at',
);

describe('a Trigger Time', () => {
  it('runs an active Automation whose time has arrived, asking it to find its own work', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation();
    const providers = providersAnswering(answer('未回答はいませんでした。'));

    await expect(runDueAutomations(fixture.environment, AT, providers)).resolves.toMatchObject([{ status: 'completed', output: '未回答はいませんでした。' }]);

    const request = providers.ai.requests[0]?.messages.find(({ role }) => role === 'user')?.content ?? '';
    expect(request).toMatch(/^Run now\. It is 2026-08-01T00:00:00\.000Z/u);
    expect(request).toContain('This Automation has not run before.');
    expect(providers.ai.requests[0]?.messages[0]?.content).toContain('未回答の Contact にリマインドしてください。');
    expect(providers.ai.requests[0]?.messages[0]?.content).toContain('- contact-1: 田中');
    expect(runs()).toEqual([{ trigger: 'schedule', automation_id: 'timed', source_message_id: null, status: 'completed', output: '未回答はいませんでした。', error: null }]);
  });

  it('moves the Automation to its next time before it runs, so it is not picked up twice', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation();
    const providers = providersAnswering(answer('済みました。'));

    await runDueAutomations(fixture.environment, AT, providers);
    await runDueAutomations(fixture.environment, AT, providers);

    expect(fixture.account.row('SELECT next_run_at FROM automations WHERE id = ?', 'timed')).toEqual({ next_run_at: '2026-08-02T00:00:00.000Z' });
    expect(runs()).toHaveLength(1);
  });

  it('tells the next run when the last one began, so its Skill can ask for the mail since', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation();
    const providers = providersAnswering(answer('済みました。'), answer('済みました。'));
    const tomorrow = new Date('2026-08-02T00:00:00.000Z');

    await runDueAutomations(fixture.environment, AT, providers);
    await runDueAutomations(fixture.environment, tomorrow, providers);

    const request = providers.ai.requests[1]?.messages.find(({ role }) => role === 'user')?.content ?? '';
    expect(request).toContain(`This Automation last ran at ${AT.toISOString()}`);
    expect(request).toContain(`after:${AT.getTime() / 1_000}`);
  });

  it('leaves an Automation that is off, or whose time has not arrived, alone', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation({ enabled: false });
    const providers = providersAnswering(answer('済みました。'));

    await expect(runDueAutomations(fixture.environment, AT, providers)).resolves.toEqual([]);
    fixture.account.execute("UPDATE automations SET enabled = 1, next_run_at = '2026-08-02T00:00:00.000Z' WHERE id = 'timed'");
    await expect(runDueAutomations(fixture.environment, AT, providers)).resolves.toEqual([]);
    expect(providers.ai.requests).toEqual([]);
  });

  it('fails at the next tick an Automation\'s Run that a tick left planning, whose pass ended while its model thought', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation({ enabled: false });
    fixture.account.execute(
      `INSERT INTO runs (id, trigger, automation_id, automation_revision, execution_mode, status, started_at, updated_at)
       VALUES ('run-left', 'schedule', 'timed', 1, 'unattended', 'planning', '2026-07-31T23:30:00.000Z', '2026-07-31T23:30:00.000Z')`,
    );

    await runDueAutomations(fixture.environment, AT, providersAnswering());

    expect(fixture.account.rows("SELECT status, finished_at FROM runs WHERE id = 'run-left'")).toEqual([{ status: 'failed', finished_at: AT.toISOString() }]);
  });

  it('plans a send to the Contact its Skill names and applies it now', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedTimedAutomation();
    const providers = providersAnswering(call('channel.send', { contactId: 'contact-1', channel: 'line', text: '明日9時です' }), answer('送りました。'));

    await runDueAutomations(fixture.environment, AT, providers);

    expect(lineSends(providers)).toMatchObject([{ body: { to: 'line-user-1', messages: [{ type: 'text', text: '明日9時です' }] } }]);
    expect(fixture.account.rows('SELECT tool, status FROM planned_writes')).toEqual([{ tool: 'channel.send', status: 'succeeded' }]);
  });

  it('holds its sends for approval when it runs by approval', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedTimedAutomation({ executionMode: 'approval' });
    const providers = providersAnswering(call('channel.send', { contactId: 'contact-1', channel: 'line', text: '明日9時です' }), answer('提案します。'));

    await expect(runDueAutomations(fixture.environment, AT, providers)).resolves.toMatchObject([{ status: 'held' }]);

    expect(lineSends(providers)).toEqual([]);
    expect(fixture.account.rows('SELECT status FROM runs')).toEqual([{ status: 'pending_approval' }]);
  });

  it('creates a Task in Google Tasks once, and is told a repeat the same day is suppressed', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute('UPDATE google_connections SET granted_scopes = ?', JSON.stringify(['https://www.googleapis.com/auth/tasks']));
    seedTimedAutomation({ tools: ['tasks.search', 'tasks.create'] });
    const createTask = call('tasks.create', { title: '会費を払う', due: '2026-08-31', notes: '口座へ振り込む' });
    const providers = providersAnswering(createTask, answer('登録しました。'));

    await runDueAutomations(fixture.environment, AT, providers);
    providers.ai.turns = [createTask, answer('登録済みでした。')];
    fixture.account.execute("UPDATE automations SET next_run_at = ? WHERE id = 'timed'", AT.toISOString());
    await runDueAutomations(fixture.environment, AT, providers);

    const own = providers.google.tasks.lists.find((list) => list.title === 'FlareChat');
    expect(providers.google.tasks.held.map(({ listId, title, notes, due }) => ({ listId, title, notes, due })))
      .toEqual([{ listId: own?.id, title: '会費を払う', notes: '口座へ振り込む', due: '2026-08-31T00:00:00.000Z' }]);
    expect(providers.ai.requests.at(-1)?.messages.at(-1)?.content).toContain('suppressed');
    // FlareChat keeps no copy of a Task.
    expect(fixture.account.rows('SELECT id FROM tasks')).toEqual([]);
  });

  it('copies the Tasks the Account kept in FlareChat into Google Tasks once its grant reaches them, with no Automation due, and leaves them until then', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_subject, title, deadline, assignee_name, description, created_at, updated_at)
       VALUES ('task-1', 'organization-1', '', '会費を払う', '2026-08-31', '田中', '', '2026-07-25', '2026-07-25')`,
    );
    const providers = memoryProviders();

    await runDueAutomations(fixture.environment, AT, providers);
    expect(providers.google.tasks.held).toEqual([]);
    expect(fixture.account.row('SELECT google_task_id FROM tasks')).toEqual({ google_task_id: null });

    fixture.account.execute('UPDATE google_connections SET granted_scopes = ?', JSON.stringify(['https://www.googleapis.com/auth/tasks']));
    await runDueAutomations(fixture.environment, AT, providers);
    await runDueAutomations(fixture.environment, AT, providers);

    expect(providers.google.tasks.held.map(({ title, notes, due }) => ({ title, notes, due })))
      .toEqual([{ title: '会費を払う', notes: '担当: 田中', due: '2026-08-31T00:00:00.000Z' }]);
    expect(fixture.account.row('SELECT google_task_id FROM tasks')).toEqual({ google_task_id: providers.google.tasks.held[0]?.id });
  });

  it('fails a send to a Contact the Account does not hold when it is applied, sending nothing', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedTimedAutomation();
    const providers = providersAnswering(call('channel.send', { contactId: 'contact-9', channel: 'line', text: 'hi' }), answer('送りました。'));

    await expect(runDueAutomations(fixture.environment, AT, providers)).resolves.toMatchObject([{ status: 'failed' }]);
    expect(lineSends(providers)).toEqual([]);
  });

  it('records a failed run rather than leaving it running forever', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation();
    const providers = providersAnswering();
    providers.ai.turns = [new Error('model unavailable')];

    await expect(runDueAutomations(fixture.environment, AT, providers)).resolves.toMatchObject([{ status: 'failed' }]);
    expect(runs()).toMatchObject([{ status: 'failed', error: 'model unavailable' }]);
  });

  it('records a failed run when the Account has no AI Connection to think through', async () => {
    fixture = await createAutomationTestApp();
    seedTimedAutomation();
    const providers = providersAnswering(answer('済みました。'));

    await runDueAutomations(fixture.environment, AT, providers);

    expect(runs()).toMatchObject([{ status: 'failed', error: 'This Automation needs an active AI Connection.' }]);
    expect(providers.ai.requests).toEqual([]);
  });

  it('goes on however many tools a run calls', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedTimedAutomation();
    const providers = providersAnswering({
      model: 'test-model', content: '', usage,
      toolCalls: Array.from({ length: 500 }, (_, index) => ({ id: `call-${index}`, name: 'query_attendance', arguments: '{}' })),
    }, { model: 'test-model', content: 'done', usage, toolCalls: [] });

    await runDueAutomations(fixture.environment, AT, providers);

    expect(runs()).toMatchObject([{ status: 'completed', error: null }]);
  });
});
