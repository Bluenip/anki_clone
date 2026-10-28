import client from './client';
import type { PackageImportJob } from './decks';

interface Upload {
  id: string; received: number; size: number; chunk_bytes: number;
  recommended_chunk_bytes?: number; status?: string; job_id?: string;
}
type Failure = { response?: { status?: number; data?: { detail?: string } }; code?: string; name?: string };
const amount = (bytes: number) => bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const failure = (error: unknown) => error as Failure;
const retryable = (error: unknown) => !failure(error).response?.status ||
  [408, 409, 429, 500, 502, 503, 504, 520, 522, 524].includes(failure(error).response?.status || 0);
const cancelled = (error: unknown, signal?: AbortSignal) => signal?.aborted ||
  failure(error).code === 'ERR_CANCELED' || failure(error).name === 'AbortError';
const storageKey = () => {
  try {
    const payload = localStorage.getItem('token')?.split('.')[1];
    return 'anki-package-upload:' + (payload ? JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub : 'current');
  } catch { return 'anki-package-upload:current'; }
};
const forget = () => { try { sessionStorage.removeItem(storageKey()); } catch { /* Storage may be disabled. */ } };
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
  const aborted = () => { clearTimeout(timer); reject(new DOMException('Upload cancelled', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
  signal?.addEventListener('abort', aborted, { once: true });
});
const readSample = (blob: Blob) => new Promise<ArrayBuffer>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as ArrayBuffer);
  reader.onerror = () => reject(new Error('Could not read this file. Select it again.'));
  reader.readAsArrayBuffer(blob);
});
async function identity(file: File, options: object) {
  // Check both ends as well as metadata before appending to a saved upload.
  const samples = await Promise.all([readSample(file.slice(0, 65536)), readSample(file.slice(Math.max(0, file.size - 65536)))]);
  let hash = 2166136261;
  for (const sample of samples) for (const byte of new Uint8Array(sample)) hash = Math.imul(hash ^ byte, 16777619);
  return JSON.stringify([file.name, file.size, file.lastModified, hash >>> 0, options]);
}
export async function discardPackageUpload() {
  let id: string | undefined;
  try { id = JSON.parse(sessionStorage.getItem(storageKey()) || 'null')?.id; } catch { /* No saved upload. */ }
  forget();
  if (id) await client.delete(`/api/apkg/uploads/${id}`, { timeout: 15000 }).catch(() => {});
}

