import Holidays from 'date-holidays';

const cache = new Map<string, Map<string, string>>();

/** Public holidays of a region ('DE-HE' → country DE, state HE) for a year: date → name. */
export function holidaysOf(region: string, year: number, lang: 'de' | 'en' = 'de'): Map<string, string> {
  const key = `${region}|${year}|${lang}`;
  let m = cache.get(key);
  if (!m) {
    const [country, state] = region.split('-');
    const hd = state ? new Holidays(country, state) : new Holidays(country);
    m = new Map();
    for (const h of hd.getHolidays(year, lang) || []) {
      if (h.type === 'public') m.set(h.date.slice(0, 10), h.name);
    }
    cache.set(key, m);
  }
  return m;
}

export function holidayName(region: string, date: string, lang: 'de' | 'en' = 'de'): string | null {
  return holidaysOf(region, Number(date.slice(0, 4)), lang).get(date) ?? null;
}

export function isHoliday(region: string, date: string): boolean {
  return holidayName(region, date) !== null;
}

export function listHolidays(region: string, year: number, lang: 'de' | 'en' = 'de'): { date: string; name: string }[] {
  return [...holidaysOf(region, year, lang).entries()].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}
