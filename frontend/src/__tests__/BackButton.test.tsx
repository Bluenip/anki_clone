import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom';
import BackButton from '../components/BackButton';

const Page = ({ name, children }: { name: string; children?: React.ReactNode }) => <div><h1>{name}</h1>{children}</div>;

describe('BackButton', () => {
  it('goes up to the parent page even when history would loop back to the study page', () => {
    // History: deck list -> deck -> study -> deck (the study page's own back link pushes the deck page again).
    render(
      <MemoryRouter initialEntries={['/decks', '/decks/35', '/study/35', '/decks/35']} initialIndex={3}>
        <Routes>
          <Route path="/decks" element={<Page name="Deck list" />} />
          <Route path="/decks/:id" element={<Page name="Deck"><BackButton to="/decks" /></Page>} />
          <Route path="/study/:id" element={<Page name="Study"><Link to="/decks/35">study back</Link></Page>} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('link', { name: /back|quay lại/i }));
    expect(screen.getByRole('heading').textContent).toBe('Deck list');
  });
});
