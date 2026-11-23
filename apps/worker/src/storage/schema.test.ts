import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { seedAutomation } from '../../test/automation';
import { createMigratedTestD1 } from '../../test/d1';
import { connections, googleConnections } from './account-schema';

const migrations = (kind: 'control' | 'organization'): string[] =>
  readdirSync(resolve(import.meta.dirname, `../../migrations/${kind}`))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const migrationSql = (kind: 'control' | 'organization'): string =>
  readFileSync(resolve(import.meta.dirname, `../../migrations/${kind}/0000_initial.sql`), 'utf8');

const workerPackage = (): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

const rootPackage = (): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

const applicationSources = (): Array<{ name: string; source: string }> => {
  const sourceRoot = resolve(import.meta.dirname, '..');
  const infrastructure = new Set([
    'cloudflare.ts',
    'account-db.ts',
    'schema-lifecycle.ts',
    'storage/database.ts',
  ]);
  return readdirSync(sourceRoot, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !infrastructure.has(name))
    .map((name) => ({ name, source: readFileSync(resolve(sourceRoot, name), 'utf8') }));
};

const tableNames = (kind: 'control' | 'organization'): string[] => {
  const database = createMigratedTestD1(kind);
  try {
    return database.rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((row) => row.name);
  } finally {
    database.close();
  }
};

describe('canonical D1 schemas', () => {
  it('has one Drizzle-generated initial migration per database kind', () => {
    expect(migrations('control')).toEqual([
      '0000_initial.sql',
      '0001_schema_release.sql',
      '0002_preset_selection.sql',
      '0003_admins.sql',
      '0004_single_admin_role.sql',
      '0005_member_logins.sql',
      '0006_account_without_inbox.sql',
    ]);
    expect(migrations('organization')).toEqual([
      '0000_initial.sql',
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
      '0066_key_browsers.sql',
    ]);
  });

  it('applies local D1 migrations before starting the Worker dev server', () => {
    expect(workerPackage().scripts?.predev).toBe('npm run db:local');
  });

  it('writes the deploy configuration, then rehearses, migrates, makes sure of the Memory index, and verifies the production database fleet before promoting Worker code', () => {
    expect(rootPackage().scripts?.['deploy:cloudflare']).toBe(
      'npm run deploy:config && npm run db:rehearse:remote && npm run db:migrate:control:remote && npm run db:migrate:organization:remote && npm run memory:index:remote && npm run deploy:worker:release -w @mail/worker && npm run db:migrate:complete:remote',
    );
  });

  it('creates only Control-plane tables in Control D1', () => {
    expect(tableNames('control')).toEqual([
      'admins',
      'automation_inbox_claims',
      'd1_migrations',
      'identities',
      'member_logins',
      'oauth_flows',
      'organization_keys',
      'organization_provisionings',
      'organization_setups',
      'organizations',
      'recovery_requests',
      'schema_releases',
      'sessions',
    ]);
    expect(migrationSql('control')).not.toMatch(
      /google_automations|automation_messages|organization_connections|passkeys|setup_sessions/u,
    );
  });

  it('models the Automation Inbox only in Account D1', () => {
    expect(tableNames('organization')).toContain('google_connections');
    expect(tableNames('organization')).toContain('d1_migrations');
    expect(tableNames('organization')).not.toContain('schema_migrations');
    expect(migrationSql('organization')).not.toMatch(/schema_migrations|kind.+google.+line.+ai/u);
  });

  it('lets a Run name an Automation and a Source Message only as its Trigger has them', () => {
    const database = createMigratedTestD1('organization');
    try {
      seedAutomation(database);
      database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '例会', '2026-08-01', 'processed')");
      const run = (id: string, trigger: string, automation: string, source: string): string =>
        `INSERT INTO runs (id, trigger, automation_id, automation_revision, source_message_id, execution_mode, status, started_at, updated_at)
         VALUES ('${id}', '${trigger}', ${automation}, ${automation === 'NULL' ? 'NULL' : 1}, ${source}, 'unattended', 'completed', '2026-08-01', '2026-08-01')`;

      expect(() => database.execute(run('mail', 'mail', "'automation-1'", "'source-1'"))).not.toThrow();
      expect(() => database.execute(run('chat', 'chat', 'NULL', 'NULL'))).not.toThrow();
      expect(() => database.execute(run('mail-without-source', 'mail', "'automation-1'", 'NULL'))).toThrow('runs_source_check');
      expect(() => database.execute(run('chat-with-automation', 'chat', "'automation-1'", 'NULL'))).toThrow('runs_automation_check');
      expect(() => database.execute(run('schedule-without-automation', 'schedule', 'NULL', 'NULL'))).toThrow('runs_automation_check');
      expect(() => database.execute("DELETE FROM automations WHERE id = 'automation-1'")).toThrow();
    } finally {
      database.close();
    }
  });

  it('removes an Operator Chat exchange’s attachments with the exchange', () => {
    const database = createMigratedTestD1('organization');
    try {
      database.execute("INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-1', 'chat', 'unattended', 'completed', '2026-10-12', '2026-10-12')");
      database.execute("INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('conversation-1', 'organization-1', 'Chat', '2026-10-12', '2026-10-12')");
      database.execute("INSERT INTO chat_turns (id, conversation_id, run_id, position, request, status, created_at, updated_at) VALUES ('turn-1', 'conversation-1', 'run-1', 1, 'Read this.', 'completed', '2026-10-12', '2026-10-12')");
      const attachment = (id: string, position: number): string =>
        `INSERT INTO chat_attachments (id, turn_id, position, filename, media_type, size, object_key, created_at) VALUES ('${id}', 'turn-1', ${position}, 'photo.png', 'image/png', 1024, 'chat-attachments/organization-1/${id}.json', '2026-10-12')`;

      database.execute(attachment('attachment-1', 1));
      expect(() => database.execute(attachment('attachment-2', 1))).toThrow();
      database.execute("DELETE FROM chat_conversations WHERE id = 'conversation-1'");
      expect(database.rows('SELECT id FROM chat_attachments')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects the removed generic Google connection shape at the type seam', () => {
    type AutomationInboxKind = typeof googleConnections.$inferInsert.kind;
    type AccountConnectionKind = typeof connections.$inferInsert.kind;

    expectTypeOf<AutomationInboxKind>().toEqualTypeOf<'automation_inbox'>();
    expectTypeOf<AccountConnectionKind>().toEqualTypeOf<'line' | 'ai' | 'discord'>();
  });

  it('keeps handwritten D1 statements out of application persistence', () => {
    const offenders = applicationSources()
      .filter(({ source }) => source.includes('.prepare('))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
