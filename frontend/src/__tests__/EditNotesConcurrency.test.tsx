import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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

const mockCards: Card[] = [
  {
    id: 101,
    deck_id: 1,
    front: 'Original Front',
    back: 'Original Back',
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

describe('CardEditorPage Note Optimistic Concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cardsApi.listCards).mockResolvedValue({ data: mockCards } as any);
  });

  it('stale response (409) preserves edits, displays conflict message, and does not automatically retry overwrite', async () => {
    const initialNote: Note = {
      id: 42,
      guid: 'guid-note-42',
      kind: 'basic',
      revision: 'rev-init-100',
      fields: {
        Front: 'Original Front',
        Back: 'Original Back',
      },
      tags: ['initial-tag'],
      cards: [
        { id: 101, deck_id: 1, front: 'Original Front', back: 'Original Back', template_ord: 0 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: initialNote } as any);
    vi.mocked(notesApi.updateNote).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          detail: 'Conflict: Note was modified by another session.',
        },
      },
    });

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
    });

    // Open edit mode
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));

    await waitFor(() => {
      expect(notesApi.getCardNote).toHaveBeenCalledWith(101);
    });

    const frontInput = (await screen.findByLabelText(/^Front/i)) as HTMLTextAreaElement;
    const backInput = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;
    const tagsInput = screen.getByLabelText(/Tags/i) as HTMLInputElement;

    expect(frontInput.value).toBe('Original Front');
    expect(backInput.value).toBe('Original Back');
    expect(tagsInput.value).toBe('initial-tag');

    // Make local modifications
    fireEvent.change(frontInput, { target: { value: 'User Modified Front' } });
    fireEvent.change(backInput, { target: { value: 'User Modified Back' } });
    fireEvent.change(tagsInput, { target: { value: 'initial-tag new-tag' } });

    // Submit update
    const updateBtn = screen.getByRole('button', { name: /^Update$/i });
    fireEvent.click(updateBtn);

    // Verify updateNote was called with loaded revision
    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledTimes(1);
    });
    expect(notesApi.updateNote).toHaveBeenCalledWith(42, {
      fields: {
        Front: 'User Modified Front',
        Back: 'User Modified Back',
      },
      tags: ['initial-tag', 'new-tag'],
      expected_revision: 'rev-init-100',
    });

    // Verify clear conflict message is displayed
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Conflict: Note was modified by another session\./i)).toBeDefined();
    });

    // Verify explicit Reload latest note button is offered with clear discard edits label
    const reloadButton = screen.getByRole('button', { name: /Reload latest note \(discards local edits\)/i });
    expect(reloadButton).toBeDefined();

    // Verify local edits are preserved in the form inputs
    expect(frontInput.value).toBe('User Modified Front');
    expect(backInput.value).toBe('User Modified Back');
    expect(tagsInput.value).toBe('initial-tag new-tag');

    // Verify no automatic retry overwrite happened
    expect(notesApi.updateNote).toHaveBeenCalledTimes(1);
    expect(cardsApi.updateCard).not.toHaveBeenCalled();

    // Verify normal cancel still works
    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
    expect(cancelBtn).toBeDefined();
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^Edit Note$/i })).toBeNull();
      expect(screen.getByRole('heading', { name: /^Add New Card$/i })).toBeDefined();
    });
  });

  it('explicit reload gets latest revision, discards local edits, and subsequent save sends the new revision', async () => {
    const staleNote: Note = {
      id: 42,
      guid: 'guid-note-42',
      kind: 'basic',
      revision: 'rev-1',
      fields: {
        Front: 'Front v1',
        Back: 'Back v1',
      },
      tags: ['v1'],
      cards: [
        { id: 101, deck_id: 1, front: 'Front v1', back: 'Back v1', template_ord: 0 },
      ],
    };

    const latestNote: Note = {
      id: 42,
      guid: 'guid-note-42',
      kind: 'basic',
      revision: 'rev-2',
      fields: {
        Front: 'Remote Front v2',
        Back: 'Remote Back v2',
      },
      tags: ['remote-tag'],
      cards: [
        { id: 101, deck_id: 1, front: 'Remote Front v2', back: 'Remote Back v2', template_ord: 0 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: staleNote } as any);
    vi.mocked(notesApi.updateNote).mockRejectedValueOnce({
      response: {
        status: 409,
        data: { detail: 'Revision mismatch' },
      },
    });

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));

    const frontInput = (await screen.findByLabelText(/^Front/i)) as HTMLTextAreaElement;
    const backInput = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;
    const tagsInput = screen.getByLabelText(/Tags/i) as HTMLInputElement;

    // Type local changes
    fireEvent.change(frontInput, { target: { value: 'Local Unsaved Front' } });
    fireEvent.change(backInput, { target: { value: 'Local Unsaved Back' } });
    fireEvent.change(tagsInput, { target: { value: 'local-tag' } });

    // Attempt save which fails with 409
    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toBeDefined();
    });

    // Mock the subsequent getCardNote call to return the latest revision
    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: latestNote } as any);

    // Click the explicit reload button
    const reloadBtn = screen.getByRole('button', { name: /Reload latest note \(discards local edits\)/i });
    fireEvent.click(reloadBtn);

    // Verify getCardNote was called again to fetch the latest note
    await waitFor(() => {
      expect(notesApi.getCardNote).toHaveBeenCalledTimes(2);
    });

    // Verify local edits were discarded and latest server values are populated
    await waitFor(() => {
      const refreshedFront = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
      expect(refreshedFront.value).toBe('Remote Front v2');
    });

    const refreshedBack = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;
    const refreshedTags = screen.getByLabelText(/Tags/i) as HTMLInputElement;
    expect(refreshedBack.value).toBe('Remote Back v2');
    expect(refreshedTags.value).toBe('remote-tag');

    // Conflict error should be cleared
    expect(screen.queryByRole('alert')).toBeNull();

    // Now edit the newly reloaded note and save
    const refreshedFront = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
    fireEvent.change(refreshedFront, { target: { value: 'Remote Front v2 edited' } });

    vi.mocked(notesApi.updateNote).mockResolvedValueOnce({
      data: {
        ...latestNote,
        revision: 'rev-3',
        fields: { ...latestNote.fields, Front: 'Remote Front v2 edited' },
      },
    } as any);

    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    // Verify the new save sends the updated expected_revision ('rev-2')
    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledTimes(2);
    });
    expect(notesApi.updateNote).toHaveBeenLastCalledWith(42, {
      fields: {
        Front: 'Remote Front v2 edited',
        Back: 'Remote Back v2',
      },
      tags: ['remote-tag'],
      expected_revision: 'rev-2',
    });

    // Form closes and card list refreshes
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Add New Card$/i })).toBeDefined();
      expect(cardsApi.listCards).toHaveBeenCalledTimes(2);
    });
  });

  it('legacy card edit sends loaded version as expected_version', async () => {
    const legacyNote: Note = {
      id: null,
      guid: 'legacy-guid-99',
      kind: 'basic',
      version: 7,
      fields: {
        Front: 'Old Legacy Front',
        Back: 'Old Legacy Back',
      },
      tags: [],
      cards: [
        { id: 101, deck_id: 1, front: 'Old Legacy Front', back: 'Old Legacy Back', template_ord: 0 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: legacyNote } as any);
    vi.mocked(cardsApi.updateCard).mockResolvedValueOnce({ data: {} } as any);

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Edit Legacy Card/i })).toBeDefined();
    });

    const frontInput = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
    const backInput = screen.getByLabelText(/^Back/i) as HTMLTextAreaElement;

    expect(frontInput.value).toBe('Old Legacy Front');
    expect(backInput.value).toBe('Old Legacy Back');

    fireEvent.change(frontInput, { target: { value: 'Updated Legacy Front' } });
    fireEvent.change(backInput, { target: { value: 'Updated Legacy Back' } });

    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledTimes(1);
    });

    // Must pass expected_version matching loaded legacy version (7)
    expect(cardsApi.updateCard).toHaveBeenCalledWith(101, {
      front: 'Updated Legacy Front',
      back: 'Updated Legacy Back',
      expected_version: 7,
    });

    expect(notesApi.updateNote).not.toHaveBeenCalled();
  });

  it('legacy card 409 conflict preserves edits without auto-retry, and explicit reload updates version for subsequent save', async () => {
    const staleLegacyNote: Note = {
      id: null,
      guid: 'legacy-guid-99',
      kind: 'basic',
      version: 1,
      fields: {
        Front: 'Legacy Front v1',
        Back: 'Legacy Back v1',
      },
      tags: [],
      cards: [
        { id: 101, deck_id: 1, front: 'Legacy Front v1', back: 'Legacy Back v1', template_ord: 0 },
      ],
    };

    const latestLegacyNote: Note = {
      id: null,
      guid: 'legacy-guid-99',
      kind: 'basic',
      version: 2,
      fields: {
        Front: 'Server Legacy Front v2',
        Back: 'Server Legacy Back v2',
      },
      tags: [],
      cards: [
        { id: 101, deck_id: 1, front: 'Server Legacy Front v2', back: 'Server Legacy Back v2', template_ord: 0 },
      ],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: staleLegacyNote } as any);
    vi.mocked(cardsApi.updateCard).mockRejectedValueOnce({
      response: {
        status: 409,
        data: { detail: 'Card conflict: version mismatch' },
      },
    });

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));

    const frontInput = (await screen.findByLabelText(/^Front/i)) as HTMLTextAreaElement;
    fireEvent.change(frontInput, { target: { value: 'Conflicted Legacy Front Input' } });

    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toBeDefined();
    });

    // Edits preserved, conflict message and reload button shown, no auto-retry
    expect(frontInput.value).toBe('Conflicted Legacy Front Input');
    expect(screen.getByText(/Card conflict: version mismatch/i)).toBeDefined();
    expect(cardsApi.updateCard).toHaveBeenCalledTimes(1);

    // Reload latest
    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: latestLegacyNote } as any);
    fireEvent.click(screen.getByRole('button', { name: /Reload latest note \(discards local edits\)/i }));

    await waitFor(() => {
      const refreshedFront = screen.getByLabelText(/^Front/i) as HTMLTextAreaElement;
      expect(refreshedFront.value).toBe('Server Legacy Front v2');
    });

    // Subsequent save sends expected_version 2
    vi.mocked(cardsApi.updateCard).mockResolvedValueOnce({ data: {} } as any);
    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledTimes(2);
    });

    expect(cardsApi.updateCard).toHaveBeenLastCalledWith(101, {
      front: 'Server Legacy Front v2',
      back: 'Server Legacy Back v2',
      expected_version: 2,
    });
  });

  it('preserves literal commas in tags and whitespace separation when saving note with revision', async () => {
    const noteWithRevision: Note = {
      id: 50,
      guid: 'guid-note-50',
      kind: 'basic',
      revision: 'rev-commas-1',
      fields: { Front: 'Term', Back: 'Definition' },
      tags: ['topic,subtopic', 'chapter1'],
      cards: [{ id: 101, deck_id: 1, front: 'Term', back: 'Definition', template_ord: 0 }],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: noteWithRevision } as any);
    vi.mocked(notesApi.updateNote).mockResolvedValueOnce({ data: noteWithRevision } as any);

    renderCardEditorPage();

    await waitFor(() => {
      expect(screen.getByText(/Cards \(1\)/i)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));

    const tagsInput = (await screen.findByLabelText(/Tags/i)) as HTMLInputElement;
    expect(tagsInput.value).toBe('topic,subtopic chapter1');

    fireEvent.change(tagsInput, { target: { value: 'topic,subtopic   vocab,extra   chapter1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledWith(50, {
        fields: { Front: 'Term', Back: 'Definition' },
        tags: ['topic,subtopic', 'vocab,extra', 'chapter1'],
        expected_revision: 'rev-commas-1',
      });
    });
  });

  it('omits expected_revision and expected_version when revision/version are undefined', async () => {
    // Note without revision
    const noteNoRev: Note = {
      id: 55,
      guid: 'guid-note-55',
      kind: 'basic',
      fields: { Front: 'Front', Back: 'Back' },
      tags: ['tag'],
      cards: [{ id: 101, deck_id: 1, front: 'Front', back: 'Back', template_ord: 0 }],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: noteNoRev } as any);
    vi.mocked(notesApi.updateNote).mockResolvedValueOnce({ data: noteNoRev } as any);

    renderCardEditorPage();
    await waitFor(() => expect(screen.getByText(/Cards \(1\)/i)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    await screen.findByLabelText(/^Front/i);

    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(notesApi.updateNote).toHaveBeenCalledWith(55, {
        fields: { Front: 'Front', Back: 'Back' },
        tags: ['tag'],
      });
    });

    // Legacy card without version
    const legacyNoVersion: Note = {
      id: null,
      guid: 'guid-legacy-no-ver',
      kind: 'basic',
      fields: { Front: 'Legacy Front', Back: 'Legacy Back' },
      tags: [],
      cards: [{ id: 101, deck_id: 1, front: 'Legacy Front', back: 'Legacy Back', template_ord: 0 }],
    };

    vi.mocked(notesApi.getCardNote).mockResolvedValueOnce({ data: legacyNoVersion } as any);
    vi.mocked(cardsApi.updateCard).mockResolvedValueOnce({ data: {} } as any);

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    await screen.findByLabelText(/^Front/i);

    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => {
      expect(cardsApi.updateCard).toHaveBeenCalledWith(101, {
        front: 'Legacy Front',
        back: 'Legacy Back',
      });
    });
  });
});
