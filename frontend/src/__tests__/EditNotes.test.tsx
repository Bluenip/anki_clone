import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CardEditorPage from '../pages/CardEditorPage';
import * as cardsApi from '../api/cards';
import * as notesApi from '../api/notes';
import client from '../api/client';
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

const mockCards: Card[] = [
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
    front: 'Hello',
    back: 'Bonjour',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const renderCardEditorPage = (deckId = '1') => {
  return render(
    <MemoryRouter initialEntries={[`/decks/${deckId}/cards`]}>
      <Routes>
        <Route path="/decks/:deckId/cards" element={<CardEditorPage />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('CardEditorPage Note Editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cardsApi.listCards).mockResolvedValue({ data: mockCards } as any);
  });

  it('reversed editing sends fields/tags to note endpoint', async () => {
    const reversedNote: Note = {
      id: 42,
      guid: 'guid-reversed-42',
      kind: 'reversed',
      fields: {
        Front: 'Bonjour',
        Back: 'Hello',
      },
      tags: ['french'],
      cards: [
        { id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 },
        { id: 102, deck_id: 1, front: 'Hello', back: 'Bonjour', template_ord: 1 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: reversedNote } as any);
    vi.mocked(notesApi.updateNote).mockResolvedValueOnce({
      data: {
        ...reversedNote,
        fields: { Front: 'Bonjour le monde', Back: 'Hello world' },
        tags: ['french', 'greetings'],
      },
    } as any);

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getByText(/Cards \(2\)/i)).toBeDefined();
    });

    // Click Edit on the first card (id: 101)
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(notesApi.getCardNote).toHaveBeenCalledWith(101);
    });

    // Check that note type and sibling count are visibly displayed
    await waitFor(() => {
      expect(screen.getByTestId('note-type').textContent).toContain('reversed');
      expect(screen.getByTestId('sibling-count').textContent).toContain('2');
    });

    // Dynamic labeled inputs for original fields should be rendered with values
    const frontInput = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
    const backInput = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;
    const tagsInput = screen.getByLabelText(/Tags/i) as HTMLInputElement;

    expect(frontInput.value).toBe('Bonjour');
    expect(backInput.value).toBe('Hello');
    expect(tagsInput.value).toBe('french');

    // Edit fields and tags
    fireEvent.change(frontInput, { target: { value: 'Bonjour le monde' } });
    fireEvent.change(backInput, { target: { value: 'Hello world' } });
    fireEvent.change(tagsInput, { target: { value: 'french greetings' } });

    // Click Update
    const updateBtn = screen.getByRole('button', { name: /Update/i });
    fireEvent.click(updateBtn);

    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledTimes(1);
    });

    // Verify fields and tags were sent to note endpoint
    expect(notesApi.updateNote).toHaveBeenCalledWith(42, {
      fields: {
        Front: 'Bonjour le monde',
        Back: 'Hello world',
      },
      tags: ['french', 'greetings'],
    });

    // Ensure updateCard was NOT called (rendered cards must not be updated directly)
    expect(cardsApi.updateCard).not.toHaveBeenCalled();

    // Verify card list was refreshed
    await waitFor(() => {
      expect(cardsApi.listCards).toHaveBeenCalledTimes(2);
    });
  });

  it('server rejection preserves text', async () => {
    const note: Note = {
      id: 42,
      guid: 'guid-42',
      kind: 'reversed',
      fields: { Front: 'Original Front', Back: 'Original Back' },
      tags: ['original-tag'],
      cards: [
        { id: 101, deck_id: 1, front: 'Original Front', back: 'Original Back', template_ord: 0 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: note } as any);
    vi.mocked(notesApi.updateNote).mockRejectedValueOnce({
      response: {
        data: {
          detail: 'Cannot remove studied card template',
        },
      },
    });

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Edit$/i })[0]).toBeDefined();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Front/i)).toBeDefined();
    });

    const frontInput = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
    const backInput = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;
    const tagsInput = screen.getByLabelText(/Tags/i) as HTMLInputElement;

    // Enter new text that will be rejected by backend
    fireEvent.change(frontInput, { target: { value: 'Preserved user input front' } });
    fireEvent.change(backInput, { target: { value: 'Preserved user input back' } });
    fireEvent.change(tagsInput, { target: { value: 'preserved-tag' } });

    fireEvent.click(screen.getByRole('button', { name: /Update/i }));

    // Error should be displayed inline
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Cannot remove studied card template/i)).toBeDefined();
    });

    // Text inputs MUST be preserved
    expect(frontInput.value).toBe('Preserved user input front');
    expect(backInput.value).toBe('Preserved user input back');
    expect(tagsInput.value).toBe('preserved-tag');
  });

  it('legacy fallback edits via updateCard', async () => {
    const legacyCardNote: Note = {
      id: null, // Legacy card note
      guid: 'legacy-guid',
      kind: 'basic',
      fields: { Front: 'Legacy Question', Back: 'Legacy Answer' },
      tags: [],
      cards: [
        { id: 101, deck_id: 1, front: 'Legacy Question', back: 'Legacy Answer', template_ord: 0 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: legacyCardNote } as any);
    vi.mocked(cardsApi.updateCard).mockResolvedValueOnce({ data: {} } as any);

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Edit$/i })[0]).toBeDefined();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Edit Legacy Card/i })).toBeDefined();
    });

    const frontInput = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
    const backInput = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;

    expect(frontInput.value).toBe('Legacy Question');
    expect(backInput.value).toBe('Legacy Answer');

    // Edit front and back
    fireEvent.change(frontInput, { target: { value: 'Updated Legacy Question' } });
    fireEvent.change(backInput, { target: { value: 'Updated Legacy Answer' } });

    fireEvent.click(screen.getByRole('button', { name: /Update/i }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledTimes(1);
    });

    // Verify updateCard called with edited values
    expect(cardsApi.updateCard).toHaveBeenCalledWith(101, {
      front: 'Updated Legacy Question',
      back: 'Updated Legacy Answer',
    });

    // Ensure updateNote was NOT called
    expect(notesApi.updateNote).not.toHaveBeenCalled();

    // Verify card list was refreshed
    await waitFor(() => {
      expect(cardsApi.listCards).toHaveBeenCalledTimes(2);
    });
  });

  it('fetch-note failure visibly handled with retry and cancel', async () => {
    vi.mocked(notesApi.getCardNote).mockRejectedValueOnce(new Error('Failed to fetch card note'));

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Edit$/i })[0]).toBeDefined();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    // Visibly displays failure message
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Failed to fetch card note/i)).toBeDefined();
    });

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
    expect(retryBtn).toBeDefined();
    expect(cancelBtn).toBeDefined();

    // Successful retry
    const resolvedNote: Note = {
      id: 99,
      guid: 'guid-99',
      kind: 'basic',
      fields: { Front: 'Recovered Front', Back: 'Recovered Back' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Recovered Front', back: 'Recovered Back', template_ord: 0 }],
    };
    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: resolvedNote } as any);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(notesApi.getCardNote).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText(/^Front/i)).toBeDefined();
    });

    expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Recovered Front');

    // Test cancel resets back to add form
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.getByText('Add New Card')).toBeDefined();
    });
  });

  it('pending guard prevents duplicate submissions during save', async () => {
    const note: Note = {
      id: 50,
      guid: 'guid-50',
      kind: 'basic',
      fields: { Front: 'Front 50', Back: 'Back 50' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Front 50', back: 'Back 50', template_ord: 0 }],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: note } as any);

    let resolveSave: (val: any) => void = () => {};
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    vi.mocked(notesApi.updateNote).mockReturnValue(savePromise as any);

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Edit$/i })[0]).toBeDefined();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update/i })).toBeDefined();
    });

    const updateBtn = screen.getByRole('button', { name: /Update/i }) as HTMLButtonElement;
    expect(updateBtn.disabled).toBe(false);

    fireEvent.click(updateBtn);

    // Button should be disabled during pending save
    expect(updateBtn.disabled).toBe(true);
    expect(notesApi.updateNote).toHaveBeenCalledTimes(1);

    // Duplicate clicks should be guarded
    fireEvent.click(updateBtn);
    expect(notesApi.updateNote).toHaveBeenCalledTimes(1);

    // Resolve save
    resolveSave({ data: note });

    await waitFor(() => {
      expect(screen.getByText('Add New Card')).toBeDefined();
    });
  });
});

describe('Notes API getCardNote client wrapper', () => {
  it('invokes client.get for /api/cards/{card_id}/note', async () => {
    const actualNotes = await vi.importActual<typeof import('../api/notes')>('../api/notes');
    const getSpy = vi.spyOn(client, 'get').mockResolvedValue({ data: {} });
    await actualNotes.getCardNote(88);
    expect(getSpy).toHaveBeenCalledWith('/api/cards/88/note');
  });
});
