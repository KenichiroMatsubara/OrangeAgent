import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSON5 from 'json5';
import { describe, expect, it } from 'vitest';

import { deployConfig, deploymentFrom, deploymentOf } from './deploy-config';

const source = JSON5.parse(readFileSync(resolve(import.meta.dirname, '../apps/worker/wrangler.jsonc'), 'utf8')) as Parameters<typeof deployConfig>[0];

const env = {
  APP_URL: 'https://flarechat.example.workers.dev',
  CLOUDFLARE_ACCOUNT_ID: 'account-1',
  CONTROL_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
};

describe('the deploy configuration', () => {
  it('fills in one deployment\'s origin, account and Control database, and keeps everything else committed', () => {
    const config = deployConfig(source, deploymentFrom(env));

    expect(config.vars).toEqual({
      CLOUDFLARE_WORKER_NAME: 'flarechat',
      APP_URL: 'https://flarechat.example.workers.dev',
      WEB_ORIGIN: 'https://flarechat.example.workers.dev',
      RP_ID: 'flarechat.example.workers.dev',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
    });
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: 'CONTROL_DB', database_id: env.CONTROL_DATABASE_ID })]);
    expect(config.env).toEqual(source.env);
    expect(config.r2_buckets).toEqual(source.r2_buckets);
  });

  it('accepts an origin written with a trailing slash', () => {
    expect(deploymentFrom({ ...env, APP_URL: 'https://flarechat.example.workers.dev/' }).appUrl).toBe('https://flarechat.example.workers.dev');
  });

  it('refuses to deploy without a value, or with an origin or database id that cannot be right', () => {
    expect(() => deploymentFrom({ ...env, APP_URL: '' })).toThrow('APP_URL is missing');
    expect(() => deploymentFrom({ ...env, CLOUDFLARE_ACCOUNT_ID: undefined })).toThrow('CLOUDFLARE_ACCOUNT_ID is missing');
    expect(() => deploymentFrom({ ...env, CONTROL_DATABASE_ID: undefined })).toThrow('CONTROL_DATABASE_ID is missing');
    expect(() => deploymentFrom({ ...env, APP_URL: 'http://flarechat.example.workers.dev' })).toThrow('https origin');
    expect(() => deploymentFrom({ ...env, APP_URL: 'https://flarechat.example.workers.dev/app' })).toThrow('https origin');
    expect(() => deploymentFrom({ ...env, CONTROL_DATABASE_ID: 'flarechat-control-apac' })).toThrow('UUID');
  });

  it('reads what the build environment leaves out from the Worker already deployed', async () => {
    const paths: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('https://api.cloudflare.com/client/v4', '');
      paths.push(path);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer build-token');
      const result = path === '/accounts'
        ? [{ id: 'account-1' }]
        : { bindings: [
          { type: 'plain_text', name: 'APP_URL', text: 'https://flarechat.example.workers.dev' },
          { type: 'd1', name: 'CONTROL_DB', database_id: env.CONTROL_DATABASE_ID },
          { type: 'd1', name: 'ORG_1', database_id: '99999999-2222-3333-4444-555555555555' },
        ] };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }) as typeof fetch;

    await expect(deploymentOf({ env: { CLOUDFLARE_API_TOKEN: 'build-token' }, workerName: 'flarechat', fetch: fetcher })).resolves.toEqual({
      appUrl: 'https://flarechat.example.workers.dev',
      accountId: 'account-1',
      controlDatabaseId: env.CONTROL_DATABASE_ID,
    });
    expect(paths).toEqual(['/accounts', '/accounts/account-1/workers/scripts/flarechat/settings']);
  });

  it('asks nothing of the API when the environment holds every value', async () => {
    const fetcher = (async () => { throw new Error('no request expected'); }) as typeof fetch;
    await expect(deploymentOf({ env: { ...env, CLOUDFLARE_API_TOKEN: 't' }, workerName: 'flarechat', fetch: fetcher })).resolves.toMatchObject({ accountId: 'account-1' });
  });

  it('refuses when the deployed Worker holds no APP_URL either', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ success: true, result: { bindings: [] } }), { status: 200 })) as typeof fetch;
    await expect(deploymentOf({ env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'account-1' }, workerName: 'flarechat', fetch: fetcher })).rejects.toThrow('APP_URL is missing');
  });
});
