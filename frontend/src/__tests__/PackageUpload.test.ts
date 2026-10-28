import { beforeEach, expect, it, vi } from 'vitest';
import client from '../api/client';
import { startPackageImport } from '../api/decks';
vi.mock('../api/client', () => ({ default: { post: vi.fn(), put: vi.fn(), get: vi.fn(), delete: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
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
  expect(client.delete).toHaveBeenCalledWith('/api/apkg/uploads/upload', { timeout: 10000 });
  expect(client.post).toHaveBeenCalledOnce();
});
it('explains when only the frontend has been updated', async () => {
  vi.mocked(client.post).mockRejectedValue({ response: { status: 404 } });
  await expect(startPackageImport(file(), false, false, 'error', 'newer', vi.fn())).rejects.toThrow('updated backend');
});
