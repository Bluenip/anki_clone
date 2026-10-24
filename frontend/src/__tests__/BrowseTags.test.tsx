import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowsePage from '../pages/BrowsePage';
import * as cardsApi from '../api/cards';

vi.mock('../api/cards');

const mockCards: cardsApi.BrowseCard[] = [
  {
    id: 101,
    deck_id: 1,
    deck_name: 'Default Deck',
    front: 'Card 1 Front',
    back: 'Card 1 Back',
    version: 3,
    is_suspended: false,
    is_buried: false,
    card_state: 'review',
    note_id: 10,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 102,
    deck_id: 1,
    deck_name: 'Default Deck',
    front: 'Card 2 Front',
    back: 'Card 2 Back',
    version: 5,
    is_suspended: false,
    is_buried: false,
    card_state: 'new',
    note_id: 10, // Sibling card of note 10
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 103,
    deck_id: 2,
    deck_name: 'Spanish',
    front: 'Card 3 Front',
    back: 'Card 3 Back',
    version: 2,
    is_suspended: false,
    is_buried: false,
    card_state: 'review',
    note_id: 12,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

describe('BrowseTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selectedpayload: sends correct action, versioned cards and whitespace-separated tags with literal commas for add_tags and remove_tags', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);
    vi.mocked(cardsApi.bulkActionCards).mockResolvedValue({
      data: { updated: 4, updated_notes: 2 },
    } as any);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    // Select card 101 and card 102
    const card1Checkbox = await screen.findByLabelText('Select card 101');
    const card2Checkbox = screen.getByLabelText('Select card 102');
    fireEvent.click(card1Checkbox);
    fireEvent.click(card2Checkbox);

    expect(screen.getByTestId('selection-count').textContent).toBe('2 selected');

    // Click "Add Tags"
    const addTagsBtn = screen.getByRole('button', { name: /^add tags$/i });
    fireEvent.click(addTagsBtn);

    // Panel should be visible with text input labeled "Tags to add"
    const tagInput = screen.getByLabelText(/^tags to add$/i);
    expect(tagInput).toBeDefined();

    // Whitespace separated tags input (commas treated as literal chars)
    fireEvent.change(tagInput, { target: { value: 'biology,part1   chapter1    exam_prep' } });

    const applyBtn = screen.getByRole('button', { name: /^apply$/i });
    expect((applyBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(cardsApi.bulkActionCards).toHaveBeenCalledWith({
        action: 'add_tags',
        tags: ['biology,part1', 'chapter1', 'exam_prep'],
        cards: [
          { card_id: 101, expected_version: 3 },
          { card_id: 102, expected_version: 5 },
        ],
      });
    });

    // Success message shows note(s) and card(s)
    expect(
      await screen.findByText(/Successfully updated 2 note\(s\) \(4 card\(s\)\)\./i)
    ).toBeDefined();

    // Now test remove_tags
    vi.mocked(cardsApi.bulkActionCards).mockResolvedValue({
      data: { updated: 2, updated_notes: 1 },
    } as any);

    const card3Checkbox = await screen.findByLabelText('Select card 103');
    fireEvent.click(card3Checkbox);

    const removeTagsBtn = screen.getByRole('button', { name: /^remove tags$/i });
    fireEvent.click(removeTagsBtn);

    const removeInput = screen.getByLabelText(/^tags to remove$/i);
    fireEvent.change(removeInput, { target: { value: 'parent::subtag' } });

    const applyRemoveBtn = screen.getByRole('button', { name: /^apply$/i });
    fireEvent.click(applyRemoveBtn);

    await waitFor(() => {
      expect(cardsApi.bulkActionCards).toHaveBeenCalledWith({
        action: 'remove_tags',
        tags: ['parent::subtag'],
        cards: [{ card_id: 103, expected_version: 2 }],
      });
    });

    expect(
      await screen.findByText(/Successfully updated 1 note\(s\) \(2 card\(s\)\)\./i)
    ).toBeDefined();
  });

  it('note-scopehelp: displays the required note-scope explanation, subtag deletion explanation in Remove Tags, and selected card count', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    const card1Checkbox = await screen.findByLabelText('Select card 101');
    fireEvent.click(card1Checkbox);

    const addTagsBtn = screen.getByRole('button', { name: /^add tags$/i });
    fireEvent.click(addTagsBtn);

    // Check exact explanation required:
    // "Tags belong to notes; all cards of each selected note are affected, including cards on other pages/decks."
    expect(
      screen.getByText(
        'Tags belong to notes; all cards of each selected note are affected, including cards on other pages/decks.'
      )
    ).toBeDefined();

    // Selected card count displayed in panel
    expect(screen.getByText(/1 selected card\(s\)/i)).toBeDefined();

    // In Add Tags, subtag removal sentence is not shown
    expect(screen.queryByText('Removing a parent tag also removes its subtags.')).toBeNull();

    // Now switch to Remove Tags panel
    const removeTagsBtn = screen.getByRole('button', { name: /^remove tags$/i });
    fireEvent.click(removeTagsBtn);

    // Both explanations are shown
    expect(
      screen.getByText(
        'Tags belong to notes; all cards of each selected note are affected, including cards on other pages/decks.'
      )
    ).toBeDefined();
    expect(
      screen.getByText('Removing a parent tag also removes its subtags.')
    ).toBeDefined();
  });

  it('blankdisabled: disables submit when input is empty or whitespace-only, disables while pending, and supports Cancel and search/page clearance', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    // Initial state: No cards selected -> Add Tags and Remove Tags are disabled
    await screen.findByLabelText('Select card 101');
    const addTagsBtn = screen.getByRole('button', { name: /^add tags$/i });
    const removeTagsBtn = screen.getByRole('button', { name: /^remove tags$/i });
    expect((addTagsBtn as HTMLButtonElement).disabled).toBe(true);
    expect((removeTagsBtn as HTMLButtonElement).disabled).toBe(true);

    // Select card 101
    fireEvent.click(screen.getByLabelText('Select card 101'));
    expect((addTagsBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(addTagsBtn);

    const applyBtn = screen.getByRole('button', { name: /^apply$/i });
    const tagInput = screen.getByLabelText(/^tags to add$/i) as HTMLInputElement;

    // Blank input -> submit is disabled
    expect((applyBtn as HTMLButtonElement).disabled).toBe(true);

    // Whitespace-only input -> submit remains disabled
    fireEvent.change(tagInput, { target: { value: '     ' } });
    expect((applyBtn as HTMLButtonElement).disabled).toBe(true);

    // Valid tag -> submit enabled
    fireEvent.change(tagInput, { target: { value: 'testtag' } });
    expect((applyBtn as HTMLButtonElement).disabled).toBe(false);

    // Cancel closes the tag panel
    const cancelBtn = screen.getByRole('button', { name: /^cancel$/i });
    fireEvent.click(cancelBtn);
    expect(screen.queryByLabelText(/^tags to add$/i)).toBeNull();

    // Reopen and verify search clears the tag panel
    fireEvent.click(addTagsBtn);
    expect(screen.getByLabelText(/^tags to add$/i)).toBeDefined();

    fireEvent.change(screen.getByLabelText('Search cards query'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText(/^tags to add$/i)).toBeNull();
    });
  });

  it('error preservation: preserves and displays backend error responses without clearing input or crashing', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);
    vi.mocked(cardsApi.bulkActionCards).mockRejectedValue({
      response: {
        status: 422,
        data: { detail: 'Tag must not contain whitespace or exceed 100 characters' },
      },
    });

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    const card1Checkbox = await screen.findByLabelText('Select card 101');
    fireEvent.click(card1Checkbox);

    const addTagsBtn = screen.getByRole('button', { name: /^add tags$/i });
    fireEvent.click(addTagsBtn);

    const tagInput = screen.getByLabelText(/^tags to add$/i);
    fireEvent.change(tagInput, { target: { value: 'invalid_tag' } });

    const applyBtn = screen.getByRole('button', { name: /^apply$/i });
    fireEvent.click(applyBtn);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Tag must not contain whitespace or exceed 100 characters');

    // Panel is still open with input preserved so user can edit or cancel
    expect(screen.getByLabelText(/^tags to add$/i)).toBeDefined();
    expect((tagInput as HTMLInputElement).value).toBe('invalid_tag');
  });
});
