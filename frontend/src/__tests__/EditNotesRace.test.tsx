import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import CardEditorPage from '../pages/CardEditorPage';
import * as cardsApi from '../api/cards';
import * as notesApi from '../api/notes';
import type { Card } from '../api/cards';
import type { Note } from '../api/notes';

vi.mock('../api/cards');
vi.mock('../api/notes', async () => {
  const actual = await vi.importActual<typeof import('../api/notes')>('../api/notes');
  return {
    ...actual,
    getCardNote: vi.fn(),
    updateNote: vi.fn(),
  };
});

const mockCardsDeck1: Card[] = [
  {
    id: 101,
    deck_id: 1,
    front: 'Bonjour',
    back: 'Hello',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 102,
    deck_id: 1,
    front: 'Au revoir',
    back: 'Goodbye',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const mockCardsDeck2: Card[] = [
  {
    id: 201,
    deck_id: 2,
    front: 'Hola',
    back: 'Hello',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const renderCardEditorPage = (initialDeckId = '1') => {
  const TestApp = () => {
    const navigate = useNavigate();
    return (
      <div>
        <button type="button" onClick={() => navigate('/decks/2/cards')}>
          Switch to Deck 2
        </button>
        <Routes>
          <Route path="/decks/:deckId/cards" element={<CardEditorPage />} />
        </Routes>
      </div>
    );
  };

  return render(
    <MemoryRouter initialEntries={[`/decks/${initialDeckId}/cards`]}>
      <TestApp />
    </MemoryRouter>
  );
};

describe('CardEditorPage UI Async Race Conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cardsApi.listCards).mockImplementation(async (deckId: number) => {
      if (deckId === 1) return { data: mockCardsDeck1 } as any;
      if (deckId === 2) return { data: mockCardsDeck2 } as any;
      return { data: [] } as any;
    });
  });

  it('delayedAafterB (save usesBnoteID): late response A ignored and save uses B note ID', async () => {
    const noteA: Note = {
      id: 501,
      guid: 'guid-note-a',
      kind: 'basic',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: ['french'],
      cards: [{ id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 }],
    };

    const noteB: Note = {
      id: 502,
      guid: 'guid-note-b',
      kind: 'basic',
      fields: { Front: 'Au revoir', Back: 'Goodbye' },
      tags: ['french-farewell'],
      cards: [{ id: 102, deck_id: 1, front: 'Au revoir', back: 'Goodbye', template_ord: 0 }],
    };

    let resolveNoteA: (val: any) => void = () => {};
    const noteAPromise = new Promise((resolve) => {
      resolveNoteA = resolve;
    });

    vi.mocked(notesApi.getCardNote).mockImplementation((cardId: number) => {
      if (cardId === 101) return noteAPromise as any;
      if (cardId === 102) return Promise.resolve({ data: noteB } as any);
      return Promise.reject(new Error('Unknown card'));
    });

    vi.mocked(notesApi.updateNote).mockResolvedValue({ data: noteB } as any);

    renderCardEditorPage('1');

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });

    // Click Edit on Card A (slow request)
    fireEvent.click(editButtons[0]);
    expect(notesApi.getCardNote).toHaveBeenCalledWith(101);

    // Immediately click Edit on Card B (fast request)
    fireEvent.click(editButtons[1]);
    expect(notesApi.getCardNote).toHaveBeenCalledWith(102);

    // Wait for Note B to be displayed
    await waitFor(() => {
      expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Au revoir');
      expect((screen.getByLabelText(/^Back/i) as HTMLTextAreaElement).value).toBe('Goodbye');
    });

    // Now resolve Note A (delayed response)
    resolveNoteA({ data: noteA });

    // Verify Note B remains displayed and was NOT overwritten by late Note A
    await waitFor(() => {
      expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Au revoir');
      expect((screen.getByLabelText(/^Back/i) as HTMLTextAreaElement).value).toBe('Goodbye');
      expect((screen.getByLabelText(/Tags/i) as HTMLInputElement).value).toBe('french-farewell');
    });

    // Edit and save
    fireEvent.change(screen.getByLabelText(/^Front/i), { target: { value: 'Au revoir tout le monde' } });
    fireEvent.click(screen.getByRole('button', { name: /Update/i }));

    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledTimes(1);
    });

    // Save must use Note B's id (502), NOT Note A's id (501)
    expect(notesApi.updateNote).toHaveBeenCalledWith(502, {
      fields: expect.objectContaining({ Front: 'Au revoir tout le monde' }),
      tags: ['french-farewell'],
    });
    expect(notesApi.updateNote).not.toHaveBeenCalledWith(501, expect.anything());
  });

  it("staleerror doesn'treplaceB: late error from A does not replace loaded note B", async () => {
    const noteB: Note = {
      id: 502,
      guid: 'guid-note-b',
      kind: 'basic',
      fields: { Front: 'Au revoir', Back: 'Goodbye' },
      tags: [],
      cards: [{ id: 102, deck_id: 1, front: 'Au revoir', back: 'Goodbye', template_ord: 0 }],
    };

    let rejectNoteA: (err: any) => void = () => {};
    const noteAPromise = new Promise((_, reject) => {
      rejectNoteA = reject;
    });

    vi.mocked(notesApi.getCardNote).mockImplementation((cardId: number) => {
      if (cardId === 101) return noteAPromise as any;
      if (cardId === 102) return Promise.resolve({ data: noteB } as any);
      return Promise.reject(new Error('Unknown card'));
    });

    renderCardEditorPage('1');

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });

    // Click Edit A (slow), then Edit B (fast)
    fireEvent.click(editButtons[0]);
    fireEvent.click(editButtons[1]);

    // Note B loads
    await waitFor(() => {
      expect(screen.getByLabelText(/^Front/i)).toBeDefined();
      expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Au revoir');
    });

    // Now Note A rejects with error
    rejectNoteA(new Error('Delayed failure on note A'));

    // Note B must remain in editor without being replaced by error alert
    await waitFor(() => {
      expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Au revoir');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/Delayed failure on note A/i)).toBeNull();
    });
  });

  it('Cancel whileloading andlate responseignored: cancelling load ignores late response', async () => {
    const noteA: Note = {
      id: 501,
      guid: 'guid-note-a',
      kind: 'basic',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 }],
    };

    let resolveNoteA: (val: any) => void = () => {};
    const noteAPromise = new Promise((resolve) => {
      resolveNoteA = resolve;
    });

    vi.mocked(notesApi.getCardNote).mockReturnValue(noteAPromise as any);

    renderCardEditorPage('1');

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    // Click Edit on Card A
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    // Spinner and Cancel button are visible during loading
    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Loading note/i })).toBeDefined();
    });
    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
    expect(cancelBtn).toBeDefined();

    // User cancels while loading
    fireEvent.click(cancelBtn);

    // Form reverts to "Add New Card"
    await waitFor(() => {
      expect(screen.getByText('Add New Card')).toBeDefined();
    });

    // Late response arrives
    resolveNoteA({ data: noteA });

    // Must still show "Add New Card" and ignore late response
    await waitFor(() => {
      expect(screen.getByText('Add New Card')).toBeDefined();
      expect(screen.queryByLabelText(/^Front/i)?.getAttribute('placeholder')).toBe('Question or term');
      expect(screen.queryByText('Bonjour')).not.toBeNull(); // in card list only
      expect(screen.queryByRole('region', { name: 'Edit note' })).toBeNull();
    });
  });

  it('pendingSave cannot switchEdit: save pending disables Edit/Delete and blocks switching', async () => {
    const noteA: Note = {
      id: 501,
      guid: 'guid-note-a',
      kind: 'basic',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 }],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValue({ data: noteA } as any);

    let resolveSave: (val: any) => void = () => {};
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    vi.mocked(notesApi.updateNote).mockReturnValue(savePromise as any);

    renderCardEditorPage('1');

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update/i })).toBeDefined();
    });

    // Trigger save
    fireEvent.click(screen.getByRole('button', { name: /Update/i }));

    // Buttons should now be disabled
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i }) as HTMLButtonElement[];
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/i }) as HTMLButtonElement[];
    expect(editButtons[0].disabled).toBe(true);
    expect(editButtons[1].disabled).toBe(true);
    expect(deleteButtons[0].disabled).toBe(true);
    expect(deleteButtons[1].disabled).toBe(true);

    // Attempting to switch to Card B should be blocked
    fireEvent.click(editButtons[1]);
    expect(notesApi.getCardNote).toHaveBeenCalledTimes(1); // Only for card 101 initially
    expect(notesApi.getCardNote).not.toHaveBeenCalledWith(102);

    // Attempting to delete Card B should be blocked
    fireEvent.click(deleteButtons[1]);
    expect(cardsApi.deleteCard).not.toHaveBeenCalled();

    // Editor still shows saving state
    expect(screen.getByRole('button', { name: /Saving\.\.\./i })).toBeDefined();

    // Finish save
    resolveSave({ data: noteA });

    await waitFor(() => {
      expect(screen.getByText('Add New Card')).toBeDefined();
    });
  });

  it('changingdeck cannotleavepreviousdecknoteeditable: deck route change cancels edit and ignores delayed responses', async () => {
    const noteA: Note = {
      id: 501,
      guid: 'guid-note-a',
      kind: 'basic',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 }],
    };

    let resolveNoteA: (val: any) => void = () => {};
    const noteAPromise = new Promise((resolve) => {
      resolveNoteA = resolve;
    });

    vi.mocked(notesApi.getCardNote).mockReturnValue(noteAPromise as any);

    renderCardEditorPage('1');

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    // Start editing card 101 in deck 1
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Loading note/i })).toBeDefined();
    });

    // Switch to deck 2
    fireEvent.click(screen.getByRole('button', { name: /Switch to Deck 2/i }));

    // Deck 2 loads cards and edit state is reset to Add New Card
    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
      expect(screen.getByText('Add New Card')).toBeDefined();
    });

    // Now resolve deck 1's slow note
    resolveNoteA({ data: noteA });

    // Deck 2 must NOT have deck 1's note opened
    await waitFor(() => {
      expect(screen.getByText('Add New Card')).toBeDefined();
      expect(screen.queryByRole('region', { name: 'Edit note' })).toBeNull();
    });
  });

  it('stale save completion does not close or reset new editor after deck change', async () => {
    const noteDeck1: Note = {
      id: 501,
      guid: 'guid-note-deck1',
      kind: 'basic',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 }],
    };

    const noteDeck2: Note = {
      id: 601,
      guid: 'guid-note-deck2',
      kind: 'basic',
      fields: { Front: 'Hola', Back: 'Hello' },
      tags: [],
      cards: [{ id: 201, deck_id: 2, front: 'Hola', back: 'Hello', template_ord: 0 }],
    };

    vi.mocked(notesApi.getCardNote).mockImplementation((cardId: number) => {
      if (cardId === 101) return Promise.resolve({ data: noteDeck1 } as any);
      if (cardId === 201) return Promise.resolve({ data: noteDeck2 } as any);
      return Promise.reject(new Error('Unknown card'));
    });

    let resolveSave1: (val: any) => void = () => {};
    const savePromise1 = new Promise((resolve) => {
      resolveSave1 = resolve;
    });

    vi.mocked(notesApi.updateNote).mockImplementation((noteId: number) => {
      if (noteId === 501) return savePromise1 as any;
      return Promise.resolve({ data: noteDeck2 } as any);
    });

    renderCardEditorPage('1');

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    // Edit card 101 in deck 1
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update/i })).toBeDefined();
    });

    // Click update to start saving in deck 1
    fireEvent.click(screen.getByRole('button', { name: /Update/i }));
    expect(notesApi.updateNote).toHaveBeenCalledWith(501, expect.anything());

    // User navigates to deck 2
    fireEvent.click(screen.getByRole('button', { name: /Switch to Deck 2/i }));

    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
    });

    // User edits card 201 in deck 2
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));

    await waitFor(() => {
      expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Hola');
    });

    // Now deck 1's save completes
    resolveSave1({ data: noteDeck1 });

    // Deck 2 editor for Note 601 must STILL be open and not closed/reset
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Edit note' })).toBeDefined();
      expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Hola');
    });
  });
});
