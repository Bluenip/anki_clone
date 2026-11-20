import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import NotFoundPage from '../pages/NotFoundPage';

describe('NotFoundPage', () => {
  it('catches unknown addresses and links back to the decks', () => {
    render(
      <MemoryRouter initialEntries={['/guide']}>
        <Routes>
          <Route path="/decks" element={<h1>Decks</h1>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeDefined();
    expect(screen.getByText('/guide')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Go to your decks' }).getAttribute('href')).toBe('/decks');
  });
});
