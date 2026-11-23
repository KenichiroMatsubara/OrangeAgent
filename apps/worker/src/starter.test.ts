
import { afterEach, describe, expect, it } from 'vitest';

import TASK_PROGRAM from '../starter/tasks.mjs';
import { OFFICE_SKILL } from './office';
import { INTAKE_SKILL, REMINDER_SKILL, TASK_SKILL, ensureStarterAutomations } from './starter';
import { accountDatabase } from './storage/database';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const CREATED_AT = '2026-07-25T00:00:00.000Z';

const automations = () => database!.rows<{ name: string; trigger: string; enabled: number; schedule: string | null; suppression_window: string }>(
  'SELECT name, trigger, enabled, schedule, suppression_window FROM automations ORDER BY trigger, name',
);

/** An Account as it stood before migration 0042: its mail Automation and Morning Automation, turned off by the migrations, and their Skills. */
const seedFormerAccount = (db: TestD1Database): void => {
  for (const [id, name, instructions] of [['intake', 'mail-intake', 'Read the Source Message and call report.'], ['morning', 'morning-notice', 'Call morning.send once.']] as const) {
    db.execute(
      "INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at) VALUES (?, 'organization-1', ?, '', ?, 2, ?, ?)",
      id, name, instructions, CREATED_AT, CREATED_AT,
    );
    db.execute('INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES (?, 2, ?, ?)', id, instructions, CREATED_AT);
  }
  db.execute(
    `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, selection_policy, priority, created_at, updated_at)
     VALUES ('former-mail', 'organization-1', 'すべてのメール', 'mail', 0, 'unattended', 'none', 1, '{}', -1, ?, ?)`,
    CREATED_AT, CREATED_AT,
  );
  db.execute(
    `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, created_at, updated_at)
     VALUES ('former-morning', 'organization-1', '朝のお知らせ', 'morning', 0, 'unattended', 'none', 1, ?, ?)`,
    CREATED_AT, CREATED_AT,
  );
  db.execute("INSERT INTO automation_skills (automation_id, skill_id, position) VALUES ('former-mail', 'intake', 0), ('former-morning', 'morning', 0)");
};

