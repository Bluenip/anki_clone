import { useContext } from 'react';
import { PrefsContext } from './prefs-context-base';

export const usePrefs = () => useContext(PrefsContext);
