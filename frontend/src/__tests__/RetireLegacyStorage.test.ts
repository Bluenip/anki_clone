import { afterEach, expect, it, vi } from 'vitest';
import { retireLegacyStorage } from '../utils/retireLegacyStorage';
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it('retires only this application worker and storage, preserving login and unrelated caches', async () => {
  const unregister = vi.fn().mockResolvedValue(true), other = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [
    { active: { scriptURL: `${location.origin}/sw.js` }, unregister },
    { active: { scriptURL: `${location.origin}/another-app/sw.js` }, unregister: other },
  ] } });
  const remove = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('caches', { keys: async () => ['anki-shell-123', 'anki-media-7', 'unrelated'], delete: remove });
  const request: { onsuccess?: () => void } = {};
  const deleteDatabase = vi.fn(() => { setTimeout(() => request.onsuccess?.(), 0); return request; });
  vi.stubGlobal('indexedDB', { deleteDatabase });
  localStorage.setItem('token', 'keep-login'); localStorage.setItem('offline-user', 'old');
  await retireLegacyStorage();
  expect(unregister).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
  expect(remove.mock.calls.map(args => args[0])).toEqual(['anki-shell-123', 'anki-media-7']);
  expect(deleteDatabase).toHaveBeenCalledWith('anki-offline-v1');
  expect(localStorage.getItem('token')).toBe('keep-login');
  expect(localStorage.getItem('offline-user')).toBeNull();
});
it('does not prevent online startup if worker or cache access is denied', async () => {
  vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => { throw Error('denied'); } } });
  vi.stubGlobal('caches', { keys: async () => { throw Error('denied'); } });
  vi.stubGlobal('indexedDB', { deleteDatabase: () => { throw Error('denied'); } });
  await expect(retireLegacyStorage()).resolves.toBeUndefined();
});
