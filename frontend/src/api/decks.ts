import client from './client';

export const listDecks = () => client.get('/api/decks');
export const createDeck = (name: string, description: string) =>
  client.post('/api/decks', { name, description });
export const getDeck = (id: number) => client.get(`/api/decks/${id}`);
export const updateDeck = (id: number, data: { name?: string; description?: string; settings?: string }) =>
  client.put(`/api/decks/${id}`, data);
export const deleteDeck = (id: number) => client.delete(`/api/decks/${id}`);

export const importCards = (id: number, text: string, separator: string = '\t') => 
  client.post(`/api/decks/${id}/import`, { text, separator });
