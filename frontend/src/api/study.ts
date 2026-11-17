import client from './client';
export type { StudyCard, StudyStats, StudyInterval, QuizExercise, QuizResult } from './types';
import type { QuizResult } from './types';

export interface QuizAnswer {
  response: string;
  hint_used: boolean;
}

export interface ReviewExtra {
  study_deck_id?: number;
  duration_ms?: number;
  request_id?: string;
  expected_version?: number;
  quiz?: QuizAnswer;
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

export const checkQuiz = (cardId: number, answer: QuizAnswer) =>
  client.post<QuizResult>(`/api/study/${cardId}/quiz/check`, answer);

/** Server detail when the latest answer came from an exercise (students may not retry those). */
export const QUIZ_UNDO_BLOCKED = 'Answers to exercises cannot be undone';
