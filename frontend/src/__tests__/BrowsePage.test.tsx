import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowsePage from '../pages/BrowsePage';
import * as cardsApi from '../api/cards';

vi.mock('../api/cards');

const mockCards: cardsApi.BrowseCard[] = [
  {
    id: 101,
    deck_id: 1,
    deck_name: 'Default Deck',
    front: 'Bonjour',
    back: 'Hello',
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
    front: 'Merci',
    back: 'Thank you',
    version: 5,
    is_suspended: false,
    is_buried: false,
    card_state: 'new',
    note_id: 11,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 103,
    deck_id: 2,
    deck_name: 'Spanish',
    front: 'Hola',
    back: 'Hello',
    version: 2,
    is_suspended: true,
    is_buried: false,
    card_state: 'review',
    note_id: 12,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

describe('BrowsePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends selected card IDs and expected_version payload on bulk action', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);
    vi.mocked(cardsApi.bulkActionCards).mockResolvedValue({ data: { updated: 2 } } as any);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    const card1Checkbox = await screen.findByLabelText('Select card 101');
    const card2Checkbox = screen.getByLabelText('Select card 102');

    fireEvent.click(card1Checkbox);
    fireEvent.click(card2Checkbox);

    expect(screen.getByTestId('selection-count').textContent).toBe('2 selected');

    const suspendBtn = screen.getByRole('button', { name: /^suspend$/i });
    fireEvent.click(suspendBtn);

    await waitFor(() => {
      expect(cardsApi.bulkActionCards).toHaveBeenCalledWith({
        action: 'suspend',
        cards: [
          { card_id: 101, expected_version: 3 },
          { card_id: 102, expected_version: 5 },
        ],
      });
    });

    expect(await screen.findByText(/Successfully updated 2 card\(s\)\./i)).toBeDefined();
  });

  it('displays 409 version conflict error when bulk action fails with conflict', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);
    const error409 = {
      response: {
        status: 409,
        data: { detail: 'Cards were modified elsewhere (version conflict 409). Please refresh.' },
      },
    };
    vi.mocked(cardsApi.bulkActionCards).mockRejectedValue(error409);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    const card1Checkbox = await screen.findByLabelText('Select card 101');
    fireEvent.click(card1Checkbox);

    const suspendBtn = screen.getByRole('button', { name: /^suspend$/i });
    fireEvent.click(suspendBtn);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/version conflict 409/i);
  });

  it('displays fallback 409 message when bulk action response has no custom detail', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);
    const error409 = {
      response: {
        status: 409,
        data: {},
      },
    };
    vi.mocked(cardsApi.bulkActionCards).mockRejectedValue(error409);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    const card1Checkbox = await screen.findByLabelText('Select card 101');
    fireEvent.click(card1Checkbox);

    const buryBtn = screen.getByRole('button', { name: /^bury$/i });
    fireEvent.click(buryBtn);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Cards were modified elsewhere (version conflict 409). Please refresh.');
  });

  it('clears selection when a new search is performed', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    const card1Checkbox = (await screen.findByLabelText('Select card 101')) as HTMLInputElement;
    const card2Checkbox = screen.getByLabelText('Select card 102') as HTMLInputElement;

    fireEvent.click(card1Checkbox);
    fireEvent.click(card2Checkbox);

    expect(screen.getByTestId('selection-count').textContent).toBe('2 selected');
    expect(card1Checkbox.checked).toBe(true);
    expect(card2Checkbox.checked).toBe(true);

    const searchInput = screen.getByLabelText('Search cards query');
    fireEvent.change(searchInput, { target: { value: 'tag:verb' } });
    const searchBtn = screen.getByRole('button', { name: /^search$/i });
    fireEvent.click(searchBtn);

    await waitFor(() => {
      expect(screen.getByTestId('selection-count').textContent).toBe('0 selected');
    });

    const refreshedCard1Checkbox = (await screen.findByLabelText('Select card 101')) as HTMLInputElement;
    const refreshedCard2Checkbox = screen.getByLabelText('Select card 102') as HTMLInputElement;
    expect(refreshedCard1Checkbox.checked).toBe(false);
    expect(refreshedCard2Checkbox.checked).toBe(false);
  });

  it('ensures newer search response wins when search responses resolve out of order', async () => {
    let resolveFirst!: (val: any) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    let resolveSecond!: (val: any) => void;
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    // Handle initial load and subsequent search calls
    vi.mocked(cardsApi.browseCards).mockImplementation(async (query: string = '') => {
      if (query === 'first_query') {
        return firstPromise as any;
      }
      if (query === 'second_query') {
        return secondPromise as any;
      }
      return { data: mockCards } as any;
    });

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    await screen.findByLabelText('Select card 101');

    const searchInput = screen.getByLabelText('Search cards query');
    const searchBtn = screen.getByRole('button', { name: /^search$/i });

    // Trigger first search (slow network)
    fireEvent.change(searchInput, { target: { value: 'first_query' } });
    fireEvent.click(searchBtn);

    // Trigger second search (fast network)
    fireEvent.change(searchInput, { target: { value: 'second_query' } });
    fireEvent.click(searchBtn);

    // Resolve second search first
    const secondResults: cardsApi.BrowseCard[] = [
      {
        id: 202,
        deck_id: 1,
        deck_name: 'Default Deck',
        front: 'Newer Query Result',
        back: 'Should be displayed',
        version: 1,
        is_suspended: false,
        is_buried: false,
        card_state: 'new',
        note_id: 20,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];

    await act(async () => {
      resolveSecond({ data: secondResults });
    });

    // Verify newer search result is shown (in table cell)
    expect(await screen.findByRole('cell', { name: 'Newer Query Result' })).toBeDefined();

    // Now resolve older/first search out of order
    const firstResults: cardsApi.BrowseCard[] = [
      {
        id: 101,
        deck_id: 1,
        deck_name: 'Default Deck',
        front: 'Older Stale Result',
        back: 'Should NOT overwrite',
        version: 1,
        is_suspended: false,
        is_buried: false,
        card_state: 'new',
        note_id: 10,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];

    await act(async () => {
      resolveFirst({ data: firstResults });
    });

    // Verify newer search result remains and older stale result was ignored
    expect(screen.getByRole('cell', { name: 'Newer Query Result' })).toBeDefined();
    expect(screen.queryByRole('cell', { name: 'Older Stale Result' })).toBeNull();
  });

  it('toggles select all displayed cards correctly', async () => {
    vi.mocked(cardsApi.browseCards).mockResolvedValue({ data: mockCards } as any);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>
    );

    await screen.findByLabelText('Select card 101');

    const selectAllCheckbox = screen.getByLabelText('Select all displayed');
    fireEvent.click(selectAllCheckbox);

    expect(screen.getByTestId('selection-count').textContent).toBe('3 selected');

    // Deselect all
    fireEvent.click(selectAllCheckbox);
    expect(screen.getByTestId('selection-count').textContent).toBe('0 selected');
  });
});
