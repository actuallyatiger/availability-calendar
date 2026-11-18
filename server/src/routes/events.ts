import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import type { Event } from '../db/types.js';
import type { ChangeBus, ChangeMessage } from '../bus.js';
import { canManage, canView, loadEventAccess, type AuthUser, type EventAccess } from '../access.js';
import { requireUser } from '../auth.js';
import { newId, nowIso } from '../util.js';
import { loadPolls } from './polls.js';
import { isCellInGrid, validateGrid, type GridSpec } from '../../../shared/grid.js';
import type { EventDetail, EventSummary, UserSummary } from '../../../shared/api.js';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const eventInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).default(''),
    visibility: z.enum(['all', 'restricted']),
    startDate: z.string(),
    endDate: z.string(),
    dayStart: z.number().int().nullable().default(null),
    dayEnd: z.number().int().nullable().default(null),
    slotMinutes: z.number().int().nullable().default(null),
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
    inviteeIds: z.array(z.string().max(64)).max(1000).default([]),
    groups: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  })
  .superRefine((v, ctx) => {
    const err = validateGrid(v);
    if (err) ctx.addIssue({ code: 'custom', message: err, path: ['startDate'] });
  });

const archiveInput = z.object({ outcome: z.enum(['happened', 'not_happened']) });

const availabilityInput = z.object({
  cells: z
    .array(
      z.object({
        date: z.string(),
        slot: z.number().int(),
        status: z.enum(['free', 'maybe', 'busy']).nullable(),
      }),
    )
    .max(20_000),
});

const listQuery = z.object({ status: z.enum(['open', 'archived']).default('open') });

function gridOf(ev: Event): GridSpec {
  return {
    startDate: ev.start_date,
    endDate: ev.end_date,
    dayStart: ev.day_start,
    dayEnd: ev.day_end,
    slotMinutes: ev.slot_minutes,
  };
}

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: error.issues.map((i) => i.message).join('; ') });
}

function mergeAccess(a: EventAccess, b: EventAccess): EventAccess {
  return {
    id: a.id,
    createdBy: a.createdBy,
    visibility: a.visibility === 'all' || b.visibility === 'all' ? 'all' : 'restricted',
    inviteeIds: [...new Set([...a.inviteeIds, ...b.inviteeIds])],
    groups: [...new Set([...a.groups, ...b.groups])],
  };
}

