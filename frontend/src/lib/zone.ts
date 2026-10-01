/** Hotel-local wall-clock <-> instant conversion (datetime-local inputs are interpreted in the hotel's zone, not the browser's). */
const fmt = (tz: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' });
const offsetAt = (ms: number, tz: string) => Date.parse(`${fmt(tz).format(new Date(ms)).replace(' ', 'T')}Z`) - ms;

/** "2026-10-05T14:30" in tz -> ISO instant. In the repeated autumn hour the later occurrence wins (same as the server). */
export function localToInstant(v: string, tz = 'Europe/Berlin'): string {
  const asUtc = Date.parse(`${v}:00Z`);
  const first = asUtc - offsetAt(asUtc, tz);
  return new Date(asUtc - offsetAt(first, tz)).toISOString();
}

/** ISO instant -> "2026-10-05T14:30" (datetime-local value) in tz. */
export const instantToLocal = (iso: string, tz = 'Europe/Berlin') =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)).replace(' ', 'T');
