import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, migrateToLatest } from './db/index.js';
import type { EventDetail, EventInput, EventSummary } from '../../shared/api.js';

let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(username: string, groups = '') {
  const res = await app.inject({ method: 'GET', url: `/api/auth/dev-login?username=${username}&groups=${groups}` });
  expect(res.statusCode).toBe(302);
  const c = res.cookies.find((c) => c.name === 'ac_session')!;
  cookies[username] = `ac_session=${c.value}`;
  const s = await as(username, 'GET', '/api/session');
  return s.json().user.id as string;
}

function as(username: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[username] ?? '' } });
}

const baseEvent: EventInput = {
  title: 'Board games',
  description: '',
  visibility: 'all',
  startDate: '2026-12-01',
  endDate: '2026-12-03',
  dayStart: 18 * 60,
  dayEnd: 22 * 60,
  slotMinutes: 60,
  timezone: 'Europe/London',
  inviteeIds: [],
  groups: [],
};

const ids: Record<string, string> = {};

beforeAll(async () => {
  // Set TEST_DATABASE_URL=postgres://... to run the suite against PostgreSQL (the DB is wiped).
  const databaseUrl = process.env.TEST_DATABASE_URL ?? 'sqlite::memory:';
  const config = loadConfig({ AUTH_MODE: 'dev', APP_URL: 'http://localhost:3000', DATABASE_URL: databaseUrl });
  const db = await createDb(config.databaseUrl);
  if (db.kind === 'postgres') {
    await sql`drop schema public cascade; create schema public`.execute(db.db);
  }
  await migrateToLatest(db.db);
  app = await buildApp({ config, db, logger: false });
  ids.alice = await login('alice');
  ids.bob = await login('bob');
  ids.carol = await login('carol');
  ids.dave = await login('dave', 'team');
});

afterAll(async () => {
  await app.close();
});

