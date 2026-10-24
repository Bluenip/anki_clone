import client from './client';
export type { StudyCard, StudyStats, StudyInterval } from './types';

export interface ReviewExtra {
  study_deck_id?: number;
  duration_ms?: number;
  request_id?: string;
  expected_version?: number;
}

export const getNextCard = (deckId: number) => client.get(`/api/study/${deckId}`);

export const reviewCard = (cardId: number, rating: number, extra?: ReviewExtra) =>
  client.post(`/api/study/${cardId}/review`, { rating, ...extra });

export const getStudyStats = (deckId: number) => client.get(`/api/study/${deckId}/stats`);

export const undoReview = () => client.post('/api/study/undo/latest');

export const cardAction = (cardId: number, action: 'bury' | 'suspend', expected_version?: number) =>
  client.post(`/api/study/${cardId}/action`, {
    action,
    ...(expected_version !== undefined ? { expected_version } : {}),
  });
