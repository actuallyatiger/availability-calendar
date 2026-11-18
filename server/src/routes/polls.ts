import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import type { ChangeBus } from '../bus.js';
import { canManage, canView, loadEventAccess, type AuthUser, type EventAccess } from '../access.js';
import { requireUser } from '../auth.js';
import { newId, nowIso } from '../util.js';
import type { Poll, UserSummary } from '../../../shared/api.js';

const MAX_OPTIONS = 50;
const label = z.string().trim().min(1).max(200);

/**
 * Optional link for an option. Accepts "example.com/x" (https:// is added),
 * rejects anything that isn't http(s) so links can't run script.
 * Empty string / null means "no link".
 */
export function normalizeUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(v) ? v : `https://${v}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Link is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Links must start with http:// or https://');
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error('Link is not a valid URL');
  return url.href;
}

const urlField = z
  .string()
  .max(2000)
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v == null) return null;
    try {
      return normalizeUrl(v);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
      return z.NEVER;
    }
  });

const optionInput = z.object({ label, url: urlField });
// Plain strings are still accepted for options without a link.
const optionEntry = z.union([label.transform((l) => ({ label: l, url: null })), optionInput]);

const pollInput = z.object({
  question: z.string().trim().min(1).max(300),
  multiple: z.boolean().default(true),
  allowSuggestions: z.boolean().default(true),
  options: z.array(optionEntry).max(MAX_OPTIONS).default([]),
});

const pollUpdate = z.object({
  question: z.string().trim().min(1).max(300).optional(),
  multiple: z.boolean().optional(),
  allowSuggestions: z.boolean().optional(),
  closed: z.boolean().optional(),
});

const optionUpdate = z.object({ url: urlField });
const votesInput = z.object({ optionIds: z.array(z.string().max(64)).max(MAX_OPTIONS) });

/** Case/whitespace-insensitive key used to reject duplicate options. */
const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function dedupe<T extends { label: string }>(options: T[]): T[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    const k = normalize(o.label);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Loads all polls for an event, shaped for the given viewer. */
export async function loadPolls(db: DB, eventId: string, viewer: AuthUser, manager: boolean): Promise<Poll[]> {
  const polls = await db
    .selectFrom('polls')
    .selectAll()
    .where('event_id', '=', eventId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (!polls.length) return [];
  const pollIds = polls.map((p) => p.id);
  const [options, votes] = await Promise.all([
    db.selectFrom('poll_options').selectAll().where('poll_id', 'in', pollIds).orderBy('position').execute(),
    db.selectFrom('poll_votes').selectAll().where('poll_id', 'in', pollIds).orderBy('created_at').execute(),
  ]);

  const userIds = [...new Set([...options.map((o) => o.created_by), ...votes.map((v) => v.user_id)])];
  const users = new Map<string, UserSummary>();
  if (userIds.length) {
    for (const u of await db.selectFrom('users').select(['id', 'name', 'username']).where('id', 'in', userIds).execute()) {
      users.set(u.id, u);
    }
  }
  const who = (id: string): UserSummary => users.get(id) ?? { id, name: 'Unknown user', username: null };

  return polls.map((p) => {
    const pollVotes = votes.filter((v) => v.poll_id === p.id);
    return {
      id: p.id,
      question: p.question,
      multiple: !!p.multiple,
      allowSuggestions: !!p.allow_suggestions,
      closed: !!p.closed,
      createdAt: p.created_at,
      voterCount: new Set(pollVotes.map((v) => v.user_id)).size,
      options: options
        .filter((o) => o.poll_id === p.id)
        .map((o) => {
          const voterIds = pollVotes.filter((v) => v.option_id === o.id).map((v) => v.user_id);
          const othersVoted = voterIds.some((id) => id !== viewer.id);
          return {
            id: o.id,
            label: o.label,
            url: o.url,
            createdBy: who(o.created_by),
            voters: voterIds.map(who),
            canDelete: !p.closed && (manager || (o.created_by === viewer.id && !othersVoted)),
            canEdit: !p.closed && (manager || o.created_by === viewer.id),
          };
        }),
    };
  });
}

export async function registerPollRoutes(app: FastifyInstance, db: DB, bus: ChangeBus): Promise<void> {
  const notify = (access: EventAccess) => bus.publish({ kind: 'poll', eventId: access.id, access });

  const badRequest = (reply: FastifyReply, error: z.ZodError) =>
    reply.code(400).send({ error: error.issues.map((i) => i.message).join('; ') });

  /** Event the user can view and that is still open, or sends an error. */
  async function openEvent(user: AuthUser, eventId: string, reply: FastifyReply) {
    const access = await loadEventAccess(db, eventId);
    if (!access || !canView(user, access)) {
      await reply.code(404).send({ error: 'Event not found' });
      return undefined;
    }
    const ev = await db.selectFrom('events').select('status').where('id', '=', eventId).executeTakeFirstOrThrow();
    if (ev.status !== 'open') {
      await reply.code(409).send({ error: 'This event is archived' });
      return undefined;
    }
    return access;
  }

  /** Poll (and its event's access) the user can see, on an open event, or sends an error. */
  async function loadPoll(user: AuthUser, pollId: string, reply: FastifyReply) {
    const poll = await db.selectFrom('polls').selectAll().where('id', '=', pollId).executeTakeFirst();
    if (!poll) {
      await reply.code(404).send({ error: 'Poll not found' });
      return undefined;
    }
    const access = await openEvent(user, poll.event_id, reply);
    if (!access) return undefined;
    return { poll, access, manager: canManage(user, access) };
  }

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/polls')) await requireUser(request, reply);
  });

  // ------------------------------------------------------------ create poll
  app.post<{ Params: { id: string } }>('/api/events/:id/polls', async (request, reply) => {
    const user = request.user!;
    const access = await openEvent(user, request.params.id, reply);
    if (!access) return;
    if (!canManage(user, access)) return reply.code(403).send({ error: 'Only the event creator can add polls' });
    const parsed = pollInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const input = parsed.data;

    const now = nowIso();
    const pollId = newId();
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('polls')
        .values({
          id: pollId,
          event_id: access.id,
          question: input.question,
          multiple: input.multiple ? 1 : 0,
          allow_suggestions: input.allowSuggestions ? 1 : 0,
          closed: 0,
          created_by: user.id,
          created_at: now,
        })
        .execute();
      const opts = dedupe(input.options);
      if (opts.length) {
        await tx
          .insertInto('poll_options')
          .values(
            opts.map((o, position) => ({
              id: newId(),
              poll_id: pollId,
              label: o.label,
              url: o.url,
              position,
              created_by: user.id,
              created_at: now,
            })),
          )
          .execute();
      }
    });
    notify(access);
    return reply.code(201).send({ id: pollId });
  });

  // ------------------------------------------------------------ update poll
  app.patch<{ Params: { pollId: string } }>('/api/polls/:pollId', async (request, reply) => {
    const user = request.user!;
    const found = await loadPoll(user, request.params.pollId, reply);
    if (!found) return;
    if (!found.manager) return reply.code(403).send({ error: 'Only the event creator can change this poll' });
    const parsed = pollUpdate.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const u = parsed.data;

    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable('polls')
        .set({
          ...(u.question !== undefined && { question: u.question }),
          ...(u.multiple !== undefined && { multiple: u.multiple ? 1 : 0 }),
          ...(u.allowSuggestions !== undefined && { allow_suggestions: u.allowSuggestions ? 1 : 0 }),
          ...(u.closed !== undefined && { closed: u.closed ? 1 : 0 }),
        })
        .where('id', '=', found.poll.id)
        .execute();

      // Switching to single choice: keep only each person's most recent vote.
      if (u.multiple === false && found.poll.multiple) {
        const votes = await tx
          .selectFrom('poll_votes')
          .selectAll()
          .where('poll_id', '=', found.poll.id)
          .orderBy('created_at', 'desc')
          .execute();
        const kept = new Set<string>();
        for (const v of votes) {
          if (!kept.has(v.user_id)) {
            kept.add(v.user_id);
            continue;
          }
          await tx
            .deleteFrom('poll_votes')
            .where('option_id', '=', v.option_id)
            .where('user_id', '=', v.user_id)
            .execute();
        }
      }
    });
    notify(found.access);
    return { ok: true };
  });

  // ------------------------------------------------------------ delete poll
  app.delete<{ Params: { pollId: string } }>('/api/polls/:pollId', async (request, reply) => {
    const user = request.user!;
    const found = await loadPoll(user, request.params.pollId, reply);
    if (!found) return;
    if (!found.manager) return reply.code(403).send({ error: 'Only the event creator can delete this poll' });
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('poll_votes').where('poll_id', '=', found.poll.id).execute();
      await tx.deleteFrom('poll_options').where('poll_id', '=', found.poll.id).execute();
      await tx.deleteFrom('polls').where('id', '=', found.poll.id).execute();
    });
    notify(found.access);
    return { ok: true };
  });

  // ------------------------------------------------------------ add option / suggestion
  app.post<{ Params: { pollId: string } }>('/api/polls/:pollId/options', async (request, reply) => {
    const user = request.user!;
    const found = await loadPoll(user, request.params.pollId, reply);
    if (!found) return;
    const { poll } = found;
    if (poll.closed) return reply.code(409).send({ error: 'This poll is closed' });
    if (!found.manager && !poll.allow_suggestions) {
      return reply.code(403).send({ error: 'This poll does not accept suggestions' });
    }
    const parsed = optionInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const existing = await db.selectFrom('poll_options').select(['label', 'position']).where('poll_id', '=', poll.id).execute();
    if (existing.length >= MAX_OPTIONS) return reply.code(409).send({ error: `A poll can have at most ${MAX_OPTIONS} options` });
    if (existing.some((o) => normalize(o.label) === normalize(parsed.data.label))) {
      return reply.code(409).send({ error: 'That option is already on the list' });
    }

    const id = newId();
    await db
      .insertInto('poll_options')
      .values({
        id,
        poll_id: poll.id,
        label: parsed.data.label,
        url: parsed.data.url,
        position: Math.max(-1, ...existing.map((o) => o.position)) + 1,
        created_by: user.id,
        created_at: nowIso(),
      })
      .execute();
    notify(found.access);
    return reply.code(201).send({ id });
  });

  // ------------------------------------------------------------ change option link
  app.patch<{ Params: { pollId: string; optionId: string } }>(
    '/api/polls/:pollId/options/:optionId',
    async (request, reply) => {
      const user = request.user!;
      const found = await loadPoll(user, request.params.pollId, reply);
      if (!found) return;
      const option = await db
        .selectFrom('poll_options')
        .selectAll()
        .where('id', '=', request.params.optionId)
        .where('poll_id', '=', found.poll.id)
        .executeTakeFirst();
      if (!option) return reply.code(404).send({ error: 'Option not found' });
      if (found.poll.closed) return reply.code(409).send({ error: 'This poll is closed' });
      if (!found.manager && option.created_by !== user.id) {
        return reply.code(403).send({ error: 'Only the person who added this option can change its link' });
      }
      const parsed = optionUpdate.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);

      await db.updateTable('poll_options').set({ url: parsed.data.url }).where('id', '=', option.id).execute();
      notify(found.access);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------ remove option
  app.delete<{ Params: { pollId: string; optionId: string } }>(
    '/api/polls/:pollId/options/:optionId',
    async (request, reply) => {
      const user = request.user!;
      const found = await loadPoll(user, request.params.pollId, reply);
      if (!found) return;
      const option = await db
        .selectFrom('poll_options')
        .selectAll()
        .where('id', '=', request.params.optionId)
        .where('poll_id', '=', found.poll.id)
        .executeTakeFirst();
      if (!option) return reply.code(404).send({ error: 'Option not found' });
      if (found.poll.closed) return reply.code(409).send({ error: 'This poll is closed' });

      if (!found.manager) {
        const othersVoted = await db
          .selectFrom('poll_votes')
          .select('user_id')
          .where('option_id', '=', option.id)
          .where('user_id', '!=', user.id)
          .executeTakeFirst();
        if (option.created_by !== user.id || othersVoted) {
          return reply.code(403).send({ error: 'You can only remove your own suggestions before others vote for them' });
        }
      }

      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom('poll_votes').where('option_id', '=', option.id).execute();
        await tx.deleteFrom('poll_options').where('id', '=', option.id).execute();
      });
      notify(found.access);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------ my votes
  app.put<{ Params: { pollId: string } }>('/api/polls/:pollId/votes', async (request, reply) => {
    const user = request.user!;
    const found = await loadPoll(user, request.params.pollId, reply);
    if (!found) return;
    const { poll } = found;
    if (poll.closed) return reply.code(409).send({ error: 'This poll is closed' });
    const parsed = votesInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const optionIds = [...new Set(parsed.data.optionIds)];
    if (!poll.multiple && optionIds.length > 1) return reply.code(400).send({ error: 'This poll allows only one choice' });

    if (optionIds.length) {
      const valid = await db
        .selectFrom('poll_options')
        .select('id')
        .where('poll_id', '=', poll.id)
        .where('id', 'in', optionIds)
        .execute();
      if (valid.length !== optionIds.length) return reply.code(400).send({ error: 'Unknown option' });
    }

    await db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('poll_votes')
        .select('option_id')
        .where('poll_id', '=', poll.id)
        .where('user_id', '=', user.id)
        .execute();
      const have = new Set(current.map((c) => c.option_id));
      const want = new Set(optionIds);
      const remove = [...have].filter((id) => !want.has(id));
      const add = optionIds.filter((id) => !have.has(id));
      if (remove.length) {
        await tx
          .deleteFrom('poll_votes')
          .where('poll_id', '=', poll.id)
          .where('user_id', '=', user.id)
          .where('option_id', 'in', remove)
          .execute();
      }
      if (add.length) {
        const now = nowIso();
        await tx
          .insertInto('poll_votes')
          .values(add.map((option_id) => ({ poll_id: poll.id, option_id, user_id: user.id, created_at: now })))
          .execute();
      }
    });
    notify(found.access);
    return { ok: true };
  });
}
