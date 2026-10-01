/** Date helpers on plain 'YYYY-MM-DD' strings (hotel-local dates; never shifted through the browser time zone). */
const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseISO = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => { const d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
/** Monday of the week containing s. */
export const weekStart = (s: string) => { const dow = (parseISO(s).getUTCDay() + 6) % 7; return addDays(s, -dow); };
export const weekDays = (start: string) => Array.from({ length: 7 }, (_, i) => addDays(start, i));
export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** ISO week number (Mon-based). */
export function isoWeek(s: string) {
  const d = parseISO(s);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - y0) / 86400000 + 1) / 7);
}
export const fmtDate = (s: string, lang: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat(lang, { ...opts, timeZone: 'UTC' }).format(parseISO(s));
export const fmtTime = (iso: string, tz: string, lang = 'de') => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
export const fmtMinutes = (m: number | null | undefined) => (m == null ? '–' : `${Math.floor(m / 60)}:${pad(Math.abs(m) % 60)} h`);
export const fmtHours = (h: number | null | undefined, lang = 'de') => (h == null ? '–' : `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(h)} h`);
export const fmtDays = (d: number, lang = 'de') => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(d);

/** Split [from, to] into windows of at most `days` days (the API caps list ranges at 62 days). */
export function windows(from: string, count: number, days = 62): { from: string; to: string }[] {
  return Array.from({ length: count }, (_, i) => ({ from: addDays(from, i * days), to: addDays(from, i * days + days - 1) }));
}
