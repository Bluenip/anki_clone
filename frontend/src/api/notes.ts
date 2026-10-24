import client from './client';

export interface NoteType {
  id?: number;
  kind: string;
  name: string;
  fields: string[];
}

export interface NoteCard {
  id: number;
  deck_id: number;
  front: string;
  back: string;
  template_ord: number;
}

export interface Note {
  id: number | null;
  guid: string;
  kind: string;
  fields: Record<string, string>;
  tags: string[];
  css?: string;
  cards: NoteCard[];
  revision?: string;
  version?: number;
}

export interface CreateNotePayload {
  note_type_id?: number;
  deck_id: number;
  kind: string;
  fields: Record<string, string>;
  tags: string[];
}

export interface UpdateNotePayload {
  fields: Record<string, string>;
  tags: string[];
  expected_revision?: string;
}

export const getNoteTypes = () => client.get<NoteType[]>('/api/note-types');

export const createNote = (payload: CreateNotePayload) =>
  client.post<Note>('/api/notes', payload);

export const getNote = (id: number) =>
  client.get<Note>(`/api/notes/${id}`);

export const updateNote = (id: number, payload: UpdateNotePayload) =>
  client.put<Note>(`/api/notes/${id}`, payload);

export const getCardNote = (cardId: number) =>
  client.get<Note>(`/api/cards/${cardId}/note`);
