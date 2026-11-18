import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { DbHandle } from './db/index.js';
import { ChangeBus } from './bus.js';
import { registerAuth } from './auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerUserRoutes } from './routes/users.js';
import { registerStreamRoute } from './routes/stream.js';
import { registerPollRoutes } from './routes/polls.js';

export interface AppOptions {
  config: Config;
  db: DbHandle;
  logger?: boolean;
}

export async function buildApp({ config, db, logger = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });

  const bus = new ChangeBus();
  await registerAuth(app, config, db.db);
  await registerUserRoutes(app, db.db);
  await registerEventRoutes(app, db.db, bus);
  await registerPollRoutes(app, db.db, bus);
  await registerStreamRoute(app, bus);

  app.get('/api/health', async () => {
    await db.db.selectFrom('users').select('id').limit(1).execute();
    return { ok: true, db: db.kind };
  });

  // Serve the built SPA (in production) with client-side routing fallback.
  const indexHtml = path.join(config.webDir, 'index.html');
  const hasWeb = fs.existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.method !== 'GET' || !hasWeb) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });

  return app;
}
