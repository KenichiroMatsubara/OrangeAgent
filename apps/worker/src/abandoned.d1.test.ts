/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import controlSchemaMigration from '../migrations/control/0000_initial.sql';
import abandonedMigration from '../migrations/organization/0063_chat_runs_abandoned.sql';
import { ACCOUNT, LEGACY_CHAT } from '../test/conversations';
import { provisionAccountDatabase } from './account-db';

declare global {
  namespace Cloudflare {
    interface Env {
      CONTROL_DB: D1Database;
      LOCAL_ORGANIZATION_DB_1: D1Database;
    }
  }
}

const ABANDONED = '答えを書き終える前に処理が止まりました。もう一度送ってください。';
/** A time as the Worker writes one, which the database's own clock gave. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** A fresh Account database with every migration applied, 0063 finding nothing to fail yet. */
const migratedAccount = async (): Promise<D1Database> => {
  await env.CONTROL_DB.batch(controlSchemaMigration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => env.CONTROL_DB.prepare(statement)));
  const provisioned = await provisionAccountDatabase({
    CONTROL_DB: env.CONTROL_DB,
    LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
  } as unknown as Parameters<typeof provisionAccountDatabase>[0], {
    accountId: ACCOUNT,
    ownerAddress: 'first@example.com',
    bindingName: 'ORG_ORGANIZATION1',
    databaseId: null,
  });
  await provisioned.initialize();
  return provisioned.database;
};

/** Applies migration 0063 as the Schema Lifecycle does: its statements in one batch. */
const fail = async (database: D1Database): Promise<void> => {
  await database.batch(abandonedMigration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => database.prepare(statement)));
};

const rows = async (database: D1Database, query: string): Promise<Array<Record<string, unknown>>> =>
  (await database.prepare(query).all<Record<string, unknown>>()).results;

/**
 * The exchanges production may hold left being written, beside the old chat's
 * conversations of every shape: one whose times are dates, one whose Run's
 * times are '' or no date (0041 coalesced missing ones to ''), one whose Run
 * recorded an error already, one whose Run its chat closed though the turn
 * stayed 'running', and a Run of an Automation and one of Operator Chat's own
 * answer, both being planned, which no exchange names.
 */
const seeded = async (): Promise<D1Database> => {
  const database = await migratedAccount();
  const at = '2026-11-03T08:00:00.000Z';
  await database.batch([
    ...LEGACY_CHAT,
    "INSERT INTO runs (id, trigger, execution_mode, status, model, tokens, tool_calls, started_at, updated_at) VALUES ('run-dated', 'chat', 'unattended', 'planning', 'test-model', 120, 2, '2026-11-03T08:00:00.000Z', '2026-11-03T08:00:05.000Z')",
    "INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-undated', 'chat', 'unattended', 'planning', '', 'yesterday')",
    "INSERT INTO runs (id, trigger, execution_mode, status, error, started_at, updated_at) VALUES ('run-erred', 'chat', 'unattended', 'planning', 'Gmail が混み合っています（429）。', '2026-11-03T08:00:00.000Z', '2026-11-03T08:00:00.000Z')",
    "INSERT INTO runs (id, trigger, execution_mode, status, finished_at, started_at, updated_at) VALUES ('run-closed', 'chat', 'unattended', 'completed', '2026-11-03T08:01:00.000Z', '2026-11-03T08:00:00.000Z', '2026-11-03T08:01:00.000Z')",
    "INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-answer', 'chat', 'unattended', 'planning', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
    `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, schedule, created_at, updated_at) VALUES ('automation-x', '${ACCOUNT}', '朝', 'schedule', 1, 'unattended', 'none', 1, 'daily 05:00', '${at}', '${at}')`,
    "INSERT INTO runs (id, trigger, automation_id, automation_revision, execution_mode, status, started_at, updated_at) VALUES ('run-automation', 'schedule', 'automation-x', 1, 'unattended', 'planning', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
    `INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('later', '${ACCOUNT}', '後で', '${at}', '${at}')`,
    "INSERT INTO chat_turns (id, conversation_id, run_id, position, request, status, created_at, updated_at) VALUES ('t-dated', 'later', 'run-dated', 1, 'a', 'running', '2026-11-03T08:00:00.000Z', '2026-11-03T08:00:30.000Z')",
    "INSERT INTO chat_turns (id, conversation_id, run_id, position, request, status, created_at, updated_at) VALUES ('t-undated', 'later', 'run-undated', 2, 'b', 'running', '', '')",
    "INSERT INTO chat_turns (id, conversation_id, run_id, position, request, status, created_at, updated_at) VALUES ('t-erred', 'later', 'run-erred', 3, 'c', 'running', '2026-11-03T08:00:00.000Z', 'not a date')",
    "INSERT INTO chat_turns (id, conversation_id, run_id, position, request, status, created_at, updated_at) VALUES ('t-closed', 'later', 'run-closed', 4, 'd', 'running', '2026-11-03T08:00:00.000Z', '2026-11-03T08:00:00.000Z')",
  ].map((statement) => database.prepare(statement)));
  return database;
};

