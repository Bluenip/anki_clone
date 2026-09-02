import client from './client';

export const listCards = (deckId: number, search?: string) =>
  client.get(`/api/decks/${deckId}/cards`, { params: { search } });
export const createCard = (deckId: number, front: string, back: string) =>
  client.post(`/api/decks/${deckId}/cards`, { front, back });
export const updateCard = (cardId: number, data: { front?: string; back?: string }) =>
  client.put(`/api/cards/${cardId}`, data);
export const deleteCard = (cardId: number) => client.delete(`/api/cards/${cardId}`);

export const browseCards = (search: string = '') =>
  client.get('/api/cards/browse', { params: { search } });
