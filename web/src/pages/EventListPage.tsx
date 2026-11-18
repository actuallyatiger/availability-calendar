import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { EventSummary } from '../../../shared/api';
import { api } from '../api';
import { useLive } from '../session';
import { formatDateTime, formatHours, formatRange } from '../format';

export function EventListPage({ archived = false }: { archived?: boolean }) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listEvents(archived ? 'archived' : 'open').then(
      (e) => {
        setEvents(e);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [archived]);

  useEffect(() => {
    setEvents(null);
    load();
  }, [load]);

  // Any change to any visible event may affect this list.
  useLive(() => true, load);

  return (
    <>
      <div className="page-head">
        <nav className="tabs">
          <NavLink to="/" end>
            Being scheduled
          </NavLink>
          <NavLink to="/archived">Archived</NavLink>
        </nav>
        <Link to="/events/new" className="btn btn-primary">
          + New event
        </Link>
      </div>

      {error && <div className="error">{error}</div>}
      {!events && !error && <p className="muted">Loading…</p>}
      {events && events.length === 0 && (
        <div className="empty-state card">
          {archived ? (
            <p>No archived events yet.</p>
          ) : (
            <>
              <p>Nothing is being scheduled right now.</p>
              <Link to="/events/new" className="btn btn-primary">
                Create the first event
              </Link>
            </>
          )}
        </div>
      )}
      <ul className="event-list">
        {events?.map((ev) => (
          <li key={ev.id}>
            <Link to={`/events/${ev.id}`} className="card event-card">
              <div className="event-card-main">
                <h2>{ev.title}</h2>
                <div className="meta">
                  <span>{formatRange(ev)}</span>
                  <span>·</span>
                  <span>{formatHours(ev)}</span>
                  <span>·</span>
                  <span>by {ev.createdBy.name}</span>
                </div>
                {ev.description && <p className="event-card-desc">{ev.description}</p>}
              </div>
              <div className="event-card-side">
                {archived ? (
                  <>
                    <StatusBadge status={ev.status} />
                    {ev.archivedAt && <span className="muted small">{formatDateTime(ev.archivedAt)}</span>}
                  </>
                ) : (
                  <>
                    <span className="count">
                      {ev.respondentCount} {ev.respondentCount === 1 ? 'response' : 'responses'}
                    </span>
                    {!ev.respondedByMe && <span className="badge badge-accent">Needs your response</span>}
                  </>
                )}
                {ev.pollCount > 0 && (
                  <span className="badge">
                    {ev.pollCount} {ev.pollCount === 1 ? 'poll' : 'polls'}
                  </span>
                )}
                {ev.visibility === 'restricted' && <span className="badge">Invite only</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function StatusBadge({ status }: { status: EventSummary['status'] }) {
  if (status === 'happened') return <span className="badge badge-free">Happened</span>;
  if (status === 'not_happened') return <span className="badge badge-busy">Didn't happen</span>;
  return <span className="badge">Open</span>;
}
