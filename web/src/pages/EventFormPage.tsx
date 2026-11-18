import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EventInput, UserSummary } from '../../../shared/api';
import { addDays, formatMinutes, MAX_EVENT_DAYS, parseTime, SLOT_LENGTHS, validateGrid } from '../../../shared/grid';
import { api } from '../api';
import { useSession } from '../session';
import { browserTimezone } from '../format';

function todayIn(tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

export function EventFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const { user } = useSession();

  const tz = browserTimezone();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(todayIn(tz));
  const [endDate, setEndDate] = useState(addDays(todayIn(tz), 6));
  const [timed, setTimed] = useState(true);
  const [dayStart, setDayStart] = useState('18:00');
  const [dayEnd, setDayEnd] = useState('23:00');
  const [slotMinutes, setSlotMinutes] = useState<number>(30);
  const [timezone, setTimezone] = useState(tz);
  const [visibility, setVisibility] = useState<'all' | 'restricted'>('all');
  const [inviteeIds, setInviteeIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [knownGroups, setKnownGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.users().then(setUsers, () => {});
    api.groups().then(setKnownGroups, () => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    api.getEvent(id).then(
      (ev) => {
        setTitle(ev.title);
        setDescription(ev.description);
        setStartDate(ev.startDate);
        setEndDate(ev.endDate);
        setTimed(ev.dayStart != null);
        if (ev.dayStart != null) setDayStart(formatMinutes(ev.dayStart));
        if (ev.dayEnd != null) setDayEnd(formatMinutes(ev.dayEnd)); // 1440 -> "00:00"
        if (ev.slotMinutes != null) setSlotMinutes(ev.slotMinutes);
        setTimezone(ev.timezone);
        setVisibility(ev.visibility);
        setInviteeIds(ev.invitees.map((i) => i.id));
        setGroups(ev.groups);
        setLoading(false);
      },
      (e: Error) => {
        setError(e.message);
        setLoading(false);
      },
    );
  }, [id]);

  const input: EventInput = useMemo(
    () => ({
      title,
      description,
      visibility,
      startDate,
      endDate,
      dayStart: timed ? parseTime(dayStart) : null,
      // An end of 00:00 means midnight at the end of the day.
      dayEnd: timed ? (dayEnd === '00:00' ? 1440 : parseTime(dayEnd)) : null,
      slotMinutes: timed ? slotMinutes : null,
      timezone,
      inviteeIds: visibility === 'restricted' ? inviteeIds : [],
      groups: visibility === 'restricted' ? groups : [],
    }),
    [title, description, visibility, startDate, endDate, timed, dayStart, dayEnd, slotMinutes, timezone, inviteeIds, groups],
  );

  const gridError =
    timed && (input.dayStart == null || input.dayEnd == null) ? 'Enter daily hours as HH:MM' : validateGrid(input);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (gridError) return setError(gridError);
    setSaving(true);
    setError(null);
    try {
      const res = editing ? await api.updateEvent(id!, input) : await api.createEvent(input);
      navigate(`/events/${res.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <form className="card form" onSubmit={submit}>
      <h1>{editing ? 'Edit event' : 'New event'}</h1>

      <label>
        Name
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Board game night" autoFocus />
      </label>

      <label>
        Description <span className="muted">(optional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} />
      </label>

      <fieldset>
        <legend>When</legend>
        <div className="row">
          <label>
            From
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          <label>
            To
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
          </label>
        </div>
        <p className="hint">Up to {MAX_EVENT_DAYS} days.</p>

        <label className="check">
          <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
          Limit to specific hours each day
        </label>
        {timed ? (
          <div className="row">
            <label>
              Daily start
              <input type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} required />
            </label>
            <label>
              Daily end
              <input type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} title="00:00 means midnight at the end of the day" required />
            </label>
            <label>
              Slot length
              <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
                {SLOT_LENGTHS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <p className="hint">People will mark whole days as free, maybe or busy.</p>
        )}

        <label>
          Timezone
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Who can see it</legend>
        <label className="check">
          <input type="radio" name="vis" checked={visibility === 'all'} onChange={() => setVisibility('all')} />
          Everyone who can sign in
        </label>
        <label className="check">
          <input type="radio" name="vis" checked={visibility === 'restricted'} onChange={() => setVisibility('restricted')} />
          Only people and groups I choose
        </label>

        {visibility === 'restricted' && (
          <div className="pickers">
            <Picker
              label="People"
              hint="Only people who have signed in before are listed. You always have access."
              options={users.filter((u) => u.id !== user.id).map((u) => ({ value: u.id, label: u.username && u.username !== u.name ? `${u.name} (${u.username})` : u.name }))}
              selected={inviteeIds}
              onChange={setInviteeIds}
            />
            <Picker
              label="Groups"
              hint="From your identity provider. Members get access even before their first sign-in."
              options={[...new Set([...knownGroups, ...groups])].map((g) => ({ value: g, label: g }))}
              selected={groups}
              onChange={setGroups}
              allowCustom
            />
          </div>
        )}
      </fieldset>

      {error && <div className="error">{error}</div>}
      {!error && gridError && <div className="hint warn">{gridError}</div>}

      <div className="actions">
        <Link to={editing ? `/events/${id}` : '/'} className="btn btn-ghost">
          Cancel
        </Link>
        <button className="btn btn-primary" disabled={saving || !!gridError}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create event'}
        </button>
      </div>
      {editing && <p className="hint">Changing dates or hours removes responses that fall outside the new range.</p>}
    </form>
  );
}

function Picker(props: {
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  allowCustom?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const shown = props.options.filter((o) => !f || o.label.toLowerCase().includes(f));
  const toggle = (v: string) =>
    props.onChange(props.selected.includes(v) ? props.selected.filter((s) => s !== v) : [...props.selected, v]);
  const canAddCustom = props.allowCustom && f && !props.options.some((o) => o.value.toLowerCase() === f);

  return (
    <div className="picker">
      <div className="picker-head">
        <strong>{props.label}</strong>
        <span className="muted small">{props.selected.length} selected</span>
      </div>
      <input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="picker-list">
        {shown.map((o) => (
          <label key={o.value} className="check">
            <input type="checkbox" checked={props.selected.includes(o.value)} onChange={() => toggle(o.value)} />
            {o.label}
          </label>
        ))}
        {canAddCustom && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              toggle(filter.trim());
              setFilter('');
            }}
          >
            + Add group “{filter.trim()}”
          </button>
        )}
        {!shown.length && !canAddCustom && <p className="muted small">Nothing to show.</p>}
      </div>
      <p className="hint">{props.hint}</p>
    </div>
  );
}
