import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { productionProviders, type Providers } from './providers';
import { respondToError } from './response';
import type { Bindings } from './types';
import { automationRoutes } from './routes/automations';
import { channelRoutes } from './routes/channels';
import { pushRoutes } from './routes/push';
import { threadRoutes } from './routes/threads';
import { transcriptRoutes } from './routes/transcripts';
import { connectionRoutes } from './routes/connections';
import { contactRoutes } from './routes/contacts';
import { listRoutes } from './routes/lists';
import { dashboardRoutes } from './routes/dashboard';
import { discordRoutes } from './routes/discord';
import { authorizationRoutes, wellKnownRoutes } from './routes/authorization';
import { entryRoutes, oauthRoutes } from './routes/entry';
import { eventRoutes } from './routes/events';
import { inboxRoutes } from './routes/inbox';
import { lineRoutes } from './routes/line';
import { operationRoutes } from './routes/operations';
import { portalRoutes } from './routes/portal';
import { presetRoutes } from './routes/presets';
import { memoryRoutes } from './routes/memories';
import { skillRoutes } from './routes/skills';
import { runRoutes } from './routes/runs';
import { serverRoutes } from './routes/servers';
import { loginRoutes } from './routes/logins';
import { tokenRoutes } from './routes/tokens';
import { siteRoutes } from './routes/site';
import { createRequestContext } from './routes/request-context';

/**
 * The HTTP surface. Every resource is one module under `routes/`;
 * this file only mounts them and is the one place a refusal becomes a response.
 */
export const createApp = (providers: Providers) => {
  const app = new Hono<{ Bindings: Bindings }>();

  app.onError(respondToError);

  app.use('/api/*', cors({ origin: (origin) => origin || 'http://localhost:5173', credentials: true }));
  app.use('*', async (context, next) => {
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      console.info(JSON.stringify({
        event: 'http_request_timing',
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: context.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }));
    }
  });

  app.route('/api', entryRoutes);
  app.route('/api', inboxRoutes(providers));
  app.route('/api', portalRoutes);
  app.route('/', oauthRoutes);
  app.route('/', wellKnownRoutes);
  app.route('/', siteRoutes);
  app.route('/api', authorizationRoutes);
  app.route('/api', presetRoutes);
  app.route('/api', connectionRoutes(providers));
  app.route('/api', skillRoutes);
  app.route('/api', memoryRoutes);
  app.route('/api', runRoutes(providers));
  app.route('/api', contactRoutes);
  app.route('/api', listRoutes);
  app.route('/api', lineRoutes(providers));
  app.route('/api', dashboardRoutes);
  app.route('/api', operationRoutes);
  app.route('/api', eventRoutes);
  app.route('/api', serverRoutes(providers));
  app.route('/api', loginRoutes());
  app.route('/api', channelRoutes);
  app.route('/api', threadRoutes(providers));
  app.route('/api', pushRoutes);
  app.route('/api', transcriptRoutes(providers));
  app.route('/api', discordRoutes);
  app.route('/api', tokenRoutes(providers));
  app.route('/api', automationRoutes(providers));

  app.all('/api/*', async (context) => {
    await createRequestContext(context.req.raw, context.env).requiredSession();
    return context.json({ error: { code: 'gone', message: 'The previous shared-ORG_DB management API has been retired. Account-scoped operations are introduced in the next implementation unit.' } }, 410);
  });

  return app;
};

export const app = createApp(productionProviders());
