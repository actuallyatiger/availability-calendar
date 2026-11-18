/* JSON shapes exchanged between the API and the web client. */

export type AuthMode = 'oidc' | 'dev';
export type EventVisibility = 'all' | 'restricted';
export type EventStatus = 'open' | 'happened' | 'not_happened';
export type AvailabilityStatus = 'free' | 'maybe' | 'busy';

export interface SessionUser {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  groups: string[];
  isAdmin: boolean;
}

export interface SessionResponse {
  user: SessionUser | null;
  authMode: AuthMode;
}

export interface UserSummary {
  id: string;
  name: string;
  username: string | null;
}

export interface EventSummary {
  id: string;
  title: string;
  description: string;
  createdBy: UserSummary;
  visibility: EventVisibility;
  startDate: string;
  endDate: string;
  dayStart: number | null;
  dayEnd: number | null;
  slotMinutes: number | null;
  timezone: string;
  status: EventStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  respondentCount: number;
  respondedByMe: boolean;
  canManage: boolean;
  pollCount: number;
}

export interface AvailabilityEntry {
  userId: string;
  date: string;
  slot: number;
  status: AvailabilityStatus;
}

export interface EventDetail extends EventSummary {
  invitees: UserSummary[];
  groups: string[];
  respondents: UserSummary[];
  availability: AvailabilityEntry[];
  polls: Poll[];
}

export interface PollOption {
  id: string;
  label: string;
  createdBy: UserSummary;
  voters: UserSummary[];
  /** True if the current user may remove this option. */
  canDelete: boolean;
}

export interface Poll {
  id: string;
  question: string;
  multiple: boolean;
  allowSuggestions: boolean;
  closed: boolean;
  createdAt: string;
  options: PollOption[];
  /** Number of distinct people who voted. */
  voterCount: number;
}

export interface PollInput {
  question: string;
  multiple: boolean;
  allowSuggestions: boolean;
  options: string[];
}

export interface PollUpdate {
  question?: string;
  multiple?: boolean;
  allowSuggestions?: boolean;
  closed?: boolean;
}

export interface EventInput {
  title: string;
  description: string;
  visibility: EventVisibility;
  startDate: string;
  endDate: string;
  dayStart: number | null;
  dayEnd: number | null;
  slotMinutes: number | null;
  timezone: string;
  inviteeIds: string[];
  groups: string[];
}

export interface AvailabilityCellInput {
  date: string;
  slot: number;
  /** null clears the cell. */
  status: AvailabilityStatus | null;
}

export type ChangeKind = 'created' | 'updated' | 'availability' | 'poll' | 'archived' | 'deleted';

export interface ChangeNotification {
  kind: ChangeKind;
  eventId: string;
}
