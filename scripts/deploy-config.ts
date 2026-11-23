import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';

/** The configuration a production deploy reads; written beside `wrangler.jsonc` so its relative paths still hold. */
export const DEPLOY_CONFIG = resolve(import.meta.dirname, '../apps/worker/wrangler.deploy.json');

const SOURCE_CONFIG = resolve(import.meta.dirname, '../apps/worker/wrangler.jsonc');

const API = 'https://api.cloudflare.com/client/v4';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The values one deployment owns, which the repository does not carry. */
export type Deployment = {
  appUrl: string;
  accountId: string;
  controlDatabaseId: string;
};

type Wrangler = {
  name?: string;
  vars?: Record<string, unknown>;
  d1_databases?: Array<{ binding: string; database_id?: string }>;
  [key: string]: unknown;
};

type Binding = { type?: string; name?: string; text?: string; database_id?: string };

type Answer<T> = { success?: boolean; result?: T; errors?: Array<{ message?: string }> };

const present = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** Checks one deployment's values, wherever they were read from. */
export const deployment = (values: { appUrl: string | undefined; accountId: string | undefined; controlDatabaseId: string | undefined }): Deployment => {
  const { appUrl, accountId, controlDatabaseId } = values;
  if (!appUrl) throw new Error('APP_URL is missing: set it on the Worker (runtime variable) or in the deploy environment.');
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is missing: set it on the Worker (runtime variable) or in the deploy environment.');
  if (!controlDatabaseId) throw new Error('CONTROL_DATABASE_ID is missing: bind CONTROL_DB on the Worker or set it in the deploy environment.');
  const origin = URL.canParse(appUrl) ? new URL(appUrl) : null;
  if (!origin || origin.protocol !== 'https:' || origin.origin !== appUrl.replace(/\/$/u, '')) {
    throw new Error(`APP_URL must be an https origin with no path, such as https://flarechat.example.workers.dev; got ${appUrl}.`);
  }
  if (!UUID.test(controlDatabaseId)) throw new Error(`CONTROL_DATABASE_ID must be the Control D1 database's UUID; got ${controlDatabaseId}.`);
  return { appUrl: origin.origin, accountId, controlDatabaseId };
};

/** Reads a deployment's values from the environment alone, as CI and a first deploy give them. */
export const deploymentFrom = (env: NodeJS.ProcessEnv): Deployment => deployment({
  appUrl: present(env.APP_URL),
  accountId: present(env.CLOUDFLARE_ACCOUNT_ID),
  controlDatabaseId: present(env.CONTROL_DATABASE_ID),
});

/**
 * Reads the values the environment leaves out from the Worker already
 * deployed: its APP_URL variable and the database its CONTROL_DB names.
 * Workers Builds hands the build an API token but not the Worker's runtime
 * variables, so the live Worker is where a redeploy finds them.
 */
export const deploymentOf = async (input: {
  env: NodeJS.ProcessEnv;
  workerName: string;
  fetch: typeof fetch;
}): Promise<Deployment> => {
  const { env } = input;
  const appUrl = present(env.APP_URL);
  const controlDatabaseId = present(env.CONTROL_DATABASE_ID);
  let accountId = present(env.CLOUDFLARE_ACCOUNT_ID);
  if (appUrl && controlDatabaseId && accountId) return deployment({ appUrl, accountId, controlDatabaseId });

  const token = present(env.CLOUDFLARE_API_TOKEN);
  if (!token) return deployment({ appUrl, accountId, controlDatabaseId });
  const request = async <T>(path: string): Promise<T> => {
    const response = await input.fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as Answer<T>;
    if (!response.ok || !body.success || body.result === undefined) {
      throw new Error(`Cloudflare API ${path} failed: ${response.status} ${body.errors?.map(({ message }) => message).join('; ') ?? ''}`);
    }
    return body.result;
  };

  if (!accountId) {
    const accounts = await request<Array<{ id: string }>>('/accounts');
    if (accounts.length !== 1) throw new Error(`CLOUDFLARE_ACCOUNT_ID is missing and the API token reaches ${accounts.length} accounts.`);
    accountId = accounts[0]?.id;
  }
  const settings = await request<{ bindings?: Binding[] }>(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(input.workerName)}/settings`,
  );
  const bindings = settings.bindings ?? [];
  return deployment({
    appUrl: appUrl ?? bindings.find(({ type, name }) => type === 'plain_text' && name === 'APP_URL')?.text,
    accountId,
    controlDatabaseId: controlDatabaseId ?? bindings.find(({ type, name }) => type === 'd1' && name === 'CONTROL_DB')?.database_id,
  });
};

/** The committed configuration with one deployment's origin, account and Control database filled in. */
export const deployConfig = (source: Wrangler, values: Deployment): Wrangler => {
  const databases = source.d1_databases ?? [];
  if (!databases.some(({ binding }) => binding === 'CONTROL_DB')) throw new Error('wrangler.jsonc binds no CONTROL_DB.');
  return {
    ...source,
    vars: {
      ...source.vars,
      APP_URL: values.appUrl,
      WEB_ORIGIN: values.appUrl,
      RP_ID: new URL(values.appUrl).hostname,
      CLOUDFLARE_ACCOUNT_ID: values.accountId,
    },
    d1_databases: databases.map((database) => (
      database.binding === 'CONTROL_DB' ? { ...database, database_id: values.controlDatabaseId } : database
    )),
  };
};

const main = async (): Promise<void> => {
  const source = JSON5.parse(readFileSync(SOURCE_CONFIG, 'utf8')) as Wrangler;
  const workerName = present(process.env.CLOUDFLARE_WORKER_NAME) ?? source.name;
  if (!workerName) throw new Error('wrangler.jsonc names no Worker.');
  const values = await deploymentOf({ env: process.env, workerName, fetch });
  writeFileSync(DEPLOY_CONFIG, `${JSON.stringify(deployConfig(source, values), null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ phase: 'deploy_config', appUrl: values.appUrl })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

/** The configuration the deploy's later steps read: the one deploy:config wrote, else the committed one. */
export const deployedConfigPath = (): string => (existsSync(DEPLOY_CONFIG) ? DEPLOY_CONFIG : SOURCE_CONFIG);
