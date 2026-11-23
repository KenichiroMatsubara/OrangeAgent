import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import controlInitialMigration from '../migrations/control/0000_initial.sql';
import accountInitialMigration from '../migrations/organization/0000_initial.sql';
import { COPIED_PATHS, COPIED_TITLES, LEGACY_CHAT } from '../test/conversations';
import { createTestD1Database, type TestD1Database } from '../test/d1';
import { schemaLifecycle } from './schema-lifecycle';
import { emptyProjection, threadOf } from './timeline';
import { decodeEvent, foldEvent } from '@mail/t3chat/wire';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const databaseAtInitialAccountSchema = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  for (const statement of accountInitialMigration
    .split('--> statement-breakpoint')
    .map((value) => value.trim())
    .filter(Boolean)) {
    database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  database.execute('INSERT INTO d1_migrations (name) VALUES (?)', '0000_initial.sql');
  return database;
};

const databaseAtInitialControlSchema = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  for (const statement of controlInitialMigration
    .split('--> statement-breakpoint')
    .map((value) => value.trim())
    .filter(Boolean)) {
    database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  database.execute('INSERT INTO d1_migrations (name) VALUES (?)', '0000_initial.sql');
  return database;
};

const databaseBeforeOperationalTaskRoles = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  const migrationDirectory = resolve(import.meta.dirname, '../migrations/organization');
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0006_operational_task_roles.sql')
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory, name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  return database;
};

const databaseBeforeAgentRuleOnly = (): TestD1Database => databaseBefore('0037_agent_rule_only.sql');

const databaseBeforeOneReminderKind = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  const migrationDirectory = resolve(import.meta.dirname, '../migrations/organization');
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0030_one_reminder_kind.sql')
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory, name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  return database;
};

const databaseBeforeRuleExecution = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  const migrationDirectory = resolve(import.meta.dirname, '../migrations/organization');
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0021_rule_execution.sql')
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory, name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  return database;
};

const databaseBeforeManualTasks = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  const migrationDirectory = resolve(import.meta.dirname, '../migrations/organization');
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0033_manual_tasks.sql')
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory, name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  return database;
};

const databaseBefore = (migration: string): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  const migrationDirectory = resolve(import.meta.dirname, '../migrations/organization');
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name < migration)
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory, name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  return database;
};