describe('auth', () => {
  it('rejects anonymous API access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects cross-origin writes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: baseEvent,
      headers: { cookie: cookies.alice!, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('events', () => {
  it('validates input', async () => {
    const res = await as('alice', 'POST', '/api/events', { ...baseEvent, endDate: '2026-11-01' });
    expect(res.statusCode).toBe(400);
    const res2 = await as('alice', 'POST', '/api/events', { ...baseEvent, dayEnd: null });
    expect(res2.statusCode).toBe(400);
  });

  it('creates public and restricted events', async () => {
    let res = await as('alice', 'POST', '/api/events', baseEvent);
    expect(res.statusCode).toBe(201);
    ids.public = res.json().id;

    res = await as('alice', 'POST', '/api/events', {
      ...baseEvent,
      title: 'Secret',
      visibility: 'restricted',
      inviteeIds: [ids.bob],
      groups: ['team'],
    });
    expect(res.statusCode).toBe(201);
    ids.restricted = res.json().id;
  });

  it('only lists events the user can see', async () => {
    const titles = async (u: string) =>
      ((await as(u, 'GET', '/api/events')).json() as EventSummary[]).map((e) => e.title).sort();
    expect(await titles('alice')).toEqual(['Board games', 'Secret']);
    expect(await titles('bob')).toEqual(['Board games', 'Secret']);
    expect(await titles('dave')).toEqual(['Board games', 'Secret']);
    expect(await titles('carol')).toEqual(['Board games']);
    expect((await as('carol', 'GET', `/api/events/${ids.restricted}`)).statusCode).toBe(404);
  });

  it('records availability and returns it in the detail', async () => {
    let res = await as('bob', 'PUT', `/api/events/${ids.public}/availability`, {
      cells: [
        { date: '2026-12-01', slot: 18 * 60, status: 'free' },
        { date: '2026-12-01', slot: 19 * 60, status: 'maybe' },
        { date: '2026-12-02', slot: 21 * 60, status: 'busy' },
      ],
    });
    expect(res.statusCode).toBe(200);

    // Overwrite and clear.
    res = await as('bob', 'PUT', `/api/events/${ids.public}/availability`, {
      cells: [
        { date: '2026-12-01', slot: 18 * 60, status: 'busy' },
        { date: '2026-12-01', slot: 19 * 60, status: null },
      ],
    });
    expect(res.statusCode).toBe(200);

    const detail = (await as('carol', 'GET', `/api/events/${ids.public}`)).json() as EventDetail;
    expect(detail.respondentCount).toBe(1);
    expect(detail.respondents.map((r) => r.id)).toEqual([ids.bob]);
    expect(detail.availability).toHaveLength(2);
    expect(detail.availability.find((a) => a.slot === 18 * 60)!.status).toBe('busy');
    expect(detail.canManage).toBe(false);
  });

  it('rejects cells outside the grid', async () => {
    const res = await as('bob', 'PUT', `/api/events/${ids.public}/availability`, {
      cells: [{ date: '2026-12-01', slot: 18 * 60 + 30, status: 'free' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('only lets the creator edit, and prunes cells outside the new grid', async () => {
    expect((await as('bob', 'PUT', `/api/events/${ids.public}`, baseEvent)).statusCode).toBe(403);
    const res = await as('alice', 'PUT', `/api/events/${ids.public}`, { ...baseEvent, endDate: '2026-12-01' });
    expect(res.statusCode).toBe(200);
    const detail = (await as('alice', 'GET', `/api/events/${ids.public}`)).json() as EventDetail;
    expect(detail.availability).toHaveLength(1);
  });

  it('supports whole-day events', async () => {
    const res = await as('carol', 'POST', '/api/events', {
      ...baseEvent,
      title: 'Day trip',
      dayStart: null,
      dayEnd: null,
      slotMinutes: null,
    });
    const id = res.json().id;
    expect(
      (await as('bob', 'PUT', `/api/events/${id}/availability`, { cells: [{ date: '2026-12-02', slot: -1, status: 'free' }] }))
        .statusCode,
    ).toBe(200);
    expect(
      (await as('bob', 'PUT', `/api/events/${id}/availability`, { cells: [{ date: '2026-12-02', slot: 600, status: 'free' }] }))
        .statusCode,
    ).toBe(400);
  });

  it('archives with an outcome and can reopen', async () => {
    expect((await as('bob', 'POST', `/api/events/${ids.public}/archive`, { outcome: 'happened' })).statusCode).toBe(403);
    expect((await as('alice', 'POST', `/api/events/${ids.public}/archive`, { outcome: 'happened' })).statusCode).toBe(200);

    const open = (await as('alice', 'GET', '/api/events')).json() as EventSummary[];
    expect(open.map((e) => e.id)).not.toContain(ids.public);
    const archived = (await as('alice', 'GET', '/api/events?status=archived')).json() as EventSummary[];
    expect(archived.find((e) => e.id === ids.public)!.status).toBe('happened');

    const res = await as('bob', 'PUT', `/api/events/${ids.public}/availability`, {
      cells: [{ date: '2026-12-01', slot: 18 * 60, status: 'free' }],
    });
    expect(res.statusCode).toBe(409);

    expect((await as('alice', 'POST', `/api/events/${ids.public}/reopen`)).statusCode).toBe(200);
  });

  it('deletes events', async () => {
    expect((await as('bob', 'DELETE', `/api/events/${ids.restricted}`)).statusCode).toBe(403);
    expect((await as('alice', 'DELETE', `/api/events/${ids.restricted}`)).statusCode).toBe(200);
    expect((await as('alice', 'GET', `/api/events/${ids.restricted}`)).statusCode).toBe(404);
  });
});

describe('directory', () => {
  it('lists users and groups', async () => {
    const users = (await as('alice', 'GET', '/api/users')).json();
    expect(users).toHaveLength(4);
    expect((await as('alice', 'GET', '/api/groups')).json()).toEqual(['team']);
  });
});

describe('sse', () => {
  it('pushes changes only to users who can see the event', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    const open = async (user: string) => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/stream`, { headers: { cookie: cookies[user]! }, signal: ctrl.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      let buf = '';
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value);
          }
        } catch {
          /* aborted */
        }
      })();
      return { text: () => buf, close: () => ctrl.abort() };
    };

    const bob = await open('bob');
    const carol = await open('carol');
    await new Promise((r) => setTimeout(r, 50));

    const res = await as('alice', 'POST', '/api/events', {
      ...baseEvent,
      title: 'Bob only',
      visibility: 'restricted',
      inviteeIds: [ids.bob],
    });
    const id = res.json().id;
    await new Promise((r) => setTimeout(r, 100));

    expect(bob.text()).toContain(`"eventId":"${id}"`);
    expect(carol.text()).not.toContain(id);
    bob.close();
    carol.close();
  });
});
