import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import StatsPage from '../pages/StatsPage';
import * as statsApi from '../api/stats';
import * as decksApi from '../api/decks';

vi.mock('../api/stats');
vi.mock('../api/decks');

const mockDecks: any[] = [
  { id: 1, name: 'Default Deck', total_cards: 10 },
  { id: 2, name: 'Languages::Japanese', total_cards: 30 },
];

const mockStats: statsApi.StatsResponse = {
  days: 30,
  deck_id: null,
  counts: {
    new: 4,
    learning: 2,
    young: 6,
    mature: 10,
    suspended: 1,
    buried: 2,
    total: 22,
    notes: 20,
  },
  history: [
    { day: -1, reviews: 8, seconds: 80, again: 1, hard: 1, good: 5, easy: 1 },
    { day: 0, reviews: 12, seconds: 120, again: 2, hard: 2, good: 6, easy: 2 },
  ],
  forecast: [
    { day: 0, cards: 5 },
    { day: 1, cards: 8 },
  ],
  intervals: [
    { label: '1 day', min: 1, max: 1, count: 1 },
    { label: '2–6 days', min: 2, max: 6, count: 5 },
    { label: '7–20 days', min: 7, max: 20, count: 2 },
    { label: '21–89 days', min: 21, max: 89, count: 6 },
    { label: '90+ days', min: 90, max: null, count: 2 },
  ],
  summary: {
    reviews: 20,
    seconds: 200,
    seconds_per_review: 10.0,
    active_days: 2,
    review_attempts: 16,
    remembered: 14,
    review_recall_percent: 87.5,
  },
  day_basis: 'Each home deck uses its configured timezone and day cutoff; day 0 means today.',
  forecast_basis: 'Current scheduled cards; excludes suspended/buried, includes overdue in day 0. Future answers can change this forecast.',
  recall_basis: 'Again versus Hard/Good/Easy on recorded review-state answers only; excludes learning and unclassified imported logs.',
};

describe('StatsPage UI and safeguards', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(decksApi.listDecks).mockResolvedValue({ data: mockDecks } as any);
    vi.mocked(statsApi.getStats).mockResolvedValue({ data: mockStats } as any);
  });

  it('renders stats page with summary cards, state distribution, and provenance notes', async () => {
    render(<StatsPage />);

    expect(screen.getByRole('status', { name: /loading statistics/i })).toBeDefined();

    await waitFor(() => {
      expect(screen.queryByRole('status', { name: /loading statistics/i })).toBeNull();
    });

    // Summary metrics
    expect(screen.getByText('20')).toBeDefined(); // total reviews
    expect(screen.getByText(/3m 20s/)).toBeDefined(); // 200s formatted
    expect(screen.getByText('87.5%')).toBeDefined(); // review recall
    expect(screen.getByText('22')).toBeDefined(); // total cards

    // Clarification on suspended / buried overlapping counts
    expect(screen.getAllByText(/Suspended/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/overlapping flags/i)).toBeDefined();

    // Forecast notice
    expect(screen.getByText(/not a fixed promise/i)).toBeDefined();

    // Provenance details
    expect(screen.getByText(/Each home deck uses its configured timezone/i)).toBeDefined();
  });

  it('handles missing data with N/A instead of false 0%', async () => {
    const emptyStats: statsApi.StatsResponse = {
      ...mockStats,
      summary: {
        reviews: 0,
        seconds: 0,
        seconds_per_review: null,
        active_days: 0,
        review_attempts: 0,
        remembered: 0,
        review_recall_percent: null,
      },
      counts: {
        new: 0,
        learning: 0,
        young: 0,
        mature: 0,
        suspended: 0,
        buried: 0,
        total: 0,
        notes: 0,
      },
      history: [],
      forecast: [],
    };
    vi.mocked(statsApi.getStats).mockResolvedValue({ data: emptyStats } as any);

    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.queryByRole('status', { name: /loading statistics/i })).toBeNull();
    });

    // Must show N/A for null recall and null seconds_per_review, not 0%
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getByText(/No review logs recorded in this timeframe/i)).toBeDefined();
  });

  it('switches time ranges (7, 30, 90, 365) correctly', async () => {
    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.getByText('7 Days')).toBeDefined();
    });

    fireEvent.click(screen.getByText('7 Days'));
    await waitFor(() => expect(statsApi.getStats).toHaveBeenCalledWith(7, null, expect.any(AbortSignal)));

    fireEvent.click(screen.getByText('90 Days'));
    await waitFor(() => expect(statsApi.getStats).toHaveBeenCalledWith(90, null, expect.any(AbortSignal)));

    fireEvent.click(screen.getByText('1 Year'));
    await waitFor(() => expect(statsApi.getStats).toHaveBeenCalledWith(365, null, expect.any(AbortSignal)));
  });

  it('selects deck and updates query with deck_id', async () => {
    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Languages::Japanese' })).toBeDefined();
    });

    const select = screen.getByRole('combobox', { name: /filter statistics by deck/i });
    fireEvent.change(select, { target: { value: '2' } });

    await waitFor(() => expect(statsApi.getStats).toHaveBeenCalledWith(30, 2, expect.any(AbortSignal)));

    // Reset to all decks
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(statsApi.getStats).toHaveBeenCalledWith(30, null, expect.any(AbortSignal)));
  });

  it('safeguards against request race conditions on rapid switching', async () => {
    let resolveFirst: (val: any) => void = () => {};
    let resolveSecond: (val: any) => void = () => {};

    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    vi.mocked(statsApi.getStats)
      .mockReturnValueOnce(firstPromise as any)
      .mockReturnValueOnce(secondPromise as any);

    render(<StatsPage />);

    // Fast switch range from 30 to 7
    await waitFor(() => {
      expect(screen.getByText('7 Days')).toBeDefined();
    });
    fireEvent.click(screen.getByText('7 Days'));
    await waitFor(() => expect(statsApi.getStats).toHaveBeenCalledTimes(2));

    // Second request finishes FIRST with 99 cards
    await act(async () => resolveSecond({
      data: {
        ...mockStats,
        counts: { ...mockStats.counts, total: 99 },
      },
    }));

    await waitFor(() => {
      expect(screen.getByText('99')).toBeDefined();
    });

    // Stale first request finishes LATER with 10 cards
    await act(async () => resolveFirst({
      data: {
        ...mockStats,
        counts: { ...mockStats.counts, total: 10 },
      },
    }));

    // Ensure the stale response does NOT overwrite the newer 99 cards
    expect(screen.getByText('99')).toBeDefined();
    expect(screen.queryByText('10 cards notes')).toBeNull();
  });

  it('shows error on failure and supports retry', async () => {
    vi.mocked(statsApi.getStats).mockRejectedValueOnce(new Error('Network error on stats'));

    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.getByText('Network error on stats')).toBeDefined();
    });

    const retryBtn = screen.getByRole('button', { name: /retry/i });
    vi.mocked(statsApi.getStats).mockResolvedValueOnce({ data: mockStats } as any);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByRole('status', { name: /loading statistics/i })).toBeNull();
      expect(screen.queryByText('Network error on stats')).toBeNull();
    });
  });
});
