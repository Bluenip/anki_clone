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
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 0 } } as any);
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, model: 'm', voice: 'v' } } as any);
    const jobs = vi.spyOn(ttsApi, 'getDeckTtsJob')
      .mockResolvedValueOnce({ data: { state: 'idle' } } as any)
      .mockResolvedValue({ data: { state: "done", total: 44, done: 44, added: 40, skipped: 4, failed: 0, remaining: 0 } } as any);
    const start = vi.spyOn(ttsApi, 'startDeckTts').mockResolvedValue(
      { data: { state: "running", total: 44, done: 11, added: 10, skipped: 1, failed: 0, remaining: 33 } } as any);

    render(<DeckAudioPanel deckId={3} />);
    fireEvent.click(await screen.findByRole('button', { name: /generate audio|tạo âm thanh/i }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(3, 'fill'));
    expect(await screen.findByText(/11 \/ 44/)).toBeTruthy();
    await waitFor(() => expect(jobs.mock.calls.length).toBeGreaterThan(1), { timeout: 3000 });
    expect(await screen.findByText(/40/)).toBeTruthy();
  });

  it('offers an upgrade to Gemini when some words use the Piper voice', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, gemini: true, piper: true, model: 'm', voice: 'v' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'done', mode: 'fill', piper: 30, total: 50, done: 50, added: 50, skipped: 0, failed: 0 } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 30 } } as any);
    const start = vi.spyOn(ttsApi, 'startDeckTts').mockResolvedValue({ data: { state: 'running', mode: 'upgrade', total: 30, done: 0 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    expect(await screen.findByText(/30 with the Piper voice|30 từ dùng giọng Piper/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /upgrade to gemini|nâng cấp lên gemini/i }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(9, 'upgrade'));
    expect(await screen.findByText(/0 \/ 30/)).toBeTruthy();
  });

  it('hides the upgrade when the server has no Gemini key', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, gemini: false, piper: true, model: 'm', voice: 'v' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'idle' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 12 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    await screen.findByRole('button', { name: /generate audio|tạo âm thanh/i });
    expect(screen.queryByRole('button', { name: /upgrade to gemini|nâng cấp lên gemini/i })).toBeNull();
  });

  it('reports a stopped job as stopped, not done', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, gemini: true, piper: true, model: 'm', voice: 'v' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'stopped', mode: 'upgrade', total: 30, done: 4, added: 4, failed: 0 } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 26 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    expect(await screen.findByText(/Stopped after 4 \/ 30|Đã dừng sau 4 \/ 30/)).toBeTruthy();
  });
});
