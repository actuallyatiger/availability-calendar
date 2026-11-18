import { formatMinutes } from '../../shared/grid';
import type { EventSummary } from '../../shared/api';

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayYearFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

const asUtc = (date: string) => new Date(`${date}T00:00:00Z`);

export function formatDay(date: string, withYear = false): string {
  return (withYear ? dayYearFmt : dayFmt).format(asUtc(date));
}

export function weekday(date: string): string {
  return weekdayFmt.format(asUtc(date));
}

export function shortDay(date: string): string {
  return shortDayFmt.format(asUtc(date));
}

export function formatRange(ev: Pick<EventSummary, 'startDate' | 'endDate'>): string {
  const sameYear = ev.startDate.slice(0, 4) === ev.endDate.slice(0, 4);
  const thisYear = String(new Date().getFullYear()) === ev.startDate.slice(0, 4);
  if (ev.startDate === ev.endDate) return formatDay(ev.startDate, !thisYear);
  return `${formatDay(ev.startDate, !sameYear)} – ${formatDay(ev.endDate, !thisYear || !sameYear)}`;
}

export function formatHours(ev: Pick<EventSummary, 'dayStart' | 'dayEnd' | 'slotMinutes'>): string {
  if (ev.dayStart == null || ev.dayEnd == null) return 'Whole days';
  return `${formatMinutes(ev.dayStart)}–${formatMinutes(ev.dayEnd)}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
