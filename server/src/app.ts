import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { sessionMiddleware, type AppEnv } from './auth.js';
import { apiRoutes, type ApiDeps } from './routes/api.js';
import { deviceRoutes } from './routes/device.js';

export function createApp(deps: ApiDeps & { logRequests?: boolean }) {
  const { db, cfg } = deps;
  const app = new Hono<AppEnv>();

  if (deps.logRequests) {
    const log = logger();
    app.use((c, next) => (c.req.path === '/healthz' ? next() : log(c, next)));
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true, connected: deps.hub.connected.size }));

  app.route('/api/device', deviceRoutes(db, cfg));

  app.use('/api/*', csrf(), sessionMiddleware(db, deps.cfg));
  app.route('/api', apiRoutes(deps));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // Built web UI, with SPA fallback so client-side routes like /pair?code= work on reload.
  const indexHtml = join(cfg.WEB_DIST, 'index.html');
  if (existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, 'utf8');
    app.use('/*', serveStatic({ root: cfg.WEB_DIST }));
    app.get('*', (c) => c.html(html));
  }

  return app;
}
