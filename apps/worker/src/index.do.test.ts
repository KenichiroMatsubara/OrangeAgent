/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import worker from './index';
import { completion, MODEL_URL, seedAccount, seedAutomation } from '../test/runtime';

describe('the Worker\'s entry points in the Workers runtime', () => {
  it('serves its routes at fetch, a discovery document to anyone and an Account\'s API to no one signed out', async () => {
    const discovered = await exports.default.fetch('http://localhost:8787/.well-known/oauth-authorization-server');
    const refused = await exports.default.fetch('http://localhost:8787/api/organizations/organization-1/chat-threads');

    expect(discovered.status).toBe(200);
    await expect(discovered.json()).resolves.toMatchObject({ issuer: env.APP_URL });
    expect(refused.status).toBe(401);
  });

  it('runs each Automation due at the scheduled tick, and moves it to its next morning', async () => {
    const database = await seedAccount();
    await seedAutomation(database, '2000-01-01T00:00:00.000Z');
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      asked.push(url);
      return url === MODEL_URL ? completion({ text: 'おはようございます。' }) : new Response(null, { status: 404 });
    });

    // The tick's work outlives the handler (waitUntil), and is waited for as the runtime waits for it.
    const context = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/30 * * * *', scheduledTime: new Date() }), env, context);
    await waitOnExecutionContext(context);

    expect(asked).toEqual([MODEL_URL]);
    expect(await database.prepare("SELECT trigger, status, output FROM runs WHERE automation_id = 'automation-1'").all()).toMatchObject({
      results: [{ trigger: 'schedule', status: 'completed', output: 'おはようございます。' }],
    });
    const { next_run_at: next } = (await database.prepare("SELECT next_run_at FROM automations WHERE id = 'automation-1'").first<{ next_run_at: string }>())!;
    expect(Date.parse(next)).toBeGreaterThan(Date.now());
  });
});
