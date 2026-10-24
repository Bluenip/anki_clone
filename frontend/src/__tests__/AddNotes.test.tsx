import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import AddPage from '../pages/AddPage';
import * as decksApi from '../api/decks';
import * as notesApi from '../api/notes';
import client from '../api/client';

vi.mock('../api/decks');
vi.mock('../api/notes', async () => {
  const actual = await vi.importActual<typeof import('../api/notes')>('../api/notes');
  return {
    ...actual,
    getNoteTypes: vi.fn(),
    createNote: vi.fn(),
    getNote: vi.fn(),
    updateNote: vi.fn(),
  };
});

const mockDecks = [
  { id: 1, name: 'Default Deck' },
  { id: 2, name: 'Languages' },
];

const mockNoteTypes: notesApi.NoteType[] = [
  { kind: 'basic', name: 'Basic', fields: ['Front', 'Back'] },
  { kind: 'reversed', name: 'Basic (and reversed card)', fields: ['Front', 'Back'] },
  { kind: 'optional_reversed', name: 'Basic (optional reversed card)', fields: ['Front', 'Back', 'Add Reverse'] },
  { kind: 'cloze', name: 'Cloze', fields: ['Text', 'Extra'] },
];

describe('AddPage note creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decksApi.listDecks).mockResolvedValue({ data: mockDecks } as any);
    vi.mocked(notesApi.getNoteTypes).mockResolvedValue({ data: mockNoteTypes } as any);
  });

  it('reversed creates ONE note payload and reports two cards', async () => {
    const mockCreatedNote: notesApi.Note = {
      id: 10,
      guid: 'guid-10',
      kind: 'reversed',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: ['french'],
      cards: [
        { id: 101, deck_id: 1, front: 'Bonjour', back: 'Hello', template_ord: 0 },
        { id: 102, deck_id: 1, front: 'Hello', back: 'Bonjour', template_ord: 1 },
      ],
    };
    vi.mocked(notesApi.createNote).mockResolvedValueOnce({ data: mockCreatedNote } as any);

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/Type/i)).toBeDefined();
    });

    // Select reversed note type
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'reversed' } });

    // Fill Front, Back, and Tags
    fireEvent.change(screen.getByLabelText(/^Front/i), { target: { value: 'Bonjour' } });
    fireEvent.change(screen.getByLabelText(/^Back/i), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText(/Tags/i), { target: { value: 'french' } });

    // Submit note
    fireEvent.click(screen.getByRole('button', { name: /Add Note/i }));

    await waitFor(() => {
      expect(notesApi.createNote).toHaveBeenCalledTimes(1);
    });

    expect(notesApi.createNote).toHaveBeenCalledWith({
      deck_id: 1,
      kind: 'reversed',
      fields: { Front: 'Bonjour', Back: 'Hello' },
      tags: ['french'],
    });

    // Reports two cards in success notification
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeDefined();
      expect(screen.getByText(/2 cards created/i)).toBeDefined();
    });

    // Fields should be cleared
    expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/^Back/i) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/Tags/i) as HTMLInputElement).value).toBe('');

    // Retains selected deck and note type
    expect((screen.getByLabelText(/Deck/i) as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText(/Type/i) as HTMLSelectElement).value).toBe('reversed');
  });

  it('cloze Extra blank', async () => {
    const mockClozeNote: notesApi.Note = {
      id: 20,
      guid: 'guid-20',
      kind: 'cloze',
      fields: { Text: 'Canberra is the capital of {{c1::Australia}}.', Extra: '' },
      tags: ['geography'],
      cards: [
        { id: 201, deck_id: 1, front: 'Canberra is the capital of [...].', back: 'Australia', template_ord: 0 },
      ],
    };
    vi.mocked(notesApi.createNote).mockResolvedValueOnce({ data: mockClozeNote } as any);

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/Type/i)).toBeDefined();
    });

    // Switch to cloze
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'cloze' } });

    // Text and Extra fields should be rendered
    const textArea = screen.getByLabelText(/^Text/i) as HTMLTextAreaElement;
    const extraArea = screen.getByLabelText(/Extra/i) as HTMLTextAreaElement;
    expect(textArea).toBeDefined();
    expect(extraArea).toBeDefined();

    // Fill Text, keep Extra blank
    fireEvent.change(textArea, { target: { value: 'Canberra is the capital of {{c1::Australia}}.' } });
    fireEvent.change(screen.getByLabelText(/Tags/i), { target: { value: 'geography' } });

    fireEvent.click(screen.getByRole('button', { name: /Add Note/i }));

    await waitFor(() => {
      expect(notesApi.createNote).toHaveBeenCalledTimes(1);
    });

    expect(notesApi.createNote).toHaveBeenCalledWith({
      deck_id: 1,
      kind: 'cloze',
      fields: {
        Text: 'Canberra is the capital of {{c1::Australia}}.',
        Extra: '',
      },
      tags: ['geography'],
    });

    await waitFor(() => {
      expect(screen.getByText(/1 card created/i)).toBeDefined();
    });
  });

  it('server error preserves text', async () => {
    const errorResponse = {
      response: {
        data: {
          detail: 'Invalid cloze format: no cloze deletion found in Text',
        },
      },
    };
    vi.mocked(notesApi.createNote).mockRejectedValueOnce(errorResponse);

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/Type/i)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/^Front/i), { target: { value: 'Preserve this front text' } });
    fireEvent.change(screen.getByLabelText(/^Back/i), { target: { value: 'Preserve this back text' } });
    fireEvent.change(screen.getByLabelText(/Tags/i), { target: { value: 'important tag' } });

    fireEvent.click(screen.getByRole('button', { name: /Add Note/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Invalid cloze format: no cloze deletion found in Text/i)).toBeDefined();
    });

    // No success message
    expect(screen.queryByRole('status')).toBeNull();

    // Text inputs MUST be preserved
    expect((screen.getByLabelText(/^Front/i) as HTMLTextAreaElement).value).toBe('Preserve this front text');
    expect((screen.getByLabelText(/^Back/i) as HTMLTextAreaElement).value).toBe('Preserve this back text');
    expect((screen.getByLabelText(/Tags/i) as HTMLInputElement).value).toBe('important tag');
  });

  it('pending prevents duplicate submits', async () => {
    let resolvePromise: (val: any) => void = () => {};
    const pendingPromise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    vi.mocked(notesApi.createNote).mockReturnValue(pendingPromise as any);

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Front/i)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/^Front/i), { target: { value: 'Test front' } });
    fireEvent.change(screen.getByLabelText(/^Back/i), { target: { value: 'Test back' } });

    const submitBtn = screen.getByRole('button', { name: /Add Note/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    // First click
    fireEvent.click(submitBtn);

    // Button should now be disabled and show pending state
    expect(submitBtn.disabled).toBe(true);
    expect(screen.getByText(/Adding Note.../i)).toBeDefined();
    expect(notesApi.createNote).toHaveBeenCalledTimes(1);

    // Attempt second submission while pending
    fireEvent.click(submitBtn);
    fireEvent.submit(submitBtn.closest('form')!);

    // Should NOT have triggered a second request
    expect(notesApi.createNote).toHaveBeenCalledTimes(1);

    // Resolve the promise
    await act(async () => {
      resolvePromise({
        data: {
          id: 5,
          guid: 'g-5',
          kind: 'basic',
          fields: { Front: 'Test front', Back: 'Test back' },
          tags: [],
          cards: [{ id: 50, deck_id: 1, front: 'Test front', back: 'Test back', template_ord: 0 }],
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeDefined();
      expect(submitBtn.disabled).toBe(false);
    });
  });

  it('allows retrying when initial loading fails', async () => {
    vi.mocked(decksApi.listDecks).mockRejectedValueOnce(new Error('Network error loading decks'));

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Network error loading decks/i)).toBeDefined();
    });

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeDefined();

    // Prepare success for retry
    vi.mocked(decksApi.listDecks).mockResolvedValueOnce({ data: mockDecks } as any);
    vi.mocked(notesApi.getNoteTypes).mockResolvedValueOnce({ data: mockNoteTypes } as any);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByLabelText(/Deck/i)).toBeDefined();
    });
  });

  it('supports cloze insert button and Ctrl+Shift+C shortcut', async () => {
    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/Type/i)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'cloze' } });

    const textArea = screen.getByLabelText(/^Text/i) as HTMLTextAreaElement;
    fireEvent.change(textArea, { target: { value: 'Mount Everest is high' } });

    // Simulate selecting 'Everest'
    textArea.setSelectionRange(6, 13);

    // Click cloze insert button
    const insertBtn = screen.getByRole('button', { name: /Insert Cloze/i });
    fireEvent.click(insertBtn);

    expect(textArea.value).toBe('Mount {{c1::Everest}} is high');

    // Test Ctrl+Shift+C key shortcut
    textArea.setSelectionRange(0, 5); // Mount
    fireEvent.keyDown(textArea, { key: 'C', ctrlKey: true, shiftKey: true });

    expect(textArea.value).toBe('{{c2::Mount}} {{c1::Everest}} is high');
  });

  it('supports Ctrl+Enter to submit', async () => {
    vi.mocked(notesApi.createNote).mockResolvedValueOnce({
      data: {
        id: 1,
        cards: [{ id: 1, deck_id: 1, front: 'Q', back: 'A', template_ord: 0 }],
      },
    } as any);

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Front/i)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/^Front/i), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText(/^Back/i), { target: { value: 'Answer' } });

    // Press Ctrl+Enter inside the form
    fireEvent.keyDown(screen.getByLabelText(/^Back/i), { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(notesApi.createNote).toHaveBeenCalledTimes(1);
    });
  });

  it('preserves literal commas in tags and splits only on whitespace', async () => {
    const mockCreatedNote: notesApi.Note = {
      id: 30,
      guid: 'guid-30',
      kind: 'basic',
      fields: { Front: 'Topic question', Back: 'Topic answer' },
      tags: ['topic,one', 'second'],
      cards: [
        { id: 301, deck_id: 1, front: 'Topic question', back: 'Topic answer', template_ord: 0 },
      ],
    };
    vi.mocked(notesApi.createNote).mockResolvedValueOnce({ data: mockCreatedNote } as any);

    render(<MemoryRouter><AddPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Front/i)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/^Front/i), { target: { value: 'Topic question' } });
    fireEvent.change(screen.getByLabelText(/^Back/i), { target: { value: 'Topic answer' } });
    fireEvent.change(screen.getByLabelText(/Tags/i), { target: { value: 'topic,one second' } });

    fireEvent.click(screen.getByRole('button', { name: /Add Note/i }));

    await waitFor(() => {
      expect(notesApi.createNote).toHaveBeenCalledTimes(1);
    });

    expect(notesApi.createNote).toHaveBeenCalledWith({
      deck_id: 1,
      kind: 'basic',
      fields: { Front: 'Topic question', Back: 'Topic answer' },
      tags: ['topic,one', 'second'],
    });
  });
});

