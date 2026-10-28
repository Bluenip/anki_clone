import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', '');
  vi.stubEnv('VITE_PACKAGE_API_URL', 'https://upload.example');
  localStorage.clear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const response = (config: InternalAxiosRequestConfig) => Promise.resolve({
  config, data: {}, status: 200, statusText: 'OK', headers: new AxiosHeaders(),
});

it('uses the relay only for package jobs/uploads/limits, with the existing bearer token', async () => {
  const { default: client } = await import('../api/client');
  localStorage.setItem('token', 'test-token');
  const adapter = vi.fn(response);
  client.defaults.adapter = adapter;
  for (const url of ['/api/apkg/jobs', '/api/apkg/uploads/id', '/api/apkg/limits', '/api/decks', '/api/apkg/export/1']) {
    await client.get(url);
  }
  expect(adapter.mock.calls.map(([config]) => config.baseURL)).toEqual([
    'https://upload.example', 'https://upload.example', 'https://upload.example', '', '',
  ]);
  expect(adapter.mock.calls[0][0].headers.Authorization).toBe('Bearer test-token');
});

it('falls back for the existing resumable retry without replaying a failed mutation', async () => {
  const { default: client } = await import('../api/client');
  const adapter = vi.fn(response).mockImplementationOnce(config =>
    Promise.reject(new AxiosError('Network error', 'ERR_NETWORK', config)));
  client.defaults.adapter = adapter;
  await expect(client.put('/api/apkg/uploads/id', 'chunk')).rejects.toThrow('Network error');
  expect(adapter).toHaveBeenCalledOnce();
  await client.get('/api/apkg/uploads/id');
  expect(adapter.mock.calls[1][0].baseURL).toBe('');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  await client.get('/api/apkg/uploads/id');
  expect(adapter.mock.calls[2][0].baseURL).toBe('https://upload.example');
});

it('keeps the relay after user cancellation or a permanent backend rejection', async () => {
  const { default: client } = await import('../api/client');
  const adapter = vi.fn(response)
    .mockImplementationOnce(config => Promise.reject(new CanceledError('cancelled', config)))
    .mockImplementationOnce(config => Promise.reject(new AxiosError('Not found', 'ERR_BAD_REQUEST', config,
      undefined, { config, status: 404, statusText: 'Not found', headers: new AxiosHeaders(), data: {} })));
  client.defaults.adapter = adapter;
  await expect(client.put('/api/apkg/uploads/id', 'chunk')).rejects.toThrow('cancelled');
  await expect(client.get('/api/apkg/jobs/id')).rejects.toThrow('Not found');
  await client.get('/api/apkg/jobs');
  expect(adapter.mock.calls.map(([config]) => config.baseURL)).toEqual(Array(3).fill('https://upload.example'));
});

it('keeps all calls on the original API when no relay is configured', async () => {
  vi.stubEnv('VITE_PACKAGE_API_URL', '');
  const { default: client } = await import('../api/client');
  const adapter = vi.fn(response);
  client.defaults.adapter = adapter;
  await client.get('/api/apkg/jobs');
  expect(adapter.mock.calls[0][0].baseURL).toBe('');
});
