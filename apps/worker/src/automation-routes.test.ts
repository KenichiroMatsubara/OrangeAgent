import { AUTOMATION_TOOLS } from '@mail/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { app } from './app';
import { createTestApp, type TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const AUTOMATIONS = '/api/organizations/organization-1/automations';

/** Two Skills the Account holds. */
const seedSkills = (account: TestApp['account']): void => {
  for (const [id, instructions] of [['reminding', '未回答の Contact にリマインドしてください。'], ['tone', '丁寧に書いてください。']] as const) {
    account.execute(
      `INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at)
       VALUES (?, 'organization-1', ?, '', ?, 1, '2026-08-01', '2026-08-01')`,
      id, id, instructions,
    );
    account.execute("INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES (?, 1, ?, '2026-08-01')", id, instructions);
  }
};

const create = async (body: Record<string, unknown>): Promise<Response> =>
  app.fetch(fixture!.jsonRequest(AUTOMATIONS, body), fixture!.environment);

const change = async (id: string, body: Record<string, unknown>): Promise<Response> =>
  app.fetch(fixture!.jsonRequest(`${AUTOMATIONS}/${id}`, body, 'PATCH'), fixture!.environment);

const read = async (id: string): Promise<Record<string, unknown>> =>
  (await (await app.fetch(fixture!.request(`${AUTOMATIONS}/${id}`), fixture!.environment)).json() as { data: Record<string, unknown> }).data;

const timed = {
  name: '朝の確認',
  skillIds: ['reminding'],
  schedule: 'daily 09:00',
  executionMode: 'unattended',
  suppressionWindow: 'day',
  enabled: true,
  tools: ['query_attendance', 'channel.send'],
};

const added = async (input: Record<string, unknown> = {}): Promise<string> => {
  const created = await create({ ...timed, ...input });
  expect(created.status).toBe(201);
  return (await created.json() as { data: { id: string } }).data.id;
};

const connectAi = async (models: string[]): Promise<Response> =>
  app.fetch(fixture!.jsonRequest('/api/organizations/organization-1/connections/ai', { apiKey: 'ai-key', provider: 'openrouter', model: models[0], models }, 'PUT'), fixture!.environment);

describe('an Automation', () => {
  it('thinks with a model the AI Connection names, recorded in its revision, and refuses any other', async () => {
    fixture = await createAutomationTestApp();
    seedSkills(fixture.account);
    expect((await connectAi(['small-model', 'large-model'])).status).toBe(200);

    const id = await added({ model: 'large-model' });
    const refused = await create({ ...timed, name: '別', model: 'other-model' });
    const defaulted = await change(id, { model: 'small-model' });

    expect((await read(id))).toMatchObject({ model: null, revision: 2 });
    expect(refused.status).toBe(400);
    expect(defaulted.status).toBe(200);
    expect(fixture.account.rows<{ revision: number; model: string | null }>('SELECT revision, model FROM automation_revisions WHERE automation_id = ? ORDER BY revision', id))
      .toEqual([{ revision: 1, model: 'large-model' }, { revision: 2, model: null }]);
  });

  it('keeps a model an Automation names on the AI Connection until the Automation names another', async () => {
    fixture = await createAutomationTestApp();
    seedSkills(fixture.account);
    expect((await connectAi(['small-model', 'large-model'])).status).toBe(200);
    const id = await added({ model: 'large-model' });

    const dropped = await connectAi(['small-model']);
    expect(dropped.status).toBe(409);
    expect((await dropped.json() as { error: { message: string } }).error.message).toContain('「朝の確認」が large-model');

    expect((await change(id, { model: null })).status).toBe(200);
    const kept = await connectAi(['small-model']);
    expect(kept.status).toBe(200);
    await expect(kept.json()).resolves.toMatchObject({ data: { model: 'small-model', models: ['small-model'] } });
  });

  it('is saved with its schedule, its Tool Grant, its first revision, and the next time it is due, which one that is off does not have', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);

    const active = await create(timed);
    const draft = await create({ ...timed, name: 'オフ', enabled: false });

    expect([active.status, draft.status]).toEqual([201, 201]);
    // TEST_NOW is 09:00 on 1 August in Tokyo, so the next 09:00 is the next day's.
    await expect(active.json()).resolves.toMatchObject({ data: {
      name: '朝の確認', schedule: 'daily 09:00', nextRunAt: '2026-08-02T00:00:00.000Z', suppressionWindow: 'day',
      tools: ['query_attendance', 'channel.send'], skillIds: ['reminding'], revision: 1, lastRun: null,
    } });
    await expect(draft.json()).resolves.toMatchObject({ data: { nextRunAt: null } });
    expect(fixture.account.rows("SELECT trigger, contact_list_id FROM automations WHERE name = '朝の確認'")).toEqual([{ trigger: 'schedule', contact_list_id: null }]);
  });

  it('is revised only when what its runs do changes', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);
    const id = await added();

    const renamed = await change(id, { name: '行事のお知らせ', enabled: false, schedule: 'weekly mon 08:30' });
    const resaved = await change(id, { name: '行事のお知らせ', executionMode: 'unattended', skillIds: ['reminding'] });
    expect([renamed.status, resaved.status]).toEqual([200, 200]);
    await expect(read(id)).resolves.toMatchObject({ name: '行事のお知らせ', enabled: false, schedule: 'weekly mon 08:30', nextRunAt: null, revision: 1 });

    await change(id, { skillIds: ['tone', 'reminding'] });
    await change(id, { suppressionWindow: 'week' });

    await expect(read(id)).resolves.toMatchObject({ revision: 3, skillIds: ['tone', 'reminding'], suppressionWindow: 'week' });
    expect(fixture.account.rows('SELECT revision, skill_ids, suppression_window FROM automation_revisions ORDER BY revision')).toEqual([
      { revision: 1, skill_ids: '["reminding"]', suppression_window: 'day' },
      { revision: 2, skill_ids: '["tone","reminding"]', suppression_window: 'day' },
      { revision: 3, skill_ids: '["tone","reminding"]', suppression_window: 'week' },
    ]);
  });

  it('may be granted any tool an Automation can call, and refuses a tool the product no longer has', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);
    const id = await added({ tools: AUTOMATION_TOOLS.map(({ name }) => name) });

    const narrowed = await change(id, { tools: ['record_event_response', 'mail.read', 'tasks.search'] });
    const report = await change(id, { tools: ['report'] });

    expect([narrowed.status, report.status]).toEqual([200, 400]);
    await expect(read(id)).resolves.toMatchObject({ tools: ['mail.read', 'tasks.search', 'record_event_response'], revision: 2 });
  });

  it('refuses a schedule it cannot run, and an edit that would leave it unnamed or without a Skill, rather than storing it', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);

    const cron = await create({ ...timed, schedule: '*/5 * * * *' });
    expect(cron.status).toBe(400);
    expect(fixture.account.rows('SELECT id FROM automations')).toEqual([]);

    const id = await added();
    const statuses = await Promise.all([
      change(id, { name: '   ' }),
      change(id, { skillIds: [] }),
      change(id, { schedule: 'every morning' }),
    ].map(async (response) => (await response).status));

    expect(statuses).toEqual([400, 400, 400]);
  });

  it('refuses a name another Automation holds, and a Skill the Account does not', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);
    await added();

    const taken = await create(timed);
    const unknown = await create({ ...timed, name: 'Other', skillIds: ['reminding', 'elsewhere'] });
    const none = await create({ ...timed, name: 'None', skillIds: [] });

    expect([taken.status, unknown.status, none.status]).toEqual([409, 409, 400]);
  });

  it('keeps a Skill it names from being deleted, and says why', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);
    await added();

    const refused = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/skills/reminding', {}, 'DELETE'), fixture.environment);

    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('このスキルを使っている自動化があります') } });
  });

  it('is removed while it has never run, and archived rather than removed once it has', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);
    const unused = await added({ name: 'Unused' });
    const used = await added({ name: 'Used' });
    fixture.account.execute(
      `INSERT INTO runs (id, trigger, automation_id, automation_revision, execution_mode, status, started_at, updated_at)
       VALUES ('run-1', 'schedule', ?, 1, 'unattended', 'completed', '2026-08-01', '2026-08-01')`,
      used,
    );

    const removed = await app.fetch(fixture.jsonRequest(`${AUTOMATIONS}/${unused}`, {}, 'DELETE'), fixture.environment);
    const kept = await app.fetch(fixture.jsonRequest(`${AUTOMATIONS}/${used}`, {}, 'DELETE'), fixture.environment);

    expect([removed.status, kept.status]).toEqual([200, 409]);
    expect(fixture.account.rows('SELECT name FROM automations')).toEqual([{ name: 'Used' }]);
  });

  it('lists neither a mail Automation nor the Morning Automation kept from before, and changes neither', async () => {
    fixture = createTestApp();
    seedSkills(fixture.account);
    fixture.account.execute(
      `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, selection_policy, priority, created_at, updated_at)
       VALUES ('former-mail', 'organization-1', 'すべてのメール', 'mail', 0, 'unattended', 'none', 1, '{}', -1, '2026-08-01', '2026-08-01')`,
    );
    const id = await added();

    const listed = await (await app.fetch(fixture.request(AUTOMATIONS), fixture.environment)).json() as { data: Array<{ id: string }> };
    const changed = await change('former-mail', { name: '別名' });

    expect(listed.data.map((automation) => automation.id)).toEqual([id]);
    expect(changed.status).toBe(404);
  });
});
