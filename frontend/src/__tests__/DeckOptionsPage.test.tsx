import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DeckOptionsPage from '../pages/DeckOptionsPage';
import * as decksApi from '../api/decks';
import * as optionsApi from '../api/options';
import type { Deck } from '../api/types';

vi.mock('../api/decks');
vi.mock('../api/options');
const legacyOptions = { preset_id: null, preset_name: null, preset_version: null, preset_settings: null, settings: '{}', overrides: {}, today: {}, presets: [] };
beforeEach(() => {
  vi.mocked(optionsApi.getDeckOptions).mockResolvedValue({ data: legacyOptions } as never);
});

const createMockDeck = (overrides?: Partial<Deck>): Deck => ({
  id: 1,
  name: 'Japanese N5',
  description: 'Vocabulary deck',
  settings: JSON.stringify({
    new_cards_per_day: 20,
    maximum_reviews_per_day: 200,
    learning_steps: '1m 10m',
    custom_backend_setting: 'do_not_erase_me',
    future_flag: 42,
    fsrs: false,
  }),
  is_shared: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  total_cards: 100,
  new_cards: 20,
  learn_cards: 10,
  due_cards: 30,
  ...overrides,
});

const renderDeckOptionsPage = (deckId = '1') => {
  return render(
    <MemoryRouter initialEntries={[`/decks/${deckId}/options`]}>
      <Routes>
        <Route path="/decks/:deckId/options" element={<DeckOptionsPage />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('DeckOptionsPage Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables fuzz only with FSRS and preserves it when saving', async () => {
    vi.mocked(decksApi.getDeck).mockResolvedValue({ data: createMockDeck() } as never);
    vi.mocked(optionsApi.saveDeckOptions).mockResolvedValue({ data: legacyOptions } as never);
    renderDeckOptionsPage();
    const fuzz = await screen.findByRole('switch', { name: 'Spread future review dates (fuzz)' });
    expect((fuzz as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'FSRS' }));
    expect((fuzz as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(fuzz);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(optionsApi.saveDeckOptions).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(vi.mocked(optionsApi.saveDeckOptions).mock.calls[0][1]);
    expect(saved.fsrs_fuzz).toBe(true);
    expect(saved.fsrs).toBe(true);
    expect(saved.custom_backend_setting).toBe('do_not_erase_me');
  });

  it('rejects a saved fuzz setting with the wrong type', async () => {
    vi.mocked(decksApi.getDeck).mockResolvedValue({ data: createMockDeck({ settings: '{"fsrs_fuzz":"true"}' }) } as never);
    renderDeckOptionsPage();
    await screen.findByText('Failed to load deck options');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(optionsApi.saveDeckOptions).not.toHaveBeenCalled();
  });

  it('keeps Today-only limits out of the base settings saved by the main form', async () => {
    vi.mocked(decksApi.getDeck).mockResolvedValue({ data:createMockDeck({settings:'{"new_cards_per_day":0}'}) } as never);
    vi.mocked(optionsApi.getDeckOptions).mockResolvedValue({data:{...legacyOptions,preset_settings:'{"new_cards_per_day":20}',settings:'{"new_cards_per_day":0}',today:{day:'today',limits:{new_cards_per_day:0}}}} as never);
    vi.mocked(optionsApi.saveDeckOptions).mockResolvedValue({data:legacyOptions} as never);
    renderDeckOptionsPage();
    const input=await screen.findByLabelText('New cards/day') as HTMLInputElement;
    expect(input.value).toBe('20');
    fireEvent.click(screen.getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(optionsApi.saveDeckOptions).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(optionsApi.saveDeckOptions).mock.calls[0][1]).new_cards_per_day).toBe(20);
  });

  it('does not replace corrupted saved settings with defaults', async () => {
    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck({ settings: '{broken' }) } as never);
    renderDeckOptionsPage();
    await screen.findByText('Failed to load deck options');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(optionsApi.saveDeckOptions).not.toHaveBeenCalled();
  });

  it('renders loading state initially', () => {
    vi.spyOn(decksApi, 'getDeck').mockReturnValue(new Promise(() => {}));
    const { container } = renderDeckOptionsPage();
    expect(container.querySelector('.spinner')).not.toBeNull();
    expect(screen.getByRole('status', { name: /loading options/i })).toBeDefined();
  });

  it('renders error state on load failure and retries successfully', async () => {
    const getDeckSpy = vi.spyOn(decksApi, 'getDeck');
    getDeckSpy.mockRejectedValueOnce(new Error('Network error loading options'));

    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText('Failed to load deck options')).toBeDefined();
      expect(screen.getByText('Network error loading options')).toBeDefined();
    });

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeDefined();

    // Mock successful response on retry
    getDeckSpy.mockResolvedValueOnce({ data: createMockDeck() } as any);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });
  });

  it('displays honest per-deck indicator without fake preset dropdown', async () => {
    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    // Honest badge is displayed
    expect(screen.getByText('Per-deck settings')).toBeDefined();

    // Fake preset dropdown with "Add Preset..." and used-by counter should NOT exist
    expect(screen.queryByText(/Add Preset/i)).toBeNull();
    expect(screen.queryByText(/used by 1 deck/i)).toBeNull();
  });

  it('displays correct Easy Days Minimum/Reduced/Normal labels and marks unsupported groups as not yet active', async () => {
    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    // Easy Days column headers must be Minimum, Reduced, Normal (not Maximum on left)
    expect(screen.getByText('Minimum')).toBeDefined();
    expect(screen.getByText('Reduced')).toBeDefined();
    expect(screen.getByText('Normal')).toBeDefined();

    // Inactive groups marked with "Not yet active" pill
    const inactiveBadges = screen.getAllByText('Not yet active');
    expect(inactiveBadges.length).toBeGreaterThanOrEqual(1); // Easy Days remains unsupported
  });

  it('provides accessible semantic switch controls and prevents toggling unsupported switches', async () => {
    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    // Working switch (Daily limits: New cards ignore review limit)
    const activeSwitch = screen.getByRole('switch', {
      name: 'New cards ignore review limit',
    });
    expect(activeSwitch).toBeDefined();
    expect(activeSwitch.getAttribute('aria-checked')).toBe('false');

    // Click to toggle working switch
    fireEvent.click(activeSwitch);
    expect(activeSwitch.hasAttribute('disabled')).toBe(false);
    expect(activeSwitch.getAttribute('aria-checked')).toBe('true');

    // FSRS is implemented and can now be enabled
    const fsrsSwitch = screen.getByRole('switch', { name: 'FSRS' });
    expect(fsrsSwitch).toBeDefined();
    expect(fsrsSwitch.hasAttribute('disabled')).toBe(false);
    expect(fsrsSwitch.getAttribute('aria-disabled')).toBe('false');

    // Clicking disabled switch does not change its state
    fireEvent.click(fsrsSwitch);
    expect(fsrsSwitch.getAttribute('aria-checked')).toBe('true');
  });

  it('validates invalid numeric and step inputs, disabling save and displaying inline errors', async () => {
    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn.hasAttribute('disabled')).toBe(false);

    // Enter negative number for new_cards_per_day
    const newCardsInput = screen.getByLabelText('New cards/day');
    fireEvent.change(newCardsInput, { target: { value: '-5' } });

    await waitFor(() => {
      expect(screen.getByText('Must be an integer between 0 and 999999')).toBeDefined();
      expect(saveBtn.hasAttribute('disabled')).toBe(true);
    });

    // Restore valid number
    fireEvent.change(newCardsInput, { target: { value: '25' } });
    await waitFor(() => {
      expect(
        screen.queryByText('Must be an integer between 0 and 999999')
      ).toBeNull();
      expect(saveBtn.hasAttribute('disabled')).toBe(false);
    });

    // Enter invalid step format for learning steps
    const learningStepsInput = screen.getByLabelText('Learning steps');
    fireEvent.change(learningStepsInput, { target: { value: 'invalid_interval' } });

    await waitFor(() => {
      expect(
        screen.getByText('Steps must be positive durations such as 1m 10m')
      ).toBeDefined();
      expect(saveBtn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('handles save pending state and inline success feedback without alerts or navigation', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let resolveUpdate: (val: any) => void = () => {};
    const updatePromise = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
    vi.spyOn(optionsApi, 'saveDeckOptions').mockReturnValue(updatePromise as any);

    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    // Save pending state
    expect(saveBtn.textContent).toBe('Saving...');
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
    expect(saveBtn.getAttribute('aria-busy')).toBe('true');

    // Resolve updateDeck
    resolveUpdate({ data: legacyOptions });

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeDefined();
      expect(screen.getByText('Settings saved successfully!')).toBeDefined();
      expect(saveBtn.textContent).toBe('Save');
    });

    // No window.alert called
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('handles save failure with inline error alert without crashing or alerts', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
    vi.spyOn(optionsApi, 'saveDeckOptions').mockRejectedValueOnce(new Error('Server database error'));

    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const alertEl = screen.getByRole('alert');
      expect(alertEl).toBeDefined();
      expect(alertEl.textContent).toContain('Server database error');
    });

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('preserves existing unknown backend settings and inactive settings upon save', async () => {
    const initialDeck = createMockDeck({
      settings: JSON.stringify({
        new_cards_per_day: 15,
        custom_backend_setting: 'do_not_erase_me',
        future_flag: 42,
        fsrs: true, // inactive setting previously loaded
      }),
    });

    vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: initialDeck } as any);
    const updateSpy = vi.spyOn(optionsApi, 'saveDeckOptions').mockResolvedValue({ data: {} } as any);

    renderDeckOptionsPage();

    await waitFor(() => {
      expect(screen.getByText('Options for Japanese N5')).toBeDefined();
    });

    // Modify a working field
    const newCardsInput = screen.getByLabelText('New cards/day');
    fireEvent.change(newCardsInput, { target: { value: '35' } });

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    const [deckIdArg, payloadArg] = updateSpy.mock.calls[0];
    expect(deckIdArg).toBe(1);

    const savedSettings = JSON.parse(payloadArg);

    // Working field updated
    expect(savedSettings.new_cards_per_day).toBe(35);

    // Unknown backend fields preserved intact
    expect(savedSettings.custom_backend_setting).toBe('do_not_erase_me');
    expect(savedSettings.future_flag).toBe(42);

    // Loaded inactive fields preserved intact
    expect(savedSettings.fsrs).toBe(true);
  });
});
