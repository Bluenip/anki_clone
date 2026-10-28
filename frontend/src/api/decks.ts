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

export interface PackageImportResult {
  cards_imported: number; cards_updated: number; cards_skipped: number;
  notes_in_package: number; cards_in_package: number;
  media_imported: number; media_bytes: number; deck_name: string; warnings: string[];
}
export interface PackageImportJob {
  id: string; status: string; completed: number; total: number;
  result: PackageImportResult | null; detail?: string; cancel_requested?: boolean;
}
interface PackageUpload { id: string; received: number; size: number; chunk_bytes: number }
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
  const aborted = () => { clearTimeout(timer); reject(new DOMException('Upload cancelled', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
  signal?.addEventListener('abort', aborted, { once: true });
});
export const startPackageImport = async (file: File, includeScheduling: boolean, collectionRestore: boolean,
  mediaConflicts: 'error' | 'rename', duplicatePolicy: 'newer' | 'skip' | 'update' | 'add',
  onProgress: (percent: number) => void, signal?: AbortSignal) => {
  let id: string | undefined;
  let submitted = false;
  try {
    const created = await client.post<PackageUpload>('/api/apkg/uploads', {
      filename: file.name, size: file.size, include_scheduling: includeScheduling,
      collection_restore: collectionRestore, media_conflicts: mediaConflicts,
      duplicate_policy: duplicatePolicy, sanitize_svg: true,
    }, { signal, timeout: 30000 });
    id = created.data.id;
    let offset = created.data.received;
    const chunkBytes = Math.min(created.data.chunk_bytes, 8 * 1024 ** 2);
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Server returned an invalid upload chunk size.');
    let failures = 0;
    while (offset < file.size) {
      const end = Math.min(offset + chunkBytes, file.size);
      try {
        const response = await client.put<PackageUpload>(`/api/apkg/uploads/${id}`, file.slice(offset, end), {
          params: { offset }, signal, timeout: 60000,
          headers: { 'Content-Type': 'application/octet-stream' },
          onUploadProgress: e => onProgress(Math.min(100, Math.round((offset + e.loaded) * 100 / file.size))),
        });
        if (response.data.received !== end) throw new Error('Server returned an unexpected upload offset.');
        offset = response.data.received;
        failures = 0;
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } }).response?.status;
        const retryable = !status || [408, 409, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
        if (signal?.aborted || !retryable || ++failures > 3) throw error;
        await pause(500 * failures, signal);
        const state = await client.get<PackageUpload>(`/api/apkg/uploads/${id}`, { signal, timeout: 30000 });
        offset = state.data.received;
        onProgress(Math.round(offset * 100 / file.size));
      }
    }
    const result = await client.post<PackageImportJob>(`/api/apkg/uploads/${id}/finish`, {}, { signal, timeout: 30000 });
    submitted = true;
    return result;
  } catch (error: unknown) {
    const data = error as { response?: { status?: number; data?: { detail?: string } }; message?: string };
    if (data.response?.status === 404 || data.response?.status === 405) {
      throw new Error('This server needs the updated backend for chunked uploads. Redeploy the backend and reload this page.');
    }
    if ([502, 503, 504, 520, 522, 524].includes(data.response?.status || 0)) {
      throw new Error(`The upload proxy returned HTTP ${data.response?.status}. Please retry after checking the server connection.`);
    }
    throw error;
  } finally {
    if (id && !submitted) {
      await client.delete(`/api/apkg/uploads/${id}`, { timeout: 10000 }).catch(() => {});
    }
  }
};
export const getPackageImport = (id: string) => client.get<PackageImportJob>(`/api/apkg/jobs/${id}`);
export const confirmPackageImport = (id: string) => client.post<PackageImportJob>(`/api/apkg/jobs/${id}/confirm`);
export const cancelPackageImport = (id: string) => client.post<PackageImportJob>(`/api/apkg/jobs/${id}/cancel`);
