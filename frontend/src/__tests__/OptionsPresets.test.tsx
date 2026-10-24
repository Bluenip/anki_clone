import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OptionsPresets } from '../components/OptionsPresets';
import * as optionsApi from '../api/options';
import type { DeckOptionsResponse } from '../api/options';
import type { DeckSettings } from '../pages/DeckOptionsPage';

vi.mock('../api/options', async () => {
  const actual = await vi.importActual('../api/options');
  return {
    ...actual,
    bindPreset: vi.fn(),
    createPreset: vi.fn(),
    saveLimits: vi.fn(),
  };
});

const mockDefaultSettings: DeckSettings = {
  new_cards_per_day: 20,
  maximum_reviews_per_day: 200,
  new_cards_ignore_review_limit: false,
  limits_start_from_top: false,
  learning_steps: '1m 10m',
  graduating_interval: 1,
  easy_interval: 4,
  insertion_order: 'Sequential (oldest cards first)',
  relearning_steps: '10m',
  minimum_interval: 1,
  leech_threshold: 8,
  leech_action: 'Tag Only',
  new_card_gather_order: 'Deck',
  new_card_sort_order: 'Card type, then order gathered',
  new_review_order: 'Mix with reviews',
  interday_learning_review_order: 'Mix with reviews',
  review_sort_order: 'Due date, then random',
  maximum_interval: 36500,
  starting_ease: 2.5,
  easy_bonus: 1.3,
  interval_modifier: 1.0,
  hard_interval: 1.2,
  new_interval: 0.0,
  custom_scheduling: false,
  dont_play_audio_automatically: false,
  skip_question_when_replaying_answer: false,
  maximum_answer_seconds: 60,
  show_on_screen_timer: false,
  stop_on_screen_timer_on_answer: false,
  seconds_to_show_question_for: 0,
  seconds_to_show_answer_for: 0,
  wait_for_audio: true,
  question_action: 'Show Answer',
  answer_action: 'Bury Card',
  bury_new_siblings: false,
  bury_review_siblings: false,
  bury_interday_learning_siblings: false,
  easy_days: { Mon: 100, Tue: 100, Wed: 100, Thu: 100, Fri: 100, Sat: 100, Sun: 100 },
  fsrs: false, fsrs_fuzz: false,
  fsrs_desired_retention: 0.9,
  fsrs_parameters: null,
  timezone: 'UTC',
  day_starts_at: 0,
  learning_ahead_seconds: 0,
};

const createMockOptions = (overrides?: Partial<DeckOptionsResponse>): DeckOptionsResponse => ({
  preset_id: null,
  preset_name: null,
  preset_version: null,
  preset_settings: null,
  settings: JSON.stringify({ new_cards_per_day: 20, maximum_reviews_per_day: 200 }),
  overrides: {},
  today: {},
  presets: [
    {
      id: 101,
      name: 'Shared General Preset',
      settings: JSON.stringify({ new_cards_per_day: 30, maximum_reviews_per_day: 250 }),
      version: 1,
      used_by: [1, 2],
    },
  ],
  ...overrides,
});

