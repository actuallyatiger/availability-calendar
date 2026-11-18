import type { DB } from './db/index.js';
import type { EventVisibility, User } from './db/types.js';
import { parseJsonArray } from './util.js';

export interface AuthUser {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  groups: string[];
  isAdmin: boolean;
}

export function toAuthUser(user: User, adminGroup: string | undefined): AuthUser {
  const groups = parseJsonArray(user.groups);
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    groups,
    isAdmin: !!adminGroup && groups.includes(adminGroup),
  };
}

/** Everything needed to decide who may see an event, without further queries. */
export interface EventAccess {
  id: string;
  createdBy: string;
  visibility: EventVisibility;
  inviteeIds: string[];
  groups: string[];
}

export function canView(user: AuthUser, ev: EventAccess): boolean {
  if (user.isAdmin || ev.createdBy === user.id || ev.visibility === 'all') return true;
  if (ev.inviteeIds.includes(user.id)) return true;
  return ev.groups.some((g) => user.groups.includes(g));
}

export function canManage(user: AuthUser, ev: Pick<EventAccess, 'createdBy'>): boolean {
  return user.isAdmin || ev.createdBy === user.id;
}

export async function loadEventAccess(db: DB, eventId: string): Promise<EventAccess | undefined> {
  const ev = await db
    .selectFrom('events')
    .select(['id', 'created_by', 'visibility'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!ev) return undefined;
  const [invitees, groups] = await Promise.all([
    db.selectFrom('event_invitees').select('user_id').where('event_id', '=', eventId).execute(),
    db.selectFrom('event_groups').select('group_name').where('event_id', '=', eventId).execute(),
  ]);
  return {
    id: ev.id,
    createdBy: ev.created_by,
    visibility: ev.visibility,
    inviteeIds: invitees.map((i) => i.user_id),
    groups: groups.map((g) => g.group_name),
  };
}
