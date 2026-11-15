import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DeckAudioPanel from '../components/DeckAudioPanel';
import * as ttsApi from '../api/tts';

vi.mock('../api/tts');

describe('DeckAudioPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays hidden when the server has no TTS key', async () => {
    const status = vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: false, model: '', voice: '' } } as any);
    const { container } = render(<DeckAudioPanel deckId={3} />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="deck-audio"]')).toBeNull();
  });

  it('starts a job and shows progress, then the summary', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, model: 'm', voice: 'v' } } as any);
    const jobs = vi.spyOn(ttsApi, 'getDeckTtsJob')
      .mockResolvedValueOnce({ data: { state: 'idle' } } as any)
      .mockResolvedValue({ data: { state: "done", total: 44, done: 44, added: 40, skipped: 4, failed: 0, remaining: 0 } } as any);
    const start = vi.spyOn(ttsApi, 'startDeckTts').mockResolvedValue(
      { data: { state: "running", total: 44, done: 11, added: 10, skipped: 1, failed: 0, remaining: 33 } } as any);

    render(<DeckAudioPanel deckId={3} />);
    fireEvent.click(await screen.findByRole('button', { name: /generate audio|tạo âm thanh/i }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(3));
    expect(await screen.findByText(/11 \/ 44/)).toBeTruthy();
    await waitFor(() => expect(jobs.mock.calls.length).toBeGreaterThan(1), { timeout: 3000 });
    expect(await screen.findByText(/40/)).toBeTruthy();
  });
});