describe('migration 0063 fails the Runs of the exchanges the chat before ADR 0201 left being written', () => {
  it('fails each such Run as that chat failed one, at the exchange\'s own last change, and keeps what it recorded', async () => {
    const database = await seeded();
    await fail(database);

    const runs = Object.fromEntries((await rows(database, 'SELECT * FROM runs ORDER BY id')).map((row) => [row.id, row]));
    expect(runs['run-dated']).toMatchObject({ status: 'failed', error: ABANDONED, finished_at: '2026-11-03T08:00:30.000Z', model: 'test-model', tokens: 120, tool_calls: 2 });
    expect(runs['run-dated']?.updated_at).toMatch(ISO);
    // With no date anywhere, it closes now.
    expect(runs['run-undated']).toMatchObject({ status: 'failed', error: ABANDONED });
    expect(runs['run-undated']?.finished_at).toMatch(ISO);
    // The error a Run recorded stays; an exchange with no date of its own closes when its Run last changed.
    expect(runs['run-erred']).toMatchObject({ status: 'failed', error: 'Gmail が混み合っています（429）。', finished_at: '2026-11-03T08:00:00.000Z' });
    // The fixture's exchange still being written (c1), whose own times are ''.
    expect(runs['run-c1']).toMatchObject({ status: 'failed', error: ABANDONED, finished_at: '2026-11-01T00:00:00.000Z' });
  });

  it('changes no Run closed already, no Run of an Automation or of Operator Chat\'s own answers, and nothing of the old chat\'s tables', async () => {
    const database = await seeded();
    const untouched = ['run-closed', 'run-answer', 'run-automation', 'run-a1', 'run-b2', 'run-d1', 'run-m2'];
    const before = await rows(database, `SELECT * FROM runs WHERE id IN (${untouched.map((id) => `'${id}'`).join(', ')}) ORDER BY id`);
    const tables = ['chat_conversations', 'chat_turns', 'chat_attachments'];
    const kept = await Promise.all(tables.map((table) => rows(database, `SELECT * FROM ${table} ORDER BY id`)));

    await fail(database);

    expect(await rows(database, `SELECT * FROM runs WHERE id IN (${untouched.map((id) => `'${id}'`).join(', ')}) ORDER BY id`)).toEqual(before);
    expect(await Promise.all(tables.map((table) => rows(database, `SELECT * FROM ${table} ORDER BY id`)))).toEqual(kept);
  });

  it('changes nothing run again', async () => {
    const database = await seeded();
    await fail(database);
    const once = await rows(database, 'SELECT * FROM runs ORDER BY id');

    await fail(database);

    expect(await rows(database, 'SELECT * FROM runs ORDER BY id')).toEqual(once);
  });
});
