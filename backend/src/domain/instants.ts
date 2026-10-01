import { DateTime } from 'luxon';
import { addDays } from './dates';

const WALL = "yyyy-LL-dd'T'HH:mm";

/**
 * Local wall-clock time in a zone → instant, resolving the two edge cases exactly like PostgreSQL's
 * `timestamp AT TIME ZONE zone` (the database trigger is the final guard, so both must agree):
 *  - a time skipped by the spring clock change is moved forward by the gap;
 *  - a time that happens twice on the autumn clock-change morning (02:00–02:59) means the LATER occurrence
 *    (standard time), whereas Luxon would pick the earlier one.
 */
export function zonedInstant(isoLocal: string, tz: string): Date {
  const dt = DateTime.fromISO(isoLocal, { zone: tz });
  const later = dt.plus({ hours: 1 });
  return (later.toFormat(WALL) === dt.toFormat(WALL) ? later : dt).toJSDate();
}

/**
 * Real instants of a shift on a local date (R4): start = zoned(date, startTime),
 * end = zoned(date + (1 if the shift wraps midnight), endTime). Never start + duration.
 */
export function shiftInstants(date: string, startTime: string, endTime: string, tz: string): { start: Date; end: Date } {
  const wraps = endTime <= startTime;
  return {
    start: zonedInstant(`${date}T${startTime}`, tz),
    end: zonedInstant(`${wraps ? addDays(date, 1) : date}T${endTime}`, tz),
  };
}

/** Start of a local day as an instant. */
export function dayStart(date: string, tz: string): Date {
  return zonedInstant(`${date}T00:00`, tz);
}

export function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start < b.end && b.start < a.end;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}
