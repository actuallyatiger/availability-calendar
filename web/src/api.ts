import type {
  AvailabilityCellInput,
  EventDetail,
  EventInput,
  EventSummary,
  SessionResponse,
  UserSummary,
} from '../../shared/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  session: () => request<SessionResponse>('GET', '/api/session'),
  logout: () => request<{ redirect: string }>('POST', '/api/auth/logout', {}),
  users: () => request<UserSummary[]>('GET', '/api/users'),
  groups: () => request<string[]>('GET', '/api/groups'),
  listEvents: (status: 'open' | 'archived') => request<EventSummary[]>('GET', `/api/events?status=${status}`),
  getEvent: (id: string) => request<EventDetail>('GET', `/api/events/${encodeURIComponent(id)}`),
  createEvent: (input: EventInput) => request<{ id: string }>('POST', '/api/events', input),
  updateEvent: (id: string, input: EventInput) => request<{ id: string }>('PUT', `/api/events/${encodeURIComponent(id)}`, input),
  deleteEvent: (id: string) => request<{ ok: true }>('DELETE', `/api/events/${encodeURIComponent(id)}`),
  archiveEvent: (id: string, outcome: 'happened' | 'not_happened') =>
    request<{ ok: true }>('POST', `/api/events/${encodeURIComponent(id)}/archive`, { outcome }),
  reopenEvent: (id: string) => request<{ ok: true }>('POST', `/api/events/${encodeURIComponent(id)}/reopen`, {}),
  setAvailability: (id: string, cells: AvailabilityCellInput[]) =>
    request<{ ok: true }>('PUT', `/api/events/${encodeURIComponent(id)}/availability`, { cells }),
};
