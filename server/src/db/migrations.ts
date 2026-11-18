import type { Kysely } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/*
 * Migrations are defined inline (rather than loaded from a folder) so they work
 * identically under tsx, compiled output, and tests. Stick to portable column
 * types (text, integer) so they run on both SQLite and PostgreSQL.
 *
 * Never edit a migration that has shipped; add a new one instead.
 */
const migrations: Record<string, Migration> = {
  '0001_init': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('users')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('sub', 'text', (c) => c.notNull().unique())
        .addColumn('username', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('groups', 'text', (c) => c.notNull().defaultTo('[]'))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('last_login_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

      await db.schema
        .createTable('events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
        .addColumn('visibility', 'text', (c) => c.notNull())
        .addColumn('start_date', 'text', (c) => c.notNull())
        .addColumn('end_date', 'text', (c) => c.notNull())
        .addColumn('day_start', 'integer')
        .addColumn('day_end', 'integer')
        .addColumn('slot_minutes', 'integer')
        .addColumn('timezone', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('open'))
        .addColumn('archived_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('events_status_idx').on('events').column('status').execute();

      await db.schema
        .createTable('event_invitees')
        .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addPrimaryKeyConstraint('event_invitees_pk', ['event_id', 'user_id'])
        .execute();

      await db.schema
        .createTable('event_groups')
        .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
        .addColumn('group_name', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('event_groups_pk', ['event_id', 'group_name'])
        .execute();

      await db.schema
        .createTable('availability')
        .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('date', 'text', (c) => c.notNull())
        .addColumn('slot', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('availability_pk', ['event_id', 'user_id', 'date', 'slot'])
        .execute();
    },
    async down(db: Kysely<any>) {
      for (const t of ['availability', 'event_groups', 'event_invitees', 'events', 'sessions', 'users']) {
        await db.schema.dropTable(t).ifExists().execute();
      }
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
