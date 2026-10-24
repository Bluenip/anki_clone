import client from './client';
import type { BrowseCard, BulkActionType, BulkCardItem, BulkActionRequest, BulkActionResult } from './types';
export type { Card, BrowseCard, BulkActionType, BulkCardItem, BulkActionRequest, BulkActionResult } from './types';

export const listCards = (deckId: number, search?: string) =>
  client.get(`/api/decks/${deckId}/cards`, { params: { search } });
export const createCard = (deckId: number, front: string, back: string) =>
  client.post(`/api/decks/${deckId}/cards`, { front, back });
export const updateCard = (cardId: number, data: { front?: string; back?: string; expected_version?: number }) =>
  client.put(`/api/cards/${cardId}`, data);
export const deleteCard = (cardId: number) => client.delete(`/api/cards/${cardId}`);

export const browseCards = (search: string = '', offset = 0) =>
  client.get<BrowseCard[]>('/api/cards/browse', { params: { search, offset, limit: 1000 } });

export const bulkActionCards = (
  actionOrPayload: BulkActionType | BulkActionRequest,
  cards?: BulkCardItem[]
) => {
  if (typeof actionOrPayload === 'string') {
    return client.post<BulkActionResult>('/api/cards/bulk-action', {
      action: actionOrPayload,
      cards: cards || [],
    });
  }
  return client.post<BulkActionResult>('/api/cards/bulk-action', actionOrPayload);
};
