import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DeckAudioPanel from '../components/DeckAudioPanel';
import * as ttsApi from '../api/tts';

vi.mock('../api/tts');

describe('DeckAudioPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays hidden when the server has no TTS key', async () => {
    const status = vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: false } } as any);
    const { container } = render(<DeckAudioPanel deckId={3} />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="deck-audio"]')).toBeNull();
  });

  it('starts a job and shows progress, then the summary', async () => {
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 0 } } as any);
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
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

  it('offers to switch Piper words to the Kokoro voice', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'idle' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 30 } } as any);
    const start = vi.spyOn(ttsApi, 'startDeckTts').mockResolvedValue({ data: { state: 'running', mode: 'upgrade', total: 30, done: 0 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    fireEvent.click(await screen.findByRole('button', { name: /switch to the kokoro voice \(30|đổi sang giọng kokoro \(30/i }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(9, 'upgrade'));
    expect(await screen.findByText(/0 \/ 30/)).toBeTruthy();
  });

  it('hides the switch when no word uses the Piper voice', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'idle' } } as any);
    const summary = vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 0 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    await screen.findByRole('button', { name: /generate audio|tạo âm thanh/i });
    await waitFor(() => expect(summary).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /kokoro/i })).toBeNull();
  });

  it('reports a stopped job as stopped, not done', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'stopped', mode: 'upgrade', total: 30, done: 4, added: 4, failed: 0 } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsSummary').mockResolvedValue({ data: { piper_words: 26 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    expect(await screen.findByText(/Stopped after 4 \/ 30|Đã dừng sau 4 \/ 30/)).toBeTruthy();
  });

  it('shows Stopping and blocks repeated clicks while a request finishes', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'running', mode: 'fill', total: 100, done: 10, added: 10, failed: 0 } } as any);
    const cancel = vi.spyOn(ttsApi, 'cancelDeckTts').mockResolvedValue({ data: { state: 'stopping', mode: 'fill', total: 100, done: 10 } } as any);
    render(<DeckAudioPanel deckId={9} />);
    fireEvent.click(await screen.findByRole('button', { name: /^stop$|^dừng$/i }));
    const stopping = await screen.findByRole('button', { name: /stopping|đang dừng/i });
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stopping);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the panel is closed, even mid-request', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
    let release: (value: any) => void = () => undefined;
    const jobs = vi.spyOn(ttsApi, 'getDeckTtsJob').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { unmount } = render(<DeckAudioPanel deckId={9} />);
    await waitFor(() => expect(jobs).toHaveBeenCalledTimes(1));
    unmount();
    release({ data: { state: 'running', mode: 'fill', total: 100, done: 10 } });
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it('shows the real job state when stopping fails', async () => {
    vi.spyOn(ttsApi, 'getTtsStatus').mockResolvedValue({ data: { enabled: true, engine: 'kokoro', voice: 'af_heart' } } as any);
    vi.spyOn(ttsApi, 'getDeckTtsJob').mockResolvedValue({ data: { state: 'running', mode: 'fill', total: 100, done: 10, added: 10, failed: 0 } } as any);
    vi.spyOn(ttsApi, 'cancelDeckTts').mockRejectedValue({ response: { data: { detail: 'Server busy' } } });
    render(<DeckAudioPanel deckId={9} />);
    fireEvent.click(await screen.findByRole('button', { name: /^stop$|^dừng$/i }));
    expect(await screen.findByText('Server busy')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^stop$|^dừng$/i })).toBeTruthy();
  });
});
