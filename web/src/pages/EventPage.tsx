import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AvailabilityStatus, EventDetail, UserSummary } from '../../../shared/api';
import { datesInRange, slotsForGrid } from '../../../shared/grid';
import { api, ApiError } from '../api';
import { useLive, useSession } from '../session';
import { browserTimezone, formatDateTime, formatHours, formatRange } from '../format';
import { cellKey } from '../components/Grid';
import { MyAvailability, type Brush } from '../components/MyAvailability';
import { aggregate, BestTimes, CellDetails, GroupAvailability } from '../components/GroupAvailability';
import { StatusBadge } from './EventListPage';
import { Polls } from '../components/Polls';

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export function EventPage() {
  const { id } = useParams() as { id: string };
  const { user } = useSession();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  const [mine, setMine] = useState<Map<string, AvailabilityStatus>>(new Map());
  const pending = useRef(new Map<string, { date: string; slot: number; status: AvailabilityStatus | null }>());
  const inflight = useRef(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [brush, setBrush] = useState<Brush>('free');
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [tab, setTab] = useState<'mine' | 'group'>('mine');

  const load = useCallback(async () => {
    try {
      const ev = await api.getEvent(id);
      setEvent(ev);
      setError(null);
      // Only replace local edits with server state when nothing is unsaved.
      if (!pending.current.size && !inflight.current) {
        setMine(new Map(ev.availability.filter((a) => a.userId === user.id).map((a) => [cellKey(a.date, a.slot), a.status])));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setDeleted(true);
      else setError((e as Error).message);
    }
  }, [id, user.id]);

  useEffect(() => {
    setEvent(null);
    setDeleted(false);
    void load();
  }, [load]);

  useLive((msg) => msg.kind === 'reconnect' || msg.eventId === id, () => void load());

  const flush = useCallback(async () => {
    if (inflight.current || !pending.current.size) return;
    const cells = [...pending.current.values()];
    pending.current.clear();
    inflight.current = true;
    setSaveState('saving');
    try {
      await api.setAvailability(id, cells);
      setSaveState(pending.current.size ? 'pending' : 'saved');
    } catch (e) {
      setSaveState('error');
      setError((e as Error).message);
      inflight.current = false;
      void load();
      return;
    }
    inflight.current = false;
    if (pending.current.size) void flush();
  }, [id, load]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commit = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 300);
  }, [flush]);

  // Flush unsaved changes when leaving the page.
  useEffect(() => () => void flush(), [flush]);

  const change = useCallback((cells: { date: string; slot: number }[], status: AvailabilityStatus | null) => {
    setMine((prev) => {
      const next = new Map(prev);
      for (const c of cells) {
        const k = cellKey(c.date, c.slot);
        if (status) next.set(k, status);
        else next.delete(k);
        pending.current.set(k, { ...c, status });
      }
      return next;
    });
    setSaveState('pending');
  }, []);

  const dates = useMemo(() => (event ? datesInRange(event.startDate, event.endDate) : []), [event]);
  const slots = useMemo(() => (event ? slotsForGrid(event) : []), [event]);

  // Group view uses server data, but overlays my unsaved local edits.
  const groupEntries = useMemo(() => {
    if (!event) return [];
    const others = event.availability.filter((a) => a.userId !== user.id);
    const mineEntries = [...mine.entries()].map(([k, status]) => {
      const [date, slot] = k.split('|') as [string, string];
      return { userId: user.id, date, slot: Number(slot), status };
    });
    return [...others, ...mineEntries];
  }, [event, mine, user.id]);
  const cells = useMemo(() => aggregate(groupEntries), [groupEntries]);

  const people: UserSummary[] = useMemo(() => {
    if (!event) return [];
    // My own entry follows local state so the group view updates instantly.
    const list = event.respondents.filter((p) => p.id !== user.id);
    if (mine.size) list.push({ id: user.id, name: user.name, username: user.username });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [event, mine.size, user]);

  const notResponded = useMemo(() => {
    if (!event) return [];
    const responded = new Set(people.map((p) => p.id));
    return event.invitees.filter((i) => !responded.has(i.id));
  }, [event, people]);

  if (deleted) {
    return (
      <div className="center-message">
        This event doesn't exist or you no longer have access. <Link to="/">Back to events</Link>
      </div>
    );
  }
  if (!event) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;

  const archived = event.status !== 'open';
  const viewerTz = browserTimezone();

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    try {
      await fn();
      after?.();
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="event-page">
      <div className="event-head">
        <div>
          <Link to={archived ? '/archived' : '/'} className="back">
            ← All events
          </Link>
          <h1>{event.title}</h1>
          <div className="meta">
            <span>{formatRange(event)}</span>
            <span>·</span>
            <span>{formatHours(event)}</span>
            <span>·</span>
            <span title="Times are shown in this timezone">{event.timezone}</span>
            {viewerTz !== event.timezone && <span className="muted">(you're in {viewerTz})</span>}
          </div>
          <div className="meta">
            <span>Created by {event.createdBy.name}</span>
            {event.visibility === 'restricted' ? (
              <span className="badge" title={[...event.invitees.map((i) => i.name), ...event.groups.map((g) => `group: ${g}`)].join(', ')}>
                Invite only
              </span>
            ) : (
              <span className="badge">Everyone</span>
            )}
            {archived && <StatusBadge status={event.status} />}
            {archived && event.archivedAt && <span className="muted small">archived {formatDateTime(event.archivedAt)}</span>}
          </div>
        </div>
        {event.canManage && (
          <div className="manage">
            {archived ? (
              <button className="btn" onClick={() => act(() => api.reopenEvent(id))}>
                Reopen
              </button>
            ) : (
              <>
                <Link to={`/events/${id}/edit`} className="btn">
                  Edit
                </Link>
                <button className="btn btn-free" onClick={() => act(() => api.archiveEvent(id, 'happened'))}>
                  ✓ Happened
                </button>
                <button className="btn btn-busy" onClick={() => act(() => api.archiveEvent(id, 'not_happened'))}>
                  ✕ Didn't happen
                </button>
              </>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (confirm(`Delete "${event.title}" and everyone's responses? This cannot be undone.`)) {
                  void act(() => api.deleteEvent(id), () => navigate('/'));
                }
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {event.description && <p className="description">{event.description}</p>}
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <nav className="tabs tabs-mobile">
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          Your availability
        </button>
        <button className={tab === 'group' ? 'active' : ''} onClick={() => setTab('group')}>
          Everyone ({people.length})
        </button>
      </nav>

      <div className="panes">
        <section className={`card pane ${tab === 'mine' ? 'show' : ''}`}>
          <div className="pane-head">
            <h2>Your availability</h2>
            <span className={`save-state ${saveState}`}>
              {saveState === 'saving' || saveState === 'pending' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
            </span>
          </div>
          {archived ? (
            <p className="muted small">This event is archived, so responses can't be changed.</p>
          ) : (
            <>
              <div className="brushes" role="radiogroup" aria-label="Paint with">
                {(['free', 'maybe', 'busy', 'clear'] as const).map((b) => (
                  <button
                    key={b}
                    role="radio"
                    aria-checked={brush === b}
                    className={`brush ${b} ${brush === b ? 'active' : ''}`}
                    onClick={() => setBrush(b)}
                  >
                    <span className={`dot ${b === 'clear' ? 'empty' : b}`} />
                    {b === 'free' ? 'Free' : b === 'maybe' ? 'Maybe' : b === 'busy' ? 'Busy' : 'Clear'}
                  </button>
                ))}
              </div>
              <p className="hint">
                Pick a status, then click or drag over the grid. Click a day or time label to fill the whole column or row.
              </p>
            </>
          )}
          <MyAvailability
            dates={dates}
            slots={slots}
            slotMinutes={event.slotMinutes}
            mine={mine}
            brush={brush}
            readOnly={archived}
            onChange={change}
            onCommit={commit}
          />
        </section>

        <section className={`card pane ${tab === 'group' ? 'show' : ''}`}>
          <div className="pane-head">
            <h2>Everyone</h2>
            <span className="muted small">
              {people.length} {people.length === 1 ? 'response' : 'responses'}
            </span>
          </div>
          <div className="legend small">
            <span>
              <span className="swatch heat-lo" /> fewer free
            </span>
            <span>
              <span className="swatch heat-hi" /> more free
            </span>
            <span>number = free, n? = maybe</span>
          </div>
          <GroupAvailability
            dates={dates}
            slots={slots}
            slotMinutes={event.slotMinutes}
            cells={cells}
            people={people}
            selected={selectedCell}
            onSelect={setSelectedCell}
          />
          <CellDetails cellKeyValue={selectedCell} cells={cells} people={people} slotMinutes={event.slotMinutes} />

          <h3>Best times</h3>
          <BestTimes dates={dates} slots={slots} slotMinutes={event.slotMinutes} cells={cells} people={people} onSelect={setSelectedCell} />

          <h3>Responded</h3>
          <p className="small">{people.length ? people.map((p) => p.name).join(', ') : <span className="muted">No responses yet.</span>}</p>
          {notResponded.length > 0 && (
            <>
              <h3>Invited, not responded</h3>
              <p className="small">{notResponded.map((p) => p.name).join(', ')}</p>
            </>
          )}
        </section>
      </div>

      <Polls
        eventId={id}
        polls={event.polls}
        userId={user.id}
        organizerId={event.createdBy.id}
        canManage={event.canManage}
        readOnly={archived}
        onChanged={load}
        onError={setError}
      />
    </div>
  );
}
