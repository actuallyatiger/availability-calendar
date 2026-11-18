import { useMemo, type CSSProperties } from 'react';
import type { AvailabilityEntry, UserSummary } from '../../../shared/api';
import { formatMinutes, WHOLE_DAY_SLOT } from '../../../shared/grid';
import { formatDay } from '../format';
import { cellKey, GridFrame } from './Grid';

export interface CellPeople {
  free: string[];
  maybe: string[];
  busy: string[];
}

export function aggregate(entries: AvailabilityEntry[]): Map<string, CellPeople> {
  const map = new Map<string, CellPeople>();
  for (const e of entries) {
    const k = cellKey(e.date, e.slot);
    let c = map.get(k);
    if (!c) map.set(k, (c = { free: [], maybe: [], busy: [] }));
    c[e.status].push(e.userId);
  }
  return map;
}

interface Props {
  dates: string[];
  slots: number[];
  slotMinutes: number | null;
  cells: Map<string, CellPeople>;
  people: UserSummary[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}

export function GroupAvailability({ dates, slots, slotMinutes, cells, people, selected, onSelect }: Props) {
  const total = people.length;
  return (
    <GridFrame
      dates={dates}
      slots={slots}
      slotMinutes={slotMinutes}
      className="group"
      renderCell={(date, slot) => {
        const k = cellKey(date, slot);
        const c = cells.get(k);
        const free = c?.free.length ?? 0;
        const maybe = c?.maybe.length ?? 0;
        const busy = c?.busy.length ?? 0;
        // Score: free counts fully, maybe half; scaled against everyone who responded.
        const score = total ? (free + maybe * 0.5) / total : 0;
        const style = { '--heat': score.toFixed(3) } as CSSProperties;
        const allFree = total > 0 && free === total;
        return (
          <button
            type="button"
            className={`cell heat ${selected === k ? 'selected' : ''} ${allFree ? 'all-free' : ''} ${busy && !free && !maybe ? 'only-busy' : ''}`}
            style={style}
            onClick={() => onSelect(selected === k ? null : k)}
            onMouseEnter={() => onSelect(k)}
            title={`${free} free, ${maybe} maybe, ${busy} busy`}
          >
            {free > 0 && <span className="n">{free}</span>}
            {maybe > 0 && <span className="m">{maybe}?</span>}
          </button>
        );
      }}
    />
  );
}

export function CellDetails({
  cellKeyValue,
  cells,
  people,
  slotMinutes,
}: {
  cellKeyValue: string | null;
  cells: Map<string, CellPeople>;
  people: UserSummary[];
  slotMinutes: number | null;
}) {
  if (!cellKeyValue) {
    return <p className="muted small cell-details">Hover or tap a cell to see who is available.</p>;
  }
  const [date, slotStr] = cellKeyValue.split('|') as [string, string];
  const slot = Number(slotStr);
  const c = cells.get(cellKeyValue) ?? { free: [], maybe: [], busy: [] };
  const byId = new Map(people.map((p) => [p.id, p.name]));
  const responded = new Set([...c.free, ...c.maybe, ...c.busy]);
  const unknown = people.filter((p) => !responded.has(p.id)).map((p) => p.id);
  const names = (ids: string[]) => ids.map((id) => byId.get(id) ?? 'Unknown').join(', ');
  const when =
    slot === WHOLE_DAY_SLOT
      ? formatDay(date)
      : `${formatDay(date)}, ${formatMinutes(slot)}–${formatMinutes(slot + (slotMinutes ?? 0))}`;

  return (
    <div className="cell-details">
      <strong>{when}</strong>
      <ul>
        <li>
          <span className="dot free" /> Free ({c.free.length}): {names(c.free) || '—'}
        </li>
        <li>
          <span className="dot maybe" /> Maybe ({c.maybe.length}): {names(c.maybe) || '—'}
        </li>
        <li>
          <span className="dot busy" /> Busy ({c.busy.length}): {names(c.busy) || '—'}
        </li>
        {unknown.length > 0 && (
          <li>
            <span className="dot empty" /> Not marked ({unknown.length}): {names(unknown)}
          </li>
        )}
      </ul>
    </div>
  );
}

interface Block {
  date: string;
  start: number;
  end: number;
  free: number;
  maybe: number;
  freeIds: string[];
  maybeIds: string[];
}

/** Ranks contiguous blocks of identical availability, best first. */
export function BestTimes({
  dates,
  slots,
  slotMinutes,
  cells,
  people,
  onSelect,
}: {
  dates: string[];
  slots: number[];
  slotMinutes: number | null;
  cells: Map<string, CellPeople>;
  people: UserSummary[];
  onSelect: (key: string) => void;
}) {
  const blocks = useMemo(() => {
    const out: Block[] = [];
    for (const date of dates) {
      let cur: Block | null = null;
      for (const slot of slots) {
        const c = cells.get(cellKey(date, slot));
        const free = c?.free ?? [];
        const maybe = c?.maybe ?? [];
        const sig = `${[...free].sort().join(',')}/${[...maybe].sort().join(',')}`;
        const curSig: string | null = cur ? `${[...cur.freeIds].sort().join(',')}/${[...cur.maybeIds].sort().join(',')}` : null;
        if (cur && curSig === sig && cur.end === slot) {
          cur.end = slot + (slotMinutes ?? 0);
        } else {
          if (cur) out.push(cur);
          cur = {
            date,
            start: slot,
            end: slot + (slotMinutes ?? 0),
            free: free.length,
            maybe: maybe.length,
            freeIds: free,
            maybeIds: maybe,
          };
        }
      }
      if (cur) out.push(cur);
    }
    return out
      .filter((b) => b.free + b.maybe > 0)
      .sort((a, b) => b.free - a.free || b.maybe - a.maybe || b.end - b.start - (a.end - a.start) || a.date.localeCompare(b.date))
      .slice(0, 5);
  }, [dates, slots, slotMinutes, cells]);

  if (!people.length) return null;
  if (!blocks.length) return <p className="muted small">No one has marked themselves free yet.</p>;

  return (
    <ol className="best-times">
      {blocks.map((b) => (
        <li key={`${b.date}-${b.start}`}>
          <button type="button" className="linklike" onClick={() => onSelect(cellKey(b.date, b.start))}>
            {formatDay(b.date)}
            {b.start !== WHOLE_DAY_SLOT && `, ${formatMinutes(b.start)}–${formatMinutes(b.end)}`}
          </button>
          <span className="muted small">
            {' '}
            {b.free}/{people.length} free{b.maybe ? `, ${b.maybe} maybe` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
