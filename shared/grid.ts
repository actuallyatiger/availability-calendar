/*
 * Helpers shared by the server and the web client for working with an event's
 * date range and daily time slots. Dates are plain YYYY-MM-DD strings and slots
 * are minutes from midnight, both interpreted in the event's timezone.
 */

export const WHOLE_DAY_SLOT = -1;
export const MAX_EVENT_DAYS = 92;
export const SLOT_LENGTHS = [15, 30, 60] as const;

export interface GridSpec {
  startDate: string;
  endDate: string;
  dayStart: number | null;
  dayEnd: number | null;
  slotMinutes: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

export function datesInRange(start: string, end: string): string[] {
  const n = daysBetween(start, end);
  const out: string[] = [];
  for (let i = 0; i <= n && i < MAX_EVENT_DAYS; i++) out.push(addDays(start, i));
  return out;
}

export function isWholeDay(spec: GridSpec): boolean {
  return spec.dayStart == null || spec.dayEnd == null || spec.slotMinutes == null;
}

export function slotsForGrid(spec: GridSpec): number[] {
  if (isWholeDay(spec)) return [WHOLE_DAY_SLOT];
  const out: number[] = [];
  for (let m = spec.dayStart!; m + spec.slotMinutes! <= spec.dayEnd!; m += spec.slotMinutes!) out.push(m);
  return out;
}

export function isCellInGrid(spec: GridSpec, date: string, slot: number): boolean {
  if (date < spec.startDate || date > spec.endDate) return false;
  if (isWholeDay(spec)) return slot === WHOLE_DAY_SLOT;
  return (
    slot >= spec.dayStart! &&
    slot + spec.slotMinutes! <= spec.dayEnd! &&
    (slot - spec.dayStart!) % spec.slotMinutes! === 0
  );
}

/** Returns an error message, or null if the grid is valid. */
export function validateGrid(spec: GridSpec): string | null {
  if (!isValidDate(spec.startDate) || !isValidDate(spec.endDate)) return 'Invalid date';
  if (spec.endDate < spec.startDate) return 'End date must be on or after start date';
  if (daysBetween(spec.startDate, spec.endDate) + 1 > MAX_EVENT_DAYS) {
    return `Date range can be at most ${MAX_EVENT_DAYS} days`;
  }
  const timed = [spec.dayStart, spec.dayEnd, spec.slotMinutes].filter((v) => v != null).length;
  if (timed === 0) return null;
  if (timed !== 3) return 'Daily start, end and slot length must all be set (or none)';
  if (!(SLOT_LENGTHS as readonly number[]).includes(spec.slotMinutes!)) return 'Invalid slot length';
  if (spec.dayStart! < 0 || spec.dayEnd! > 1440) return 'Daily hours must be within one day';
  if (spec.dayEnd! - spec.dayStart! < spec.slotMinutes!) return 'Daily end must be after daily start';
  return null;
}

export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59 || h > 24 || (h === 24 && m > 0)) return null;
  return h * 60 + m;
}
