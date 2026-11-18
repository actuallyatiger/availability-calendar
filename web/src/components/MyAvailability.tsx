import { useEffect, useRef } from 'react';
import type { AvailabilityStatus } from '../../../shared/api';
import { cellKey, GridFrame } from './Grid';

export type Brush = AvailabilityStatus | 'clear';

interface Props {
  dates: string[];
  slots: number[];
  slotMinutes: number | null;
  mine: Map<string, AvailabilityStatus>;
  brush: Brush;
  readOnly: boolean;
  /** Apply a status (null = clear) to a set of cells. */
  onChange: (cells: { date: string; slot: number }[], status: AvailabilityStatus | null) => void;
  onCommit: () => void;
}

/**
 * Paintable grid. Mouse/pen: click and drag to paint. Touch: tap cells
 * (dragging scrolls). Starting on a cell that already has the brush's status
 * erases instead, like a toggle.
 */
export function MyAvailability({ dates, slots, slotMinutes, mine, brush, readOnly, onChange, onCommit }: Props) {
  const drag = useRef<{ status: AvailabilityStatus | null } | null>(null);
  // Set when a mouse/pen pointerdown already handled a cell, so the following click is ignored.
  const handledByPointer = useRef(false);

  useEffect(() => {
    const end = () => {
      // The click (if any) fires right after pointerup; reset afterwards.
      setTimeout(() => (handledByPointer.current = false), 0);
      if (drag.current) {
        drag.current = null;
        onCommit();
      }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [onCommit]);

  const targetFor = (current: AvailabilityStatus | undefined): AvailabilityStatus | null => {
    if (brush === 'clear') return null;
    return current === brush ? null : brush;
  };

  const applyMany = (cells: { date: string; slot: number }[]) => {
    if (readOnly || !cells.length) return;
    // If every cell already has the brush status, clear them; otherwise paint them all.
    const all = cells.every((c) => mine.get(cellKey(c.date, c.slot)) === brush);
    onChange(cells, brush === 'clear' || all ? null : brush);
    onCommit();
  };

  return (
    <GridFrame
      dates={dates}
      slots={slots}
      slotMinutes={slotMinutes}
      className={readOnly ? 'readonly' : 'paintable'}
      onDateClick={readOnly ? undefined : (date) => applyMany(slots.map((slot) => ({ date, slot })))}
      onSlotClick={readOnly || slots.length < 2 ? undefined : (slot) => applyMany(dates.map((date) => ({ date, slot })))}
      renderCell={(date, slot) => {
        const status = mine.get(cellKey(date, slot));
        return (
          <button
            type="button"
            className={`cell ${status ?? 'empty'}`}
            aria-label={`${date} ${slot}: ${status ?? 'not set'}`}
            disabled={readOnly}
            onPointerDown={(e) => {
              if (readOnly || e.button !== 0) return;
              const target = targetFor(status);
              if (e.pointerType === 'touch') {
                // Handled on click so that touch scrolling still works.
                return;
              }
              e.preventDefault();
              handledByPointer.current = true;
              drag.current = { status: target };
              onChange([{ date, slot }], target);
            }}
            onPointerEnter={() => {
              if (drag.current) onChange([{ date, slot }], drag.current.status);
            }}
            onClick={() => {
              // Keyboard activation and touch taps (mouse/pen are handled on pointerdown).
              if (handledByPointer.current) {
                handledByPointer.current = false;
                return;
              }
              if (readOnly) return;
              onChange([{ date, slot }], targetFor(status));
              onCommit();
            }}
          />
        );
      }}
    />
  );
}
