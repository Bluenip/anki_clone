import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import DecksPage from '../pages/DecksPage';
import * as decksApi from '../api/decks';

vi.mock('../api/decks');

const renderWithRouter = (ui: React.ReactElement) => {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
};

describe('DecksPage state handling and accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    vi.spyOn(decksApi, 'listDecks').mockReturnValue(new Promise(() => {}));
    const { container } = renderWithRouter(<DecksPage />);
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('renders empty state when no decks are returned', async () => {
    vi.spyOn(decksApi, 'listDecks').mockResolvedValue({ data: [] } as any);
    renderWithRouter(<DecksPage />);

    await waitFor(() => {
      expect(screen.getByText(/Your next learning journey starts here/i)).toBeDefined();
    });
  });

  it('renders error state with retry button on fetch failure, and retries successfully', async () => {
    const listDecksMock = vi.spyOn(decksApi, 'listDecks');
    listDecksMock.mockRejectedValueOnce(new Error('Network error'));

    renderWithRouter(<DecksPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeDefined();

    // Mock successful recovery on retry
    listDecksMock.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          name: 'Japanese N5',
          description: 'Basic vocabulary',
          settings: '{}',
          is_shared: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_cards: 50,
          new_cards: 10,
          learn_cards: 5,
          due_cards: 15,
        },
      ],
    } as any);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('Japanese N5')).toBeDefined();
    });
  });

  it('opens create deck modal and closes on Escape key, restoring focus to opener', async () => {
    vi.spyOn(decksApi, 'listDecks').mockResolvedValue({ data: [] } as any);
    renderWithRouter(<DecksPage />);

    const createBtn = await screen.findByRole('button', { name: /^Create Deck$/i });
    createBtn.focus();
    expect(document.activeElement).toBe(createBtn);

    fireEvent.click(createBtn);

    // Modal should now be visible
    expect(screen.getByText('Create New Deck')).toBeDefined();
    const modal = screen.getByRole('dialog');
    expect(modal).toBeDefined();

    // Input should be focused
    const input = screen.getByLabelText(/Deck Name/i);
    expect(document.activeElement).toBe(input);

    // Press Escape to dismiss
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('Create New Deck')).toBeNull();
    });

    // Focus restored to opener button
    expect(document.activeElement).toBe(createBtn);
  });

  it('handles successful deck creation', async () => {
    const listDecksMock = vi.spyOn(decksApi, 'listDecks');
    listDecksMock.mockResolvedValueOnce({ data: [] } as any);
    const createDeckMock = vi.spyOn(decksApi, 'createDeck').mockResolvedValueOnce({ data: { id: 2, name: 'Biology' } } as any);

    renderWithRouter(<DecksPage />);

    const createBtn = await screen.findByRole('button', { name: /^Create Deck$/i });
    fireEvent.click(createBtn);

    const input = screen.getByLabelText(/Deck Name/i);
    fireEvent.change(input, { target: { value: 'Biology' } });

    listDecksMock.mockResolvedValueOnce({
      data: [{ id: 2, name: 'Biology', total_cards: 0, new_cards: 0, learn_cards: 0, due_cards: 0 }],
    } as any);

    const submitBtn = screen.getByRole('button', { name: /^Create$/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createDeckMock).toHaveBeenCalledWith('Biology', '');
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('renders create failure visibly inside modal, preserves input, and allows retry', async () => {
    vi.spyOn(decksApi, 'listDecks').mockResolvedValue({ data: [] } as any);
    const createDeckMock = vi.spyOn(decksApi, 'createDeck');
    createDeckMock.mockRejectedValueOnce({
      response: { data: { detail: 'Deck name already exists' } },
    });

    renderWithRouter(<DecksPage />);

    const createBtn = await screen.findByRole('button', { name: /^Create Deck$/i });
    fireEvent.click(createBtn);

    const input = screen.getByLabelText(/Deck Name/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Duplicate Deck' } });

    const submitBtn = screen.getByRole('button', { name: /^Create$/i });
    fireEvent.click(submitBtn);

    // Error should be rendered visibly INSIDE modal
    await waitFor(() => {
      const modal = screen.getByRole('dialog');
      expect(modal).toBeDefined();
      expect(screen.getByText('Deck name already exists')).toBeDefined();
    });

    // Input preserved
    expect(input.value).toBe('Duplicate Deck');

    // Empty list still displays empty state, NOT load error!
    expect(screen.getByText(/Your next learning journey starts here/i)).toBeDefined();
    expect(screen.queryByText(/Failed to load decks/i)).toBeNull();

    // Allows retry with modified name
    createDeckMock.mockResolvedValueOnce({ data: { id: 3, name: 'Duplicate Deck 2' } } as any);
    fireEvent.change(input, { target: { value: 'Duplicate Deck 2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('renders import failure visibly inside modal and preserves inputs', async () => {
    vi.spyOn(decksApi, 'listDecks').mockResolvedValue({
      data: [{ id: 10, name: 'Spanish', total_cards: 0, new_cards: 0, learn_cards: 0, due_cards: 0 }],
    } as any);
    const importCardsMock = vi.spyOn(decksApi, 'importCards');
    importCardsMock.mockRejectedValueOnce({
      response: { data: { detail: 'Invalid TSV format on line 2' } },
    });

    renderWithRouter(<DecksPage />);

    // Open gear menu
    const gearBtn = await screen.findByLabelText(/Options for deck Spanish/i);
    fireEvent.click(gearBtn);

    const importMenuItem = screen.getByText('Import Cards');
    fireEvent.click(importMenuItem);

    const textarea = screen.getByLabelText(/Basic notes: Front/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hola\tHello\nIncomplete' } });

    const importSubmitBtn = screen.getByRole('button', { name: /^Preview Import$/i });
    fireEvent.click(importSubmitBtn);

    await waitFor(() => {
      expect(screen.getByText('Invalid TSV format on line 2')).toBeDefined();
    });

    // Input preserved inside active modal
    expect(textarea.value).toBe('Hola\tHello\nIncomplete');
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('renders rename and delete operation errors without corrupting empty deck state', async () => {
    vi.spyOn(decksApi, 'listDecks').mockResolvedValue({
      data: [{ id: 1, name: 'German', total_cards: 0, new_cards: 0, learn_cards: 0, due_cards: 0 }],
    } as any);
    vi.spyOn(decksApi, 'updateDeck').mockRejectedValueOnce(new Error('Rename network error'));
    vi.spyOn(decksApi, 'deleteDeck').mockRejectedValueOnce(new Error('Delete network error'));

    // Mock prompt and confirm
    vi.spyOn(window, 'prompt').mockReturnValue('German B1');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithRouter(<DecksPage />);

    // 1. Rename failure
    const gearBtn = await screen.findByLabelText(/Options for deck German/i);
    fireEvent.click(gearBtn);

    const renameItem = screen.getByText('Rename');
    fireEvent.click(renameItem);

    await waitFor(() => {
      expect(screen.getByText('Failed to rename deck.')).toBeDefined();
    });

    // Dismiss error
    fireEvent.click(screen.getByLabelText('Dismiss error'));

    // 2. Delete failure
    fireEvent.click(screen.getByLabelText(/Options for deck German/i));
    const deleteItem = screen.getByText('Delete');
    fireEvent.click(deleteItem);

    await waitFor(() => {
      expect(screen.getByText('Failed to delete deck.')).toBeDefined();
    });
  });

  it('focus trap ignores disabled and hidden controls and traps Tab / Shift+Tab', async () => {
    vi.spyOn(decksApi, 'listDecks').mockResolvedValue({ data: [] } as any);
    renderWithRouter(<DecksPage />);

    const createBtn = await screen.findByRole('button', { name: /^Create Deck$/i });
    fireEvent.click(createBtn);

    const input = screen.getByLabelText(/Deck Name/i);
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
    const submitBtn = screen.getByRole('button', { name: /^Create$/i });

    // Initially submitBtn is disabled (!newDeckName), so it is excluded from focusable list
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(input);

    // Tab from input to cancelBtn
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);

    // Tab from cancelBtn (last enabled element) wraps back to input (first element)
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    // Now type into input so submitBtn becomes enabled
    fireEvent.change(input, { target: { value: 'Japanese Vocab' } });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

    // Move focus to submitBtn (now the last focusable element)
    submitBtn.focus();
    expect(document.activeElement).toBe(submitBtn);

    // Tab from submitBtn wraps around to first element (input)
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    // Shift+Tab from first element (input) wraps to last element (submitBtn)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(submitBtn);
  });
});


it('keeps package options in the import dialog and restores focus on Escape', async () => {
  vi.spyOn(decksApi, 'listDecks').mockResolvedValue({ data: [] } as any);
  renderWithRouter(<DecksPage />);
  const opener = await screen.findByRole('button', { name: 'Import File' });
  expect(screen.queryByLabelText('Media name collisions')).toBeNull();
  fireEvent.click(opener);
  expect(screen.getByRole('dialog', { name: 'Import file' })).toBeDefined();
  expect(screen.getByLabelText('Media name collisions')).toBe(document.activeElement);
  fireEvent.change(screen.getByLabelText('Existing package notes'), { target: { value: 'skip' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  expect((screen.getByLabelText('Existing package notes') as HTMLSelectElement).value).toBe('skip');
});

it('recovers a server-side preview in a fresh browser tab and places confirmation above the deck list', async () => {
  sessionStorage.clear();
  vi.spyOn(decksApi, 'listDecks').mockResolvedValue({ data: [] } as any);
  vi.spyOn(decksApi, 'listPendingPackageImports').mockResolvedValue({ data: [{ id: 'recovered', status: 'awaiting_confirmation' }] } as any);
  vi.spyOn(decksApi, 'getPackageImport').mockResolvedValue({ data: {
    id: 'recovered', status: 'awaiting_confirmation', completed: 1, total: 1,
    result: { cards_imported: 432, cards_updated: 0, cards_skipped: 0, notes_in_package: 214,
      cards_in_package: 432, media_imported: 921, media_bytes: 20000000, deck_name: 'Hanzi', warnings: [] },
  } } as any);
  const view = renderWithRouter(<DecksPage />);
  await screen.findByRole('button', { name: 'Import package' });
  expect(sessionStorage.getItem('anki-package-import')).toBe('recovered');
  const panel = screen.getByRole('region', { name: 'Package import' });
  const table = view.container.querySelector('.desktop-deck-table');
  expect(panel.compareDocumentPosition(table! ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  view.unmount();
  sessionStorage.clear();
});