export async function registerEventRoutes(app: FastifyInstance, db: DB, bus: ChangeBus): Promise<void> {
  const notify = (msg: ChangeMessage) => bus.publish(msg);

  async function userSummaries(ids: string[]): Promise<Map<string, UserSummary>> {
    const unique = [...new Set(ids)];
    const map = new Map<string, UserSummary>();
    if (!unique.length) return map;
    const rows = await db.selectFrom('users').select(['id', 'name', 'username']).where('id', 'in', unique).execute();
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  async function summarize(user: AuthUser, events: Event[]): Promise<EventSummary[]> {
    if (!events.length) return [];
    const ids = events.map((e) => e.id);
    const [creators, counts, mine, polls] = await Promise.all([
      userSummaries(events.map((e) => e.created_by)),
      db
        .selectFrom('availability')
        .select(['event_id', (eb) => eb.fn.count<number>('user_id').distinct().as('n')])
        .where('event_id', 'in', ids)
        .groupBy('event_id')
        .execute(),
      db
        .selectFrom('availability')
        .select('event_id')
        .distinct()
        .where('event_id', 'in', ids)
        .where('user_id', '=', user.id)
        .execute(),
      db
        .selectFrom('polls')
        .select(['event_id', (eb) => eb.fn.count<number>('id').as('n')])
        .where('event_id', 'in', ids)
        .groupBy('event_id')
        .execute(),
    ]);
    const countMap = new Map(counts.map((c) => [c.event_id, Number(c.n)]));
    const pollMap = new Map(polls.map((c) => [c.event_id, Number(c.n)]));
    const mineSet = new Set(mine.map((m) => m.event_id));
    return events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      createdBy: creators.get(e.created_by) ?? { id: e.created_by, name: 'Unknown user', username: null },
      visibility: e.visibility,
      startDate: e.start_date,
      endDate: e.end_date,
      dayStart: e.day_start,
      dayEnd: e.day_end,
      slotMinutes: e.slot_minutes,
      timezone: e.timezone,
      status: e.status,
      archivedAt: e.archived_at,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      respondentCount: countMap.get(e.id) ?? 0,
      respondedByMe: mineSet.has(e.id),
      canManage: canManage(user, { createdBy: e.created_by }),
      pollCount: pollMap.get(e.id) ?? 0,
    }));
  }

  /** Loads an event the user can view, or sends 404 and returns undefined. */
  async function loadViewable(user: AuthUser, id: string, reply: FastifyReply) {
    const access = await loadEventAccess(db, id);
    if (!access || !canView(user, access)) {
      await reply.code(404).send({ error: 'Event not found' });
      return undefined;
    }
    const event = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { access, event };
  }

  async function setAccessLists(eventId: string, inviteeIds: string[], groups: string[]) {
    const validInvitees = inviteeIds.length
      ? (await db.selectFrom('users').select('id').where('id', 'in', [...new Set(inviteeIds)]).execute()).map((r) => r.id)
      : [];
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('event_invitees').where('event_id', '=', eventId).execute();
      await tx.deleteFrom('event_groups').where('event_id', '=', eventId).execute();
      if (validInvitees.length) {
        await tx
          .insertInto('event_invitees')
          .values(validInvitees.map((user_id) => ({ event_id: eventId, user_id })))
          .execute();
      }
      const uniqueGroups = [...new Set(groups)];
      if (uniqueGroups.length) {
        await tx
          .insertInto('event_groups')
          .values(uniqueGroups.map((group_name) => ({ event_id: eventId, group_name })))
          .execute();
      }
    });
  }

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/events')) await requireUser(request, reply);
  });

  // ------------------------------------------------------------ list
  app.get('/api/events', async (request, reply) => {
    const q = listQuery.safeParse(request.query);
    if (!q.success) return badRequest(reply, q.error);
    const user = request.user!;

    let query = db.selectFrom('events').selectAll();
    query =
      q.data.status === 'open'
        ? query.where('status', '=', 'open').orderBy('start_date', 'asc')
        : query.where('status', '!=', 'open').orderBy('archived_at', 'desc');

    if (!user.isAdmin) {
      query = query.where((eb) => {
        const ors = [
          eb('visibility', '=', 'all'),
          eb('created_by', '=', user.id),
          eb('id', 'in', eb.selectFrom('event_invitees').select('event_id').where('user_id', '=', user.id)),
        ];
        if (user.groups.length) {
          ors.push(
            eb('id', 'in', eb.selectFrom('event_groups').select('event_id').where('group_name', 'in', user.groups)),
          );
        }
        return eb.or(ors);
      });
    }

    const events = await query.limit(q.data.status === 'archived' ? 200 : 1000).execute();
    return summarize(user, events);
  });

  // ------------------------------------------------------------ detail
  app.get<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const user = request.user!;
    const found = await loadViewable(user, request.params.id, reply);
    if (!found) return;
    const { access, event } = found;

    const rows = await db
      .selectFrom('availability')
      .select(['user_id', 'date', 'slot', 'status'])
      .where('event_id', '=', event.id)
      .execute();
    const grid = gridOf(event);
    const availability = rows
      .filter((r) => isCellInGrid(grid, r.date, r.slot))
      .map((r) => ({ userId: r.user_id, date: r.date, slot: r.slot, status: r.status }));

    const respondentIds = [...new Set(availability.map((a) => a.userId))];
    const people = await userSummaries([...respondentIds, ...access.inviteeIds]);
    const [summary] = await summarize(user, [event]);
    const polls = await loadPolls(db, event.id, user, summary!.canManage);

    const detail: EventDetail = {
      ...summary!,
      invitees: access.inviteeIds.map((id) => people.get(id)).filter((u): u is UserSummary => !!u),
      groups: access.groups,
      respondents: respondentIds.map((id) => people.get(id)).filter((u): u is UserSummary => !!u),
      availability,
      polls,
    };
    return detail;
  });

  // ------------------------------------------------------------ create
  app.post('/api/events', async (request, reply) => {
    const parsed = eventInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const input = parsed.data;
    const user = request.user!;
    const now = nowIso();
    const id = newId();

    await db
      .insertInto('events')
      .values({
        id,
        title: input.title,
        description: input.description,
        created_by: user.id,
        visibility: input.visibility,
        start_date: input.startDate,
        end_date: input.endDate,
        day_start: input.dayStart,
        day_end: input.dayEnd,
        slot_minutes: input.slotMinutes,
        timezone: input.timezone,
        status: 'open',
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (input.visibility === 'restricted') await setAccessLists(id, input.inviteeIds, input.groups);

    const access = (await loadEventAccess(db, id))!;
    notify({ kind: 'created', eventId: id, access });
    return reply.code(201).send({ id });
  });

  // ------------------------------------------------------------ update
  app.put<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const user = request.user!;
    const found = await loadViewable(user, request.params.id, reply);
    if (!found) return;
    const { access: before, event } = found;
    if (!canManage(user, before)) return reply.code(403).send({ error: 'Only the creator can edit this event' });
    if (event.status !== 'open') return reply.code(409).send({ error: 'Reopen the event before editing it' });

    const parsed = eventInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const input = parsed.data;

    await db
      .updateTable('events')
      .set({
        title: input.title,
        description: input.description,
        visibility: input.visibility,
        start_date: input.startDate,
        end_date: input.endDate,
        day_start: input.dayStart,
        day_end: input.dayEnd,
        slot_minutes: input.slotMinutes,
        timezone: input.timezone,
        updated_at: nowIso(),
      })
      .where('id', '=', event.id)
      .execute();
    await setAccessLists(
      event.id,
      input.visibility === 'restricted' ? input.inviteeIds : [],
      input.visibility === 'restricted' ? input.groups : [],
    );

    // Drop availability that no longer fits the (possibly changed) grid.
    const grid: GridSpec = input;
    const cells = await db
      .selectFrom('availability')
      .select(['date', 'slot'])
      .distinct()
      .where('event_id', '=', event.id)
      .execute();
    const stale = cells.filter((c) => !isCellInGrid(grid, c.date, c.slot));
    if (stale.length) {
      await db.transaction().execute(async (tx) => {
        for (const c of stale) {
          await tx
            .deleteFrom('availability')
            .where('event_id', '=', event.id)
            .where('date', '=', c.date)
            .where('slot', '=', c.slot)
            .execute();
        }
      });
    }

    const after = (await loadEventAccess(db, event.id))!;
    // Notify everyone who could see it before or after, so lost access is reflected too.
    notify({ kind: 'updated', eventId: event.id, access: mergeAccess(before, after) });
    return { id: event.id };
  });

  // ------------------------------------------------------------ archive / reopen
  app.post<{ Params: { id: string } }>('/api/events/:id/archive', async (request, reply) => {
    const user = request.user!;
    const found = await loadViewable(user, request.params.id, reply);
    if (!found) return;
    if (!canManage(user, found.access)) return reply.code(403).send({ error: 'Only the creator can archive this event' });
    const parsed = archiveInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const now = nowIso();
    await db
      .updateTable('events')
      .set({ status: parsed.data.outcome, archived_at: now, updated_at: now })
      .where('id', '=', found.event.id)
      .execute();
    notify({ kind: 'archived', eventId: found.event.id, access: found.access });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/reopen', async (request, reply) => {
    const user = request.user!;
    const found = await loadViewable(user, request.params.id, reply);
    if (!found) return;
    if (!canManage(user, found.access)) return reply.code(403).send({ error: 'Only the creator can reopen this event' });

    await db
      .updateTable('events')
      .set({ status: 'open', archived_at: null, updated_at: nowIso() })
      .where('id', '=', found.event.id)
      .execute();
    notify({ kind: 'updated', eventId: found.event.id, access: found.access });
    return { ok: true };
  });

  // ------------------------------------------------------------ delete
  app.delete<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const user = request.user!;
    const found = await loadViewable(user, request.params.id, reply);
    if (!found) return;
    if (!canManage(user, found.access)) return reply.code(403).send({ error: 'Only the creator can delete this event' });

    await db.transaction().execute(async (tx) => {
      // Explicit deletes so we don't depend on FK cascade support/config.
      const pollIds = tx.selectFrom('polls').select('id').where('event_id', '=', found.event.id);
      await tx.deleteFrom('poll_votes').where('poll_id', 'in', pollIds).execute();
      await tx.deleteFrom('poll_options').where('poll_id', 'in', pollIds).execute();
      await tx.deleteFrom('polls').where('event_id', '=', found.event.id).execute();
      await tx.deleteFrom('availability').where('event_id', '=', found.event.id).execute();
      await tx.deleteFrom('event_invitees').where('event_id', '=', found.event.id).execute();
      await tx.deleteFrom('event_groups').where('event_id', '=', found.event.id).execute();
      await tx.deleteFrom('events').where('id', '=', found.event.id).execute();
    });
    notify({ kind: 'deleted', eventId: found.event.id, access: found.access });
    return { ok: true };
  });

  // ------------------------------------------------------------ my availability
  app.put<{ Params: { id: string } }>('/api/events/:id/availability', async (request, reply) => {
    const user = request.user!;
    const found = await loadViewable(user, request.params.id, reply);
    if (!found) return;
    if (found.event.status !== 'open') return reply.code(409).send({ error: 'This event is archived' });

    const parsed = availabilityInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const grid = gridOf(found.event);
    const cells = parsed.data.cells;
    if (cells.some((c) => !isCellInGrid(grid, c.date, c.slot))) {
      return reply.code(400).send({ error: 'One or more cells are outside the event range' });
    }

    const now = nowIso();
    const upserts = cells.filter((c) => c.status !== null);
    const clears = cells.filter((c) => c.status === null);

    await db.transaction().execute(async (tx) => {
      const clearsByDate = new Map<string, number[]>();
      for (const c of clears) clearsByDate.set(c.date, [...(clearsByDate.get(c.date) ?? []), c.slot]);
      for (const [date, slots] of clearsByDate) {
        await tx
          .deleteFrom('availability')
          .where('event_id', '=', found.event.id)
          .where('user_id', '=', user.id)
          .where('date', '=', date)
          .where('slot', 'in', slots)
          .execute();
      }
      for (let i = 0; i < upserts.length; i += 500) {
        const chunk = upserts.slice(i, i + 500);
        await tx
          .insertInto('availability')
          .values(
            chunk.map((c) => ({
              event_id: found.event.id,
              user_id: user.id,
              date: c.date,
              slot: c.slot,
              status: c.status!,
              updated_at: now,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['event_id', 'user_id', 'date', 'slot']).doUpdateSet((eb) => ({
              status: eb.ref('excluded.status'),
              updated_at: eb.ref('excluded.updated_at'),
            })),
          )
          .execute();
      }
    });

    notify({ kind: 'availability', eventId: found.event.id, access: found.access });
    return { ok: true };
  });
}
