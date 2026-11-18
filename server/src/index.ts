import { loadConfig } from './config.js';
import { createDb, migrateToLatest } from './db/index.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const db = await createDb(config.databaseUrl);
  await migrateToLatest(db.db);

  const app = await buildApp({ config, db });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await db.db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`database: ${db.kind}, auth: ${config.authMode}, url: ${config.appUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