describe('OptionsPresets Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles shared preset attach and displays used_by count', async () => {
    const initialOptions = createMockOptions();
    const updatedOptions = createMockOptions({
      preset_id: 101,
      preset_name: 'Shared General Preset',
      preset_version: 1,
      preset_settings: JSON.stringify({ new_cards_per_day: 30, maximum_reviews_per_day: 250 }),
      settings: JSON.stringify({ new_cards_per_day: 30, maximum_reviews_per_day: 250 }),
    });

    vi.mocked(optionsApi.bindPreset).mockResolvedValue({ data: updatedOptions } as any);
    const onOptionsUpdate = vi.fn();

    const { rerender } = render(
      <OptionsPresets
        deckId={1}
        options={initialOptions}
        currentSettings={mockDefaultSettings}
        onOptionsUpdate={onOptionsUpdate}
        onReload={vi.fn()}
      />
    );

    // Initial state: per-deck settings, no preset bound
    expect(screen.getByText('No preset bound (using deck settings)')).toBeDefined();

    // Select preset to attach
    const select = screen.getByLabelText('Select preset to attach');
    fireEvent.change(select, { target: { value: '101' } });

    const attachBtn = screen.getByRole('button', { name: 'Attach' });
    fireEvent.click(attachBtn);

    await waitFor(() => {
      expect(optionsApi.bindPreset).toHaveBeenCalledWith(1, 101);
      expect(onOptionsUpdate).toHaveBeenCalledWith(updatedOptions);
    });

    // Re-render with updated options
    rerender(
      <OptionsPresets
        deckId={1}
        options={updatedOptions}
        currentSettings={mockDefaultSettings}
        onOptionsUpdate={onOptionsUpdate}
        onReload={vi.fn()}
      />
    );

    // Verify used_by count is displayed
    expect(screen.getByTestId('selected-preset-name').textContent).toBe('Shared General Preset');
    expect(screen.getByText(/used by 2 decks/i)).toBeDefined();
  });

  it('sends null when clearing today overrides', async () => {
    const initialOptions = createMockOptions({
      today: {
        day: '2026-10-22',
        limits: { new_cards_per_day: 50, maximum_reviews_per_day: 300 },
      },
    });

    const clearedOptions = createMockOptions({
      today: {},
    });

    vi.mocked(optionsApi.saveLimits).mockResolvedValue({ data: clearedOptions } as any);
    const onOptionsUpdate = vi.fn();

    render(
      <OptionsPresets
        deckId={1}
        options={initialOptions}
        currentSettings={mockDefaultSettings}
        onOptionsUpdate={onOptionsUpdate}
        onReload={vi.fn()}
      />
    );

    // Switch to 'Today only' tab
    const todayTab = screen.getByRole('tab', { name: 'Today only' });
    fireEvent.click(todayTab);

    // Click "Clear overrides"
    const clearBtn = screen.getByRole('button', { name: 'Clear overrides' });
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(optionsApi.saveLimits).toHaveBeenCalledWith(1, {
        scope: 'today',
        new_cards_per_day: null,
        maximum_reviews_per_day: null,
      });
      expect(onOptionsUpdate).toHaveBeenCalledWith(clearedOptions);
    });
  });

  it('preserves typed values on 409 conflict and shows reload notice', async () => {
    const initialOptions = createMockOptions({
      preset_id: 101,
      preset_name: 'Shared General Preset',
      preset_version: 1,
    });

    const conflictError = {
      response: {
        status: 409,
        data: { detail: 'Preset conflict (409): Settings were modified elsewhere.' },
      },
    };

    vi.mocked(optionsApi.saveLimits).mockRejectedValue(conflictError);
    const onReload = vi.fn();

    render(
      <OptionsPresets
        deckId={1}
        options={initialOptions}
        currentSettings={mockDefaultSettings}
        onOptionsUpdate={vi.fn()}
        onReload={onReload}
      />
    );

    // Scope is 'preset' by default
    const newCardsInput = screen.getByLabelText(/New cards\/day \(Preset\)/i) as HTMLInputElement;
    const maxReviewsInput = screen.getByLabelText(/Maximum reviews\/day \(Preset\)/i) as HTMLInputElement;

    // User types new values
    fireEvent.change(newCardsInput, { target: { value: '45' } });
    fireEvent.change(maxReviewsInput, { target: { value: '350' } });

    expect(newCardsInput.value).toBe('45');
    expect(maxReviewsInput.value).toBe('350');

    // Click Apply limits
    const applyBtn = screen.getByRole('button', { name: 'Apply limits' });
    fireEvent.click(applyBtn);

    // Wait for 409 error alert and reload notice
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Preset conflict:/i)).toBeDefined();
    });

    // Verify typed values are preserved in the inputs
    expect(newCardsInput.value).toBe('45');
    expect(maxReviewsInput.value).toBe('350');

    // Verify reload notice has reload button which triggers onReload
    const reloadBtn = screen.getByRole('button', { name: 'Reload Options' });
    fireEvent.click(reloadBtn);
    expect(onReload).toHaveBeenCalled();
  });
});
