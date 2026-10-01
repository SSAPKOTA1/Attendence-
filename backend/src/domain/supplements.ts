import { DateTime } from 'luxon';

export interface SupplementMinutes {
  nightMinutes: number;
  saturdayMinutes: number;
  sundayMinutes: number;
  holidayMinutes: number;
}

function minuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Night / Saturday / Sunday / public-holiday minutes of a worked interval, evaluated per hotel-local minute.
 * nightFrom–nightTo may wrap midnight (23:00–06:00).
 * The unpaid break is deducted automatically: the time of the break is not recorded, so every supplement is
 * reduced in proportion to the break (worked ÷ gross). Results are fractional; callers round once per total.
 */
export function supplementMinutes(
  start: Date,
  end: Date,
  tz: string,
  nightFrom: string,
  nightTo: string,
  isHoliday: (date: string) => boolean,
  breakMinutes = 0,
): SupplementMinutes {
  const out = { nightMinutes: 0, saturdayMinutes: 0, sundayMinutes: 0, holidayMinutes: 0 };
  const nf = minuteOfDay(nightFrom);
  const nt = minuteOfDay(nightTo);
  const inNight = (mod: number) => (nf > nt ? mod >= nf || mod < nt : mod >= nf && mod < nt);
  const startOffset = DateTime.fromJSDate(start, { zone: tz }).offset;
  const endOffset = DateTime.fromJSDate(end, { zone: tz }).offset;
  const holidayCache = new Map<string, boolean>();
  let gross = 0;
  for (let ms = start.getTime(); ms + 60_000 <= end.getTime(); ms += 60_000) {
    gross++;
    let local: Date;
    if (startOffset === endOffset) local = new Date(ms + startOffset * 60_000);
    else local = new Date(ms + DateTime.fromMillis(ms, { zone: tz }).offset * 60_000);
    const mod = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (inNight(mod)) out.nightMinutes++;
    const weekday = local.getUTCDay();
    if (weekday === 6) out.saturdayMinutes++;
    if (weekday === 0) out.sundayMinutes++;
    const date = local.toISOString().slice(0, 10);
    let hol = holidayCache.get(date);
    if (hol === undefined) {
      hol = isHoliday(date);
      holidayCache.set(date, hol);
    }
    if (hol) out.holidayMinutes++;
  }
  if (breakMinutes > 0 && gross > 0) {
    const factor = Math.max(0, gross - breakMinutes) / gross;
    out.nightMinutes *= factor;
    out.saturdayMinutes *= factor;
    out.sundayMinutes *= factor;
    out.holidayMinutes *= factor;
  }
  return out;
}
