import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { formatMinutes, WHOLE_DAY_SLOT } from '../../../shared/grid';
import { shortDay, weekday } from '../format';

export const cellKey = (date: string, slot: number) => `${date}|${slot}`;

interface GridFrameProps {
  dates: string[];
  slots: number[];
  slotMinutes: number | null;
  renderCell: (date: string, slot: number) => ReactNode;
  onDateClick?: (date: string) => void;
  onSlotClick?: (slot: number) => void;
  className?: string;
}

/** Shared layout: sticky date header row and time label column. */
export function GridFrame({ dates, slots, slotMinutes, renderCell, onDateClick, onSlotClick, className }: GridFrameProps) {
  const wholeDay = slots.length === 1 && slots[0] === WHOLE_DAY_SLOT;
  const style = { '--cols': dates.length } as CSSProperties;

  const slotLabel = (slot: number) => {
    if (slot === WHOLE_DAY_SLOT) return 'All day';
    // With short slots, only label the start of each hour to reduce noise.
    if (slotMinutes && slotMinutes < 30 && slot % 60 !== 0) return '';
    return formatMinutes(slot);
  };

  return (
    <div className={`grid-scroll ${className ?? ''}`}>
      <div className={`grid ${wholeDay ? 'grid-whole-day' : ''}`} style={style} role="grid">
        <div className="grid-corner" />
        {dates.map((d) => (
          <div
            key={d}
            className={`grid-date ${onDateClick ? 'clickable' : ''}`}
            onClick={onDateClick ? () => onDateClick(d) : undefined}
            title={onDateClick ? 'Apply to the whole day' : undefined}
            role="columnheader"
          >
            <span className="wd">{weekday(d)}</span>
            <span>{shortDay(d)}</span>
          </div>
        ))}
        {slots.map((slot) => (
          <Fragment key={slot}>
            <div
              className={`grid-time ${onSlotClick ? 'clickable' : ''} ${slot % 60 === 0 ? 'hour' : ''}`}
              onClick={onSlotClick ? () => onSlotClick(slot) : undefined}
              title={onSlotClick ? 'Apply to this time on every day' : undefined}
              role="rowheader"
            >
              {slotLabel(slot)}
            </div>
            {dates.map((d) => (
              <div key={d} className={`grid-cell-wrap ${slot % 60 === 0 ? 'hour' : ''}`}>
                {renderCell(d, slot)}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
