import client from './client';

export interface TtsStatus {
  enabled: boolean;
  gemini?: boolean;
  piper?: boolean;
  model: string;
  voice: string;
}

export interface TtsJob {
  state: 'idle' | 'queued' | 'running' | 'waiting' | 'done' | 'stopped' | 'failed';
  mode?: 'fill' | 'upgrade';
  piper?: number;
  total?: number;
  done?: number;
  resume_at?: number | null;
  added?: number;
  skipped?: number;
  failed?: number;
  remaining?: number;
  error?: string;
}

export const getTtsStatus = () => client.get<TtsStatus>('/api/tts/status');
export const getDeckTtsJob = (deckId: number) => client.get<TtsJob>(`/api/decks/${deckId}/tts`);
export const startDeckTts = (deckId: number, mode: 'fill' | 'upgrade' = 'fill') =>
  client.post<TtsJob>(`/api/decks/${deckId}/tts`, null, { params: { mode } });
export const getDeckTtsSummary = (deckId: number) => client.get<{ piper_words: number }>(`/api/decks/${deckId}/tts/summary`);
export const cancelDeckTts = (deckId: number) => client.post<TtsJob>(`/api/decks/${deckId}/tts/cancel`);
