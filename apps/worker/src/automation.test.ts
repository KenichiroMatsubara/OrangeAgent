import { afterEach, describe, expect, it } from 'vitest';

import { AUTOMATION_TOOLS } from '@mail/domain';

import { planAutomation, readRunTranscript, type AccountThinking, type RunnableAutomation, type TriggerWork } from './automation';
import { encrypt, masterKey } from './cryptography';
import { accountFacts, RECORDS_FACTS, timedRequest } from './facts';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { suppressionKey } from './suppression';
import type { ModelCompletion, ModelPort, ModelRequest, TurnToolCall } from './turns';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2 } from '../test/seed';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const CREATED_AT = '2026-08-01T00:00:00.000Z';
const usage = { promptTokens: 1, cachedTokens: 0, completionTokens: 0 };
const connection = { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model', models: ['test-model', 'test-large'] };
const account = { name: 'さくら会', inboxAddress: 'sakura.club@example.com', contacts: [] };
const work: TriggerWork = {
  request: timedRequest({ at: new Date('2026-08-02T20:00:00.000Z'), previous: '2026-08-01T20:00:00.000Z' }),
  facts: `${accountFacts(account)}\n\n${RECORDS_FACTS}`,
};

/** An Account with its mailbox connected, two Skills, and two Contacts. */
const accountDatabase = (): TestD1Database => {
  const opened = createMigratedTestD1('organization');
  opened.execute("INSERT INTO google_connections (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at) VALUES ('inbox-1', 'automation_inbox', 'google-subject-1', 'sakura.club@example.com', '[]', '{}', 'history-1', 1, 'active', ?, ?)", CREATED_AT, CREATED_AT);
  opened.execute("INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at) VALUES ('skill-1', 'organization-1', 'メールの取り込み', 'Reading mail.', 'Manage explicit work.', 3, ?, ?)", CREATED_AT, CREATED_AT);
  opened.execute("INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at) VALUES ('skill-2', 'organization-1', '会計', 'When fees are asked for.', 'Fees.', 1, ?, ?)", CREATED_AT, CREATED_AT);
  opened.execute("INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES ('skill-1', 3, 'Manage explicit work.', ?), ('skill-2', 1, 'Fees.', ?)", CREATED_AT, CREATED_AT);
  opened.execute("INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('contact-treasurer', 'organization-1', '会計', 'treasurer@example.com', 'active', '[]', ?, ?)", CREATED_AT, CREATED_AT);
  opened.execute("INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('contact-stranger', 'organization-1', '他人', 'stranger@example.com', 'active', '[]', ?, ?)", CREATED_AT, CREATED_AT);
  return opened;
};

const automation = (overrides: Partial<RunnableAutomation> = {}): RunnableAutomation => ({
  id: 'automation-mail',
  name: '毎朝のメール処理',
  revision: 1,
  executionMode: 'unattended',
  suppressionWindow: 'none',
  skillIds: ['skill-1'],
  grant: AUTOMATION_TOOLS.map(({ name }) => name),
  model: null,
  ...overrides,
});

/** A model that calls the given tools on its first turn, each later turn's in turn, then answers `done`. */
const scripted = (...turns: Array<Array<{ name: string; arguments: unknown }>>): ModelPort & { requests: ModelRequest[] } => {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request): Promise<ModelCompletion> => {
      requests.push(request);
      const calls = turns[requests.length - 1];
      if (!calls) return { model: 'test-model', content: 'done', toolCalls: [], usage };
      return {
        model: 'test-model',
        content: '',
        usage,
        toolCalls: calls.map((call, index): TurnToolCall => ({ id: `call-${requests.length}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
      };
    },
  };
};

const thinking = (model: ModelPort): AccountThinking => ({
  database: database!.binding, model, connection, servers: [], fetch: async () => new Response(),
  skills: { db: drizzleAccountDatabase(database!.binding), bucket: createMemoryR2().bucket, accountId: 'organization-1' }, at: new Date(),
});

const plan = async (model: ModelPort, runnable: RunnableAutomation = automation()) =>
  planAutomation({ thinking: thinking(model), automation: runnable, work, runId: 'run-1' });

describe('an Automation run’s bounds', () => {
  const rereading = (turns: number, perTurn: { promptTokens: number; cachedTokens: number; completionTokens: number }): ModelPort => {
    let turn = 0;
    return { complete: async () => ++turn < turns
      ? { model: 'test-model', content: '', usage: perTurn, toolCalls: [{ id: `call-${turn}`, name: 'mail.read', arguments: '{}' }] }
      : { model: 'test-model', content: 'done', usage: perTurn, toolCalls: [] } };
  };

  it('lets a long run go on while its repeated prompt is served from the cache', async () => {
    database = accountDatabase();

    const result = await plan(rereading(6, { promptTokens: 100_000, cachedTokens: 96_000, completionTokens: 2_000 }));

    expect(result.error).toBeNull();
    expect(result.thought).toMatchObject({ output: 'done', tokens: 6 * 102_000 });
  });

  it('goes on however many tokens a turn holds or the run bills', async () => {
    database = accountDatabase();

    const result = await plan(rereading(6, { promptTokens: 400_000, cachedTokens: 0, completionTokens: 2_000 }));

    expect(result.error).toBeNull();
    expect(result.thought).toMatchObject({ output: 'done', tokens: 6 * 402_000 });
  });
});

describe('what a run is told', () => {
  it('thinks with the model it names, and with the default once the AI Connection no longer names it', async () => {
    database = accountDatabase();
    const asked: string[] = [];
    const model: ModelPort = { complete: async (request) => {
      asked.push(request.model);
      return { model: request.model, content: '済みました。', toolCalls: [], usage: { promptTokens: 1, cachedTokens: 0, completionTokens: 1 } };
    } };

    await plan(model, automation({ model: 'test-large' }));
    await plan(model, automation({ model: 'retired-model' }));
    await plan(model, automation());

    expect(asked).toEqual(['test-large', 'test-model', 'test-model']);
  });

  it('starts with its Skills, then how the product works, whom it acts for, and when it last ran', async () => {
    database = accountDatabase();
    const model = scripted();

    const result = await planAutomation({
      thinking: thinking(model),
      automation: automation(),
      work: { ...work, facts: accountFacts({ ...account, contacts: [{ id: 'contact-secretary', name: '鈴木華乃子', description: '幹事/メール、登録用紙などの対応' }] }) },
      runId: 'run-1',
    });

    const system = model.requests[0]?.messages[0]?.content ?? '';
    // The Skill it names comes first, in full, already activated; then every Skill, in the catalog Agent Skills describe.
    expect(system).toMatch(/^# .+\n\nThis Skill is already activated for this run\.\n\nManage explicit work\./u);
    expect(system).toContain('<description>When fees are asked for.</description>');
    expect(system).toContain('call activate_skill with its name');
    expect(system).toContain('Whom you tell anything is what your Skills say');
    expect(system).toContain('its call answers planned');
    expect(system).toContain('in the language your Skills are written in, not in the language of these instructions or of the request OrangeAgent starts the run with');
    expect(system).toContain('You act for the Account "さくら会". Its own mailbox is sakura.club@example.com');
    expect(system).toContain('- contact-secretary: 鈴木華乃子 — 幹事/メール、登録用紙などの対応');
    expect(model.requests[0]?.messages[1]?.content).toContain('This Automation last ran at 2026-08-01T20:00:00.000Z');
    expect(model.requests[0]?.messages[1]?.content).toContain('after:1785614400');
    expect(result.skills?.read).toEqual([{ id: 'skill-1', revision: 3, files: { 'SKILL.md': expect.stringMatching(/^[0-9a-f]{64}$/u) } }]);
  });

  it('is offered no mail, calendar, Drive, Meet, or Task tool while the Account has no mailbox, whatever its grant names', async () => {
    database = accountDatabase();
    database.execute("DELETE FROM google_connections WHERE id = 'inbox-1'");
    const model = scripted();

    await planAutomation({ thinking: thinking(model), automation: automation(), work, runId: 'run-1' });

    const offered = (model.requests[0]?.tools ?? []).map((tool) => tool.function.name);
    expect(offered).toEqual(expect.arrayContaining(['query_contacts', 'query_attendance', 'channel.send']));
    expect(offered.filter((name) => /^(mail|calendar|drive|meet|tasks)\./u.test(name) || name.endsWith('_scheduled_event'))).toEqual([]);
  });

  it('says so when the Automation has not run before', () => {
    expect(timedRequest({ at: new Date('2026-08-02T20:00:00.000Z'), previous: null })).toContain('This Automation has not run before.');
  });
});

describe('the writes an Automation plans', () => {
  it('plans a send to a Contact without sending anything, and freezes the call as its write will read it', async () => {
    database = accountDatabase();

    const result = await plan(scripted([{ name: 'channel.send', arguments: { channel: 'line', contactId: 'contact-treasurer', text: 'Bring shoes.' } }]));

    expect(result.error).toBeNull();
    expect(result.writes).toEqual([{
      key: 'channel.send:0', tool: 'channel.send', dependsOn: [],
      arguments: { channel: 'line', destination: null, contactId: 'contact-treasurer', text: 'Bring shoes.' },
    }]);
    expect(result.thought?.messages.find((message) => message.role === 'tool')?.content).toBe('{"status":"planned"}');
  });

  it('plans a send to any Contact and any address its Skills name, because whom it tells is theirs to say', async () => {
    database = accountDatabase();

    const result = await plan(scripted([
      { name: 'channel.send', arguments: { channel: 'line', contactId: 'contact-stranger', text: 'Hi.' } },
      { name: 'channel.send', arguments: { channel: 'line', destination: 'line-group-1', text: 'Hi all.' } },
    ]));

    expect(result.error).toBeNull();
    expect(result.writes.map(({ tool }) => tool)).toEqual(['channel.send', 'channel.send']);
  });

  it('plans an email to one Contact rather than to every one of them', async () => {
    database = accountDatabase();

    const result = await plan(scripted([{ name: 'mail.send', arguments: { to: 'Treasurer@Example.com', subject: '参加費の入金期限', body: '8月20日までに入金してください。' } }]));

    expect(result.writes).toMatchObject([{ tool: 'mail.send', arguments: { to: 'Treasurer@Example.com', subject: '参加費の入金期限' } }]);
  });

  it('plans an event with the mail it came from and the attendees it names', async () => {
    database = accountDatabase();

    const result = await plan(scripted([{ name: 'create_scheduled_event', arguments: { title: 'Practice', startsAt: '2026-08-10T09:00:00+09:00', endsAt: '2026-08-10T10:00:00+09:00', attendees: ['stranger@example.com'], messageId: 'gmail-1' } }]));

    expect(result.writes).toMatchObject([{ tool: 'create_scheduled_event', arguments: { inviteRoster: false, attendees: ['stranger@example.com'], messageId: 'gmail-1', title: 'Practice' } }]);
  });

  it('plans each write of a message in order across turns, telling the model each answer, and never waits for a person', async () => {
    database = accountDatabase();
    const model = scripted(
      [{ name: 'channel.send', arguments: { channel: 'line', contactId: 'contact-treasurer', text: 'One.' } }, { name: 'query_contacts', arguments: {} }],
      [{ name: 'mail.send', arguments: { to: 'treasurer@example.com', subject: '二通目', body: 'Two.' } }],
    );

    const result = await plan(model, automation({ executionMode: 'approval' }));

    expect(result.error).toBeNull();
    expect(result.writes.map(({ key }) => key)).toEqual(['channel.send:0', 'mail.send:1']);
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1]?.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['call-1-0', 'call-1-1']);
    expect(model.requests[2]?.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['call-1-0', 'call-1-1', 'call-2-0']);
    expect(result.thought?.output).toBe('done');
  });

  it('plans every write it calls, however many', async () => {
    database = accountDatabase();
    const sends = Array.from({ length: 200 }, (_, index) => ({
      name: 'channel.send', arguments: { channel: 'line', contactId: 'contact-treasurer', text: `Message ${index}` },
    }));

    const result = await plan(scripted(sends));

    expect(result.error).toBeNull();
    expect(result.writes).toHaveLength(200);
  });

  it('plans Task writes, and tells the model why one was refused so it can correct the call', async () => {
    database = accountDatabase();

    const result = await plan(scripted(
      [
        { name: 'tasks.create', arguments: { title: '資料を出す', due: '2026-08-20T17:00:00+09:00', notes: '資料を出す' } },
        { name: 'tasks.update', arguments: { listId: 'list-1', taskId: 'task-1', status: 'open' } },
        { name: 'tasks.update', arguments: { taskId: 'task-1', title: '別の作業' } },
        { name: 'tasks.update', arguments: { listId: 'list-1', taskId: 'task-1', status: 'completed' } },
      ],
      [{ name: 'tasks.create', arguments: { title: '資料を出す', due: '2026-08-20', notes: '17時までに資料を出す\n\n担当: 会計' } }],
    ));

    const told = (result.thought?.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.content);
    expect(told[0]).toContain('YYYY-MM-DD');
    expect(told[1]).toContain('Only a person reopens a Task');
    expect(told[2]).toContain('tasks.update requires the taskId and the listId');
    expect(result.writes.map(({ tool, arguments: arguments_ }) => ({ tool, arguments: arguments_ }))).toEqual([
      { tool: 'tasks.update', arguments: { listId: 'list-1', taskId: 'task-1', status: 'completed' } },
      { tool: 'tasks.create', arguments: { title: '資料を出す', notes: '17時までに資料を出す\n\n担当: 会計', due: '2026-08-20' } },
    ]);
    // Planning a Task write reaches neither Google Tasks nor the Account's database.
    expect(database.rows('SELECT id FROM tasks')).toEqual([]);
  });

  it('plans no write of a read-only run, which is not offered one', async () => {
    database = accountDatabase();
    const model = scripted([{ name: 'tasks.create', arguments: { title: 'x', due: null } }]);

    const result = await plan(model, automation({ executionMode: 'read_only' }));

    expect(result.writes).toEqual([]);
    expect(model.requests[0]?.tools.map((tool) => tool.function.name)).not.toContain('tasks.create');
    expect(result.thought?.messages.find((message) => message.role === 'tool')?.content).toContain('tasks.create is not one of the tools you were given');
  });

  it('withholds a write its Suppression Window already holds, without planning it again', async () => {
    database = accountDatabase();
    const call = { channel: 'line', destination: null, contactId: 'contact-treasurer', text: 'Weekly.' };
    database.execute(
      "INSERT INTO suppressions (key, scope, tool, recorded_at, expires_at) VALUES (?, 'automation-mail', 'channel.send', ?, NULL)",
      suppressionKey({ scope: 'automation-mail', tool: 'channel.send', arguments: call }),
      CREATED_AT,
    );

    const result = await plan(scripted([{ name: 'channel.send', arguments: call }]), automation({ suppressionWindow: 'forever' }));

    expect(result.writes).toEqual([]);
    expect(result.thought?.messages.find((message) => message.role === 'tool')?.content).toContain('suppressed');
  });
});

describe('a Run Transcript', () => {
  const transcript = { runId: 'run-1', source: null, request: '今日の予定を確認して', messages: [{ role: 'assistant', content: '確認しました。' }], finalOutput: '確認しました。', error: null };

  it('is read as the JSON it was kept as', async () => {
    const r2 = createMemoryR2();
    await r2.bucket.put('run-transcripts/organization-1/run-1.json', JSON.stringify({ ...transcript, accountId: 'organization-1', automationId: 'automation-1', automationRevision: 1 }));

    await expect(readRunTranscript({ bucket: r2.bucket, accountKey: await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), accountId: 'organization-1', runId: 'run-1' }))
      .resolves.toEqual(transcript);
  });

  it('is still read when it was kept encrypted before transcripts were kept as they are', async () => {
    const r2 = createMemoryR2();
    const key = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const envelope = await encrypt(JSON.stringify({ ...transcript, accountId: 'organization-1', automationId: 'automation-1', automationRevision: 1 }), key, 'run-transcript:organization-1:run-1');
    await r2.bucket.put('run-transcripts/organization-1/run-1.json', JSON.stringify(envelope));

    await expect(readRunTranscript({ bucket: r2.bucket, accountKey: key, accountId: 'organization-1', runId: 'run-1' })).resolves.toEqual(transcript);
  });
});
