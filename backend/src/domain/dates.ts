import { DateTime } from 'luxon';

/** Calendar helpers on 'YYYY-MM-DD' strings (no time zone involved). */
const d = (s: string) => DateTime.fromISO(s, { zone: 'utc' });

export function addDays(date: string, n: number): string {
  return d(date).plus({ days: n }).toISODate()!;
}

/** ISO weekday 1 = Monday … 7 = Sunday */
export function isoWeekday(date: string): number {
  return d(date).weekday;
}

export function weekStart(date: string): string {
  return d(date).startOf('week').toISODate()!;
}

export function weekEnd(date: string): string {
  return d(date).endOf('week').toISODate()!;
}

export function monthStart(date: string): string {
  return d(date).startOf('month').toISODate()!;
}

export function monthEnd(date: string): string {
  return d(date).endOf('month').toISODate()!;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  return { from, to: monthEnd(from) };
}

export function addMonths(month: string, n: number): string {
  return d(`${month}-01`).plus({ months: n }).toFormat('yyyy-MM');
}

export function eachMonth(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let m = fromMonth;
  while (m <= toMonth && out.length < 1200) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

export function daysBetween(from: string, to: string): number {
  return Math.round(d(to).diff(d(from), 'days').days);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** Local calendar date of an instant in a time zone. */
export function localDate(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toISODate()!;
}

/** Local 'HH:mm' of an instant in a time zone. */
export function localTime(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toFormat('HH:mm');
}

export function todayIn(tz: string, now: Date): string {
  return localDate(now, tz);
}

/** Completed years between birthDate and date (age on that date). */
export function ageOn(birthDate: string, date: string): number {
  const b = d(birthDate);
  const x = d(date);
  let age = x.year - b.year;
  if (x.month < b.month || (x.month === b.month && x.day < b.day)) age -= 1;
  return age;
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && d(s).isValid;
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
