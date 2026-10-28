import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import client from '../api/client';
import { startPackageImport } from '../api/decks';
vi.mock('../api/client', () => ({ default: { post: vi.fn(), put: vi.fn(), get: vi.fn(), delete: vi.fn() } }));
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const file = () => new File(['1234567890'], 'music.apkg');
const setup = () => {
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'upload', received: 0, chunk_bytes: 4 } });
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'job', status: 'queued' } });
};
it('uploads bounded slices before creating the import job', async () => {
  setup();
  vi.mocked(client.put).mockResolvedValueOnce({ data: { received: 4 } }).mockResolvedValueOnce({ data: { received: 8 } }).mockResolvedValueOnce({ data: { received: 10 } });
  const result = await startPackageImport(file(), false, false, 'error', 'newer', vi.fn());
  expect(result.data.id).toBe('job');
  expect(vi.mocked(client.put).mock.calls.map(call => (call[1] as Blob).size)).toEqual([4, 4, 2]);
  expect(vi.mocked(client.put).mock.calls.map(call => (call[2]?.params as { offset: number } | undefined)?.offset)).toEqual([0, 4, 8]);
  expect(client.post).toHaveBeenLastCalledWith('/api/apkg/uploads/upload/finish', {}, expect.anything());
  expect(client.delete).not.toHaveBeenCalled();
});
it('resumes from the acknowledged server offset when an upload response is lost', async () => {
  setup();
  vi.mocked(client.put).mockRejectedValueOnce({ response: { status: 502 } }).mockResolvedValueOnce({ data: { received: 8 } }).mockResolvedValueOnce({ data: { received: 10 } });
  vi.mocked(client.get).mockResolvedValueOnce({ data: { received: 4 } });
  await startPackageImport(file(), false, false, 'error', 'newer', vi.fn());
  expect(vi.mocked(client.put).mock.calls.map(call => (call[2]?.params as { offset: number } | undefined)?.offset)).toEqual([0, 4, 8]);
});
it('cleans up a rejected upload and never starts an import', async () => {
  setup();
  vi.mocked(client.put).mockRejectedValueOnce({ response: { status: 413 } });
  vi.mocked(client.delete).mockResolvedValue({ data: { status: 'cancelled' } });
  await expect(startPackageImport(file(), false, false, 'error', 'newer', vi.fn())).rejects.toEqual({ response: { status: 413 } });
  expect(client.delete).toHaveBeenCalledWith('/api/apkg/uploads/upload', { timeout: 15000 });
  expect(client.post).toHaveBeenCalledOnce();
});
it('explains when only the frontend has been updated', async () => {
  vi.mocked(client.post).mockRejectedValue({ response: { status: 404 } });
  await expect(startPackageImport(file(), false, false, 'error', 'newer', vi.fn())).rejects.toThrow('server needs an update');
});


it('reduces the next chunk after a slow successful request', async () => {
  const uploadFile = new File([new Uint8Array(512 * 1024)], 'slow.apkg', { lastModified: 1 });
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'upload', received: 0, chunk_bytes: 1024 ** 2, recommended_chunk_bytes: 256 * 1024 } });
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'job' } });
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.mocked(client.put).mockImplementation(async (_url, body, config) => {
    clock += 80000; // This request would have exceeded the previous 60s deadline.
    return { data: { received: ((config?.params as { offset: number } | undefined)?.offset || 0) + (body as Blob).size } };
  });
  await startPackageImport(uploadFile, false, false, 'error', 'newer', vi.fn());
  const calls = vi.mocked(client.put).mock.calls;
  expect((calls[0][1] as Blob).size).toBe(256 * 1024);
  expect((calls[1][1] as Blob).size).toBe(32 * 1024);
  expect(calls.every(call => call[2]?.timeout === 120000)).toBe(true);
});

it('shrinks a timed-out request before retrying the same offset', async () => {
  const uploadFile = new File([new Uint8Array(256 * 1024)], 'retry.apkg');
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'upload', received: 0, chunk_bytes: 1024 ** 2 } });
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'job' } });
  vi.mocked(client.get).mockResolvedValue({ data: { received: 0, status: 'uploading' } });
  vi.mocked(client.put).mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' });
  vi.mocked(client.put).mockImplementation(async (_url, body, config) => ({ data: { received: ((config?.params as { offset: number } | undefined)?.offset || 0) + (body as Blob).size } }));
  const status = vi.fn();
  await startPackageImport(uploadFile, false, false, 'error', 'newer', vi.fn(), undefined, status);
  const calls = vi.mocked(client.put).mock.calls;
  expect((calls[0][1] as Blob).size).toBe(256 * 1024);
  expect((calls[1][1] as Blob).size).toBe(128 * 1024);
  expect(status).toHaveBeenCalledWith('Connection interrupted. Retrying with smaller parts…');
});

it('keeps acknowledged data after a failed transfer and resumes when selected again', async () => {
  const nativeTimeout = setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => { args[1] = 0; return nativeTimeout(...args); }) as typeof setTimeout);
  const uploadFile = new File(['1234567890'], 'resume.apkg', { lastModified: 1 });
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'upload', received: 0, chunk_bytes: 4 } });
  vi.mocked(client.put).mockResolvedValueOnce({ data: { received: 4 } });
  vi.mocked(client.put).mockRejectedValue({ code: 'ECONNABORTED' });
  vi.mocked(client.get).mockResolvedValue({ data: { id: 'upload', received: 4, chunk_bytes: 4, status: 'uploading' } });
  const first = expect(startPackageImport(uploadFile, false, false, 'error', 'newer', vi.fn())).rejects.toThrow('Upload paused');
  await first;
  expect(client.delete).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('anki-package-upload:current')).toContain('upload');
  vi.mocked(client.put).mockResolvedValueOnce({ data: { received: 8 } }).mockResolvedValueOnce({ data: { received: 10 } });
  vi.mocked(client.post).mockResolvedValueOnce({ data: { id: 'job' } });
  const resumed = startPackageImport(uploadFile, false, false, 'error', 'newer', vi.fn());
  await resumed;
  expect(client.post).toHaveBeenCalledTimes(2); // One upload initialization, one finish.
  expect((vi.mocked(client.put).mock.calls.at(-2)?.[2]?.params as { offset: number } | undefined)?.offset).toBe(4);
  expect(sessionStorage.getItem('anki-package-upload:current')).toBeNull();
});
