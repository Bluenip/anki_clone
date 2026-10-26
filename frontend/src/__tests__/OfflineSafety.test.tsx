import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { sanitizeHtml } from '../utils/sanitize';
import OfflinePage from '../pages/OfflinePage';
import { localAccount, changeLocal, synchronize } from '../utils/offline';
import type { LocalAccount } from '../utils/offline';

vi.mock('../context/useAuth', () => ({ useAuth: () => ({ user: { id: 7 } }) }));
vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('Offline')) } }));
vi.mock('../utils/offline', () => ({ localAccount: vi.fn(), changeLocal: vi.fn(), synchronize: vi.fn(), downloadDeck: vi.fn() }));
vi.mock('../components/CardFace', () => ({ default: () => <div>Saved card</div> }));
vi.mock('../components/OfflineCardFace', () => ({ default: () => <div>Downloaded card</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const queued = (): LocalAccount => ({ decks: [], answers: [{ request_id: 'unique-request-123', card_id: 9, expected_version: 0, settings_hash: 'a'.repeat(64), rating: 3, duration_ms: 1000, reviewed_at: new Date().toISOString(), question: 'Old question', conflict: 'A newer review exists' }] });

describe('Offline review safety', () => {
  it('keeps pending answers visible when synchronization fails', async () => {
    vi.mocked(localAccount).mockResolvedValue(queued());
    vi.mocked(synchronize).mockRejectedValue(new Error('Network unavailable'));
    render(<OfflinePage />);
    await screen.findByText(/1 pending answers/);
    fireEvent.click(screen.getByText('Sync now'));
    await screen.findByRole('alert');
    expect(screen.getByText(/1 pending answers/)).toBeDefined();
    expect(changeLocal).not.toHaveBeenCalled();
  });

  it('only discards a conflicting local answer after explicit confirmation', async () => {
    const saved = queued(); vi.mocked(localAccount).mockResolvedValue(saved);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<OfflinePage />);
    const button = await screen.findByText('Keep server version and discard local answers');
    fireEvent.click(button); expect(changeLocal).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    vi.mocked(changeLocal).mockImplementation(async (_uid, apply) => { const result = apply(saved); expect(result.answers).toHaveLength(0); });
    fireEvent.click(button);
    await waitFor(() => expect(changeLocal).toHaveBeenCalledTimes(1));
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('allows only same-origin media blobs while retaining script and link sanitization', () => {
    const local = `blob:${window.location.origin}/local-media`;
    expect(sanitizeHtml(`<img src="${local}" onerror="alert(1)">`)).toContain(`src="${local}"`);
    expect(sanitizeHtml(`<img src="${local}" onerror="alert(1)">`)).not.toContain('onerror');
    expect(sanitizeHtml('<img src="blob:https://foreign.example/uuid">')).not.toContain('src=');
    expect(sanitizeHtml(`<a href="${local}">link</a>`)).not.toContain('href=');
    expect(sanitizeHtml('<img src="javascript:alert(1)"><script>alert(1)</script>')).not.toContain('javascript:');
  });
});
