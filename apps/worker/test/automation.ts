import { AUTOMATION_TOOLS } from '@mail/domain';

import { createAccountKey, encrypt, masterKey, unwrapAccountKey } from '../src/cryptography';
import type { Bindings } from '../src/types';
import { createTestApp, type TestApp } from './app';
import type { MemoryR2 } from './seed';
import type { TestD1Database } from './d1';

const CREATED_AT = '2026-07-25T00:00:00.000Z';
const MASTER_KEY_MATERIAL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Gives the Account one active Automation that runs every morning at 05:00,
 * may call every tool an Automation can, and thinks with one Skill, and marks
 * the starting Automations as given, so the tick adds none of its own. It is
 * due only when a test gives it a next run.
 */
export const seedAutomation = (account: TestD1Database, options: { executionMode?: string; suppressionWindow?: string; nextRunAt?: string | null } = {}): void => {
  account.execute(
    `INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at)
     VALUES ('intake-skill', 'organization-1', 'メールの取り込み', 'Reading mail.', 'Read the mail that arrived and act on it.', 1, ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  account.execute("INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES ('intake-skill', 1, 'Read the mail that arrived and act on it.', ?)", CREATED_AT);
  const tools = AUTOMATION_TOOLS.map(({ name }) => name);
  account.execute(
    `INSERT INTO automations
      (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, schedule, next_run_at, created_at, updated_at)
     VALUES ('automation-1', 'organization-1', '毎朝のメール処理', 'schedule', 1, ?, ?, 1, 'daily 05:00', ?, ?, ?)`,
    options.executionMode ?? 'unattended',
    options.suppressionWindow ?? 'none',
    options.nextRunAt ?? null,
    CREATED_AT,
    CREATED_AT,
  );
  account.execute("INSERT INTO automation_skills (automation_id, skill_id, position) VALUES ('automation-1', 'intake-skill', 0)");
  for (const tool of tools) account.execute("INSERT INTO automation_tools (automation_id, tool) VALUES ('automation-1', ?)", tool);
  account.execute(
    `INSERT INTO automation_revisions (automation_id, revision, skill_ids, tools, execution_mode, suppression_window, created_at)
     VALUES ('automation-1', 1, '["intake-skill"]', ?, ?, ?, ?)`,
    JSON.stringify(tools),
    options.executionMode ?? 'unattended',
    options.suppressionWindow ?? 'none',
    CREATED_AT,
  );
  account.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ('starter-automations-0042', '{"intakeAutomationId":"automation-1"}', ?)`,
    CREATED_AT,
  );
};

export interface AutomationTestApp extends TestApp {
  environment: Bindings;
  transcriptR2: MemoryR2;
}

export const createAutomationTestApp = async (
  options: { ai?: boolean; enabled?: boolean; lineSecret?: string } = {},
): Promise<AutomationTestApp> => {
  const fixture = createTestApp({ includeAutomationInbox: false });
  const deploymentKey = await masterKey(MASTER_KEY_MATERIAL);
  const wrapped = await createAccountKey(deploymentKey, 'v1', 'organization-1');
  const accountKey = await unwrapAccountKey(wrapped, deploymentKey, 'organization-1');
  const googleCredential = await encrypt(
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      scopes: [],
      tokenType: 'Bearer',
    }),
    accountKey,
    'google-connection:organization-1:automation-inbox',
  );
  fixture.control.execute(
    `INSERT INTO organization_keys
      (organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    'organization-1',
    wrapped.masterKeyVersion,
    JSON.stringify(wrapped.envelope),
    CREATED_AT,
    CREATED_AT,
  );
  fixture.account.execute(
    `INSERT INTO google_connections
      (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
     VALUES (?, 'automation_inbox', ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    'inbox-1',
    'subject-1',
    'automation@example.com',
    '[]',
    JSON.stringify(googleCredential),
    'history-before-connection',
    options.enabled === false ? 0 : 1,
    CREATED_AT,
    CREATED_AT,
  );
  seedAutomation(fixture.account);
  if (options.ai) {
    const aiCredential = await encrypt(
      JSON.stringify({
        apiKey: 'api-key',
        baseUrl: 'https://ai.example.com/v1',
        model: 'test-model',
      }),
      accountKey,
      'organization-connection:organization-1:ai',
    );
    fixture.account.execute(
      `INSERT INTO connections
        (id, kind, label, credential, status, created_at, updated_at)
       VALUES (?, 'ai', ?, ?, 'active', ?, ?)`,
      'ai-1',
      'OpenAI-compatible API',
      JSON.stringify(aiCredential),
      CREATED_AT,
      CREATED_AT,
    );
  }
  if (options.lineSecret) {
    const lineCredential = await encrypt(
      JSON.stringify({
        channelSecret: options.lineSecret,
        channelAccessToken: 'line-token',
      }),
      accountKey,
      'organization-connection:organization-1:line',
    );
    fixture.account.execute(
      `INSERT INTO connections
        (id, kind, label, credential, status, created_at, updated_at)
       VALUES (?, 'line', ?, ?, 'active', ?, ?)`,
      'line-1',
      'LINE',
      JSON.stringify(lineCredential),
      CREATED_AT,
      CREATED_AT,
    );
  }
  fixture.environment.CREDENTIAL_MASTER_KEY = MASTER_KEY_MATERIAL;
  fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'v1';
  const transcriptR2 = fixture.r2;
  return { ...fixture, transcriptR2 };
};
