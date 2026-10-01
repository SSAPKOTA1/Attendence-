import { hoursBetween } from './instants';

export interface TimedShift {
  date: string;
  start: Date;
  end: Date;
}

/**
 * R4: only gaps between different days' work count. Previous day's LAST end → first start of the day,
 * and the day's last end → next day's FIRST start. Gaps between parts of the same day are not rest periods.
 */
export function restGaps<T extends TimedShift>(prevDay: T[], day: T[], nextDay: T[]): {
  previous: { gapHours: number; neighbour: T } | null;
  next: { gapHours: number; neighbour: T } | null;
  restPeriodHours: number | null;
} {
  if (day.length === 0) return { previous: null, next: null, restPeriodHours: null };
  const firstStart = day.reduce((a, b) => (b.start < a.start ? b : a));
  const lastEnd = day.reduce((a, b) => (b.end > a.end ? b : a));
  let previous = null;
  let next = null;
  if (prevDay.length > 0) {
    const prevLast = prevDay.reduce((a, b) => (b.end > a.end ? b : a));
    previous = { gapHours: hoursBetween(prevLast.end, firstStart.start), neighbour: prevLast };
  }
  if (nextDay.length > 0) {
    const nextFirst = nextDay.reduce((a, b) => (b.start < a.start ? b : a));
    next = { gapHours: hoursBetween(lastEnd.end, nextFirst.start), neighbour: nextFirst };
  }
  const gaps = [previous?.gapHours, next?.gapHours].filter((g): g is number => g !== undefined);
  const restPeriodHours = gaps.length ? Math.round(Math.min(...gaps) * 100) / 100 : null;
  return { previous, next, restPeriodHours };
}

/** First start to last end of a day (split shifts), in hours. */
export function daySpanHours(day: TimedShift[]): number {
  if (day.length === 0) return 0;
  const start = Math.min(...day.map((s) => s.start.getTime()));
  const end = Math.max(...day.map((s) => s.end.getTime()));
  return (end - start) / 3_600_000;
}

/** Gaps (minutes) between consecutive parts of a split day. */
export function gapsBetweenParts(day: TimedShift[]): number[] {
  const sorted = [...day].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) out.push((sorted[i].start.getTime() - sorted[i - 1].end.getTime()) / 60_000);
  return out;
}
