import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EN } from '../../src/lib/en';
import { translate } from '../../src/lib/i18n';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : []; });
}

/** German is the source text: every t('…') literal and every label in the Record<string,string> lookup tables needs an English entry. */
function usedTexts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of [...files('src/pages'), ...files('src/components')]) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) out.set(m[2].replace(/\\'/g, "'"), f);
    for (const blk of s.matchAll(/Record<string, string> = \{(.*?)\n?\};/gs)) for (const m of blk[1].matchAll(/:\s*'((?:\\.|[^'])*)'/g)) out.set(m[1].replace(/\\'/g, "'"), f);
    for (const m of s.matchAll(/\[\d+, '([^']+)'\]/g)) out.set(m[1], f);
    for (const m of s.matchAll(/\bL\(\s*'((?:\\.|[^'])*)'\)/g)) out.set(m[1].replace(/\\'/g, "'"), f); // L('…'): translated when rendered
  }
  return out;
}

describe('i18n', () => {
  it('has an English text for every German text used in the UI', () => {
    const missing = [...usedTexts()].filter(([k]) => !(k in EN)).map(([k, f]) => `${k}  (${f})`);
    expect(missing).toEqual([]);
  });
  it('has no unused English entries', () => {
    const used = usedTexts();
    const extra = Object.keys(EN).filter((k) => !used.has(k) && !['Dienstplan & Zeiterfassung', 'Zeiterfassung'].includes(k));
    expect(extra).toEqual([]);
  });
  it('keeps the same {placeholders} in both languages', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [de, en] of Object.entries(EN)) expect(ph(en), de).toEqual(ph(de));
  });
  it('translates and interpolates', () => {
    expect(translate('de', 'Hallo {name}', { name: 'Maria' })).toBe('Hallo Maria');
    expect(translate('en', 'Hallo {name}', { name: 'Maria' })).toBe('Hello Maria');
    expect(translate('en', 'Unbekannter Text')).toBe('Unbekannter Text');
  });
});
