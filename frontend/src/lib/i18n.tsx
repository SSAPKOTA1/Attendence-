import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { EN } from './en';
import { setApiLanguage } from './api';

export type Lang = 'de' | 'en';
const KEY = 'ui.lang';
const initial = (): Lang => {
  try { const s = localStorage.getItem(KEY); if (s === 'de' || s === 'en') return s; } catch { /* ignore */ }
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? 'en' : 'de';
};

/** German is the source language: t('Deutscher Text', { n }) returns the English entry from en.ts when lang = 'en'. */
export function translate(lang: Lang, de: string, params?: Record<string, string | number>): string {
  let s = lang === 'en' ? EN[de] ?? de : de;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (de: string, params?: Record<string, string | number>) => string }
const I18n = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setL] = useState<Lang>(() => { const l = initial(); setApiLanguage(l); return l; });
  const setLang = useCallback((l: Lang) => {
    setL(l); setApiLanguage(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
    document.documentElement.lang = l;
  }, []);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (de, params) => translate(lang, de, params) }), [lang, setLang]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export function useI18n() {
  const c = useContext(I18n);
  if (!c) throw new Error('I18nProvider missing');
  return c;
}
export const useT = () => useI18n().t;