export async function startPackageImport(file: File, includeScheduling: boolean, collectionRestore: boolean,
  mediaConflicts: 'error' | 'rename', duplicatePolicy: 'newer' | 'skip' | 'update' | 'add',
  onProgress: (percent: number) => void, signal?: AbortSignal, onStatus: (text: string) => void = () => {}) {
  let id: string | undefined;
  const options = { filename: file.name, size: file.size, include_scheduling: includeScheduling,
    collection_restore: collectionRestore, media_conflicts: mediaConflicts, duplicate_policy: duplicatePolicy, sanitize_svg: true };
  const retry = async <T,>(action: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); } catch (error) {
        if (cancelled(error, signal) || !retryable(error) || attempt >= 4) throw error;
        onStatus('Connection interrupted. Reconnecting…');
        await pause(Math.min(4000, 500 * 2 ** attempt), signal);
      }
    }
  };
  try {
    onStatus('Preparing upload…');
    const fingerprint = await identity(file, options);
    let saved: { id: string; fingerprint: string } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); } catch { /* No usable saved state. */ }
    let state: Upload | undefined;
    if (saved?.fingerprint === fingerprint) {
      id = saved.id;
      try {
        state = (await retry(() => client.get<Upload>(`/api/apkg/uploads/${id}`, { signal, timeout: 30000 }))).data;
        if (state.status === 'submitted' && state.job_id) {
          const job = await retry(() => client.get<PackageImportJob>(`/api/apkg/jobs/${state!.job_id}`, { signal, timeout: 30000 }));
          forget(); return job;
        }
        if (state.status && state.status !== 'uploading') { state = undefined; id = undefined; forget(); }
      } catch (error) {
        if ([404, 410].includes(failure(error).response?.status || 0)) { id = undefined; forget(); }
        else throw error;
      }
    } else if (saved) await discardPackageUpload();
    if (!state) {
      const response = await retry(() => client.post<Upload>('/api/apkg/uploads', options, { signal, timeout: 30000 }));
      state = response.data; id = state.id;
      try { sessionStorage.setItem(storageKey(), JSON.stringify({ id, fingerprint })); } catch { /* Upload still works without storage. */ }
    }
    let offset = state.received;
    const maxChunk = Math.min(state.chunk_bytes, 8 * 1024 ** 2);
    if (!Number.isInteger(maxChunk) || maxChunk <= 0 || !Number.isInteger(offset) || offset < 0 || offset > file.size) throw new Error('Invalid upload state. Select the file again.');
    const minChunk = Math.min(32 * 1024, maxChunk);
    let chunkBytes = Math.min(maxChunk, state.recommended_chunk_bytes || 256 * 1024);
    let failures = 0;
    onProgress(Math.round(offset * 100 / file.size));
    while (offset < file.size) {
      const end = Math.min(offset + chunkBytes, file.size);
      const started = performance.now();
      onStatus(offset ? 'Uploading — continuing from the last saved part…' : 'Uploading…');
      try {
        const response = await client.put<Upload>(`/api/apkg/uploads/${id}`, file.slice(offset, end), {
          params: { offset }, signal, timeout: 120000,
          headers: { 'Content-Type': 'application/octet-stream' },
          onUploadProgress: event => {
            onProgress(Math.min(100, Math.round((offset + event.loaded) * 1000 / file.size) / 10));
            onStatus(`Sending ${amount(offset + event.loaded)} of ${amount(file.size)}…`);
          },
        });
        if (response.data.received !== end) throw new Error('Unexpected upload offset. Please select the same file to resume.');
        offset = end; failures = 0;
        const elapsed = Math.max(1, performance.now() - started);
        // Aim for ten seconds per request. Increase gradually on fast links.
        chunkBytes = Math.max(minChunk, Math.min(maxChunk, Math.floor(chunkBytes * Math.min(1.5, 10000 / elapsed))));
        onProgress(Math.round(offset * 100 / file.size));
      } catch (error) {
        const canShrink = chunkBytes > minChunk;
        if (cancelled(error, signal) || (!retryable(error) && !(failure(error).response?.status === 413 && canShrink)) || ++failures > 5) throw error;
        chunkBytes = Math.max(minChunk, Math.floor(chunkBytes / 2));
        onStatus('Connection interrupted. Retrying with smaller parts…');
        await pause(Math.min(4000, 500 * failures), signal);
        const current = (await retry(() => client.get<Upload>(`/api/apkg/uploads/${id}`, { signal, timeout: 30000 }))).data;
        if (current.status && current.status !== 'uploading') throw new Error('This upload expired. Select the file again.');
        if (!Number.isInteger(current.received) || current.received < offset || current.received > end) throw new Error('Invalid saved upload offset.');
        if (current.received > offset) failures = 0;
        offset = current.received;
        onProgress(Math.round(offset * 100 / file.size));
      }
    }
    onStatus('Upload complete. Preparing preview…');
    // Finish is idempotent: a lost response must not create a second import.
    const result = await retry(() => client.post<PackageImportJob>(`/api/apkg/uploads/${id}/finish`, {}, { signal, timeout: 30000 }));
    forget(); return result;
  } catch (error) {
    if (cancelled(error, signal)) { await discardPackageUpload(); throw error; }
    const status = failure(error).response?.status;
    if (retryable(error) || !status) {
      const paused = new Error('Upload paused because the connection was interrupted. Choose Resume upload, or select the same file again to continue from the saved part.');
      paused.name = 'PackageUploadPaused';
      throw paused;
    }
    if (id) await discardPackageUpload();
    if (status === 404 || status === 405) throw new Error('The server needs an update for package uploads. Reload this page after the update finishes.');
    throw error;
  }
}