describe('Schema Lifecycle', () => {
  it('makes a partially migrated Control database ready for current code', async () => {
    const database = databaseAtInitialControlSchema();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'control',
      database: database.binding,
    });

    expect(receipt).toMatchObject({
      kind: 'control',
      currentMigration: '0006_account_without_inbox.sql',
      appliedMigrations: [
        '0001_schema_release.sql',
        '0002_preset_selection.sql',
        '0003_admins.sql',
        '0004_single_admin_role.sql',
        '0005_member_logins.sql',
        '0006_account_without_inbox.sql',
      ],
    });
    expect(database.rows<{ state: string }>(
      "SELECT state FROM schema_releases WHERE id = 'organization'",
    )).toEqual([{ state: 'ready' }]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('rejects a Control database whose migration history is ahead of current code', async () => {
    const database = databaseAtInitialControlSchema();
    database.execute('INSERT INTO d1_migrations (name) VALUES (?)', '9999_future.sql');

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'control',
      database: database.binding,
    })).rejects.toMatchObject({
      name: 'SchemaReadinessError',
      category: 'database_ahead',
      kind: 'control',
      currentMigration: '9999_future.sql',
      expectedMigration: '0006_account_without_inbox.sql',
    });
  });

  it('rejects an existing Control schema that has no migration history ledger', async () => {
    const database = createTestD1Database();
    openDatabases.push(database);
    for (const statement of controlInitialMigration
      .split('--> statement-breakpoint')
      .map((value) => value.trim())
      .filter(Boolean)) {
      database.execute(statement);
    }

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'control',
      database: database.binding,
    })).rejects.toMatchObject({
      name: 'SchemaReadinessError',
      category: 'migration_history_missing',
      kind: 'control',
      currentMigration: '',
      expectedMigration: '0006_account_without_inbox.sql',
    });
  });

  it('makes a partially migrated Account database ready for current code', async () => {
    const database = databaseAtInitialAccountSchema();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    });

    expect(receipt).toMatchObject({
      kind: 'organization',
      currentMigration: '0065_runs_browser_time.sql',
      appliedMigrations: [
        '0001_tasks.sql',
        '0002_line_destination_roster.sql',
        '0003_release_safe_line_destination_index.sql',
        '0004_manual_line_destination_source.sql',
        '0005_optional_recipient_email.sql',
        '0006_operational_task_roles.sql',
        '0007_source_message_deliveries.sql',
        '0008_rule_permitted_lists.sql',
        '0009_prompts.sql',
        '0010_agent_rules.sql',
        '0011_agent_runs.sql',
        '0012_event_agent_owners.sql',
        '0013_agent_rule_writes.sql',
        '0014_members.sql',
        '0015_attachment_folders.sql',
        '0016_member_task_assignments.sql',
        '0017_member_portal.sql',
        '0018_automation_inbox_health.sql',
        '0019_task_role_revisions.sql',
        '0020_event_responses_and_guests.sql',
        '0021_rule_execution.sql',
        '0022_operator_chat.sql',
        '0023_access_tokens.sql',
        '0024_automations.sql',
        '0025_discord_channel.sql',
        '0026_contact_description.sql',
        '0027_name_the_contact.sql',
        '0028_rule_notice_contacts.sql',
        '0029_agent_email_summary.sql',
        '0030_one_reminder_kind.sql',
        '0031_agent_tasks.sql',
        '0032_morning_entries.sql',
        '0033_manual_tasks.sql',
        '0034_task_status.sql',
        '0035_task_deadlines.sql',
        '0036_unowned_events.sql',
        '0037_agent_rule_only.sql',
        '0038_drop_proposed_actions.sql',
        '0039_chat_attachments.sql',
        '0040_morning_automation.sql',
        '0041_one_automation.sql',
        '0042_skills_name_the_reader.sql',
        '0043_generated_chat_files.sql',
        '0044_skill_files.sql',
        '0045_skill_folders.sql',
        '0046_operator_tokens.sql',
        '0047_chat_branches.sql',
        '0048_memories.sql',
        '0049_operator_token_clients.sql',
        '0050_memory_episodes.sql',
        '0051_chat_turn_tools.sql',
        '0052_automation_model.sql',
        '0053_transcripts.sql',
        '0054_automation_on_off.sql',
        '0055_tasks_in_google.sql',
        '0056_browser_logins.sql',
        '0057_mcp_oauth.sql',
        '0058_chat_threads.sql',
        '0059_chat_approvals.sql',
        '0060_chat_message_files.sql',
        '0061_chat_conversations_copied.sql',
        '0062_push_subscriptions.sql',
        '0063_chat_runs_abandoned.sql',
        '0064_agent_skills_names.sql',
        '0065_runs_browser_time.sql',
      ],
    });
    expect(database.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
    database.execute(
      "INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('recipient-1', 'organization-1', 'First', '', 'active', '[]', '2026-01-01', '2026-01-01')",
    );
    database.execute(
      "INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('recipient-2', 'organization-1', 'Second', '', 'active', '[]', '2026-01-01', '2026-01-01')",
    );
    expect(database.rows<{ email: string }>('SELECT email FROM members')).toEqual([
      { email: '' },
      { email: '' },
    ]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('can retry a migration after a failed batch leaves the database unchanged', async () => {
    const database = databaseAtInitialAccountSchema();
    database.execute(
      'CREATE INDEX tasks_source_role_deadline_title_idx ON source_messages(id)',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).rejects.toMatchObject({
      name: 'SchemaReadinessError',
      category: 'migration_apply_failed',
      kind: 'organization',
      currentMigration: '0000_initial.sql',
      expectedMigration: '0065_runs_browser_time.sql',
    });

    database.execute('DROP INDEX tasks_source_role_deadline_title_idx');

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).resolves.toMatchObject({
      currentMigration: '0065_runs_browser_time.sql',
    });
  });

  it('rejects an applied migration whose recorded checksum no longer matches', async () => {
    const database = databaseAtInitialAccountSchema();
    database.execute('ALTER TABLE d1_migrations ADD COLUMN checksum TEXT');
    database.execute(
      'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
      'modified-after-application',
      '0000_initial.sql',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).rejects.toMatchObject({
      name: 'SchemaReadinessError',
      category: 'checksum_mismatch',
      kind: 'organization',
      currentMigration: '0000_initial.sql',
      expectedMigration: '0065_runs_browser_time.sql',
    });
  });

  it('accepts the recorded checksum from the constrained Task schema and migrates it forward', async () => {
    const database = databaseAtInitialAccountSchema();
    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });
    database.execute(
      'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
      '4b2f3889191d0eafbbe45b78103db7139c7ce2b937c02cbbb6824f5131d7429f',
      '0001_tasks.sql',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });
  });

  it('accepts the legacy Operational Task Roles checksum recorded by the local schema lifecycle', async () => {
    const database = databaseAtInitialAccountSchema();
    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });
    database.execute(
      'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
      '7c37ad2276cf9819a1e58105345d18816d4e15ea0b850399b11e3fa641c9eb2e',
      '0006_operational_task_roles.sql',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });
  });

  it('carries a Task named by a legacy role across to an unassigned Contact assignment', async () => {
    const database = databaseBeforeOperationalTaskRoles();
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')");
    database.execute("INSERT INTO task_role_assignments (role, identity_id, display_name, assigned_at, updated_at) VALUES ('legacy-registration', 'identity-1', 'Owner', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_role, assignee_identity_id, assignee_name, description, created_at, updated_at) VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '登録する', '2026-08-20', 'legacy-registration', 'identity-1', 'Owner', '登録を行う', '2026-08-01', '2026-08-01')");

    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });

    expect(database.rows<{ title: string; assignee_name: string; assignee_member_id: string | null }>(
      'SELECT title, assignee_name, assignee_member_id FROM tasks',
    )).toEqual([{ title: '登録する', assignee_name: '未割り当て', assignee_member_id: null }]);
    expect(database.rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operational_task_roles', 'task_role_assignments', 'task_role_revisions')",
    )).toEqual([]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('rewrites every reminder Job of the old kinds into the one kind under the key the Reminder Schedule uses', async () => {
    const database = databaseBeforeOneReminderKind();
    const job = (id: string, kind: string, payload: string, key: string, state = 'pending'): void => database.execute(
      'INSERT INTO jobs (id, kind, payload, state, attempts, available_at, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      id, kind, payload, state, '2026-08-01T00:00:00.000Z', key, '2026-08-01', '2026-08-01',
    );
    job('job-task', 'task_reminder', '{"taskId":"task-1","contactId":"contact-1","milestone":3}', 'task-reminder:task-1:contact-1:3', 'running');
    job('job-registration', 'attendance_reminder', '{"eventId":"event-1","contactId":"contact-1","milestone":0}', 'attendance-reminder:event-1:contact-1:0');
    job('job-scheduled', 'mcp.reminder', '{"contactId":"contact-1","channel":"line","text":"水を持って"}', 'mcp-reminder:contact-1:2026-08-01T00:00:00.000Z:水を持って');
    job('job-other', 'gmail.sync', '{"historyId":"1"}', 'gmail.sync:1', 'succeeded');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows<{ id: string; kind: string; payload: string; idempotency_key: string }>(
      'SELECT id, kind, payload, idempotency_key FROM jobs ORDER BY id',
    )).toEqual([
      { id: 'job-other', kind: 'gmail.sync', payload: '{"historyId":"1"}', idempotency_key: 'gmail.sync:1' },
      { id: 'job-registration', kind: 'reminder', payload: '{"eventId":"event-1","contactId":"contact-1","milestone":0,"subject":"registration"}', idempotency_key: 'reminder:registration:event-1:contact-1:0' },
      { id: 'job-scheduled', kind: 'reminder', payload: '{"contactId":"contact-1","channel":"line","text":"水を持って","subject":"scheduled"}', idempotency_key: 'reminder:scheduled:contact-1:2026-08-01T00:00:00.000Z:水を持って' },
      { id: 'job-task', kind: 'reminder', payload: '{"taskId":"task-1","contactId":"contact-1","milestone":3,"subject":"task"}', idempotency_key: 'reminder:task:task-1:contact-1:3' },
    ]);
  });

  it('refuses a reminder Job the rename left without a Contact, which is the row production had to repair before 0030 could apply', async () => {
    const database = databaseBeforeOneReminderKind();
    database.execute(
      'INSERT INTO jobs (id, kind, payload, state, attempts, available_at, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      'job-member', 'task_reminder', '{"taskId":"task-1","memberId":"contact-1","milestone":3}', 'running', '2026-08-01T00:00:00.000Z', 'task-reminder:task-1:3', '2026-08-01', '2026-08-01',
    );

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .rejects.toMatchObject({
        category: 'migration_apply_failed',
        currentMigration: '0029_agent_email_summary.sql',
        expectedMigration: '0065_runs_browser_time.sql',
      });
    expect(database.rows<{ kind: string }>('SELECT kind FROM jobs')).toEqual([{ kind: 'task_reminder' }]);
  });

  it('renames the roster to Contacts and carries its links, tokens, and Event Recipients across', async () => {
    const database = databaseAtInitialAccountSchema();
    database.execute("INSERT INTO recipient_profiles (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('member-1', 'organization-1', 'First', 'first@example.com', 'active', '[]', '2026-01-01', '2026-01-01')");
    database.execute("INSERT INTO events (id, organization_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES ('event-1', 'organization-1', '年次行事', '2026-09-01T10:00:00+09:00', '2026-09-01T12:00:00+09:00', 'scheduled', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO event_recipients (event_id, recipient_profile_id, name_snapshot, email_snapshot, created_at) VALUES ('event-1', 'member-1', 'First', 'first@example.com', '2026-08-01')");
    database.execute("INSERT INTO recipient_link_tokens (token, recipient_profile_id, expires_at, created_at) VALUES ('token-1', 'member-1', '2026-08-02', '2026-08-01')");
    database.execute("INSERT INTO connections (id, kind, label, credential, status, created_at, updated_at) VALUES ('connection-1', 'line', 'LINE', '{}', 'active', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO line_destinations (id, connection_id, destination_id, kind, status, discovered_at, updated_at) VALUES ('line-1', 'connection-1', 'U1', 'user', 'discovered', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO recipient_line_destinations (recipient_profile_id, line_destination_id, created_at) VALUES ('member-1', 'line-1', '2026-08-01')");

    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });

    expect(database.rows<{ id: string; name: string }>('SELECT id, name FROM members')).toEqual([{ id: 'member-1', name: 'First' }]);
    expect(database.rows<{ member_id: string }>('SELECT member_id FROM event_recipients')).toEqual([{ member_id: 'member-1' }]);
    expect(database.rows<{ member_id: string }>('SELECT member_id FROM member_link_tokens')).toEqual([{ member_id: 'member-1' }]);
    expect(database.rows<{ member_id: string }>('SELECT member_id FROM member_line_destinations')).toEqual([{ member_id: 'member-1' }]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps existing Event Delivery Records intact when Source Message references are added', async () => {
    const database = databaseBeforeOperationalTaskRoles();
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')");
    database.execute("INSERT INTO events (id, organization_id, source_message_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES ('event-1', 'organization-1', 'source-1', '年次行事', '2026-09-01T10:00:00+09:00', '2026-09-01T12:00:00+09:00', 'scheduled', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO deliveries (id, event_id, channel, destination, outcome, external_id, created_at) VALUES ('delivery-1', 'event-1', 'calendar', 'reader@example.com', 'succeeded', 'google-event-1', '2026-08-01')");

    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });

    expect(database.rows<{ id: string; event_id: string | null; source_message_id: string | null }>(
      'SELECT id, event_id, source_message_id FROM deliveries',
    )).toEqual([{
      id: 'delivery-1',
      event_id: 'event-1',
      source_message_id: null,
    }]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('carries every Task across, gives it a status, and identifies it by id alone', async () => {
    const database = databaseBeforeManualTasks();
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')");
    database.execute("INSERT INTO rules (id, organization_id, name, status, created_at, updated_at) VALUES ('rule-1', 'organization-1', 'Schema', 'active', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO events (id, organization_id, rule_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES ('event-1', 'organization-1', 'rule-1', '年次行事', '2026-09-01T10:00:00+09:00', '2026-09-01T12:00:00+09:00', 'scheduled', '2026-08-01', '2026-08-01')");
    database.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_member_id, assignee_name,
         description, remarks, completed, completed_at, created_at, updated_at, scheduled_event_id, scheduled_event_title)
       VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '振り込む', '2026-08-20', 'contact-1', '山田', '振込する', '済', 1, '2026-08-02', '2026-08-01', '2026-08-02', 'event-1', '年次行事'),
              ('task-2', 'organization-1', 'source-1', '年次行事', '会場を予約する', '2026-08-25T17:00:00+09:00', NULL, '未割り当て', '', '', 0, NULL, '2026-08-01', '2026-08-01', NULL, NULL)`,
    );
    const before = database.rows<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    const after = database.rows<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id');
    expect(after).toEqual([
      { ...before[0], planned_write_id: null, link_token: expect.stringMatching(/^[0-9a-f]{48}$/u), completed_via: null, status: 'completed', google_task_id: null },
      { ...before[1], planned_write_id: null, link_token: expect.stringMatching(/^[0-9a-f]{48}$/u), completed_via: null, status: 'open', deadline: '2026-08-25', google_task_id: null },
    ]);
    expect(after[0]?.link_token).not.toBe(after[1]?.link_token);
    database.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_name, description, created_at, updated_at)
       VALUES ('task-3', 'organization-1', 'source-1', '年次行事', '振り込む', '2026-08-20', '未割り当て', '', '2026-08-03', '2026-08-03'),
              ('task-4', 'organization-1', NULL, '', '会場を予約する', NULL, '未割り当て', '', '2026-08-03', '2026-08-03')`,
    );
    expect(database.rows('SELECT id, status, deadline FROM tasks WHERE id IN (\'task-3\', \'task-4\') ORDER BY id')).toEqual([
      { id: 'task-3', status: 'open', deadline: '2026-08-20' },
      { id: 'task-4', status: 'open', deadline: null },
    ]);
    database.execute("UPDATE tasks SET planned_write_id = 'write-1' WHERE id = 'task-3'");
    expect(() => database.execute("UPDATE tasks SET planned_write_id = 'write-1' WHERE id = 'task-4'")).toThrow();
    expect(() => database.execute("UPDATE tasks SET status = 'done' WHERE id = 'task-4'")).toThrow();
    expect(() => database.execute("UPDATE tasks SET completed_via = 'somebody' WHERE id = 'task-4'")).toThrow();
    expect(() => database.execute("UPDATE tasks SET link_token = (SELECT link_token FROM tasks WHERE id = 'task-1') WHERE id = 'task-2'")).toThrow();
    expect(database.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name NOT LIKE 'sqlite_%' ORDER BY name")).toEqual([
      { name: 'tasks_assignee_idx' },
      { name: 'tasks_link_token_idx' },
      { name: 'tasks_order_idx' },
      { name: 'tasks_planned_write_idx' },
      { name: 'tasks_scheduled_event_idx' },
      { name: 'tasks_updated_idx' },
    ]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('reads every deadline as an Asia/Tokyo date or none, and keeps an unreadable one in the description', async () => {
    const database = databaseBeforeManualTasks();
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '依頼', '2026-08-01', 'processed')");
    const task = (id: string, deadline: string, description: string, completed = 0): void => database.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_name, description, completed, created_at, updated_at)
       VALUES (?, 'organization-1', 'source-1', '依頼', '作業', ?, '未割り当て', ?, ?, '2026-08-01', '2026-08-01')`,
      id, deadline, description, completed,
    );
    task('date', '2026-08-20', '');
    task('local-time', '2026-08-20T17:00', '');
    task('local-space', '2026-08-20 09:30:00', '');
    task('offset', '2026-08-20T00:30:00+09:00', '');
    task('utc', '2026-08-20T20:00:00.000Z', '', 1);
    task('impossible-date', '2026-02-30', '書類を出す');
    task('impossible-time', '2026-02-30T10:00', '');
    task('words', '8月末', '会費を払う');
    task('compact-offset', '2026-08-20T15:00:00+0900', '');
    task('empty', '', '');
    task('blank', '   ', '');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT id, deadline, description, status FROM tasks ORDER BY id')).toEqual([
      { id: 'blank', deadline: null, description: '', status: 'open' },
      { id: 'compact-offset', deadline: null, description: '元の締切: 2026-08-20T15:00:00+0900', status: 'open' },
      { id: 'date', deadline: '2026-08-20', description: '', status: 'open' },
      { id: 'empty', deadline: null, description: '', status: 'open' },
      { id: 'impossible-date', deadline: null, description: '書類を出す\n\n元の締切: 2026-02-30', status: 'open' },
      { id: 'impossible-time', deadline: null, description: '元の締切: 2026-02-30T10:00', status: 'open' },
      { id: 'local-space', deadline: '2026-08-20', description: '', status: 'open' },
      { id: 'local-time', deadline: '2026-08-20', description: '', status: 'open' },
      { id: 'offset', deadline: '2026-08-20', description: '', status: 'open' },
      { id: 'utc', deadline: '2026-08-21', description: '', status: 'completed' },
      { id: 'words', deadline: null, description: '会費を払う\n\n元の締切: 8月末', status: 'open' },
    ]);
  });

  it('drops the Proposed Actions table, rows and all, once Rule Effects hold every write', async () => {
    const database = databaseBeforeAgentRuleOnly();
    database.execute(
      `INSERT INTO proposed_actions (id, agent_run_id, agent_rule_id, tool, arguments, status, created_at, expires_at)
       VALUES ('proposal-1', 'run-1', 'agent-rule-1', 'send_line_message', '{}', 'approved', '2026-08-01', '2026-08-02')`,
    );

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows("SELECT name FROM sqlite_master WHERE name LIKE 'proposed_actions%'")).toEqual([]);
  });

  it('rebuilds the automation tables as one Automation, one Run, and one Planned Write, keeping every record people made', async () => {
    const database = databaseBefore('0041_one_automation.sql');
    const at = '2026-08-01T00:00:00.000Z';
    database.execute("INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('contact-1', 'organization-1', '田中', 'tanaka@example.com', 'active', '[]', ?, ?)", at, at);
    database.execute("INSERT INTO prompts (id, organization_id, name, instructions, current_revision, created_at, updated_at) VALUES ('intake', 'organization-1', 'メールの取り込み', 'Act.', 1, ?, ?)", at, at);
    database.execute(
      `INSERT INTO agent_rules (id, organization_id, name, status, execution_mode, prompt_id, selection_policy, priority, current_revision, created_at, updated_at)
       VALUES ('agent-1', 'organization-1', 'すべてのメール', 'active', 'unattended', 'intake', '{}', -1, 1, ?, ?)`,
      at, at,
    );
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '例会', ?, 'processed')", at);
    database.execute(
      `INSERT INTO events (id, organization_id, agent_rule_id, source_message_id, google_event_id, title, starts_at, ends_at, location, description, status, created_at, updated_at, calendar_description)
       VALUES ('event-1', 'organization-1', 'agent-1', 'source-1', 'google-1', '例会', '2026-08-03T19:00:00+09:00', '2026-08-03T21:00:00+09:00', '', '', 'scheduled', ?, ?, '')`,
      at, at,
    );
    database.execute("INSERT INTO event_recipients (event_id, member_id, name_snapshot, email_snapshot, created_at) VALUES ('event-1', 'contact-1', '田中', 'tanaka@example.com', ?)", at);
    database.execute(
      `INSERT INTO rule_runs (id, agent_rule_id, rule_revision, source_message_id, execution_mode, intent, status, created_at, updated_at)
       VALUES ('mail-run', 'agent-1', 1, 'source-1', 'unattended', 'live', 'completed', ?, ?),
              ('chat-run', NULL, 0, NULL, 'unattended', 'chat', 'completed', ?, ?)`,
      at, at, at, at,
    );
    database.execute(
      `INSERT INTO rule_effects (id, rule_run_id, effect_key, kind, arguments, depends_on, idempotency_key, status, attempts, created_at, updated_at)
       VALUES ('effect-1', 'mail-run', 'create_task:0', 'agent.create_task', '{}', '[]', 'key-1', 'succeeded', 1, ?, ?)`,
      at, at,
    );
    database.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, rule_effect_id, title, assignee_name, description, remarks, status, completed, created_at, updated_at, scheduled_event_id, scheduled_event_title)
       VALUES ('task-1', 'organization-1', 'source-1', '例会', 'effect-1', '会場を予約する', '未割り当て', '', '', 'open', 0, ?, ?, 'event-1', '例会')`,
      at, at,
    );
    database.execute("INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('conversation-1', 'organization-1', '相談', ?, ?)", at, at);
    database.execute(
      `INSERT INTO chat_turns (id, conversation_id, rule_run_id, position, request, response, status, created_at, updated_at)
       VALUES ('turn-1', 'conversation-1', 'chat-run', 0, '予定は？', '例会があります。', 'completed', ?, ?)`,
      at, at,
    );
    database.execute("INSERT INTO settings (key, value, updated_at) VALUES ('baseline-agent-rule:v1', '{}', ?), ('morning-automation:v1', '{}', ?), ('kept', '1', ?)", at, at, at);

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    const tables = database.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(({ name }) => name);
    expect(tables).toEqual(expect.arrayContaining(['skills', 'skill_revisions', 'automations', 'automation_skills', 'automation_tools', 'automation_revisions', 'runs', 'planned_writes']));
    for (const gone of ['agent_rules', 'rule_runs', 'rule_effects', 'agent_runs', 'rules', 'lists', 'list_items', 'prompts', 'prompt_revisions']) expect(tables).not.toContain(gone);
    expect(tables.filter((name) => name.startsWith('agent_rule') || name.startsWith('rule_') || name.startsWith('carry_'))).toEqual([]);
    expect(database.rows('SELECT id, automation_id, source_message_id, title FROM events')).toEqual([{ id: 'event-1', automation_id: null, source_message_id: 'source-1', title: '例会' }]);
    expect(database.rows('SELECT event_id, member_id FROM event_recipients')).toEqual([{ event_id: 'event-1', member_id: 'contact-1' }]);
    expect(database.rows('SELECT id, planned_write_id, scheduled_event_id FROM tasks')).toEqual([{ id: 'task-1', planned_write_id: null, scheduled_event_id: 'event-1' }]);
    expect(database.rows('SELECT id, trigger, automation_id, status FROM runs')).toEqual([{ id: 'chat-run', trigger: 'chat', automation_id: null, status: 'completed' }]);
    expect(database.rows('SELECT id, run_id, response FROM chat_turns')).toEqual([{ id: 'turn-1', run_id: 'chat-run', response: '例会があります。' }]);
    expect(database.rows('SELECT key FROM settings ORDER BY key')).toEqual([{ key: 'kept' }]);
    expect(() => database.execute(
      `INSERT INTO automations (id, account_id, name, trigger, state, execution_mode, suppression_window, revision, created_at, updated_at)
       VALUES ('mail-without-policy', 'organization-1', 'メール', 'mail', 'active', 'unattended', 'none', 1, ?, ?)`,
      at, at,
    )).toThrow();
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('makes each Operator Chat exchange already kept follow the one before it in its conversation', async () => {
    const database = databaseBefore('0047_chat_branches.sql');
    const at = '2026-10-30T00:00:00.000Z';
    database.execute(
      `INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at)
       VALUES ('run-1', 'chat', 'unattended', 'completed', ?, ?), ('run-2', 'chat', 'unattended', 'completed', ?, ?),
              ('run-3', 'chat', 'unattended', 'failed', ?, ?), ('run-4', 'chat', 'unattended', 'completed', ?, ?)`,
      at, at, at, at, at, at, at, at,
    );
    database.execute("INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('one', 'organization-1', '相談', ?, ?), ('two', 'organization-1', '別件', ?, ?)", at, at, at, at);
    // Positions need not start at one or be consecutive: a conversation carried across migration 0041 began at zero.
    database.execute(
      `INSERT INTO chat_turns (id, conversation_id, run_id, position, request, response, status, created_at, updated_at)
       VALUES ('one-c', 'one', 'run-3', 5, '場所は？', NULL, 'failed', ?, ?),
              ('one-a', 'one', 'run-1', 0, '予定は？', '例会です。', 'completed', ?, ?),
              ('one-b', 'one', 'run-2', 2, 'いつ？', '3日です。', 'completed', ?, ?),
              ('two-a', 'two', 'run-4', 1, '別件は？', 'ありません。', 'completed', ?, ?)`,
      at, at, at, at, at, at, at, at,
    );

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT id, parent_turn_id FROM chat_turns ORDER BY conversation_id, position')).toEqual([
      { id: 'one-a', parent_turn_id: null },
      { id: 'one-b', parent_turn_id: 'one-a' },
      { id: 'one-c', parent_turn_id: 'one-b' },
      { id: 'two-a', parent_turn_id: null },
    ]);
  });

  it('gives every memory kept before Episodes an Episode of its own words, and renames the memory search a Tool Grant names', async () => {
    const database = databaseBefore('0050_memory_episodes.sql');
    const at = '2026-11-01T00:00:00.000Z';
    database.execute("INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-1', 'chat', 'unattended', 'completed', ?, ?)", at, at);
    database.execute("INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('talk', 'organization-1', '相談', ?, ?)", at, at);
    database.execute("INSERT INTO chat_turns (id, conversation_id, run_id, position, request, response, status, created_at, updated_at) VALUES ('turn-1', 'talk', 'run-1', 0, '覚えて', '覚えました。', 'completed', ?, ?)", at, at);
    // Every shape 0048 onward wrote: each author kind, the same words twice, words a member changed, and empty words.
    database.execute(
      `INSERT INTO memories (id, content, author_kind, author_name, conversation_id, turn_id, edited_by, created_at, updated_at) VALUES
        ('chat-1', '山田さんは和食が好き', 'chat', '', 'talk', 'turn-1', NULL, '2026-11-01T01:00:00.000Z', '2026-11-01T01:00:00.000Z'),
        ('chat-2', '山田さんは和食が好き', 'chat', '', 'talk', 'turn-1', NULL, '2026-11-01T02:00:00.000Z', '2026-11-01T02:00:00.000Z'),
        ('cli-1', '例会は第2土曜', 'cli', '山田', NULL, NULL, '田中', '2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
        ('person-1', '', 'person', '田中', NULL, NULL, NULL, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`,
    );
    database.execute("INSERT INTO memory_uses (turn_id, memory_id, use, created_at) VALUES ('turn-1', 'chat-1', 'saved', ?)", at);
    database.execute(
      `INSERT INTO automations (id, account_id, name, trigger, state, execution_mode, suppression_window, revision, schedule, created_at, updated_at)
       VALUES ('one', 'organization-1', '朝', 'schedule', 'active', 'unattended', 'none', 1, 'daily 09:00', ?, ?), ('both', 'organization-1', '夜', 'schedule', 'active', 'unattended', 'none', 1, 'daily 21:00', ?, ?)`,
      at, at, at, at,
    );
    database.execute(
      `INSERT INTO automation_tools (automation_id, tool) VALUES
        ('one', 'searchMCPMemory'), ('one', 'mail.search'), ('both', 'searchMCPMemory'), ('both', 'memory.search')`,
    );

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT id, source, member_name, conversation_id, turn_id, content, content_hash, state, received_at FROM memory_episodes ORDER BY id')).toEqual([
      { id: 'legacy-chat-1', source: 'legacy', member_name: '', conversation_id: 'talk', turn_id: 'turn-1', content: '山田さんは和食が好き', content_hash: 'legacy:chat-1', state: 'committed', received_at: '2026-11-01T01:00:00.000Z' },
      { id: 'legacy-chat-2', source: 'legacy', member_name: '', conversation_id: 'talk', turn_id: 'turn-1', content: '山田さんは和食が好き', content_hash: 'legacy:chat-2', state: 'committed', received_at: '2026-11-01T02:00:00.000Z' },
      { id: 'legacy-cli-1', source: 'legacy', member_name: '山田', conversation_id: null, turn_id: null, content: '例会は第2土曜', content_hash: 'legacy:cli-1', state: 'committed', received_at: '2026-11-02T00:00:00.000Z' },
      { id: 'legacy-person-1', source: 'legacy', member_name: '田中', conversation_id: null, turn_id: null, content: '', content_hash: 'legacy:person-1', state: 'committed', received_at: '2026-11-04T00:00:00.000Z' },
    ]);
    expect(database.rows('SELECT id, episode_id, kind, speaker, provenance, status, evidence_start, evidence_end, valid_from, valid_to, indexed_at, edited_by FROM memories ORDER BY id')).toEqual([
      { id: 'chat-1', episode_id: 'legacy-chat-1', kind: 'fact', speaker: 'agent', provenance: 3, status: 'active', evidence_start: 0, evidence_end: 10, valid_from: '2026-11-01T01:00:00.000Z', valid_to: null, indexed_at: null, edited_by: null },
      { id: 'chat-2', episode_id: 'legacy-chat-2', kind: 'fact', speaker: 'agent', provenance: 3, status: 'active', evidence_start: 0, evidence_end: 10, valid_from: '2026-11-01T02:00:00.000Z', valid_to: null, indexed_at: null, edited_by: null },
      { id: 'cli-1', episode_id: 'legacy-cli-1', kind: 'fact', speaker: 'agent', provenance: 3, status: 'active', evidence_start: 0, evidence_end: 7, valid_from: '2026-11-02T00:00:00.000Z', valid_to: null, indexed_at: null, edited_by: '田中' },
      { id: 'person-1', episode_id: 'legacy-person-1', kind: 'fact', speaker: 'user', provenance: 1, status: 'active', evidence_start: 0, evidence_end: 0, valid_from: '2026-11-04T00:00:00.000Z', valid_to: null, indexed_at: null, edited_by: null },
    ]);
    expect(database.rows('SELECT memory_id, actor_kind, action FROM memory_changes ORDER BY memory_id')).toEqual(
      ['chat-1', 'chat-2', 'cli-1', 'person-1'].map((memory_id) => ({ memory_id, actor_kind: 'maintenance', action: 'import' })),
    );
    expect(database.rows('SELECT asked_by_identity, asked_by_name FROM chat_turns')).toEqual([{ asked_by_identity: null, asked_by_name: '' }]);
    expect(database.rows('SELECT automation_id, tool FROM automation_tools ORDER BY automation_id, tool')).toEqual([
      { automation_id: 'both', tool: 'memory.search' },
      { automation_id: 'one', tool: 'mail.search' },
      { automation_id: 'one', tool: 'memory.search' },
    ]);
    expect(database.rows('SELECT memory_id, use FROM memory_uses')).toEqual([{ memory_id: 'chat-1', use: 'saved' }]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('archives the Automations a mail or the Morning started, expires their waiting runs, and drops the Morning and the reminder settings', async () => {
    const database = databaseBefore('0042_skills_name_the_reader.sql');
    const at = '2026-10-14T20:00:00.000Z';
    database.execute("INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('contact-1', 'organization-1', '田中', 'tanaka@example.com', 'active', '[]', ?, ?)", at, at);
    database.execute("INSERT INTO contact_lists (id, account_id, name, description, created_at, updated_at) VALUES ('list-1', 'organization-1', '役員', '', ?, ?)", at, at);
    database.execute(
      `INSERT INTO automations (id, account_id, name, trigger, state, execution_mode, contact_list_id, suppression_window, revision, selection_policy, priority, schedule, next_run_at, created_at, updated_at)
       VALUES ('mail', 'organization-1', 'すべてのメール', 'mail', 'active', 'approval', 'list-1', 'none', 1, '{}', -1, NULL, NULL, ?, ?),
              ('morning', 'organization-1', '朝のお知らせ', 'morning', 'suspended', 'unattended', NULL, 'none', 1, NULL, NULL, NULL, NULL, ?, ?),
              ('timed', 'organization-1', '朝の確認', 'schedule', 'active', 'unattended', 'list-1', 'day', 1, NULL, NULL, 'daily 09:00', '2026-10-15T00:00:00.000Z', ?, ?)`,
      at, at, at, at, at, at,
    );
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '例会', ?, 'processed'), ('source-2', 'gmail-2', 'history-2', 'sender@example.com', '総会', ?, 'processed')", at, at);
    database.execute(
      `INSERT INTO runs (id, trigger, automation_id, automation_revision, source_message_id, execution_mode, status, started_at, updated_at)
       VALUES ('held', 'mail', 'mail', 1, 'source-1', 'approval', 'pending_approval', ?, ?),
              ('done', 'mail', 'mail', 1, 'source-2', 'approval', 'completed', ?, ?)`,
      at, at, at, at,
    );
    database.execute(
      `INSERT INTO planned_writes (id, run_id, key, tool, arguments, idempotency_key, status, created_at, updated_at)
       VALUES ('held-write', 'held', 'report:0', 'report', '{"summary":"例会"}', 'key-held', 'planned', ?, ?),
              ('done-write', 'done', 'create_task:0', 'create_task', '{}', 'key-done', 'succeeded', ?, ?)`,
      at, at, at, at,
    );
    database.execute("INSERT INTO morning_entries (id, channel, destination, body, state, attempts, created_at) VALUES ('entry-1', 'line', 'Uabc', '本文', 'pending', 0, ?)", at);
    database.execute("INSERT INTO settings (key, value, updated_at) VALUES ('task_reminders_enabled', 'true', ?), ('task_reminder_days', '[7,3]', ?), ('morning_notice_sent_for', ?, ?), ('kept', '1', ?)", at, at, at, at, at);

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT id, state, contact_list_id, next_run_at FROM automations ORDER BY id')).toEqual([
      { id: 'mail', state: 'archived', contact_list_id: null, next_run_at: null },
      { id: 'morning', state: 'archived', contact_list_id: null, next_run_at: null },
      { id: 'timed', state: 'active', contact_list_id: null, next_run_at: '2026-10-15T00:00:00.000Z' },
    ]);
    expect(database.rows('SELECT id, status FROM runs ORDER BY id')).toEqual([{ id: 'done', status: 'completed' }, { id: 'held', status: 'expired' }]);
    expect(database.rows('SELECT id, status FROM planned_writes ORDER BY id')).toEqual([{ id: 'done-write', status: 'succeeded' }, { id: 'held-write', status: 'expired' }]);
    const tables = database.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(({ name }) => name);
    expect(tables).not.toContain('morning_entries');
    expect(tables).not.toContain('morning_notices');
    expect(database.rows('SELECT key FROM settings ORDER BY key')).toEqual([{ key: 'kept' }]);
    database.execute("DELETE FROM contact_lists WHERE id = 'list-1'");
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps every MCP Server as it was, with its static token and signed in to by no one', async () => {
    const database = databaseBefore('0057_mcp_oauth.sql');
    const at = '2026-11-01T00:00:00.000Z';
    database.execute(
      `INSERT INTO mcp_servers (id, account_id, name, url, token_envelope, revision, created_at, updated_at)
       VALUES ('server-1', 'organization-1', 'line', 'https://mcp.line.example/mcp', '{"sealed":true}', '2025-06-18', ?, ?),
              ('server-2', 'organization-1', 'notion', 'https://mcp.notion.example/mcp', NULL, NULL, ?, ?)`,
      at, at, at, at,
    );
    const before = database.rows<Record<string, unknown>>('SELECT * FROM mcp_servers ORDER BY id');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT * FROM mcp_servers ORDER BY id')).toEqual(before.map((row) => ({ ...row, oauth_envelope: null, oauth_error: null })));
  });

  it('adds Operator Chat\'s tables and leaves every conversation of the chat before ADR 0201 as it was, copied there (0061)', async () => {
    const database = databaseBefore('0058_chat_threads.sql');
    const at = '2026-11-01T00:00:00.000Z';
    database.execute(
      `INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('conversation-1', 'organization-1', '予定', ?, ?)`,
      at, at,
    );
    const before = database.rows<Record<string, unknown>>('SELECT * FROM chat_conversations');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT * FROM chat_conversations')).toEqual(before);
    expect(database.rows('SELECT id, title, last_sequence, created_at, updated_at FROM chat_threads')).toEqual([
      { id: 'conversation-1', title: '予定', last_sequence: 0, created_at: at, updated_at: at },
    ]);
    expect(database.rows('SELECT * FROM chat_events')).toEqual([]);
    expect(database.rows('SELECT * FROM chat_files')).toEqual([]);
  });

  it('copies every conversation of the chat before ADR 0201, in every shape it was kept, into Operator Chat as events t3code reads, rewriting none', async () => {
    const database = databaseBefore('0061_chat_conversations_copied.sql');
    for (const statement of LEGACY_CHAT) database.execute(statement);
    const legacy = ['chat_conversations', 'chat_turns', 'chat_attachments', 'runs'];
    const before = legacy.map((table) => database.rows<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`));

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    // The old chat's rows stay as they were but for the Run of the exchange left being written, which 0063 fails.
    const after = legacy.map((table) => database.rows<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`));
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    // 0065 adds each Run's browser time, 0 for every Run written before it.
    expect(after[3]?.filter((row) => row.id !== 'run-c1')).toEqual(before[3]?.filter((row) => row.id !== 'run-c1').map((row) => ({ ...row, browser_ms: 0 })));
    expect(after[3]?.find((row) => row.id === 'run-c1')).toMatchObject({ status: 'failed' });
    const threads = database.rows<{ id: string; title: string; last_sequence: number }>('SELECT id, title, last_sequence FROM chat_threads ORDER BY id');
    expect(Object.fromEntries(threads.map((row) => [row.id, row.title]))).toEqual(COPIED_TITLES);
    for (const thread of threads) {
      const events = database.rows<{ sequence: number; type: string; payload: string }>('SELECT sequence, type, payload FROM chat_events WHERE thread_id = ? ORDER BY sequence', thread.id);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(thread.last_sequence).toBe(events.length);
      let projection = emptyProjection(threadOf({ id: thread.id, title: thread.title, createdAt: 0, updatedAt: 0 }));
      for (const event of events) projection = foldEvent(projection, decodeEvent(event.payload));
      expect(projection.runs.map((run) => run.id)).toEqual((COPIED_PATHS[thread.id] ?? []).map((turnId) => `run-${turnId}`));
      expect(projection.visibleTurnItems).toHaveLength(projection.turnItems.length);
    }
    expect(database.rows("SELECT name FROM sqlite_master WHERE name = 'chat_import_turns'")).toEqual([]);
  });

  it('adds Operator Chat\'s approval tables empty and leaves every conversation as it was', async () => {
    const database = databaseBefore('0059_chat_approvals.sql');
    const at = '2026-11-21T00:00:00.000Z';
    database.execute(
      `INSERT INTO chat_threads (id, account_id, title, last_sequence, created_by_identity, created_by_name, created_at, updated_at) VALUES ('thread-1', 'organization-1', '予定', 3, 'identity-1', '山田', ?, ?)`,
      at, at,
    );
    database.execute(`INSERT INTO chat_events (thread_id, sequence, type, payload, created_at) VALUES ('thread-1', 1, 'run.created', '{}', ?)`, at);
    const before = database.rows<Record<string, unknown>>('SELECT * FROM chat_threads');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT * FROM chat_threads')).toEqual(before);
    expect(database.rows('SELECT * FROM chat_thread_modes')).toEqual([]);
    expect(database.rows('SELECT * FROM chat_pauses')).toEqual([]);
    expect(database.rows('SELECT * FROM chat_tool_allowances')).toEqual([]);
    expect(() => database.execute(`INSERT INTO chat_thread_modes (thread_id, mode, changed_at) VALUES ('thread-1', 'sometimes', ?)`, at)).toThrow('chat_thread_modes_mode_check');
  });

  it('keeps every file an answer kept as an answer\'s, first of its message, and checks where a file came from', async () => {
    const database = databaseBefore('0060_chat_message_files.sql');
    const at = '2026-11-21T00:00:00.000Z';
    database.execute(
      `INSERT INTO chat_threads (id, account_id, title, last_sequence, created_by_identity, created_by_name, created_at, updated_at) VALUES ('thread-1', 'organization-1', '予定', 3, 'identity-1', '山田', ?, ?)`,
      at, at,
    );
    database.execute(
      `INSERT INTO chat_files (id, thread_id, run_id, filename, media_type, size, object_key, created_at) VALUES ('file-1', 'thread-1', 'run-1', '表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 12, 'chat-files/organization-1/file-1', ?)`,
      at,
    );
    const before = database.rows<Record<string, unknown>>('SELECT * FROM chat_files');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT * FROM chat_files')).toEqual(before.map((row) => ({ ...row, origin: 'response', position: 0 })));
    expect(() => database.execute(
      `INSERT INTO chat_files (id, thread_id, run_id, filename, media_type, size, object_key, created_at, origin) VALUES ('file-2', 'thread-1', 'run-1', 'a.png', 'image/png', 1, 'k', ?, 'upload')`,
      at,
    )).toThrow('chat_files_origin_check');
  });

  it('names every Skill as Agent Skills name one, keeps the name it had as its title, and fails no row (0064)', async () => {
    const database = databaseBefore('0064_agent_skills_names.sql');
    const at = '2026-11-22T00:00:00.000Z';
    const skill = (id: string, name: string) => database.execute(
      "INSERT INTO skills (id, account_id, name, description, instructions, revision, published, created_at, updated_at) VALUES (?, 'organization-1', ?, '', '', 1, 0, ?, ?)",
      id, name, at, at,
    );
    skill('aaaaaaaa-1111-2222-3333-444444444444', 'タスクの管理');
    skill('bbbbbbbb-1111-2222-3333-444444444444', 'メールの取り込み');
    skill('cccccccc-1111-2222-3333-444444444444', 'Weekly Report');
    skill('dddddddd-1111-2222-3333-444444444444', '招待行事の登録対応');
    skill('eeeeeeee-1111-2222-3333-444444444444', 'already-fine');
    // A Skill an Account already named task-reminder keeps it, so the starting one takes a name from its id.
    skill('ffffffff-1111-2222-3333-444444444444', 'task-reminder');
    skill('99999999-1111-2222-3333-444444444444', 'タスクのリマインド');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows<Record<string, unknown>>('SELECT id, name, title, directory FROM skills ORDER BY id')).toEqual([
      { id: '99999999-1111-2222-3333-444444444444', name: 'skill-999999991111', title: 'タスクのリマインド', directory: null },
      { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'task-management', title: 'タスクの管理', directory: null },
      { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'mail-intake', title: 'メールの取り込み', directory: null },
      { id: 'cccccccc-1111-2222-3333-444444444444', name: 'weekly-report', title: 'Weekly Report', directory: null },
      { id: 'dddddddd-1111-2222-3333-444444444444', name: 'skill-dddddddd1111', title: '招待行事の登録対応', directory: null },
      { id: 'eeeeeeee-1111-2222-3333-444444444444', name: 'already-fine', title: 'already-fine', directory: null },
      { id: 'ffffffff-1111-2222-3333-444444444444', name: 'task-reminder', title: 'task-reminder', directory: null },
    ]);
  });

  it('fails the Run of every exchange the chat before ADR 0201 left being written, and no other Run (0063)', async () => {
    const database = databaseBefore('0063_chat_runs_abandoned.sql');
    for (const statement of LEGACY_CHAT) database.execute(statement);
    // An Automation's Run being planned, and a Run of Operator Chat's answer being written, which no old exchange names.
    database.execute("INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, schedule, created_at, updated_at) VALUES ('automation-x', 'organization-1', '朝', 'schedule', 1, 'unattended', 'none', 1, 'daily 05:00', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')");
    database.execute("INSERT INTO runs (id, trigger, automation_id, automation_revision, execution_mode, status, started_at, updated_at) VALUES ('run-automation', 'schedule', 'automation-x', 1, 'unattended', 'planning', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')");
    database.execute("INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-answer', 'chat', 'unattended', 'planning', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')");
    const before = database.rows<Record<string, unknown>>('SELECT * FROM runs ORDER BY id');
    const turns = database.rows<Record<string, unknown>>('SELECT * FROM chat_turns ORDER BY id');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    const after = database.rows<Record<string, unknown>>('SELECT * FROM runs ORDER BY id');
    // 0065 adds each Run's browser time, 0 for every Run written before it.
    expect(after.filter((row) => row.id !== 'run-c1')).toEqual(before.filter((row) => row.id !== 'run-c1').map((row) => ({ ...row, browser_ms: 0 })));
    // c1's own times were '', so it closes when its Run was last changed.
    expect(after.find((row) => row.id === 'run-c1')).toMatchObject({
      status: 'failed', error: '答えを書き終える前に処理が止まりました。もう一度送ってください。', finished_at: '2026-11-01T00:00:00.000Z',
    });
    expect(database.rows('SELECT * FROM chat_turns ORDER BY id')).toEqual(turns);
  });

  it('adds the push tables empty, leaves every conversation as it was, and keeps one row per push address and one notice of a kind per answer', async () => {
    const database = databaseBefore('0062_push_subscriptions.sql');
    const at = '2026-11-21T00:00:00.000Z';
    database.execute(
      `INSERT INTO chat_threads (id, account_id, title, last_sequence, created_by_identity, created_by_name, created_at, updated_at) VALUES ('thread-1', 'organization-1', '予定', 3, 'identity-1', '山田', ?, ?)`,
      at, at,
    );
    const before = database.rows<Record<string, unknown>>('SELECT * FROM chat_threads');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT * FROM chat_threads')).toEqual(before);
    expect(database.rows('SELECT * FROM push_subscriptions')).toEqual([]);
    expect(database.rows('SELECT * FROM chat_notices')).toEqual([]);
    database.execute(`INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at) VALUES ('s1', 'identity-1', 'https://push.example.net/a', 'k', 'a', ?)`, at);
    expect(() => database.execute(`INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at) VALUES ('s2', 'identity-2', 'https://push.example.net/a', 'k', 'a', ?)`, at)).toThrow('UNIQUE');
    database.execute(`INSERT INTO chat_notices (thread_id, run_id, kind, created_at) VALUES ('thread-1', 'run-1', 'completed', ?)`, at);
    expect(() => database.execute(`INSERT INTO chat_notices (thread_id, run_id, kind, created_at) VALUES ('thread-1', 'run-1', 'completed', ?)`, at)).toThrow('UNIQUE');
    expect(() => database.execute(`INSERT INTO chat_notices (thread_id, run_id, kind, created_at) VALUES ('thread-1', 'run-1', 'started', ?)`, at)).toThrow('chat_notices_kind_check');
  });

  it('leaves every Task as it is with no Google task yet, and renames the Task tools a Tool Grant names', async () => {
    const database = databaseBefore('0055_tasks_in_google.sql');
    const at = '2026-11-01T00:00:00.000Z';
    database.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_name, description, status, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', NULL, '', '振り込む', '2026-11-20', '山田', '', 'open', 0, ?, ?),
              ('task-2', 'organization-1', NULL, '', '会場を予約する', NULL, '未割り当て', '', 'cancelled', 0, ?, ?)`,
      at, at, at, at,
    );
    database.execute(
      `INSERT INTO automations (id, account_id, name, trigger, state, execution_mode, suppression_window, revision, schedule, created_at, updated_at)
       VALUES ('old', 'organization-1', '朝', 'schedule', 'active', 'unattended', 'none', 1, 'daily 09:00', ?, ?), ('both', 'organization-1', '夜', 'schedule', 'active', 'unattended', 'none', 1, 'daily 21:00', ?, ?)`,
      at, at, at, at,
    );
    database.execute(
      `INSERT INTO automation_tools (automation_id, tool) VALUES
        ('old', 'query_tasks'), ('old', 'create_task'), ('old', 'update_task'), ('old', 'mail.search'),
        ('both', 'query_tasks'), ('both', 'tasks.search')`,
    );
    database.execute("INSERT INTO contact_lists (id, account_id, name, created_at, updated_at) VALUES ('list-1', 'organization-1', '役員', ?, ?)", at, at);
    database.execute(
      `INSERT INTO access_tokens (id, account_id, name, token_hash, contact_list_id, suppression_window, created_at, updated_at)
       VALUES ('token-1', 'organization-1', '外部', 'hash-1', 'list-1', 'day', ?, ?)`,
      at, at,
    );
    database.execute("INSERT INTO access_token_tools (token_id, tool) VALUES ('token-1', 'query_tasks'), ('token-1', 'create_task'), ('token-1', 'query_contacts')");
    const before = database.rows<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id');

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows('SELECT * FROM tasks ORDER BY id')).toEqual(before.map((row) => ({ ...row, google_task_id: null })));
    expect(database.rows('SELECT automation_id, tool FROM automation_tools ORDER BY automation_id, tool')).toEqual([
      { automation_id: 'both', tool: 'tasks.search' },
      { automation_id: 'old', tool: 'mail.search' },
      { automation_id: 'old', tool: 'tasks.create' },
      { automation_id: 'old', tool: 'tasks.search' },
      { automation_id: 'old', tool: 'tasks.update' },
    ]);
    expect(database.rows('SELECT token_id, tool FROM access_token_tools ORDER BY tool')).toEqual([{ token_id: 'token-1', tool: 'query_contacts' }]);
  });

  it('includes every checked-in Account migration in the current schema', async () => {
    const database = createTestD1Database();
    openDatabases.push(database);
    const checkedInMigrations = readdirSync(resolve(
      import.meta.dirname,
      '../migrations/organization',
    )).filter((name) => name.endsWith('.sql')).sort();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    });

    expect(receipt.appliedMigrations).toEqual(checkedInMigrations);
  });

  it('includes every checked-in Control migration in the current schema', async () => {
    const database = createTestD1Database();
    openDatabases.push(database);
    const checkedInMigrations = readdirSync(resolve(
      import.meta.dirname,
      '../migrations/control',
    )).filter((name) => name.endsWith('.sql')).sort();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'control',
      database: database.binding,
    });

    expect(receipt.appliedMigrations).toEqual(checkedInMigrations);
  });

  it('converges when two callers migrate the same Account database concurrently', async () => {
    const database = databaseAtInitialAccountSchema();

    const receipts = await Promise.all([
      schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }),
      schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }),
    ]);

    expect(receipts).toEqual([
      expect.objectContaining({ currentMigration: '0065_runs_browser_time.sql' }),
      expect.objectContaining({ currentMigration: '0065_runs_browser_time.sql' }),
    ]);
  });

  it('records no browser time for every Run written before it, and refuses a negative one (0065)', async () => {
    const database = databaseBefore('0065_runs_browser_time.sql');
    database.execute("INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-1', 'chat', 'unattended', 'completed', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z')");

    await expect(schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }))
      .resolves.toMatchObject({ currentMigration: '0065_runs_browser_time.sql' });

    expect(database.rows<{ browser_ms: number }>("SELECT browser_ms FROM runs WHERE id = 'run-1'")).toEqual([{ browser_ms: 0 }]);
    expect(() => database.execute("UPDATE runs SET browser_ms = -1 WHERE id = 'run-1'")).toThrow('CHECK');
  });
});
