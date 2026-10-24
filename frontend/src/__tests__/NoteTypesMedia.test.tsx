import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import client from '../api/client';
import NoteTypesPage from '../pages/NoteTypesPage';
import MediaTools from '../components/MediaTools';
import CardFace from '../components/CardFace';
vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const model = { id: 1, revision: 'a'.repeat(64), name: 'Custom', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}' }], css: '' };
beforeEach(() => { vi.resetAllMocks(); });

describe('note types and media', () => {
  it('sends revision and keeps the draft on conflict', async () => {
    vi.mocked(client.get).mockResolvedValue({ data: [model] });
    vi.mocked(client.put).mockRejectedValue({ response: { data: { detail: 'Note type changed; reload before saving' } } });
    render(<MemoryRouter><NoteTypesPage /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Custom' });
    fireEvent.change(screen.getByLabelText('Note type'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local draft' } });
    fireEvent.click(screen.getByText('Save note type'));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Local draft');
    expect(client.put).toHaveBeenCalledWith('/api/models/1', expect.objectContaining({ name: 'Local draft', expected_revision: model.revision }));
  });
  it('uploads portable markup and ignores a response after unmount', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(client.post).mockReturnValue(new Promise(r => { resolve = r; }) as never);
    const insert = vi.fn();
    const view = render(<MediaTools onInsert={insert} />);
    fireEvent.change(screen.getByLabelText('Attach image/audio'), { target: { files: [new File(['image'], 'a.png', { type: 'image/png' })] } });
    expect(client.post).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => resolve({ data: { markup: '<img src="hash.png">' } }));
    expect(insert).not.toHaveBeenCalled();
  });
  it('inserts upload response into the current draft', async () => {
    vi.mocked(client.post).mockResolvedValue({ data: { markup: '[sound:hash.ogg]' } });
    const insert = vi.fn(); render(<MediaTools onInsert={insert} />);
    fireEvent.change(screen.getByLabelText('Attach image/audio'), { target: { files: [new File(['audio'], 'a.ogg')] } });
    await waitFor(() => expect(insert).toHaveBeenCalledWith('[sound:hash.ogg]'));
  });
  it('compares a typed answer only after reveal and supports Enter', () => {
    const front = '<span data-type-field="Back" data-type-answer="Élite" data-type-options="type,nc,ci"></span>';
    const reveal = vi.fn();
    const view = render(<CardFace html={front} frontHtml={front} backHtml={front} onRevealAnswer={reveal} />);
    const input = screen.getByLabelText('Type answer (Back)');
    fireEvent.change(input, { target: { value: 'elite' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Correct answer: Élite')).toBeNull();
    view.rerender(<CardFace html={front} frontHtml={front} backHtml={front} showAnswer />);
    expect(screen.getByText('Correct answer: Élite')).toBeDefined();
    expect(screen.getByText('Match')).toBeDefined();
  });
});

it('optimizer only updates draft weights after explicit Use', async () => {
  const { default: FsrsOptimizer } = await import('../components/FsrsOptimizer');
  const weights = Array.from({ length: 21 }, () => 1);
  vi.mocked(client.post).mockResolvedValue({ data: { parameters: weights, training_samples: 400, history_entries: 800 } });
  const use = vi.fn();
  render(<FsrsOptimizer deckId={3} onUse={use} />);
  fireEvent.click(screen.getByText('Optimize FSRS parameters'));
  await screen.findByText('Use optimized parameters');
  expect(use).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Use optimized parameters'));
  expect(use).toHaveBeenCalledWith(weights);
  expect(client.post).toHaveBeenCalledTimes(1);
});

it('releases microphone tracks when recording fails', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const stop = vi.fn();
  const instances: Recorder[] = [];
  class Recorder {
    state = 'inactive'; mimeType = 'audio/webm'; onerror?: () => void; onstop?: () => void;
    stream = { getTracks: () => [{ stop }] };
    constructor() { instances.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) } });
  try {
    render(<MediaTools onInsert={vi.fn()} />);
    fireEvent.click(screen.getByText('Record audio'));
    await screen.findByText('Stop recording and attach');
    act(() => instances[0].onerror?.());
    await screen.findByText('Recording failed. Please try again.');
    expect(stop).toHaveBeenCalled();
    expect((screen.getByText('Record audio') as HTMLButtonElement).disabled).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});
