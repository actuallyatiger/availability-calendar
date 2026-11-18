import type { Insertable, Selectable, Updateable } from 'kysely';

/*
 * Column types are deliberately limited to TEXT and INTEGER so the same schema
 * and queries run unchanged on SQLite and PostgreSQL. Timestamps are ISO-8601
 * strings; dates are YYYY-MM-DD strings; JSON is stored as TEXT.
 */

export interface UserTable {
  id: string;
  /** OIDC subject (or `dev:<username>` in dev auth mode). */
  sub: string;
  username: string | null;
  name: string;
  email: string | null;
  /** JSON array of group names from the latest login. */
  groups: string;
  created_at: string;
  last_login_at: string;
}

export interface SessionTable {
  /** SHA-256 of the session token held in the cookie. */
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export type EventVisibility = 'all' | 'restricted';
export type EventStatus = 'open' | 'happened' | 'not_happened';

export interface EventTable {
  id: string;
  title: string;
  description: string;
  created_by: string;
  visibility: EventVisibility;
  /** Inclusive date range, YYYY-MM-DD, interpreted in `timezone`. */
  start_date: string;
  end_date: string;
  /** Daily window in minutes from midnight. Null => whole-day mode. */
  day_start: number | null;
  day_end: number | null;
  slot_minutes: number | null;
  timezone: string;
  status: EventStatus;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventInviteeTable {
  event_id: string;
  user_id: string;
}

export interface EventGroupTable {
  event_id: string;
  group_name: string;
}

export type AvailabilityStatus = 'free' | 'maybe' | 'busy';

export interface AvailabilityTable {
  event_id: string;
  user_id: string;
  date: string;
  /** Minutes from midnight of the slot start, or WHOLE_DAY_SLOT (-1). */
  slot: number;
  status: AvailabilityStatus;
  updated_at: string;
}

export interface PollTable {
  id: string;
  event_id: string;
  question: string;
  /** 1 = voters may pick several options, 0 = pick one. */
  multiple: number;
  /** 1 = anyone who can see the event may add options. */
  allow_suggestions: number;
  closed: number;
  created_by: string;
  created_at: string;
}

export interface PollOptionTable {
  id: string;
  poll_id: string;
  label: string;
  /** Display order within the poll. */
  position: number;
  /** Optional http(s) link, e.g. a map or menu. */
  url: string | null;
  created_by: string;
  created_at: string;
}

export interface PollVoteTable {
  poll_id: string;
  option_id: string;
  user_id: string;
  created_at: string;
}

export interface Database {
  users: UserTable;
  sessions: SessionTable;
  events: EventTable;
  event_invitees: EventInviteeTable;
  event_groups: EventGroupTable;
  availability: AvailabilityTable;
  polls: PollTable;
  poll_options: PollOptionTable;
  poll_votes: PollVoteTable;
}

export type User = Selectable<UserTable>;
export type NewUser = Insertable<UserTable>;
export type Event = Selectable<EventTable>;
export type NewEvent = Insertable<EventTable>;
export type EventUpdate = Updateable<EventTable>;
