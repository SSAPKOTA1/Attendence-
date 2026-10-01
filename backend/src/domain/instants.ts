import { DateTime } from 'luxon';
import { addDays } from './dates';

/**
 * Real instants of a shift on a local date (R4): start = zoned(date, startTime),
 * end = zoned(date + (1 if the shift wraps midnight), endTime). Never start + duration.
 */
export function shiftInstants(date: string, startTime: string, endTime: string, tz: string): { start: Date; end: Date } {
  const wraps = endTime <= startTime;
  const start = DateTime.fromISO(`${date}T${startTime}`, { zone: tz });
  const end = DateTime.fromISO(`${wraps ? addDays(date, 1) : date}T${endTime}`, { zone: tz });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** Start of a local day as an instant. */
export function dayStart(date: string, tz: string): Date {
  return DateTime.fromISO(`${date}T00:00`, { zone: tz }).toJSDate();
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
