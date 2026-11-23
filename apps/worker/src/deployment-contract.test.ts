import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DUE_WORK_CRON } from './background/runner';
import { TIERS } from './environment';

const packageJson = (path: string): { scripts: Record<string, string> } => JSON.parse(
  readFileSync(resolve(import.meta.dirname, path), 'utf8'),
) as { scripts: Record<string, string> };

describe('deployment contract', () => {
  it('declares exactly the one cron the background runner is written for', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as { triggers: { crons: string[] } };

    expect(wrangler.triggers.crons).toEqual([DUE_WORK_CRON]);
  });

  it('names the production Control database and bucket rather than leaving Wrangler to find them', () => {
    // Without an id, a deploy looks the binding up from the live Worker and
    // provisions a new resource when that lookup fails, and every wrangler d1
    // command resolves CONTROL_DB by its auto-provisioned name instead of the
    // database the Worker is bound to. The committed id is a placeholder no
    // database has, so a deploy that skips deploy:config fails instead; the
    // real id comes from CONTROL_DATABASE_ID through wrangler.deploy.json.
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as { d1_databases: Array<{ binding: string; database_id?: string }>; r2_buckets: Array<{ binding: string; bucket_name?: string }> };
    const root = packageJson('../../../package.json');
    const worker = packageJson('../package.json');
    const steps = root.scripts['deploy:cloudflare']?.split('&&').map((step) => step.trim()) ?? [];

    expect(wrangler.d1_databases.find(({ binding }) => binding === 'CONTROL_DB')?.database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(wrangler.r2_buckets.find(({ binding }) => binding === 'RECOVERY_RECEIPTS')?.bucket_name).toBeTruthy();
    expect(steps[0]).toBe('npm run deploy:config');
    expect(root.scripts['db:migrate:control:remote']).toContain('--config apps/worker/wrangler.deploy.json');
    expect(worker.scripts['deploy:worker:release']).toContain('--config wrangler.deploy.json');
    expect(root.scripts['deploy:preview']?.startsWith('npm run deploy:config && ')).toBe(true);
    expect(worker.scripts['deploy:worker:preview']).toContain('--config wrangler.deploy.json');
  });

  it('binds the Memory to Workers AI and a named Vectorize index, made sure of before the Worker is deployed', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as { ai?: { binding?: string }; vectorize?: Array<{ binding: string; index_name?: string }>; env: { local: Record<string, unknown> } };
    const root = packageJson('../../../package.json');
    const steps = root.scripts['deploy:cloudflare']?.split('&&').map((step) => step.trim()) ?? [];

    expect(wrangler.ai?.binding).toBe('AI');
    expect(wrangler.vectorize?.find(({ binding }) => binding === 'MEMORY_INDEX')?.index_name).toBeTruthy();
    // Local development binds neither, so nothing it does reaches the paid, remote Workers AI.
    expect(wrangler.env.local.ai).toBeUndefined();
    expect(wrangler.env.local.vectorize).toBeUndefined();
    expect(steps.indexOf('npm run memory:index:remote')).toBeGreaterThan(-1);
    expect(steps.indexOf('npm run memory:index:remote')).toBeLessThan(steps.findIndex((step) => step.includes('deploy:worker:release')));
  });

  it('binds Cloudflare Browser Run as the browser every run operates, and leaves local development without it', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as { browser?: { binding?: string }; env: { local: Record<string, unknown> } };

    expect(wrangler.browser?.binding).toBe('BROWSER');
    // A run in local development is offered no browser, so nothing it does spends Browser Run's paid time.
    expect(wrangler.env.local.browser).toBeUndefined();
  });

  it('binds a Dynamic Worker loader and one container class per size FlareChat lends, and leaves local development without them', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as {
      worker_loaders?: Array<{ binding: string }>;
      containers?: Array<{ class_name: string; instance_type: string; image: string }>;
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ new_sqlite_classes?: string[] }>;
      env: { local: { worker_loaders?: unknown; containers?: unknown; durable_objects: { bindings: Array<{ class_name: string }> } } };
    };
    const sizes = TIERS.filter((tier) => tier.name !== 'isolate').map((tier) => tier.name);
    const classes = Object.fromEntries((wrangler.containers ?? []).map((container) => [container.instance_type, container.class_name]));

    expect(wrangler.worker_loaders?.map(({ binding }) => binding)).toEqual(['LOADER']);
    expect(Object.keys(classes).sort()).toEqual([...sizes].sort());
    const migrated = wrangler.migrations.flatMap((migration) => migration.new_sqlite_classes ?? []);
    for (const className of Object.values(classes)) {
      expect(wrangler.durable_objects.bindings.some((binding) => binding.class_name === className)).toBe(true);
      expect(migrated).toContain(className);
      expect(wrangler.env.local.durable_objects.bindings.some((binding) => binding.class_name === className)).toBe(false);
    }
    // Local development binds neither, so nothing it does starts a paid container.
    expect(wrangler.env.local.worker_loaders).toBeUndefined();
    expect(wrangler.env.local.containers).toBeUndefined();
  });

  it('builds the container image with the sandbox-shim of the Sandbox SDK version the Worker bundles', () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, '../workbench/Dockerfile'), 'utf8');
    const worker = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const wrangler = JSON.parse(readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8')) as { compatibility_flags?: string[] };

    // Files and sandbox-shim speak one protocol, so the package is pinned exactly and the image copies the same tag.
    const version = worker.dependencies['@cloudflare/sandbox'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(dockerfile).toContain(`COPY --from=docker.io/cloudflare/sandbox:${version ?? ''} /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim`);
    // Files reads Linux's error names through node:os; process.env stays empty of the Worker's secrets.
    expect(wrangler.compatibility_flags).toEqual(expect.arrayContaining(['nodejs_compat', 'nodejs_compat_do_not_populate_process_env']));
  });

  it('binds the Workflow a recording is transcribed in, in production and in local development alike', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as {
      workflows?: Array<{ binding: string; class_name: string }>;
      env: { local: { workflows?: Array<{ binding: string; class_name: string }> } };
    };

    // Workflows are not inherited by an environment, so local development names its own.
    for (const workflows of [wrangler.workflows, wrangler.env.local.workflows]) {
      expect(workflows?.map(({ binding, class_name: className }) => [binding, className])).toEqual([['TRANSCRIBER', 'Transcriber']]);
    }
  });

  it('routes both root and Worker deploy commands through the migration release pipeline', () => {
    const root = packageJson('../../../package.json');
    const worker = packageJson('../package.json');

    expect(worker.scripts.deploy).not.toContain('wrangler deploy');
    expect(worker.scripts.deploy).toContain('npm run deploy --prefix ../..');
    expect(root.scripts['deploy:cloudflare']).toContain('db:migrate:control:remote');
    expect(root.scripts['deploy:cloudflare']).toContain('db:migrate:organization:remote');
    expect(root.scripts['deploy:cloudflare']).toContain('deploy:worker:release');
    expect(root.scripts['deploy:cloudflare']).toContain('db:migrate:complete:remote');
    expect(worker.scripts['deploy:worker:release']).toContain('wrangler deploy');
  });
});
