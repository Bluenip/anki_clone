import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { PrefsContext, setActiveLang, translator } from './prefs-context-base';
import type { Lang, Theme } from './prefs-context-base';

const read = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* Storage may be restricted. */ }
};

const initialTheme = (): Theme => {
  const fromDom = document.documentElement.dataset.theme; // set by public/theme-init.js
  if (fromDom === 'light' || fromDom === 'dark') return fromDom;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

const initialLang = (): Lang => {
  const saved = read('lang');
  if (saved === 'en' || saved === 'vi') return saved;
  return navigator.language?.toLowerCase().startsWith('vi') ? 'vi' : 'en';
};

export const PrefsProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [lang, setLangState] = useState<Lang>(initialLang);
  setActiveLang(lang);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const value = useMemo(() => ({
    theme,
    toggleTheme: () => setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      write('theme', next);
      return next;
    }),
    lang,
    setLang: (next: Lang) => { write('lang', next); setLangState(next); },
    t: translator(lang),
  }), [theme, lang]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
};
