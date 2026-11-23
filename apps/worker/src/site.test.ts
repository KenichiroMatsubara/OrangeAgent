import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { app } from './app';
import { SITE_PATHS } from './routes/site';
import type { Bindings } from './types';

const ORIGIN = 'https://orangeagent.example.workers.dev';

const open = async (path: string): Promise<{ status: number; type: string | null; body: string }> => {
  const response = await app.fetch(new Request(`${ORIGIN}${path}`), {} as Bindings);
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
};

describe('the public site', () => {
  it('serves the homepage to anyone, describing the app and linking to its privacy policy', async () => {
    const page = await open('/about');

    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('<title>OrangeAgent</title>');
    expect(page.body).toContain('href="/privacy"');
    expect(page.body).toContain('Gmail');
    expect(page.body).toContain('https://github.com/KenichiroMatsubara/OrangeAgent');
  });

  it('serves the privacy policy to anyone, with the Limited Use disclosure Google asks for', async () => {
    const page = await open('/privacy');

    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('href="https://developers.google.com/terms/api-services-user-data-policy"');
    expect(page.body).toContain("OrangeAgent's use and transfer to any other app of information received from Google APIs will adhere to");
    expect(page.body).toContain('including the Limited Use requirements');
    expect(page.body).toContain('https://github.com/KenichiroMatsubara/OrangeAgent/issues');
  });

  it('answers each page before the single-page app does, so no request reaches the app shell instead', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as { assets: { run_worker_first: string[] } };

    expect(SITE_PATHS).toEqual(['/about', '/privacy']);
    for (const path of SITE_PATHS) expect(wrangler.assets.run_worker_first).toContain(path);
  });
});
