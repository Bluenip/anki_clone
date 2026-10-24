import React, { useState, useEffect } from 'react';
import type { DeckOptionsResponse, OptionPreset } from '../api/options';
import { bindPreset, createPreset, saveLimits } from '../api/options';
import type { DeckSettings } from '../pages/DeckOptionsPage';

export interface OptionsPresetsProps {
  deckId: number;
  options: DeckOptionsResponse;
  currentSettings: DeckSettings;
  onOptionsUpdate: (updated: DeckOptionsResponse) => void;
  onReload: () => void;
  onBusyChange?: (busy: boolean) => void;
}

export const OptionsPresets: React.FC<OptionsPresetsProps> = ({
  deckId,
  options,
  currentSettings,
  onOptionsUpdate,
  onReload,
  onBusyChange,
}) => {
  // Preset management state
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [newPresetName, setNewPresetName] = useState<string>('');
  const [presetLoading, setPresetLoading] = useState<boolean>(false);
  const [presetError, setPresetError] = useState<string | null>(null);

  // Daily limits overrides state
  const [scope, setScope] = useState<'preset' | 'deck' | 'today'>('preset');
  const [draft, setDraft] = useState({ key: '', newCards: '', maxReviews: '' });
  const [limitsLoading, setLimitsLoading] = useState<boolean>(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [is409Conflict, setIs409Conflict] = useState<boolean>(false);
  const [limitsSuccess, setLimitsSuccess] = useState<string | null>(null);

  useEffect(() => {
    onBusyChange?.(presetLoading || limitsLoading);
    return () => onBusyChange?.(false);
  }, [presetLoading, limitsLoading, onBusyChange]);

  const draftKey = JSON.stringify([deckId, scope, options.preset_id, options.preset_version, options.preset_settings, options.overrides, options.today]);
  let initial: { new_cards_per_day?: number; maximum_reviews_per_day?: number } = {};
  if (scope === 'preset') {
    try { initial = JSON.parse(options.preset_settings || '{}'); } catch { /* Parent validates saved settings. */ }
  } else if (scope === 'deck') initial = options.overrides || {};
  else initial = options.today?.limits || {};
  const newCardsInput = draft.key === draftKey ? draft.newCards : String(initial.new_cards_per_day ?? '');
  const maxReviewsInput = draft.key === draftKey ? draft.maxReviews : String(initial.maximum_reviews_per_day ?? '');
  const setNewCardsInput = (value: string) => setDraft({ key: draftKey, newCards: value, maxReviews: maxReviewsInput });
  const setMaxReviewsInput = (value: string) => setDraft({ key: draftKey, newCards: newCardsInput, maxReviews: value });
  const changeScope = (value: 'preset' | 'deck' | 'today') => {
    setScope(value); setLimitsError(null); setIs409Conflict(false); setLimitsSuccess(null);
  };

  // Find currently bound preset
  const currentPreset: OptionPreset | undefined = options.presets?.find(
    (p) => p.id === options.preset_id
  );
  const usedByCount = currentPreset ? currentPreset.used_by.length : 0;

  // Effective settings calculation
  let effectiveNewCards = 20;
  let effectiveMaxReviews = 200;
  try {
    const eff = JSON.parse(options.settings || '{}');
    if (eff.new_cards_per_day != null) effectiveNewCards = eff.new_cards_per_day;
    if (eff.maximum_reviews_per_day != null) effectiveMaxReviews = eff.maximum_reviews_per_day;
  } catch {
    // default to standard
  }

  const handleAttachPreset = async () => {
    if (!selectedPresetId) return;
    setPresetLoading(true);
    setPresetError(null);
    try {
      const res = await bindPreset(deckId, Number(selectedPresetId));
      onOptionsUpdate(res.data);
      setSelectedPresetId('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to attach preset';
      setPresetError(message);
    } finally {
      setPresetLoading(false);
    }
  };

  const handleDetachPreset = async () => {
    setPresetLoading(true);
    setPresetError(null);
    try {
      const res = await bindPreset(deckId, null);
      onOptionsUpdate(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to detach preset';
      setPresetError(message);
    } finally {
      setPresetLoading(false);
    }
  };

  const handleCreatePreset = async () => {
    const trimmed = newPresetName.trim();
    if (!trimmed) return;
    setPresetLoading(true);
    setPresetError(null);
    try {
      const created = await createPreset(trimmed, JSON.stringify(currentSettings));
      const res = await bindPreset(deckId, created.data.id);
      onOptionsUpdate(res.data);
      setNewPresetName('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create preset';
      setPresetError(message);
    } finally {
      setPresetLoading(false);
    }
  };

  const handleApplyLimits = async () => {
    setLimitsError(null);
    setIs409Conflict(false);
    setLimitsSuccess(null);

    const parseVal = (str: string): number | null | 'invalid' => {
      if (str.trim() === '') return null;
      const num = Number(str.trim());
      if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0 || num > 999999) {
        return 'invalid';
      }
      return num;
    };

    const newCards = parseVal(newCardsInput);
    if (newCards === 'invalid') {
      setLimitsError('New cards/day must be a whole number between 0 and 999,999 (or blank).');
      return;
    }

    const maxReviews = parseVal(maxReviewsInput);
    if (maxReviews === 'invalid') {
      setLimitsError('Maximum reviews/day must be a whole number between 0 and 999,999 (or blank).');
      return;
    }

    setLimitsLoading(true);
    try {
      const res = await saveLimits(deckId, {
        scope,
        new_cards_per_day: newCards,
        maximum_reviews_per_day: maxReviews,
        expected_version: scope === 'preset' ? (options.preset_version ?? undefined) : undefined,
      });
      onOptionsUpdate(res.data);
      setLimitsSuccess('Limits updated successfully!');
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setIs409Conflict(true);
        setLimitsError('Preset conflict: Settings were modified elsewhere. Please reload before saving.');
      } else {
        const message = err?.response?.data?.detail || (err instanceof Error ? err.message : 'Failed to save limits');
        setLimitsError(message);
      }
    } finally {
      setLimitsLoading(false);
    }
  };

  const handleClearOverrides = async () => {
    if (scope === 'preset') return;
    setLimitsError(null);
    setIs409Conflict(false);
    setLimitsSuccess(null);
    setLimitsLoading(true);

    try {
      const res = await saveLimits(deckId, {
        scope,
        new_cards_per_day: null,
        maximum_reviews_per_day: null,
      });
      onOptionsUpdate(res.data);
      setNewCardsInput('');
      setMaxReviewsInput('');
      setLimitsSuccess('Overrides cleared.');
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setIs409Conflict(true);
        setLimitsError('Preset conflict: Settings were modified elsewhere. Please reload before saving.');
      } else {
        const message = err?.response?.data?.detail || (err instanceof Error ? err.message : 'Failed to clear overrides');
        setLimitsError(message);
      }
    } finally {
      setLimitsLoading(false);
    }
  };

  return (
    <fieldset disabled={presetLoading || limitsLoading} className="options-presets-wrapper" style={{ border: 0, padding: 0, minWidth: 0, marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Preset Selector & Management Panel */}
      <section className="options-card options-panel">
        <div className="options-card-header">
          <div className="options-card-title-group">
            <h3>Preset Settings</h3>
          </div>
          <div>
            {options.preset_id ? (
              <span className="options-scope-badge" title="Bound to shared preset">
                <span className="badge-dot" style={{ background: '#22c55e' }} aria-hidden="true" />
                <span>Shared Preset ({usedByCount} {usedByCount === 1 ? 'deck' : 'decks'})</span>
              </span>
            ) : (
              <span className="options-scope-badge" title="Independent deck settings">
                <span className="badge-dot" aria-hidden="true" />
                <span>Standalone settings</span>
              </span>
            )}
          </div>
        </div>

        {presetError && (
          <div className="options-alert options-alert-error" role="alert" style={{ marginBottom: '0.85rem' }}>
            <span>{presetError}</span>
          </div>
        )}

        <div className="options-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <div>
            <strong>Selected Preset: </strong>
            {options.preset_id ? (
              <span>
                <strong data-testid="selected-preset-name">{options.preset_name}</strong> (used by {usedByCount} {usedByCount === 1 ? 'deck' : 'decks'})
              </span>
            ) : (
              <span>No preset bound (using deck settings)</span>
            )}
          </div>
          {options.preset_id != null && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDetachPreset}
              disabled={presetLoading}
            >
              {presetLoading ? 'Detaching...' : 'Detach Preset'}
            </button>
          )}
        </div>

        {/* Attach existing preset dropdown (no fake Default!) */}
        <div className="options-row" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <label htmlFor="preset-select" className="options-label" style={{ minWidth: '130px' }}>
            Attach Preset:
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flex: 1, minWidth: '240px' }}>
            <select
              id="preset-select"
              aria-label="Select preset to attach"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
              disabled={presetLoading}
              style={{ flex: 1 }}
            >
              <option value="">-- Choose a preset --</option>
              {options.presets &&
                options.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.used_by.length} {p.used_by.length === 1 ? 'deck' : 'decks'})
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleAttachPreset}
              disabled={presetLoading || !selectedPresetId}
            >
              Attach
            </button>
          </div>
        </div>

        {/* Create new preset from current base settings */}
        <div className="options-row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <label htmlFor="new-preset-name" className="options-label" style={{ minWidth: '130px' }}>
            New Preset:
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flex: 1, minWidth: '240px' }}>
            <input
              id="new-preset-name"
              type="text"
              placeholder="Enter new preset name"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              disabled={presetLoading}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCreatePreset}
              disabled={presetLoading || !newPresetName.trim()}
            >
              Save as New Preset
            </button>
          </div>
        </div>
      </section>

      {/* Daily Limits Overrides Panel */}
      <section className="options-card options-panel">
        <div className="options-card-header">
          <div className="options-card-title-group">
            <h3>Daily Limits Scope & Overrides</h3>
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted, #94a3b8)' }}>
            Effective limits: <strong>{effectiveNewCards} new</strong> / <strong>{effectiveMaxReviews} reviews</strong>
          </div>
        </div>

        {limitsError && (
          <div className="options-alert options-alert-error" role="alert" style={{ marginBottom: '0.85rem' }}>
            <span>{limitsError}</span>
            {is409Conflict && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: '1rem', padding: '0.2rem 0.6rem' }}
                onClick={onReload}
              >
                Reload Options
              </button>
            )}
          </div>
        )}

        {limitsSuccess && (
          <div className="options-alert options-alert-success" role="status" style={{ marginBottom: '0.85rem' }}>
            <span>{limitsSuccess}</span>
          </div>
        )}

        {/* Scope selector tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }} role="tablist" aria-label="Limits scope selector">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'preset'}
            className={`btn ${scope === 'preset' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '0.35rem 0.85rem', fontSize: '0.85rem' }}
            onClick={() => changeScope('preset')}
          >
            Preset
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'deck'}
            className={`btn ${scope === 'deck' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '0.35rem 0.85rem', fontSize: '0.85rem' }}
            onClick={() => changeScope('deck')}
          >
            This deck
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'today'}
            className={`btn ${scope === 'today' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '0.35rem 0.85rem', fontSize: '0.85rem' }}
            onClick={() => changeScope('today')}
          >
            Today only
          </button>
        </div>

        <p className="options-inactive-notice" style={{ marginBottom: '1rem' }}>
          Today expires at study-day boundary. Blank values remove overrides.
        </p>

        <div className="options-row" style={{ marginBottom: '0.75rem' }}>
          <label htmlFor="override-new-cards" className="options-label">
            New cards/day ({scope === 'preset' ? 'Preset' : scope === 'deck' ? 'This deck' : 'Today'})
          </label>
          <input
            id="override-new-cards"
            name="override_new_cards"
            type="number"
            min="0"
            max="999999"
            placeholder={scope === 'preset' ? 'Base count' : 'Blank = no override'}
            value={newCardsInput}
            onChange={(e) => setNewCardsInput(e.target.value)}
            disabled={limitsLoading}
          />
        </div>

        <div className="options-row" style={{ marginBottom: '1.25rem' }}>
          <label htmlFor="override-max-reviews" className="options-label">
            Maximum reviews/day ({scope === 'preset' ? 'Preset' : scope === 'deck' ? 'This deck' : 'Today'})
          </label>
          <input
            id="override-max-reviews"
            name="override_max_reviews"
            type="number"
            min="0"
            max="999999"
            placeholder={scope === 'preset' ? 'Base count' : 'Blank = no override'}
            value={maxReviewsInput}
            onChange={(e) => setMaxReviewsInput(e.target.value)}
            disabled={limitsLoading}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          {(scope === 'deck' || scope === 'today') && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClearOverrides}
              disabled={limitsLoading}
            >
              Clear overrides
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleApplyLimits}
            disabled={limitsLoading}
          >
            {limitsLoading ? 'Applying...' : 'Apply limits'}
          </button>
        </div>
      </section>
    </fieldset>
  );
};
