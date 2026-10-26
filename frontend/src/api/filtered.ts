import client from './client';
import type { StudyCard } from './types';

export type SessionOrder = 'oldest' | 'newest' | 'random' | 'due' | 'lapses';

export type StudyFilter = { search: string; limit: number; order: SessionOrder };

export interface Session {
  filters?: StudyFilter[];
  id: number;
  name: string;
  search: string;
  limit: number;
  order: SessionOrder;
  reschedule: boolean;
  version: number;
  remaining: number;
  preview_again_seconds?: number;
  preview_hard_seconds?: number;
  preview_good_seconds?: number;
}

export interface CreateSessionPayload {
  filters?: StudyFilter[];
  name: string;
  search?: string;
  limit?: number;
  order?: SessionOrder;
  reschedule?: boolean;
  preview_again_seconds?: number;
  preview_hard_seconds?: number;
  preview_good_seconds?: number;
}

export interface NextCardResponse {
  session: Session;
  card: StudyCard | null;
  next_available_at: string | null;
}

export interface AnswerCardPayload {
  expected_session_version: number;
  card_id: number;
  expected_version: number;
  rating: number; // 1..4
  duration_ms?: number;
}

export interface AnswerCardResponse {
  session: Session;
}

export interface UndoCardResponse {
  session: Session;
}

export interface DeleteSessionResponse {
  deleted: boolean;
}

export const getFilteredSessions = () => client.get<Session[]>('/api/filtered');

export const createFilteredSession = (data: CreateSessionPayload) =>
  client.post<Session>('/api/filtered', {
    ...(data.filters ? { filters: data.filters } : {}),
    name: data.name,
    search: data.search ?? 'is:due',
    limit: data.limit ?? 100,
    order: data.order ?? 'oldest',
    reschedule: data.reschedule ?? false,
    preview_again_seconds: data.preview_again_seconds ?? 60,
    preview_hard_seconds: data.preview_hard_seconds ?? 600,
    preview_good_seconds: data.preview_good_seconds ?? 0,
  });

export const rebuildFilteredSession = (id: number, expected_version: number) =>
  client.post<Session>(`/api/filtered/${id}/rebuild`, { expected_version });

export const emptyFilteredSession = (id: number, expected_version: number) =>
  client.post<Session>(`/api/filtered/${id}/empty`, { expected_version });

export const deleteFilteredSession = (id: number, expected_version: number) =>
  client.delete<DeleteSessionResponse>(`/api/filtered/${id}`, {
    params: { expected_version },
  });

export const getFilteredNextCard = (id: number) =>
  client.get<NextCardResponse>(`/api/filtered/${id}/next`);

export const answerFilteredCard = (id: number, payload: AnswerCardPayload) =>
  client.post<AnswerCardResponse>(`/api/filtered/${id}/answer`, payload);

export const undoFilteredSession = (id: number) =>
  client.post<UndoCardResponse>(`/api/filtered/${id}/undo`, {});

export type { StudyCard };

export const editFilteredSession = (id: number, expected_version: number, data: CreateSessionPayload) =>
  client.put<Session>(`/api/filtered/${id}`, { ...data, expected_version });
