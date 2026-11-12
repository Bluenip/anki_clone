import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { PrefsProvider } from '../context/PrefsContext';
import { en } from '../i18n/en';
import { vi as viDict } from '../i18n/vi';

const renderNavbar = () => render(<PrefsProvider><MemoryRouter><Navbar /></MemoryRouter></PrefsProvider>);

describe('theme and language toggles', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('switches language and remembers it', () => {
    localStorage.setItem('lang', 'en');
    renderNavbar();
    expect(screen.getByText('Guide')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en['nav.language'] }));
    expect(screen.getByText('Hướng dẫn')).toBeDefined();
    expect(localStorage.getItem('lang')).toBe('vi');
    expect(document.documentElement.lang).toBe('vi');
  });

  it('switches theme and remembers it', () => {
    localStorage.setItem('lang', 'en');
    document.documentElement.dataset.theme = 'dark';
    renderNavbar();
    fireEvent.click(screen.getByRole('button', { name: en['nav.themeLight'] }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('has a Vietnamese translation for every key', () => {
    const missing = Object.keys(en).filter(key => !viDict[key as keyof typeof en]?.trim());
    expect(missing).toEqual([]);
  });
});
