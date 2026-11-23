/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import controlSchemaMigration from '../migrations/control/0000_initial.sql';
import { provisionAccountDatabase } from './account-db';
import { claimNotice, forgetEndpoint, removeSubscription, saveSubscription, subscriptionsOf, threadStarter } from './subscriptions';
import { createThread } from './threads';

declare global {
  namespace Cloudflare {
    interface Env {
      CONTROL_DB: D1Database;
      LOCAL_ORGANIZATION_DB_1: D1Database;
    }
  }
}

/** A fresh Account database with every migration applied, as provisioning applies them. */
const migratedAccount = async (): Promise<D1Database> => {
  await env.CONTROL_DB.batch(controlSchemaMigration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => env.CONTROL_DB.prepare(statement)));
  const provisioned = await provisionAccountDatabase({
    CONTROL_DB: env.CONTROL_DB,
    LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
  } as unknown as Parameters<typeof provisionAccountDatabase>[0], {
    accountId: 'organization-1',
    ownerAddress: 'first@example.com',
    bindingName: 'ORG_ORGANIZATION1',
    databaseId: null,
  });
  await provisioned.initialize();
  return provisioned.database;
};

const AT = '2026-11-21T00:00:00.000Z';
const target = (endpoint: string, p256dh = 'BKey') => ({ endpoint, p256dh, auth: 'auth' });

describe('push subscriptions and notices in D1', () => {
  it('applies migration 0062 and keeps one row per push address, the member who last subscribed with it', async () => {
    const database = await migratedAccount();
    const applied = await database.prepare("SELECT name FROM d1_migrations WHERE name = '0062_push_subscriptions.sql'").all<{ name: string }>();
    expect(applied.results).toHaveLength(1);

    await saveSubscription({ database, identityId: 'identity-1', target: target('https://push.example.net/a'), label: 'iPhone の Safari', timestamp: AT });
    await saveSubscription({ database, identityId: 'identity-1', target: target('https://push.example.net/b'), label: 'Mac の Chrome', timestamp: AT });
    await saveSubscription({ database, identityId: 'identity-2', target: target('https://push.example.net/c'), label: '', timestamp: AT });
    // The same browser handed to another member is theirs from then on, with the keys it subscribed with last.
    await saveSubscription({ database, identityId: 'identity-2', target: target('https://push.example.net/b', 'BNew'), label: 'Mac の Chrome', timestamp: AT });

    expect((await subscriptionsOf(database, ['identity-1'])).map((row) => row.endpoint)).toEqual(['https://push.example.net/a']);
    expect((await subscriptionsOf(database, ['identity-2'])).map((row) => [row.endpoint, row.p256dh]).sort()).toEqual([
      ['https://push.example.net/b', 'BNew'], ['https://push.example.net/c', 'BKey'],
    ]);
    expect(await subscriptionsOf(database, [])).toEqual([]);

    // A member removes only their own browser; a gone address is forgotten whoever it was for.
    await removeSubscription({ database, identityId: 'identity-1', endpoint: 'https://push.example.net/c' });
    await removeSubscription({ database, identityId: 'identity-1', endpoint: 'https://push.example.net/a' });
    await forgetEndpoint(database, 'https://push.example.net/b');
    const left = await database.prepare('SELECT identity_id, endpoint, label FROM push_subscriptions').all();
    expect(left.results).toEqual([{ identity_id: 'identity-2', endpoint: 'https://push.example.net/c', label: '' }]);
  });

  it('claims each kind of notice once per answer, and drops a conversation\'s notices with it', async () => {
    const database = await migratedAccount();
    const thread = await createThread({ database, accountId: 'organization-1', createdBy: { identityId: 'identity-1', name: '山田' }, timestamp: AT });

    expect(await threadStarter(database, thread.id)).toBe('identity-1');
    expect(await threadStarter(database, 'missing')).toBeNull();
    expect(await claimNotice({ database, threadId: thread.id, runId: 'run-1', kind: 'approval', timestamp: AT })).toBe(true);
    expect(await claimNotice({ database, threadId: thread.id, runId: 'run-1', kind: 'approval', timestamp: AT })).toBe(false);
    expect(await claimNotice({ database, threadId: thread.id, runId: 'run-1', kind: 'completed', timestamp: AT })).toBe(true);
    expect(await claimNotice({ database, threadId: thread.id, runId: 'run-2', kind: 'approval', timestamp: AT })).toBe(true);

    await database.prepare('PRAGMA foreign_keys = ON').run();
    await database.prepare('DELETE FROM chat_threads WHERE id = ?').bind(thread.id).run();
    expect((await database.prepare('SELECT * FROM chat_notices').all()).results).toEqual([]);
  });
});