describe('Notes API client wrapper functions', () => {
  it('invokes client.get for note types', async () => {
    const actualNotes = await vi.importActual<typeof import('../api/notes')>('../api/notes');
    const getSpy = vi.spyOn(client, 'get').mockResolvedValue({ data: [] });
    await actualNotes.getNoteTypes();
    expect(getSpy).toHaveBeenCalledWith('/api/note-types');
  });

  it('invokes client.post for createNote', async () => {
    const actualNotes = await vi.importActual<typeof import('../api/notes')>('../api/notes');
    const postSpy = vi.spyOn(client, 'post').mockResolvedValue({ data: {} });
    const payload: notesApi.CreateNotePayload = {
      deck_id: 1,
      kind: 'basic',
      fields: { Front: 'F', Back: 'B' },
      tags: ['tag1'],
    };
    await actualNotes.createNote(payload);
    expect(postSpy).toHaveBeenCalledWith('/api/notes', payload);
  });

  it('invokes client.get for getNote by id', async () => {
    const actualNotes = await vi.importActual<typeof import('../api/notes')>('../api/notes');
    const getSpy = vi.spyOn(client, 'get').mockResolvedValue({ data: {} });
    await actualNotes.getNote(42);
    expect(getSpy).toHaveBeenCalledWith('/api/notes/42');
  });

  it('invokes client.put for updateNote by id', async () => {
    const actualNotes = await vi.importActual<typeof import('../api/notes')>('../api/notes');
    const putSpy = vi.spyOn(client, 'put').mockResolvedValue({ data: {} });
    const payload: notesApi.UpdateNotePayload = {
      fields: { Front: 'Updated' },
      tags: ['new'],
    };
    await actualNotes.updateNote(42, payload);
    expect(putSpy).toHaveBeenCalledWith('/api/notes/42', payload);
  });
});
