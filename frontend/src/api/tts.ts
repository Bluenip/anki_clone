import client from './client';

export interface TtsStatus {
  enabled: boolean;
  engine?: string;
  voice?: string;
}

export interface TtsJob {
  state: 'idle' | 'queued' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed';
  mode?: 'fill' | 'upgrade' | 'fix';
  total?: number;
  done?: number;
  added?: number;
  skipped?: number;
  failed?: number;
  remaining?: number;
  error?: string;
}

export const getTtsStatus = () => client.get<TtsStatus>('/api/tts/status');
export const getDeckTtsJob = (deckId: number) => client.get<TtsJob>(`/api/decks/${deckId}/tts`);
export const startDeckTts = (deckId: number, mode: 'fill' | 'upgrade' | 'fix' = 'fill') =>
  client.post<TtsJob>(`/api/decks/${deckId}/tts`, null, { params: { mode } });
export const getDeckTtsSummary = (deckId: number) => client.get<{ piper_words: number; stale_notes?: number }>(`/api/decks/${deckId}/tts/summary`);
export const cancelDeckTts = (deckId: number) => client.post<TtsJob>(`/api/decks/${deckId}/tts/cancel`);
