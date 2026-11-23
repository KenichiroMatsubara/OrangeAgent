/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * An Account as the Worker serves it in the Workers runtime, for the suite
 * that drives the Worker's entry points and Durable Objects there
 * (vitest.do.config.ts): its route in the Control D1, its key, its Account D1
 * migrated as the Schema Lifecycle migrates one, and an AI Connection whose
 * model answers at `MODEL_URL`, which a test serves by replacing the global
 * `fetch` the Worker reads at every call. Storage starts empty for each test
 * (test/storage.ts), so each test seeds the Account it needs.
 */

import { streamedCompletion } from './stream';
import { env } from 'cloudflare:workers';

import { createAccountKey, encrypt, masterKey, unwrapAccountKey } from '../src/cryptography';
import { accountKeyFor } from '../src/keys';
import { schemaLifecycle } from '../src/schema-lifecycle';
import { accountDatabase } from '../src/storage/database';
import { createThread, type ThreadActor } from '../src/threads';
import { saveTranscriptionConnection } from '../src/transcription';
import { createTranscript } from '../src/transcripts';
import type { Bindings } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      LOCAL_ORGANIZATION_DB_1: D1Database;
    }
    /** The Worker the suite runs as its main module, which `exports` reaches. */
    interface GlobalProps {
      mainModule: typeof import('../src/index');
    }
  }
}

export const ACCOUNT = 'organization-1';
export const OWNER: ThreadActor = { identityId: 'identity-1', name: 'Owner' };
export const MODEL = 'test-model';
/** Where the AI Connection's OpenAI-compatible model is asked. */
export const MODEL_URL = 'https://ai.example.com/v1/chat/completions';

const CREATED_AT = '2026-07-25T00:00:00.000Z';
const BINDING = 'LOCAL_ORGANIZATION_DB_1';

/** Seeds an active Account with an AI Connection, and returns its Account D1. */
export const seedAccount = async (): Promise<D1Database> => {
  await schemaLifecycle.ensureCurrent({ kind: 'control', database: env.CONTROL_DB });
  const database = env.LOCAL_ORGANIZATION_DB_1;
  await schemaLifecycle.ensureCurrent({ kind: 'organization', database });
  const deploymentKey = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const wrapped = await createAccountKey(deploymentKey, env.CREDENTIAL_MASTER_KEY_VERSION, ACCOUNT);
  const accountKey = await unwrapAccountKey(wrapped, deploymentKey, ACCOUNT);
  const credential = await encrypt(
    JSON.stringify({ apiKey: 'ai-key', baseUrl: 'https://ai.example.com/v1', model: MODEL }),
    accountKey,
    `organization-connection:${ACCOUNT}:ai`,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO organizations (id, name, status, database_id, binding_name, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(ACCOUNT, ACCOUNT, `local:${BINDING}`, BINDING, CREATED_AT, CREATED_AT),
    env.CONTROL_DB.prepare(
      `INSERT INTO organization_keys (organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(ACCOUNT, wrapped.masterKeyVersion, JSON.stringify(wrapped.envelope), CREATED_AT, CREATED_AT),
  ]);
  await database.prepare(
    `INSERT INTO connections (id, kind, label, credential, status, created_at, updated_at)
     VALUES ('ai-1', 'ai', 'OpenAI-compatible API', ?, 'active', ?, ?)`,
  ).bind(JSON.stringify(credential), CREATED_AT, CREATED_AT).run();
  return database;
};

/** A new conversation of the seeded Account, started by its owner. */
export const seedThread = async (database: D1Database): Promise<string> =>
  (await createThread({ database, accountId: ACCOUNT, createdBy: OWNER, timestamp: CREATED_AT })).id;

/** What the AI Connection's model answers one request with: words, or one call of a tool. */
export type ModelReply = { text: string } | { call: { id: string; name: string; arguments: Record<string, unknown> } };

/** A Chat Completions response, streamed as Pi asks every model to answer. */
export const completion = (reply: ModelReply): Response => streamedCompletion({
  model: MODEL,
  choices: [{
    message: 'text' in reply
      ? { content: reply.text }
      : { content: null, tool_calls: [{ id: reply.call.id, function: { name: reply.call.name, arguments: JSON.stringify(reply.call.arguments) } }] },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/**
 * Gives the Account one active Automation that runs every morning at 05:00
 * with one Skill and no tool, due at `nextRunAt`, and marks the starting
 * Automations as given, so the tick adds none of its own.
 */
export const seedAutomation = async (database: D1Database, nextRunAt: string): Promise<void> => {
  await database.batch([
    database.prepare(
      `INSERT INTO skills (id, account_id, name, description, instructions, revision, created_at, updated_at)
       VALUES ('morning-skill', ?, '朝の確認', 'The morning check.', 'Say good morning.', 1, ?, ?)`,
    ).bind(ACCOUNT, CREATED_AT, CREATED_AT),
    database.prepare("INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES ('morning-skill', 1, 'Say good morning.', ?)").bind(CREATED_AT),
    database.prepare(
      `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, schedule, next_run_at, created_at, updated_at)
       VALUES ('automation-1', ?, '朝の確認', 'schedule', 1, 'unattended', 'none', 1, 'daily 05:00', ?, ?, ?)`,
    ).bind(ACCOUNT, nextRunAt, CREATED_AT, CREATED_AT),
    database.prepare("INSERT INTO automation_skills (automation_id, skill_id, position) VALUES ('automation-1', 'morning-skill', 0)"),
    database.prepare(
      `INSERT INTO automation_revisions (automation_id, revision, skill_ids, tools, execution_mode, suppression_window, created_at)
       VALUES ('automation-1', 1, '["morning-skill"]', '[]', 'unattended', 'none', ?)`,
    ).bind(CREATED_AT),
    database.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('starter-automations-0042', '{}', ?)").bind(CREATED_AT),
  ]);
};

/** A WAV recording's first bytes, which is all a recording is read by. */
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);

/** Where the Transcription Connection's OpenRouter model is asked. */
export const TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** Gives the seeded Account a Transcription Connection and one recording uploaded to be transcribed, and returns the transcript's id. */
export const seedTranscript = async (database: D1Database): Promise<string> => {
  const db = accountDatabase(database);
  const key = await accountKeyFor(env, ACCOUNT);
  await saveTranscriptionConnection({ db, key, accountId: ACCOUNT, apiKey: 'or-key', model: 'microsoft/mai-transcribe-2' });
  const transcript = await createTranscript({
    db, bucket: env.RECOVERY_RECEIPTS, key, accountId: ACCOUNT, upload: { filename: '総会.wav', bytes: WAV }, createdBy: OWNER.name,
  });
  return transcript.id;
};
