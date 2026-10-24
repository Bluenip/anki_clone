import client from './client';

export interface OptionPreset {
  id: number;
  name: string;
  settings: string;
  version: number;
  used_by: number[];
}

export interface DeckOptionsLimits {
  new_cards_per_day?: number;
  maximum_reviews_per_day?: number;
}

export interface DeckOptionsResponse {
  preset_id: number | null;
  preset_name: string | null;
  preset_version: number | null;
  preset_settings: string | null;
  settings: string;
  overrides: DeckOptionsLimits;
  today: {
    day?: string;
    limits?: DeckOptionsLimits;
  } | Record<string, never>;
  presets: OptionPreset[];
}

export interface SaveLimitsPayload {
  scope: 'preset' | 'deck' | 'today';
  new_cards_per_day: number | null;
  maximum_reviews_per_day: number | null;
  expected_version?: number;
}

export const getDeckOptions = (deckId: number) =>
  client.get<DeckOptionsResponse>(`/api/decks/${deckId}/options`);

export const createPreset = (name: string, settings: string) =>
  client.post<OptionPreset>('/api/options/presets', { name, settings });

export const bindPreset = (deckId: number, presetId: number | null) =>
  client.put<DeckOptionsResponse>(`/api/decks/${deckId}/options/preset`, { preset_id: presetId });

export const saveDeckOptions = (deckId: number, settings: string, expectedVersion?: number | null) =>
  client.put<DeckOptionsResponse>(`/api/decks/${deckId}/options`, {
    settings,
    ...(expectedVersion != null ? { expected_version: expectedVersion } : {}),
  });

export const saveLimits = (deckId: number, payload: SaveLimitsPayload) =>
  client.put<DeckOptionsResponse>(`/api/decks/${deckId}/options/limits`, payload);
