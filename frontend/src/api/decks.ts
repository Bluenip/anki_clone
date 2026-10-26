import client from './client';
export type { Deck, DeckSummary } from './types';

export const listDecks = () => client.get('/api/decks');
export const getTodaySummary = () => client.get<{ reviews: number; seconds: number; seconds_per_card: number }>('/api/study/summary/today');
export const createDeck = (name: string, description: string) =>
  client.post('/api/decks', { name, description });
export const getDeck = (id: number) => client.get(`/api/decks/${id}`);
export const updateDeck = (id: number, data: { name?: string; description?: string; settings?: string }) =>
  client.put(`/api/decks/${id}`, data);
export const deleteDeck = (id: number) => client.delete(`/api/decks/${id}`);

export interface TextImportOptions {
  preview?: boolean;
  duplicate_policy?: 'add' | 'skip' | 'update';
  match_scope?: 'deck' | 'collection';
  match_fields?: 'first' | 'all';
  has_header?: boolean;
  allow_html?: boolean;
  front_column?: number;
  back_column?: number;
  kind?: string;
  note_type_id?: number;
  field_columns?: Record<string, number>;
  tags_column?: number;
  guid_column?: number;
  tags?: string[];
  use_file_decks?: boolean;
}
export const importCards = (id: number, text: string, separator: string = '\t', options: TextImportOptions = {}) =>
  client.post(`/api/decks/${id}/import`, { text, separator, ...options });
export const exportText = (deckId: number, format: 'csv' | 'txt' | 'tsv') =>
  client.get(`/api/decks/${deckId}/export/text`, { params: { format }, responseType: 'blob' });

// Import .apkg file
export const importApkg = async (file: File, includeScheduling = false, collectionRestore = false, mediaConflicts: 'error' | 'rename' = 'error', duplicatePolicy: 'newer' | 'skip' | 'update' | 'add' = 'newer') => {
  const formData = new FormData();
  formData.append('file', file);
  return client.post('/api/apkg/import', formData, {
    params: { include_scheduling: includeScheduling, collection_restore: collectionRestore, media_conflicts: mediaConflicts, duplicate_policy: duplicatePolicy },
    headers: { 'Content-Type': 'multipart/form-data' }
  });
};

// Export deck as .apkg
export const exportApkg = async (deckId: number, includeScheduling = false, modern = false) => {
  const response = await client.get(
    `/api/apkg/export/${deckId}?include_scheduling=${includeScheduling}&modern=${modern}`,
    { responseType: 'blob' }
  );
  return response;
};

export const exportCollection = () => client.get('/api/apkg/export-collection', { responseType: 'blob' });

export const getImportNoteTypes = () => client.get<{ id: number; name: string; fields: string[] }[]>('/api/note-types/available');
