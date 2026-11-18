import fs from 'node:fs';
import path from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect, type Dialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Database } from './types.js';
import { migrationProvider } from './migrations.js';

export type DbKind = 'sqlite' | 'postgres';
export type DB = Kysely<Database>;

export interface DbHandle {
  db: DB;
  kind: DbKind;
}

/**
 * Supported DATABASE_URL forms:
 *   sqlite:./data/app.db        (relative path)
 *   sqlite:///data/app.db       (absolute path)
 *   sqlite::memory:             (in-memory, tests)
 *   postgres://user:pass@host:5432/db  (or postgresql://)
 */
export async function createDb(databaseUrl: string): Promise<DbHandle> {
  let dialect: Dialect;
  let kind: DbKind;

  if (/^postgres(ql)?:\/\//.test(databaseUrl)) {
    kind = 'postgres';
    const pg = await import('pg');
    // Return BIGINT (e.g. COUNT(*)) as JS numbers rather than strings.
    pg.default.types.setTypeParser(20, (v) => Number(v));
    dialect = new PostgresDialect({
      pool: new pg.default.Pool({ connectionString: databaseUrl, max: 10 }),
    });
  } else if (databaseUrl.startsWith('sqlite:')) {
    kind = 'sqlite';
    let file = databaseUrl.slice('sqlite:'.length);
    if (file.startsWith('//')) file = file.slice(2); // sqlite:///abs/path -> /abs/path
    const { default: SQLite } = await import('better-sqlite3');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const sqlite = new SQLite(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    dialect = new SqliteDialect({ database: sqlite });
  } else {
    throw new Error(`Unsupported DATABASE_URL "${databaseUrl}". Use sqlite:<path> or postgres://...`);
  }

  return { db: new Kysely<Database>({ dialect }), kind };
}

export async function migrateToLatest(db: DB): Promise<void> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}
