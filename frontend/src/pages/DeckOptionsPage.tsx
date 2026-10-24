import FsrsOptimizer from '../components/FsrsOptimizer';
import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getDeck } from '../api/decks';
import { getDeckOptions, saveDeckOptions } from '../api/options';
import type { DeckOptionsResponse } from '../api/options';
import { OptionsPresets } from '../components/OptionsPresets';
import type { Deck } from '../api/types';
import '../DeckOptions.css';

export interface DeckSettings {
  // Daily limits (active)
  new_cards_per_day: number;
  maximum_reviews_per_day: number;
  new_cards_ignore_review_limit: boolean;
  limits_start_from_top: boolean;

  // New cards (active)
  learning_steps: string;
  graduating_interval: number;
  easy_interval: number;
  insertion_order: string;

  // Lapses (active)
  relearning_steps: string;
  minimum_interval: number;
  leech_threshold: number;
  leech_action: string;

  // Display Order (unsupported/inactive)
  new_card_gather_order: string;
  new_card_sort_order: string;
  new_review_order: string;
  interday_learning_review_order: string;
  review_sort_order: string;

  // Advanced (active)
  maximum_interval: number;
  starting_ease: number;
  easy_bonus: number;
  interval_modifier: number;
  hard_interval: number;
  new_interval: number;
  custom_scheduling: boolean;

  // Audio (active)
  dont_play_audio_automatically: boolean;
  skip_question_when_replaying_answer: boolean;

  // Timers (active)
  maximum_answer_seconds: number;
  show_on_screen_timer: boolean;
  stop_on_screen_timer_on_answer: boolean;

  // Auto Advance (active)
  seconds_to_show_question_for: number;
  seconds_to_show_answer_for: number;
  wait_for_audio: boolean;
  question_action: string;
  answer_action: string;

  // Burying (active)
  bury_new_siblings: boolean;
  bury_review_siblings: boolean;
  bury_interday_learning_siblings: boolean;

  // Easy Days (unsupported/inactive)
  easy_days: Record<string, number>;

  // FSRS (active)
  fsrs: boolean;
  fsrs_desired_retention: number;
  fsrs_parameters: number[] | null;
  fsrs_fuzz: boolean;
  timezone: string;
  day_starts_at: number;
  learning_ahead_seconds: number;

