import client from './client';

export const getCategories = () => client.get('/api/shared/categories');
export const browseSharedDecks = (search?: string, category?: string) =>
  client.get('/api/shared/decks', { params: { search, category } });
export const getSharedDeck = (id: number) => client.get(`/api/shared/decks/${id}`);
export const shareDeck = (deckId: number, data: { title: string; description?: string; category: string }) =>
  client.post(`/api/shared/decks/${deckId}/share`, data);
export const downloadSharedDeck = (sharedId: number) =>
  client.post(`/api/shared/decks/${sharedId}/download`);
export const rateSharedDeck = (sharedId: number, rating: number) =>
  client.post(`/api/shared/decks/${sharedId}/rate`, { rating });
