import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { requireUser } from '../auth.js';
import { parseJsonArray } from '../util.js';
import type { UserSummary } from '../../../shared/api.js';

/** Directory endpoints used by the "share with" picker. */
export async function registerUserRoutes(app: FastifyInstance, db: DB): Promise<void> {
  // Only users who have signed in at least once are known to the app.
  app.get('/api/users', { preHandler: requireUser }, async (): Promise<UserSummary[]> => {
    return db.selectFrom('users').select(['id', 'name', 'username']).orderBy('name').execute();
  });

  // Group names seen in users' OIDC claims (refreshed at each login).
  app.get('/api/groups', { preHandler: requireUser }, async (): Promise<string[]> => {
    const rows = await db.selectFrom('users').select('groups').execute();
    const all = new Set<string>();
    for (const r of rows) for (const g of parseJsonArray(r.groups)) all.add(g);
    return [...all].sort((a, b) => a.localeCompare(b));
  });
}