  // Retain any loaded unknown backend settings without erasing
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: DeckSettings = {
  // Daily limits
  new_cards_per_day: 20,
  maximum_reviews_per_day: 200,
  new_cards_ignore_review_limit: false,
  limits_start_from_top: false,

  // New cards
  learning_steps: '1m 10m',
  graduating_interval: 1,
  easy_interval: 4,
  insertion_order: 'Sequential (oldest cards first)',

  // Lapses
  relearning_steps: '10m',
  minimum_interval: 1,
  leech_threshold: 8,
  leech_action: 'Tag Only',

  // Display Order
  new_card_gather_order: 'Deck',
  new_card_sort_order: 'Card type, then order gathered',
  new_review_order: 'Mix with reviews',
  interday_learning_review_order: 'Mix with reviews',
  review_sort_order: 'Due date, then random',

  // Advanced
  maximum_interval: 36500,
  starting_ease: 2.5,
  easy_bonus: 1.3,
  interval_modifier: 1.0,
  hard_interval: 1.2,
  new_interval: 0.0,
  custom_scheduling: false,

  // Audio
  dont_play_audio_automatically: false,
  skip_question_when_replaying_answer: false,

  // Timers
  maximum_answer_seconds: 60,
  show_on_screen_timer: false,
  stop_on_screen_timer_on_answer: false,

  // Auto Advance
  seconds_to_show_question_for: 0.0,
  seconds_to_show_answer_for: 0.0,
  wait_for_audio: true,
  question_action: 'Show Answer',
  answer_action: 'Bury Card',

  // Burying
  bury_new_siblings: false,
  bury_review_siblings: false,
  bury_interday_learning_siblings: false,

  // Easy Days
  easy_days: { Mon: 100, Tue: 100, Wed: 100, Thu: 100, Fri: 100, Sat: 100, Sun: 100 },

  // FSRS
  fsrs: false,
  fsrs_desired_retention: 0.9,
  fsrs_parameters: null,
  fsrs_fuzz: false,
  timezone: 'UTC',
  day_starts_at: 0,
  learning_ahead_seconds: 0,
};

interface ToggleSwitchProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

const ToggleSwitch = ({ id, label, checked, disabled = false, onChange }: ToggleSwitchProps) => (
  <button
    type="button"
    role="switch"
    id={id}
    aria-label={label}
    aria-checked={checked}
    aria-disabled={disabled}
    disabled={disabled}
    className={`toggle-switch ${checked ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
    onClick={() => {
      if (!disabled) {
        onChange(!checked);
      }
    }}
  >
    <span className="toggle-thumb" aria-hidden="true" />
  </button>
);

const normalizeAnswerAction = (action: string): string => {
  const lower = action.toLowerCase().trim();
  if (lower === 'answer good' || lower === 'good') return 'Good';
  if (lower === 'answer hard' || lower === 'hard') return 'Hard';
  if (lower === 'answer again' || lower === 'again') return 'Again';
  if (lower === 'answer easy' || lower === 'easy') return 'Easy';
  if (lower === 'bury card' || lower === 'bury' || lower === 'bury_card') return 'Bury Card';
  return action;
};

const validateField = (field: string, value: unknown): string | null => {
  if (field === 'learning_steps' || field === 'relearning_steps') {
    if (typeof value !== 'string') return 'Steps must be text';
    for (const token of value.trim().split(/\s+/).filter(Boolean)) {
      const match = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(token);
      if (!match) return 'Steps must be positive durations such as 1m 10m';
      const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, '': 60 }[match[2].toLowerCase()] ?? 0);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 31536000) return 'Each step must be between one second and one year';
    }
    return null;
  }
  if (field === 'timezone') {
    if (typeof value !== 'string' || !value.trim()) return 'Timezone is required';
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value.trim() });
      return null;
    } catch {
      return 'Must be a valid IANA timezone (e.g. UTC, America/New_York)';
    }
  }
  if (field === 'fsrs_desired_retention') {
    if (value === '' || value == null) return 'Must be between 70% and 99% (0.7 - 0.99)';
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0.7 || num > 0.99) {
      return 'Must be between 70% and 99% (0.7 - 0.99)';
    }
    return null;
  }
  const bounds: Record<string, [number, number, boolean]> = {
    new_cards_per_day: [0, 999999, true],
    maximum_reviews_per_day: [0, 999999, true],
    graduating_interval: [1, 36500, true],
    easy_interval: [1, 36500, true],
    minimum_interval: [1, 36500, true],
    leech_threshold: [1, 999999, true],
    maximum_interval: [1, 36500, true],
    starting_ease: [1.3, 10, false],
    easy_bonus: [1, 10, false],
    hard_interval: [1, 10, false],
    interval_modifier: [0.01, 10, false],
    new_interval: [0, 1, false],
    maximum_answer_seconds: [1, 3600, true],
    day_starts_at: [0, 23, true],
    learning_ahead_seconds: [0, 3600, true],
    seconds_to_show_question_for: [0, 3600, false],
    seconds_to_show_answer_for: [0, 3600, false],
  };
  const bound = bounds[field];
  if (!bound) return null;
  const number = Number(value);
  if (value === '' || value == null || !Number.isFinite(number) || number < bound[0] || number > bound[1] || (bound[2] && !Number.isInteger(number))) {
    return `Must be ${bound[2] ? 'an integer' : 'a number'} between ${bound[0]} and ${bound[1]}`;
  }
  return null;
};

const validateAll = (currSettings: DeckSettings): Record<string, string> => {
  const errors: Record<string, string> = {};
  const fieldsToCheck: string[] = [
    'new_cards_per_day',
    'maximum_reviews_per_day',
    'learning_steps',
    'graduating_interval',
    'easy_interval',
    'relearning_steps',
    'minimum_interval',
    'leech_threshold',
    'maximum_interval',
    'starting_ease',
    'easy_bonus',
    'interval_modifier',
    'hard_interval',
    'new_interval',
    'maximum_answer_seconds',
    'seconds_to_show_question_for',
    'seconds_to_show_answer_for',
    'day_starts_at',
    'learning_ahead_seconds',
    'fsrs_desired_retention',
    'timezone',
  ];
  for (const field of fieldsToCheck) {
    const err = validateField(field, currSettings[field]);
    if (err) {
      errors[field] = err;
    }
  }
  return errors;
};

const validateAndApplyLoadedSettings = (rawJson: string): DeckSettings => {
  const parsed: unknown = JSON.parse(rawJson || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved settings are invalid; they were not overwritten.');
  const loaded = parsed as Record<string, unknown>;
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    if (key in loaded) {
      if (defaultValue === null) {
        continue;
      }
      if (typeof loaded[key] !== typeof defaultValue || (typeof loaded[key] === 'number' && !Number.isFinite(loaded[key] as number))) {
        throw new Error(`Saved setting ${key} has an invalid value; it was not overwritten.`);
      }
    }
  }
  if ('fsrs_parameters' in loaded) {
    const p = loaded.fsrs_parameters;
    if (p !== null && (!Array.isArray(p) || p.length !== 21 || p.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new Error('Saved setting fsrs_parameters has an invalid value; it was not overwritten.');
    }
  }
  if ('fsrs_desired_retention' in loaded) {
    const r = loaded.fsrs_desired_retention;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0.7 || r > 0.99) {
      throw new Error('Saved setting fsrs_desired_retention has an invalid value; it was not overwritten.');
    }
  }
  if ('day_starts_at' in loaded) {
    const d = loaded.day_starts_at;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 23) {
      throw new Error('Saved setting day_starts_at has an invalid value; it was not overwritten.');
    }
  }
  if ('learning_ahead_seconds' in loaded) {
    const l = loaded.learning_ahead_seconds;
    if (typeof l !== 'number' || !Number.isInteger(l) || l < 0 || l > 3600) {
      throw new Error('Saved setting learning_ahead_seconds has an invalid value; it was not overwritten.');
    }
  }
  if ('maximum_answer_seconds' in loaded) {
    const m = loaded.maximum_answer_seconds;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 3600) {
      throw new Error('Saved setting maximum_answer_seconds has an invalid value; it was not overwritten.');
    }
  }
  if ('timezone' in loaded) {
    const tz = loaded.timezone;
    if (typeof tz !== 'string' || !tz.trim()) {
      throw new Error('Saved setting timezone has an invalid value; it was not overwritten.');
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    } catch {
      throw new Error('Saved setting timezone has an invalid value; it was not overwritten.');
    }
  }
  if ('easy_days' in loaded && (!loaded.easy_days || Array.isArray(loaded.easy_days) ||
    Object.values(loaded.easy_days as Record<string, unknown>).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100))) {
    throw new Error('Saved Easy Days settings are invalid.');
  }
  if (typeof loaded.answer_action === 'string') {
    loaded.answer_action = normalizeAnswerAction(loaded.answer_action);
  }
  return { ...DEFAULT_SETTINGS, ...loaded } as DeckSettings;
};

const DeckOptionsPageContent = () => {
  const { deckId } = useParams<{ deckId: string }>();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [options, setOptions] = useState<DeckOptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<DeckSettings>(DEFAULT_SETTINGS);

  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (!deckId) return;
    let cancelled = false;

    const deckPromise = getDeck(Number(deckId));
    const optionsPromise = getDeckOptions(Number(deckId));

    void Promise.all([deckPromise, optionsPromise])
      .then(([deckRes, optionsRes]) => {
        if (cancelled) return;
        const optData: DeckOptionsResponse = optionsRes?.data ?? {
          preset_id: null,
          preset_name: null,
          preset_version: null,
          preset_settings: deckRes.data?.settings || null,
          settings: deckRes.data?.settings || '{}',
          overrides: {},
          today: {},
          presets: [],
        };
        setOptions(optData);

        const rawSettings =
          optData.preset_settings != null
            ? optData.preset_settings
            : (deckRes.data?.settings || optData.settings || '{}');

        const loadedSettings = validateAndApplyLoadedSettings(rawSettings);

        setDeck(deckRes.data);
        setLoadError(null);
        setSettings(loadedSettings);
        setValidationErrors({});
        setSuccessMessage(null);
        setSaveError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load deck options.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [deckId, loadAttempt]);

  const handleOptionsUpdate = (newOptions: DeckOptionsResponse) => {
    setOptions(newOptions);
    try {
      const rawSettings =
        newOptions.preset_settings != null
          ? newOptions.preset_settings
          : (deck?.settings || newOptions.settings || '{}');
      const loadedSettings = validateAndApplyLoadedSettings(rawSettings);
      setSettings(loadedSettings);
      setValidationErrors({});
      setSuccessMessage(null);
      setSaveError(null);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to apply updated options.');
    }
  };

  const handleTextChange = (field: keyof DeckSettings, value: string) => {
    if (isSaving || presetBusy) return;
    setSettings((prev) => ({ ...prev, [field]: value }));
    const err = validateField(field as string, value);
    setValidationErrors((prev) => {
      const next = { ...prev };
      if (err) {
        next[field as string] = err;
      } else {
        delete next[field as string];
      }
      return next;
    });
    setSuccessMessage(null);
    setSaveError(null);
  };

  const handleNumberChange = (field: keyof DeckSettings, rawValue: string) => {
    if (isSaving || presetBusy) return;
    const num = rawValue === '' ? ('' as unknown as number) : Number(rawValue);
    setSettings((prev) => ({
      ...prev,
      [field]: rawValue === '' ? ('' as unknown as number) : (Number.isNaN(num) ? prev[field] : num),
    }));
    const err = validateField(field as string, rawValue === '' ? '' : num);
    setValidationErrors((prev) => {
      const next = { ...prev };
      if (err) {
        next[field as string] = err;
      } else {
        delete next[field as string];
      }
      return next;
    });
    setSuccessMessage(null);
    setSaveError(null);
  };

  const handleRetentionPercentChange = (rawValue: string) => {
    if (isSaving || presetBusy) return;
    if (rawValue === '') {
      setSettings((prev) => ({ ...prev, fsrs_desired_retention: '' as unknown as number }));
      setValidationErrors((prev) => ({
        ...prev,
        fsrs_desired_retention: 'Must be between 70% and 99% (0.7 - 0.99)',
      }));
      setSuccessMessage(null);
      setSaveError(null);
      return;
    }
    const percent = Number(rawValue);
    const decimal = Number.isNaN(percent)
      ? ('' as unknown as number)
      : Math.round(percent * 100) / 10000;
    setSettings((prev) => ({
      ...prev,
      fsrs_desired_retention: decimal,
    }));
    const err = validateField('fsrs_desired_retention', decimal);
    setValidationErrors((prev) => {
      const next = { ...prev };
      if (err) {
        next.fsrs_desired_retention = err;
      } else {
        delete next.fsrs_desired_retention;
      }
      return next;
    });
    setSuccessMessage(null);
    setSaveError(null);
  };

  const handleToggleChange = (field: keyof DeckSettings, value: boolean) => {
    if (isSaving || presetBusy) return;
    setSettings((prev) => ({ ...prev, [field]: value }));
    setSuccessMessage(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (isSaving || presetBusy) return;
    setSuccessMessage(null);
    setSaveError(null);

    const errors = validateAll(settings);
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      setSaveError('Please correct the validation errors before saving.');
      return;
    }

    setIsSaving(true);
    try {
      const res = await saveDeckOptions(
        Number(deckId),
        JSON.stringify(settings),
        options?.preset_version ?? undefined
      );
      if (res?.data) {
        setOptions(res.data);
      }
      setSuccessMessage('Settings saved successfully!');
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setSaveError('Preset conflict: Settings were modified elsewhere. Please reload before saving.');
      } else {
        setSaveError(err?.response?.data?.detail || (err instanceof Error ? err.message : 'Failed to save settings.'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (loading || (!loadError && deck !== null && deck.id !== Number(deckId))) {
    return (
      <div className="options-loading-container" role="status" aria-label="Loading options">
        <div className="spinner" />
        <p className="loading-text">Loading deck options...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="options-container">
        <div className="options-error-panel" role="alert">
          <h3>Failed to load deck options</h3>
          <p className="error-message">{loadError}</p>
          <div className="error-actions">
            <button type="button" className="btn btn-primary" onClick={() => { setLoading(true); setLoadError(null); setLoadAttempt(value => value + 1); }}>
              Retry
            </button>
            <Link to="/decks" className="btn btn-secondary">
              Back to Decks
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!deck) {
    return (
      <div className="options-container">
        <div className="options-error-panel" role="alert">
          <h3>Deck not found</h3>
          <p className="error-message">The requested deck could not be found.</p>
          <div className="error-actions">
            <Link to="/decks" className="btn btn-secondary">
              Back to Decks
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  return (
    <div className="options-container">
      <fieldset disabled={isSaving || presetBusy} style={{border: 0, padding: 0, minWidth: 0}}>
      {/* Compact Toolbar */}
      <div className="options-toolbar">
        <div className="options-breadcrumb">
          <Link to="/decks" className="options-back-link">
            Decks
          </Link>
          <span className="options-breadcrumb-sep">/</span>
          <span className="options-breadcrumb-current">Options for {deck.name}</span>
        </div>
        <div className="options-toolbar-actions">
          {options?.preset_id != null ? (
            <div
              className="options-scope-badge"
              title={`Preset: ${options.preset_name}`}
            >
              <span className="badge-dot" style={{ background: '#22c55e' }} aria-hidden="true" />
              <span>Preset: {options.preset_name}</span>
            </div>
          ) : (
            <div
              className="options-scope-badge"
              title="Settings are stored directly on this deck."
            >
              <span className="badge-dot" aria-hidden="true" />
              <span>Per-deck settings</span>
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary options-save-btn"
            onClick={handleSave}
            disabled={isSaving || presetBusy || hasValidationErrors}
            aria-busy={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Inline Feedback Alerts */}
      {saveError && (
        <div className="options-alert options-alert-error" role="alert">
          <span>{saveError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => { setLoading(true); setLoadAttempt(v => v+1); }}>Reload options</button>
        </div>
      )}
      {successMessage && (
        <div className="options-alert options-alert-success" role="status">
          <span>{successMessage}</span>
        </div>
      )}

      {/* Options Presets and Daily Limits Overrides Panels */}
      {options && (
        <details className="options-preset-details">
        <summary>Presets and daily limit overrides</summary>
        <OptionsPresets
          deckId={Number(deckId)}
          options={options}
          currentSettings={settings}
          onOptionsUpdate={handleOptionsUpdate}
          onBusyChange={setPresetBusy}
          onReload={() => {
            setLoading(true);
            setLoadError(null);
            setLoadAttempt((v) => v + 1);
          }}
        />
        </details>
      )}
      {settings.fsrs && <p>FSRS uses the learning steps, desired retention and maximum interval below. SM-2 ease and interval modifiers are retained for switching back.</p>}

      {/* Two Desktop Columns / One Mobile Column */}
      <div className="options-grid">
        {/* Left Column */}
        <div className="options-col">
          {/* Daily Limits (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Daily Limits</h3>
              </div>
            </div>
            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="new_cards_per_day" className="options-label">
                  New cards/day
                </label>
                <input
                  id="new_cards_per_day"
                  name="new_cards_per_day"
                  type="number"
                  min="0"
                  step="1"
                  value={settings.new_cards_per_day}
                  onChange={(e) => handleNumberChange('new_cards_per_day', e.target.value)}
                  className={validationErrors.new_cards_per_day ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.new_cards_per_day}
                  aria-describedby={
                    validationErrors.new_cards_per_day ? 'new_cards_per_day-error' : undefined
                  }
                />
              </div>
              {validationErrors.new_cards_per_day && (
                <span id="new_cards_per_day-error" className="field-error" role="alert">
                  {validationErrors.new_cards_per_day}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="maximum_reviews_per_day" className="options-label">
                  Maximum reviews/day
                </label>
                <input
                  id="maximum_reviews_per_day"
                  name="maximum_reviews_per_day"
                  type="number"
                  min="0"
                  step="1"
                  value={settings.maximum_reviews_per_day}
                  onChange={(e) => handleNumberChange('maximum_reviews_per_day', e.target.value)}
                  className={validationErrors.maximum_reviews_per_day ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.maximum_reviews_per_day}
                  aria-describedby={
                    validationErrors.maximum_reviews_per_day
                      ? 'maximum_reviews_per_day-error'
                      : undefined
                  }
                />
              </div>
              {validationErrors.maximum_reviews_per_day && (
                <span id="maximum_reviews_per_day-error" className="field-error" role="alert">
                  {validationErrors.maximum_reviews_per_day}
                </span>
              )}
            </div>

            <div className="options-row">
              <label htmlFor="new_cards_ignore_review_limit" className="options-label">
                New cards ignore review limit
              </label>
              <ToggleSwitch
                id="new_cards_ignore_review_limit"
                label="New cards ignore review limit"
                checked={settings.new_cards_ignore_review_limit}
                onChange={(val) => handleToggleChange('new_cards_ignore_review_limit', val)}
              />
            </div>

            <div className="options-row">
              <label htmlFor="limits_start_from_top" className="options-label">
                Limits start from top
              </label>
              <ToggleSwitch
                id="limits_start_from_top"
                label="Limits start from top"
                checked={settings.limits_start_from_top}
                onChange={(val) => handleToggleChange('limits_start_from_top', val)}
              />
            </div>
          </section>

          {/* New Cards (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>New Cards</h3>
              </div>
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="learning_steps" className="options-label">
                  Learning steps
                </label>
                <input
                  id="learning_steps"
                  name="learning_steps"
                  type="text"
                  value={settings.learning_steps}
                  onChange={(e) => handleTextChange('learning_steps', e.target.value)}
                  placeholder="e.g. 1m 10m"
                  className={validationErrors.learning_steps ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.learning_steps}
                  aria-describedby={
                    validationErrors.learning_steps ? 'learning_steps-error' : undefined
                  }
                />
              </div>
              {validationErrors.learning_steps && (
                <span id="learning_steps-error" className="field-error" role="alert">
                  {validationErrors.learning_steps}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="graduating_interval" className="options-label">
                  Graduating interval (days)
                </label>
                <input
                  id="graduating_interval"
                  disabled={settings.fsrs}
                  name="graduating_interval"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.graduating_interval}
                  onChange={(e) => handleNumberChange('graduating_interval', e.target.value)}
                  className={validationErrors.graduating_interval ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.graduating_interval}
                  aria-describedby={
                    validationErrors.graduating_interval ? 'graduating_interval-error' : undefined
                  }
                />
              </div>
              {validationErrors.graduating_interval && (
                <span id="graduating_interval-error" className="field-error" role="alert">
                  {validationErrors.graduating_interval}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="easy_interval" className="options-label">
                  Easy interval (days)
                </label>
                <input
                  id="easy_interval"
                  disabled={settings.fsrs}
                  name="easy_interval"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.easy_interval}
                  onChange={(e) => handleNumberChange('easy_interval', e.target.value)}
                  className={validationErrors.easy_interval ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.easy_interval}
                  aria-describedby={
                    validationErrors.easy_interval ? 'easy_interval-error' : undefined
                  }
                />
              </div>
              {validationErrors.easy_interval && (
                <span id="easy_interval-error" className="field-error" role="alert">
                  {validationErrors.easy_interval}
                </span>
              )}
            </div>

            <div className="options-row">
              <label htmlFor="insertion_order" className="options-label">
                Insertion order (sequential only)
              </label>
              <select
                id="insertion_order"
                disabled
                name="insertion_order"
                value={settings.insertion_order}
                onChange={(e) => handleTextChange('insertion_order', e.target.value)}
              >
                <option>Sequential (oldest cards first)</option>
                <option>Random</option>
              </select>
            </div>
          </section>

          {/* Lapses (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Lapses</h3>
              </div>
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="relearning_steps" className="options-label">
                  Relearning steps
                </label>
                <input
                  id="relearning_steps"
                  name="relearning_steps"
                  type="text"
                  value={settings.relearning_steps}
                  onChange={(e) => handleTextChange('relearning_steps', e.target.value)}
                  placeholder="e.g. 10m"
                  className={validationErrors.relearning_steps ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.relearning_steps}
                  aria-describedby={
                    validationErrors.relearning_steps ? 'relearning_steps-error' : undefined
                  }
                />
              </div>
              {validationErrors.relearning_steps && (
                <span id="relearning_steps-error" className="field-error" role="alert">
                  {validationErrors.relearning_steps}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="minimum_interval" className="options-label">
                  Minimum interval (days)
                </label>
                <input
                  id="minimum_interval"
                  disabled={settings.fsrs}
                  name="minimum_interval"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.minimum_interval}
                  onChange={(e) => handleNumberChange('minimum_interval', e.target.value)}
                  className={validationErrors.minimum_interval ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.minimum_interval}
                  aria-describedby={
                    validationErrors.minimum_interval ? 'minimum_interval-error' : undefined
                  }
                />
              </div>
              {validationErrors.minimum_interval && (
                <span id="minimum_interval-error" className="field-error" role="alert">
                  {validationErrors.minimum_interval}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="leech_threshold" className="options-label">
                  Leech threshold
                </label>
                <input
                  id="leech_threshold"
                  name="leech_threshold"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.leech_threshold}
                  onChange={(e) => handleNumberChange('leech_threshold', e.target.value)}
                  className={validationErrors.leech_threshold ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.leech_threshold}
                  aria-describedby={
                    validationErrors.leech_threshold ? 'leech_threshold-error' : undefined
                  }
                />
              </div>
              {validationErrors.leech_threshold && (
                <span id="leech_threshold-error" className="field-error" role="alert">
                  {validationErrors.leech_threshold}
                </span>
              )}
            </div>

            <div className="options-row">
              <label htmlFor="leech_action" className="options-label">
                Leech action
              </label>
              <select
                id="leech_action"
                name="leech_action"
                value={settings.leech_action}
                onChange={(e) => handleTextChange('leech_action', e.target.value)}
              >
                <option>Tag Only</option>
                <option>Suspend Card</option>
              </select>
            </div>
          </section>

          {/* Display Order */}
          <section className="options-card options-panel">
            <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Display Order</h3>
              </div>
            </div>

            <div className="options-row">
              <label htmlFor="new_card_gather_order" className="options-label">
                New card gather order
              </label>
              <select
                id="new_card_gather_order"
                name="new_card_gather_order"
                value={settings.new_card_gather_order}
                onChange={(e) => handleTextChange('new_card_gather_order', e.target.value)}
              >
                <option>Deck</option>
                <option>Deck, then random notes</option>
                <option>Ascending position</option>
                <option>Descending position</option>
                <option>Random notes</option>
                <option>Random cards</option>
              </select>
            </div>

            <div className="options-row">
              <label htmlFor="new_card_sort_order" className="options-label">
                New card sort order
              </label>
              <select
                id="new_card_sort_order"
                name="new_card_sort_order"
                value={settings.new_card_sort_order}
                onChange={(e) => handleTextChange('new_card_sort_order', e.target.value)}
              >
                <option>Card type, then order gathered</option>
                <option>Order gathered</option>
                <option>Card type, then random</option>
                <option>Random note, then card type</option>
                <option>Random</option>
              </select>
            </div>

            <div className="options-row">
              <label htmlFor="new_review_order" className="options-label">
                New/review order
              </label>
              <select
                id="new_review_order"
                name="new_review_order"
                value={settings.new_review_order}
                onChange={(e) => handleTextChange('new_review_order', e.target.value)}
              >
                <option>Mix with reviews</option>
                <option>Show before reviews</option>
                <option>Show after reviews</option>
              </select>
            </div>

            <div className="options-row">
              <label htmlFor="interday_learning_review_order" className="options-label">
                Interday learning/review order
              </label>
              <select
                id="interday_learning_review_order"
                name="interday_learning_review_order"
                value={settings.interday_learning_review_order}
                onChange={(e) =>
                  handleTextChange('interday_learning_review_order', e.target.value)
                }
              >
                <option>Mix with reviews</option>
                <option>Show before reviews</option>
                <option>Show after reviews</option>
              </select>
            </div>

            <div className="options-row">
              <label htmlFor="review_sort_order" className="options-label">
                Review sort order
              </label>
              <select
                id="review_sort_order"
                name="review_sort_order"
                value={settings.review_sort_order}
                onChange={(e) => handleTextChange('review_sort_order', e.target.value)}
              >
                <option>Due date, then random</option>
                <option>Due date, then deck</option>
                <option>Deck, then due date</option>
                <option>Ascending intervals</option>
                <option>Descending intervals</option>
                <option>Ascending ease</option>
                <option>Descending ease</option>
                <option>Relative overdueness</option>
              </select>
            </div>
          </fieldset></section>

          {/* FSRS (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>FSRS</h3>
              </div>
            </div>

            <div className="options-row">
              <label htmlFor="fsrs" className="options-label">
                FSRS
              </label>
              <ToggleSwitch
                id="fsrs"
                label="FSRS"
                checked={settings.fsrs}
                onChange={(val) => handleToggleChange('fsrs', val)}
              />
            </div>

            <div className="options-row">
              <label htmlFor="fsrs_fuzz" className="options-label">
                Spread future review dates (fuzz)
              </label>
              <ToggleSwitch
                id="fsrs_fuzz"
                label="Spread future review dates (fuzz)"
                checked={settings.fsrs_fuzz}
                disabled={!settings.fsrs}
                onChange={(val) => handleToggleChange('fsrs_fuzz', val)}
              />
            </div>
            <p className="options-description">
              Slightly varies future FSRS review intervals. Existing due dates stay unchanged.
            </p>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="fsrs_desired_retention" className="options-label">
                  Desired retention (%)
                </label>
                <input
                  id="fsrs_desired_retention"
                  name="fsrs_desired_retention"
                  type="number"
                  min="70"
                  max="99"
                  step="1"
                  value={
                    settings.fsrs_desired_retention === ('' as unknown as number)
                      ? ''
                      : settings.fsrs_desired_retention != null
                      ? Math.round(Number(settings.fsrs_desired_retention) * 1000) / 10
                      : ''
                  }
                  onChange={(e) => handleRetentionPercentChange(e.target.value)}
                  className={validationErrors.fsrs_desired_retention ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.fsrs_desired_retention}
                  aria-describedby={
                    validationErrors.fsrs_desired_retention
                      ? 'fsrs_desired_retention-error'
                      : undefined
                  }
                />
              </div>
              {validationErrors.fsrs_desired_retention && (
                <span id="fsrs_desired_retention-error" className="field-error" role="alert">
                  {validationErrors.fsrs_desired_retention}
                </span>
              )}
            </div>

            {settings.fsrs && <FsrsOptimizer key={deckId} deckId={Number(deckId)} onUse={parameters => setSettings(old => ({ ...old, fsrs_parameters: parameters }))} />}
            {settings.fsrs_parameters && <details className="fsrs-parameters"><summary>Current FSRS parameters</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(settings.fsrs_parameters)}</pre><button type="button" onClick={() => setSettings(old => ({ ...old, fsrs_parameters: null }))}>Reset to default parameters</button></details>}

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="timezone" className="options-label">
                  Timezone
                </label>
                <input
                  id="timezone"
                  name="timezone"
                  type="text"
                  value={settings.timezone}
                  onChange={(e) => handleTextChange('timezone', e.target.value)}
                  placeholder="e.g. UTC, America/New_York"
                  className={validationErrors.timezone ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.timezone}
                  aria-describedby={
                    validationErrors.timezone ? 'timezone-error' : undefined
                  }
                />
              </div>
              {validationErrors.timezone && (
                <span id="timezone-error" className="field-error" role="alert">
                  {validationErrors.timezone}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="day_starts_at" className="options-label">
                  Day starts at (hours past midnight)
                </label>
                <input
                  id="day_starts_at"
                  name="day_starts_at"
                  type="number"
                  min="0"
                  max="23"
                  step="1"
                  value={settings.day_starts_at}
                  onChange={(e) => handleNumberChange('day_starts_at', e.target.value)}
                  className={validationErrors.day_starts_at ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.day_starts_at}
                  aria-describedby={
                    validationErrors.day_starts_at ? 'day_starts_at-error' : undefined
                  }
                />
              </div>
              {validationErrors.day_starts_at && (
                <span id="day_starts_at-error" className="field-error" role="alert">
                  {validationErrors.day_starts_at}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="learning_ahead_seconds" className="options-label">
                  Learning ahead limit (seconds)
                </label>
                <input
                  id="learning_ahead_seconds"
                  name="learning_ahead_seconds"
                  type="number"
                  min="0"
                  max="3600"
                  step="1"
                  value={settings.learning_ahead_seconds}
                  onChange={(e) => handleNumberChange('learning_ahead_seconds', e.target.value)}
                  className={validationErrors.learning_ahead_seconds ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.learning_ahead_seconds}
                  aria-describedby={
                    validationErrors.learning_ahead_seconds
                      ? 'learning_ahead_seconds-error'
                      : undefined
                  }
                />
              </div>
              {validationErrors.learning_ahead_seconds && (
                <span id="learning_ahead_seconds-error" className="field-error" role="alert">
                  {validationErrors.learning_ahead_seconds}
                </span>
              )}
            </div>
          </section>
        </div>

        {/* Right Column */}
        <div className="options-col">
          {/* Burying (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Burying</h3>
              </div>
            </div>
            <div className="options-row">
              <label htmlFor="bury_new_siblings" className="options-label">
                Bury new siblings
              </label>
              <ToggleSwitch
                id="bury_new_siblings"
                label="Bury new siblings"
                checked={settings.bury_new_siblings}
                onChange={(val) => handleToggleChange('bury_new_siblings', val)}
              />
            </div>
            <div className="options-row">
              <label htmlFor="bury_review_siblings" className="options-label">
                Bury review siblings
              </label>
              <ToggleSwitch
                id="bury_review_siblings"
                label="Bury review siblings"
                checked={settings.bury_review_siblings}
                onChange={(val) => handleToggleChange('bury_review_siblings', val)}
              />
            </div>
            <div className="options-row">
              <label
                htmlFor="bury_interday_learning_siblings"
                className="options-label"
              >
                Bury interday learning siblings
              </label>
              <ToggleSwitch
                id="bury_interday_learning_siblings"
                label="Bury interday learning siblings"
                checked={settings.bury_interday_learning_siblings}
                onChange={(val) => handleToggleChange('bury_interday_learning_siblings', val)}
              />
            </div>
          </section>

          {/* Audio (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Audio</h3>
              </div>
            </div>
            <div className="options-row">
              <label htmlFor="dont_play_audio_automatically" className="options-label">
                Don't play audio automatically
              </label>
              <ToggleSwitch
                id="dont_play_audio_automatically"
                label="Don't play audio automatically"
                checked={settings.dont_play_audio_automatically}
                onChange={(val) => handleToggleChange('dont_play_audio_automatically', val)}
              />
            </div>
            <div className="options-row">
              <label
                htmlFor="skip_question_when_replaying_answer"
                className="options-label"
              >
                Skip question when replaying answer
              </label>
              <ToggleSwitch
                id="skip_question_when_replaying_answer"
                label="Skip question when replaying answer"
                checked={settings.skip_question_when_replaying_answer}
                onChange={(val) =>
                  handleToggleChange('skip_question_when_replaying_answer', val)
                }
              />
            </div>
          </section>

          {/* Timers (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Timers</h3>
              </div>
            </div>
            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="maximum_answer_seconds" className="options-label">
                  Maximum answer seconds
                </label>
                <input
                  id="maximum_answer_seconds"
                  name="maximum_answer_seconds"
                  type="number"
                  min="1"
                  max="3600"
                  step="1"
                  value={settings.maximum_answer_seconds}
                  onChange={(e) => handleNumberChange('maximum_answer_seconds', e.target.value)}
                  className={validationErrors.maximum_answer_seconds ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.maximum_answer_seconds}
                  aria-describedby={
                    validationErrors.maximum_answer_seconds
                      ? 'maximum_answer_seconds-error'
                      : undefined
                  }
                />
              </div>
              {validationErrors.maximum_answer_seconds && (
                <span id="maximum_answer_seconds-error" className="field-error" role="alert">
                  {validationErrors.maximum_answer_seconds}
                </span>
              )}
            </div>
            <div className="options-row">
              <label htmlFor="show_on_screen_timer" className="options-label">
                Show on-screen timer
              </label>
              <ToggleSwitch
                id="show_on_screen_timer"
                label="Show on-screen timer"
                checked={settings.show_on_screen_timer}
                onChange={(val) => handleToggleChange('show_on_screen_timer', val)}
              />
            </div>
            <div className="options-row">
              <label
                htmlFor="stop_on_screen_timer_on_answer"
                className="options-label"
              >
                Stop on-screen timer on answer
              </label>
              <ToggleSwitch
                id="stop_on_screen_timer_on_answer"
                label="Stop on-screen timer on answer"
                checked={settings.stop_on_screen_timer_on_answer}
                onChange={(val) => handleToggleChange('stop_on_screen_timer_on_answer', val)}
              />
            </div>
          </section>

          {/* Auto Advance (Active) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Auto Advance</h3>
              </div>
            </div>
            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="seconds_to_show_question_for" className="options-label">
                  Seconds to show question for
                </label>
                <input
                  id="seconds_to_show_question_for"
                  name="seconds_to_show_question_for"
                  type="number"
                  min="0"
                  max="3600"
                  step="0.1"
                  value={settings.seconds_to_show_question_for}
                  onChange={(e) =>
                    handleNumberChange('seconds_to_show_question_for', e.target.value)
                  }
                  className={validationErrors.seconds_to_show_question_for ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.seconds_to_show_question_for}
                  aria-describedby={
                    validationErrors.seconds_to_show_question_for
                      ? 'seconds_to_show_question_for-error'
                      : undefined
                  }
                />
              </div>
              {validationErrors.seconds_to_show_question_for && (
                <span id="seconds_to_show_question_for-error" className="field-error" role="alert">
                  {validationErrors.seconds_to_show_question_for}
                </span>
              )}
            </div>
            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="seconds_to_show_answer_for" className="options-label">
                  Seconds to show answer for
                </label>
                <input
                  id="seconds_to_show_answer_for"
                  name="seconds_to_show_answer_for"
                  type="number"
                  min="0"
                  max="3600"
                  step="0.1"
                  value={settings.seconds_to_show_answer_for}
                  onChange={(e) =>
                    handleNumberChange('seconds_to_show_answer_for', e.target.value)
                  }
                  className={validationErrors.seconds_to_show_answer_for ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.seconds_to_show_answer_for}
                  aria-describedby={
                    validationErrors.seconds_to_show_answer_for
                      ? 'seconds_to_show_answer_for-error'
                      : undefined
                  }
                />
              </div>
              {validationErrors.seconds_to_show_answer_for && (
                <span id="seconds_to_show_answer_for-error" className="field-error" role="alert">
                  {validationErrors.seconds_to_show_answer_for}
                </span>
              )}
            </div>
            <div className="options-row">
              <label htmlFor="wait_for_audio" className="options-label">
                Wait for audio
              </label>
              <ToggleSwitch
                id="wait_for_audio"
                label="Wait for audio"
                checked={settings.wait_for_audio}
                onChange={(val) => handleToggleChange('wait_for_audio', val)}
              />
            </div>
            <div className="options-row">
              <label htmlFor="question_action" className="options-label">
                Question action
              </label>
              <select
                id="question_action"
                name="question_action"
                value={settings.question_action}
                onChange={(e) => handleTextChange('question_action', e.target.value)}
              >
                <option>Show Answer</option>
              </select>
            </div>
            <div className="options-row">
              <label htmlFor="answer_action" className="options-label">
                Answer action
              </label>
              <select
                id="answer_action"
                name="answer_action"
                value={settings.answer_action}
                onChange={(e) => handleTextChange('answer_action', e.target.value)}
              >
                <option>Bury Card</option>
                <option>Good</option>
                <option>Hard</option>
                <option>Again</option>
                <option>Easy</option>
              </select>
            </div>
          </section>

          {/* Easy Days (Inactive / Unsupported) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Easy Days</h3>
                <span className="status-pill pill-inactive">Not yet active</span>
              </div>
            </div>
            <p className="options-inactive-notice">
              Easy Days review rebalancing is not yet active on the backend. Settings are retained.
            </p>
            <div className="easy-days-header" aria-hidden="true">
              <span />
              <div className="easy-days-labels">
                <span className="easy-days-label-min">Minimum</span>
                <span className="easy-days-label-mid">Reduced</span>
                <span className="easy-days-label-max">Normal</span>
              </div>
            </div>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
              <div className="slider-row" key={day}>
                <label htmlFor={`easy_days_${day}`} className="day-label disabled">
                  {day}
                </label>
                <input
                  id={`easy_days_${day}`}
                  type="range"
                  className="glass-slider disabled"
                  min="0"
                  max="100"
                  value={settings.easy_days?.[day] ?? 100}
                  disabled={true}
                  aria-label={`${day} load percentage`}
                  aria-disabled="true"
                  readOnly
                />
              </div>
            ))}
          </section>

          {/* Advanced (Active SM-2 Settings) */}
          <section className="options-card options-panel">
            <div className="options-card-header">
              <div className="options-card-title-group">
                <h3>Advanced</h3>
              </div>
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="maximum_interval" className="options-label">
                  Maximum interval (days)
                </label>
                <input
                  id="maximum_interval"
                  name="maximum_interval"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.maximum_interval}
                  onChange={(e) => handleNumberChange('maximum_interval', e.target.value)}
                  className={validationErrors.maximum_interval ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.maximum_interval}
                  aria-describedby={
                    validationErrors.maximum_interval ? 'maximum_interval-error' : undefined
                  }
                />
              </div>
              {validationErrors.maximum_interval && (
                <span id="maximum_interval-error" className="field-error" role="alert">
                  {validationErrors.maximum_interval}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="starting_ease" className="options-label">
                  Starting ease
                </label>
                <input
                  id="starting_ease"
                  disabled={settings.fsrs}
                  name="starting_ease"
                  type="number"
                  min="1.0"
                  step="0.05"
                  value={settings.starting_ease}
                  onChange={(e) => handleNumberChange('starting_ease', e.target.value)}
                  className={validationErrors.starting_ease ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.starting_ease}
                  aria-describedby={
                    validationErrors.starting_ease ? 'starting_ease-error' : undefined
                  }
                />
              </div>
              {validationErrors.starting_ease && (
                <span id="starting_ease-error" className="field-error" role="alert">
                  {validationErrors.starting_ease}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="easy_bonus" className="options-label">
                  Easy bonus
                </label>
                <input
                  id="easy_bonus"
                  disabled={settings.fsrs}
                  name="easy_bonus"
                  type="number"
                  min="1.0"
                  step="0.05"
                  value={settings.easy_bonus}
                  onChange={(e) => handleNumberChange('easy_bonus', e.target.value)}
                  className={validationErrors.easy_bonus ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.easy_bonus}
                  aria-describedby={
                    validationErrors.easy_bonus ? 'easy_bonus-error' : undefined
                  }
                />
              </div>
              {validationErrors.easy_bonus && (
                <span id="easy_bonus-error" className="field-error" role="alert">
                  {validationErrors.easy_bonus}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="interval_modifier" className="options-label">
                  Interval modifier
                </label>
                <input
                  id="interval_modifier"
                  disabled={settings.fsrs}
                  name="interval_modifier"
                  type="number"
                  min="0.1"
                  step="0.05"
                  value={settings.interval_modifier}
                  onChange={(e) => handleNumberChange('interval_modifier', e.target.value)}
                  className={validationErrors.interval_modifier ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.interval_modifier}
                  aria-describedby={
                    validationErrors.interval_modifier ? 'interval_modifier-error' : undefined
                  }
                />
              </div>
              {validationErrors.interval_modifier && (
                <span id="interval_modifier-error" className="field-error" role="alert">
                  {validationErrors.interval_modifier}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="hard_interval" className="options-label">
                  Hard interval
                </label>
                <input
                  id="hard_interval"
                  disabled={settings.fsrs}
                  name="hard_interval"
                  type="number"
                  min="0.1"
                  step="0.05"
                  value={settings.hard_interval}
                  onChange={(e) => handleNumberChange('hard_interval', e.target.value)}
                  className={validationErrors.hard_interval ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.hard_interval}
                  aria-describedby={
                    validationErrors.hard_interval ? 'hard_interval-error' : undefined
                  }
                />
              </div>
              {validationErrors.hard_interval && (
                <span id="hard_interval-error" className="field-error" role="alert">
                  {validationErrors.hard_interval}
                </span>
              )}
            </div>

            <div className="options-row-with-error">
              <div className="options-row-main">
                <label htmlFor="new_interval" className="options-label">
                  New interval
                </label>
                <input
                  id="new_interval"
                  disabled={settings.fsrs}
                  name="new_interval"
                  type="number"
                  min="0.0"
                  step="0.05"
                  value={settings.new_interval}
                  onChange={(e) => handleNumberChange('new_interval', e.target.value)}
                  className={validationErrors.new_interval ? 'has-error' : ''}
                  aria-invalid={!!validationErrors.new_interval}
                  aria-describedby={
                    validationErrors.new_interval ? 'new_interval-error' : undefined
                  }
                />
              </div>
              {validationErrors.new_interval && (
                <span id="new_interval-error" className="field-error" role="alert">
                  {validationErrors.new_interval}
                </span>
              )}
            </div>

            <div className="options-row" style={{ marginTop: '0.75rem' }}>
              <label htmlFor="custom_scheduling" className="options-label disabled">
                Custom scheduling
              </label>
              <ToggleSwitch
                id="custom_scheduling"
                label="Custom scheduling"
                checked={settings.custom_scheduling}
                disabled={true}
                onChange={(val) => handleToggleChange('custom_scheduling', val)}
              />
            </div>
            <p className="options-inactive-notice" style={{ marginTop: '0.5rem' }}>
              Custom scheduling scripts are not yet active on the backend. Settings are retained.
            </p>
          </section>
        </div>
      </div>
      </fieldset>
    </div>
  );
};

export default function DeckOptionsPage() {
  const { deckId } = useParams<{ deckId: string }>();
  return <DeckOptionsPageContent key={deckId} />;
}
