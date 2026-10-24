import client from './client';

export interface StatsCounts {
  new: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
  buried: number;
  total: number;
  notes: number;
}

export interface StatsHistoryRow {
  day: number;
  reviews: number;
  seconds: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface StatsForecastRow {
  day: number;
  cards: number;
}

export interface StatsIntervalBucket {
  label: string;
  min: number;
  max: number | null;
  count: number;
}

export interface StatsSummary {
  reviews: number;
  seconds: number;
  seconds_per_review: number | null;
  active_days: number;
  review_attempts: number;
  remembered: number;
  review_recall_percent: number | null;
}

export interface StatsResponse {
  days: number;
  deck_id: number | null;
  counts: StatsCounts;
  history: StatsHistoryRow[];
  forecast: StatsForecastRow[];
  intervals: StatsIntervalBucket[];
  summary: StatsSummary;
  day_basis: string;
  forecast_basis: string;
  recall_basis: string;
}

export const getStats = (days: number = 30, deckId?: number | null, signal?: AbortSignal) => {
  const params: Record<string, unknown> = { days };
  if (deckId !== undefined && deckId !== null) {
    params.deck_id = deckId;
  }
  return client.get<StatsResponse>('/api/stats', { params, signal });
};
