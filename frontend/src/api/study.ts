import client from './client';

export const getNextCard = (deckId: number) => client.get(`/api/study/${deckId}`);
export const reviewCard = (cardId: number, rating: number) =>
  client.post(`/api/study/${cardId}/review`, { rating });
export const getStudyStats = (deckId: number) => client.get(`/api/study/${deckId}/stats`);