describe('the starting Automations', () => {
  it('give a new Account a mail Automation every morning and a reminder Automation it turns on itself, each telling whom its Skill names and keeping Tasks as タスクの管理 says', async () => {
    database = createMigratedTestD1('organization');

    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');
    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');

    expect(automations()).toEqual([
      { name: 'タスクのリマインド', trigger: 'schedule', enabled: 0, schedule: 'daily 07:00', suppression_window: 'day' },
      { name: '毎朝のメール処理', trigger: 'schedule', enabled: 1, schedule: 'daily 05:00', suppression_window: 'none' },
    ]);
    // Each is named as Agent Skills name one, and keeps the name a person reads as its title.
    expect(database.rows('SELECT name, title, instructions FROM skills ORDER BY name')).toEqual([
      { name: 'mail-intake', title: 'メールの取り込み', instructions: INTAKE_SKILL },
      { name: 'office-files', title: 'Officeファイル', instructions: OFFICE_SKILL },
      { name: 'task-management', title: 'タスクの管理', instructions: TASK_SKILL },
      { name: 'task-reminder', title: 'タスクのリマインド', instructions: REMINDER_SKILL },
    ]);
    expect(database.rows(`SELECT automations.name AS automation, skills.name AS skill FROM automation_skills
      JOIN automations ON automations.id = automation_skills.automation_id JOIN skills ON skills.id = automation_skills.skill_id
      ORDER BY automations.name, automation_skills.position`)).toEqual([
      { automation: 'タスクのリマインド', skill: 'task-reminder' },
      { automation: 'タスクのリマインド', skill: 'task-management' },
      { automation: '毎朝のメール処理', skill: 'mail-intake' },
      { automation: '毎朝のメール処理', skill: 'task-management' },
    ]);
    expect(database.rows("SELECT tool FROM automation_tools JOIN automations ON automations.id = automation_tools.automation_id WHERE automations.name = 'タスクのリマインド' ORDER BY tool")).toEqual([
      { tool: 'channel.send' }, { tool: 'mail.send' }, { tool: 'query_contacts' }, { tool: 'tasks.search' },
    ]);
    expect(INTAKE_SKILL).toContain('送信先: 要約送信グループ');
    expect(REMINDER_SKILL).toContain('期限の 7 日前、3 日前、当日、期限を過ぎた次の日');
    // No Skill names a tool the product no longer has.
    for (const skill of [INTAKE_SKILL, REMINDER_SKILL, TASK_SKILL]) expect(skill).not.toMatch(/query_tasks|create_task|update_task/u);
    // タスクの管理 carries the program that keeps a Task's notes under scripts/, and says how to run it with code.run, calling the run's tools.
    expect(database.rows("SELECT skill_files.path, skill_files.content = ? AS shipped FROM skill_files JOIN skills ON skills.id = skill_files.skill_id WHERE skills.name = 'task-management'", TASK_PROGRAM))
      .toEqual([{ path: 'scripts/tasks.mjs', shipped: 1 }]);
    for (const words of ['code.run', '"javascript"', '"task-management"', 'new Tasks(tools)', "from './skills/task-management/scripts/tasks.mjs'", 'noticeOf']) expect(TASK_SKILL).toContain(words);
    expect(TASK_SKILL).not.toMatch(/tasks\.py|FLARECHAT_|None/u);
    for (const skill of [INTAKE_SKILL, REMINDER_SKILL]) expect(skill).toContain('tasks.mjs');
    expect(REMINDER_SKILL).toContain('noticeOf(task');
  });

  it('take the place of an Account’s mail and Morning Automations, rewriting its mail Skill and removing the Morning’s', async () => {
    database = createMigratedTestD1('organization');
    seedFormerAccount(database);

    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');

    expect(automations()).toEqual([
      { name: 'すべてのメール', trigger: 'mail', enabled: 0, schedule: null, suppression_window: 'none' },
      { name: '朝のお知らせ', trigger: 'morning', enabled: 0, schedule: null, suppression_window: 'none' },
      { name: 'タスクのリマインド', trigger: 'schedule', enabled: 0, schedule: 'daily 07:00', suppression_window: 'day' },
      { name: '毎朝のメール処理', trigger: 'schedule', enabled: 1, schedule: 'daily 05:00', suppression_window: 'none' },
    ]);
    expect(database.rows('SELECT id, name, revision, instructions FROM skills ORDER BY name')).toEqual([
      { id: 'intake', name: 'mail-intake', revision: 3, instructions: INTAKE_SKILL },
      { id: expect.any(String), name: 'office-files', revision: 1, instructions: OFFICE_SKILL },
      { id: expect.any(String), name: 'task-management', revision: 1, instructions: TASK_SKILL },
      { id: expect.any(String), name: 'task-reminder', revision: 1, instructions: REMINDER_SKILL },
    ]);
    expect(database.rows("SELECT revision, instructions FROM skill_revisions WHERE skill_id = 'intake' ORDER BY revision")).toEqual([
      { revision: 2, instructions: 'Read the Source Message and call report.' },
      { revision: 3, instructions: INTAKE_SKILL },
    ]);
  });

  it('leave a mail Skill an Account wrote for itself as it is when the Account never ran the former mail Automation', async () => {
    database = createMigratedTestD1('organization');
    database.execute(
      "INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at) VALUES ('own', 'organization-1', 'mail-intake', '', '自分で書いた指示', 1, ?, ?)",
      CREATED_AT, CREATED_AT,
    );

    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');

    expect(database.row("SELECT instructions FROM skills WHERE id = 'own'")).toEqual({ instructions: '自分で書いた指示' });
    expect(database.row("SELECT skill_id FROM automation_skills JOIN automations ON automations.id = automation_skills.automation_id WHERE automations.name = '毎朝のメール処理' ORDER BY position LIMIT 1")).toEqual({ skill_id: 'own' });
  });

  it('give an Account that already had its starting Automations the Office Skill once, and leave one the Account wrote of that name as it is', async () => {
    database = createMigratedTestD1('organization');
    database.execute("INSERT INTO settings (key, value, updated_at) VALUES ('starter-automations-0042', '{}', ?)", CREATED_AT);

    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');
    database.execute("DELETE FROM skills WHERE name = 'office-files'");
    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');

    expect(automations()).toEqual([]);
    expect(database.rows('SELECT name FROM skills')).toEqual([]);

    database.close();
    database = createMigratedTestD1('organization');
    database.execute("INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at) VALUES ('own', 'organization-1', 'office-files', '', '私たちの書き方', 1, ?, ?)", CREATED_AT, CREATED_AT);

    await ensureStarterAutomations(accountDatabase(database.binding), 'organization-1');

    expect(database.rows("SELECT id, instructions FROM skills WHERE name = 'office-files'")).toEqual([{ id: 'own', instructions: '私たちの書き方' }]);
  });
});
