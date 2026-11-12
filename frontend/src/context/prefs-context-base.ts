import { createContext } from 'react';
import { en, type MessageKey } from '../i18n/en';
import { vi } from '../i18n/vi';

export type Theme = 'light' | 'dark';
export type Lang = 'en' | 'vi';
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const dictionaries = { en, vi };

export const translator = (lang: Lang): Translate => (key, vars) => {
  let text: string = dictionaries[lang][key] ?? en[key] ?? key;
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
  return text;
};

// Current language for code that runs later (async callbacks, effects) and must not
// list `t` as a hook dependency, which would re-run fetches when the language changes.
let activeLang: Lang = 'en';
export const setActiveLang = (lang: Lang) => { activeLang = lang; };
export const tNow: Translate = (key, vars) => translator(activeLang)(key, vars);

export interface PrefsContextType {
  theme: Theme;
  toggleTheme: () => void;
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

// Default (no provider, e.g. in unit tests): English, dark.
export const PrefsContext = createContext<PrefsContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  lang: 'en',
  setLang: () => {},
  t: translator('en'),
});
