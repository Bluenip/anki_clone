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
    new_cards_ignore_review_limit: false,
    limits_start_from_top: false,
    learning_steps: '1m 10m',
    fsrs: false,
    fsrs_desired_retention: 0.9,
    fsrs_parameters: null,
    timezone: 'UTC',
    day_starts_at: 0,
    learning_ahead_seconds: 0,
    bury_new_siblings: false,
    bury_review_siblings: false,
    bury_interday_learning_siblings: false,
    dont_play_audio_automatically: false,
    skip_question_when_replaying_answer: false,
    maximum_answer_seconds: 60,
    show_on_screen_timer: false,
    stop_on_screen_timer_on_answer: false,
    seconds_to_show_question_for: 0.0,
    seconds_to_show_answer_for: 0.0,
    wait_for_audio: true,
    question_action: 'Show Answer',
    answer_action: 'Bury Card',
    custom_backend_setting: 'do_not_erase_me',
    future_flag: 42,
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

describe('OptionsScheduling (FSRS & Supported Scheduling Settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('FSRS Panel & Desired Retention', () => {
    it('renders active FSRS toggle and toggles state when clicked', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const fsrsSwitch = screen.getByRole('switch', { name: 'FSRS' });
      expect(fsrsSwitch).toBeDefined();
      expect(fsrsSwitch.hasAttribute('disabled')).toBe(false);
      expect(fsrsSwitch.getAttribute('aria-checked')).toBe('false');

      fireEvent.click(fsrsSwitch);
      expect(fsrsSwitch.getAttribute('aria-checked')).toBe('true');
    });

    it('displays desired retention percentage UI and saves as decimal', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({
        data: createMockDeck({
          settings: JSON.stringify({
            fsrs: true,
            fsrs_desired_retention: 0.9,
          }),
        }),
      } as any);
      const updateSpy = vi.spyOn(optionsApi, 'saveDeckOptions').mockResolvedValue({ data: {} } as any);

      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const retentionInput = screen.getByLabelText('Desired retention (%)') as HTMLInputElement;
      expect(retentionInput).toBeDefined();
      expect(retentionInput.value).toBe('90');

      // Change to 85%
      fireEvent.change(retentionInput, { target: { value: '85' } });
      expect(retentionInput.value).toBe('85');

      const saveBtn = screen.getByRole('button', { name: 'Save' });
      expect(saveBtn.hasAttribute('disabled')).toBe(false);
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledTimes(1);
      });

      const payload = JSON.parse(updateSpy.mock.calls[0][1]);
      expect(payload.fsrs_desired_retention).toBe(0.85);
      expect(payload.fsrs).toBe(true);
    });

    it('validates desired retention percentage bounds (70% - 99%)', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const retentionInput = screen.getByLabelText('Desired retention (%)');
      const saveBtn = screen.getByRole('button', { name: 'Save' });

      // Out of bounds: 65%
      fireEvent.change(retentionInput, { target: { value: '65' } });
      await waitFor(() => {
        expect(screen.getByText('Must be between 70% and 99% (0.7 - 0.99)')).toBeDefined();
        expect(saveBtn.hasAttribute('disabled')).toBe(true);
      });

      // Out of bounds: 105%
      fireEvent.change(retentionInput, { target: { value: '105' } });
      await waitFor(() => {
        expect(screen.getByText('Must be between 70% and 99% (0.7 - 0.99)')).toBeDefined();
        expect(saveBtn.hasAttribute('disabled')).toBe(true);
      });

      // Valid: 95%
      fireEvent.change(retentionInput, { target: { value: '95' } });
      await waitFor(() => {
        expect(screen.queryByText('Must be between 70% and 99% (0.7 - 0.99)')).toBeNull();
        expect(saveBtn.hasAttribute('disabled')).toBe(false);
      });
    });
  });

  describe('Timezone, Cutoff, and Learn Ahead Validation', () => {
    it('validates timezone against IANA timezone format', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      const updateSpy = vi.spyOn(optionsApi, 'saveDeckOptions').mockResolvedValue({ data: {} } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const tzInput = screen.getByLabelText('Timezone');
      const saveBtn = screen.getByRole('button', { name: 'Save' });

      // Invalid timezone
      fireEvent.change(tzInput, { target: { value: 'Invalid/Timezone' } });
      await waitFor(() => {
        expect(screen.getByText('Must be a valid IANA timezone (e.g. UTC, America/New_York)')).toBeDefined();
        expect(saveBtn.hasAttribute('disabled')).toBe(true);
      });

      // Valid timezone
      fireEvent.change(tzInput, { target: { value: 'America/New_York' } });
      await waitFor(() => {
        expect(screen.queryByText('Must be a valid IANA timezone (e.g. UTC, America/New_York)')).toBeNull();
        expect(saveBtn.hasAttribute('disabled')).toBe(false);
      });

      fireEvent.click(saveBtn);
      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledTimes(1);
      });
      const payload = JSON.parse(updateSpy.mock.calls[0][1]);
      expect(payload.timezone).toBe('America/New_York');
    });

    it('validates day_starts_at cutoff integer bounds (0..23)', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      const updateSpy = vi.spyOn(optionsApi, 'saveDeckOptions').mockResolvedValue({ data: {} } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const cutoffInput = screen.getByLabelText('Day starts at (hours past midnight)');
      const saveBtn = screen.getByRole('button', { name: 'Save' });

      // Out of bounds: 24
      fireEvent.change(cutoffInput, { target: { value: '24' } });
      await waitFor(() => {
        expect(screen.getByText('Must be an integer between 0 and 23')).toBeDefined();
        expect(saveBtn.hasAttribute('disabled')).toBe(true);
      });

      // Valid: 4
      fireEvent.change(cutoffInput, { target: { value: '4' } });
      await waitFor(() => {
        expect(screen.queryByText('Must be an integer between 0 and 23')).toBeNull();
        expect(saveBtn.hasAttribute('disabled')).toBe(false);
      });

      fireEvent.click(saveBtn);
      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledTimes(1);
      });
      const payload = JSON.parse(updateSpy.mock.calls[0][1]);
      expect(payload.day_starts_at).toBe(4);
    });

    it('validates learning_ahead_seconds integer bounds (0..3600)', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      const updateSpy = vi.spyOn(optionsApi, 'saveDeckOptions').mockResolvedValue({ data: {} } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const learnAheadInput = screen.getByLabelText('Learning ahead limit (seconds)');
      const saveBtn = screen.getByRole('button', { name: 'Save' });

      // Out of bounds: 3601
      fireEvent.change(learnAheadInput, { target: { value: '3601' } });
      await waitFor(() => {
        expect(screen.getByText('Must be an integer between 0 and 3600')).toBeDefined();
        expect(saveBtn.hasAttribute('disabled')).toBe(true);
      });

      // Valid: 1200
      fireEvent.change(learnAheadInput, { target: { value: '1200' } });
      await waitFor(() => {
        expect(screen.queryByText('Must be an integer between 0 and 3600')).toBeNull();
        expect(saveBtn.hasAttribute('disabled')).toBe(false);
      });

      fireEvent.click(saveBtn);
      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledTimes(1);
      });
      const payload = JSON.parse(updateSpy.mock.calls[0][1]);
      expect(payload.learning_ahead_seconds).toBe(1200);
    });
  });

  describe('Preserving Unknowns & Validating Saved Settings', () => {
    it('preserves fsrs_parameters vector and unknown backend settings on save', async () => {
      const mockParameters = Array.from({ length: 21 }, (_, i) => Number((0.1 * (i + 1)).toFixed(2)));
      const initialDeck = createMockDeck({
        settings: JSON.stringify({
          fsrs: true,
          fsrs_desired_retention: 0.88,
          fsrs_parameters: mockParameters,
          timezone: 'Asia/Tokyo',
          day_starts_at: 3,
          learning_ahead_seconds: 600,
          custom_ml_model_ref: 'fsrs-v5-custom',
          arbitrary_future_flag: 999,
        }),
      });

      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: initialDeck } as any);
      const updateSpy = vi.spyOn(optionsApi, 'saveDeckOptions').mockResolvedValue({ data: {} } as any);

      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      // Toggle bury new siblings
      const buryNewSwitch = screen.getByRole('switch', { name: 'Bury new siblings' });
      fireEvent.click(buryNewSwitch);

      const saveBtn = screen.getByRole('button', { name: 'Save' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledTimes(1);
      });

      const savedSettings = JSON.parse(updateSpy.mock.calls[0][1]);
      expect(savedSettings.fsrs).toBe(true);
      expect(savedSettings.fsrs_desired_retention).toBe(0.88);
      expect(savedSettings.fsrs_parameters).toEqual(mockParameters);
      expect(savedSettings.timezone).toBe('Asia/Tokyo');
      expect(savedSettings.day_starts_at).toBe(3);
      expect(savedSettings.learning_ahead_seconds).toBe(600);
      expect(savedSettings.bury_new_siblings).toBe(true);
      // Preserves unknown fields
      expect(savedSettings.custom_ml_model_ref).toBe('fsrs-v5-custom');
      expect(savedSettings.arbitrary_future_flag).toBe(999);
    });

    it('rejects corrupted or invalid loaded settings without overwriting', async () => {
      // Invalid fsrs_desired_retention in saved JSON
      const invalidDeck = createMockDeck({
        settings: JSON.stringify({
          fsrs_desired_retention: 1.5, // > 0.99
        }),
      });

      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: invalidDeck } as any);
      renderDeckOptionsPage();

      await screen.findByText('Failed to load deck options');
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(optionsApi.saveDeckOptions).not.toHaveBeenCalled();
    });

    it('rejects corrupted fsrs_parameters (wrong length) without overwriting', async () => {
      const invalidDeck = createMockDeck({
        settings: JSON.stringify({
          fsrs_parameters: [0.1, 0.2, 0.3], // only 3 elements instead of 21
        }),
      });

      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: invalidDeck } as any);
      renderDeckOptionsPage();

      await screen.findByText('Failed to load deck options');
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
  });

  describe('Auto Advance, Timers, Audio, and Burying Supported Settings', () => {
    it('enables all 3 bury switches without inactive notice', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      expect(screen.queryByText(/Card sibling burying is not yet active/i)).toBeNull();

      const buryNew = screen.getByRole('switch', { name: 'Bury new siblings' });
      const buryReview = screen.getByRole('switch', { name: 'Bury review siblings' });
      const buryInterday = screen.getByRole('switch', { name: 'Bury interday learning siblings' });

      expect(buryNew.hasAttribute('disabled')).toBe(false);
      expect(buryReview.hasAttribute('disabled')).toBe(false);
      expect(buryInterday.hasAttribute('disabled')).toBe(false);

      fireEvent.click(buryNew);
      expect(buryNew.getAttribute('aria-checked')).toBe('true');
    });

    it('enables audio switches without inactive notice', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      expect(screen.queryByText(/Audio playback options are not yet active/i)).toBeNull();

      const dontPlayAudio = screen.getByRole('switch', { name: "Don't play audio automatically" });
      const skipQuestion = screen.getByRole('switch', { name: 'Skip question when replaying answer' });

      expect(dontPlayAudio.hasAttribute('disabled')).toBe(false);
      expect(skipQuestion.hasAttribute('disabled')).toBe(false);

      fireEvent.click(dontPlayAudio);
      expect(dontPlayAudio.getAttribute('aria-checked')).toBe('true');
    });

    it('enables timers and validates maximum_answer_seconds (1..3600)', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      expect(screen.queryByText(/Review timers are not yet active/i)).toBeNull();

      const maxAnswerInput = screen.getByLabelText('Maximum answer seconds');
      const saveBtn = screen.getByRole('button', { name: 'Save' });

      // Out of bounds: 0
      fireEvent.change(maxAnswerInput, { target: { value: '0' } });
      await waitFor(() => {
        expect(screen.getByText('Must be an integer between 1 and 3600')).toBeDefined();
        expect(saveBtn.hasAttribute('disabled')).toBe(true);
      });

      // Valid: 120
      fireEvent.change(maxAnswerInput, { target: { value: '120' } });
      await waitFor(() => {
        expect(screen.queryByText('Must be an integer between 1 and 3600')).toBeNull();
        expect(saveBtn.hasAttribute('disabled')).toBe(false);
      });

      const showTimer = screen.getByRole('switch', { name: 'Show on-screen timer' });
      const stopTimer = screen.getByRole('switch', { name: 'Stop on-screen timer on answer' });

      expect(showTimer.hasAttribute('disabled')).toBe(false);
      expect(stopTimer.hasAttribute('disabled')).toBe(false);
    });

    it('exposes only supported auto advance actions (question: Show Answer; answer: Bury Card, Good, Hard, Again, Easy)', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      expect(screen.queryByText(/Auto advance actions are not yet supported/i)).toBeNull();

      const questionSelect = screen.getByLabelText('Question action') as HTMLSelectElement;
      expect(questionSelect.disabled).toBe(false);
      const questionOptions = Array.from(questionSelect.options).map((o) => o.text);
      expect(questionOptions).toEqual(['Show Answer']);

      const answerSelect = screen.getByLabelText('Answer action') as HTMLSelectElement;
      expect(answerSelect.disabled).toBe(false);
      const answerOptions = Array.from(answerSelect.options).map((o) => o.text);
      expect(answerOptions).toEqual(['Bury Card', 'Good', 'Hard', 'Again', 'Easy']);

      // Change answer action to Good
      fireEvent.change(answerSelect, { target: { value: 'Good' } });
      expect(answerSelect.value).toBe('Good');
    });

    it('enables daily limits review limit switches', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      const ignoreLimit = screen.getByRole('switch', { name: 'New cards ignore review limit' });
      const limitsFromTop = screen.getByRole('switch', { name: 'Limits start from top' });

      expect(ignoreLimit.hasAttribute('disabled')).toBe(false);
      expect(limitsFromTop.hasAttribute('disabled')).toBe(false);

      fireEvent.click(ignoreLimit);
      expect(ignoreLimit.getAttribute('aria-checked')).toBe('true');
    });
  });

  describe('Inactive & Unsupported Sections Preserved', () => {
    it('enables Easy Days and Display Order while Custom Scheduling remains disabled', async () => {
      vi.spyOn(decksApi, 'getDeck').mockResolvedValue({ data: createMockDeck() } as any);
      renderDeckOptionsPage();

      await waitFor(() => {
        expect(screen.getByText('Options for Japanese N5')).toBeDefined();
      });

      // Easy Days
      expect(screen.getByText(/Future review dates prefer weekdays/i)).toBeDefined();
      const mondaySlider = screen.getByLabelText('Mon load percentage') as HTMLInputElement;
      expect(mondaySlider.disabled).toBe(false);

      // Custom Scheduling
      expect(screen.getByText(/Custom scheduling scripts are not yet active/i)).toBeDefined();
      const customSchedulingSwitch = screen.getByRole('switch', { name: 'Custom scheduling' });
      expect(customSchedulingSwitch.hasAttribute('disabled')).toBe(true);

      // Inactive badges: exactly 2 remaining (Display Order and Easy Days)
      expect(screen.queryAllByText('Not yet active')).toHaveLength(0);
      expect(screen.getByLabelText('New card gather order').closest('fieldset')?.disabled).toBe(false);

      // Scope badge remains per-deck
      expect(screen.getByText('Per-deck settings')).toBeDefined();
    });
  });
});
