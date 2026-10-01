/** Bradford factor = spells² × days. */
export function bradfordFactor(spells: number, days: number): number {
  return spells * spells * days;
}

/** Merges sick entries on consecutive calendar days into spells (8.2). Input must be sorted by start. */
export function mergeSpells<T extends { startDate: string; endDate: string }>(entries: T[], addDays: (d: string, n: number) => string): T[][] {
  const spells: T[][] = [];
  for (const e of entries) {
    const last = spells[spells.length - 1];
    if (last) {
      const lastEnd = last.reduce((m, x) => (x.endDate > m ? x.endDate : m), last[0].endDate);
      if (e.startDate <= addDays(lastEnd, 1)) {
        last.push(e);
        continue;
      }
    }
    spells.push([e]);
  }
  return spells;
}
