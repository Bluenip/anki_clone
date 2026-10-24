export interface Deck {
  id: number;
  name: string;
  description: string;
  settings: string;
  is_shared: boolean;
  created_at: string;
  updated_at: string;
  total_cards: number;
  new_cards: number;
  learn_cards: number;
  due_cards: number;
}

export type DeckSummary = Pick<Deck, 'id' | 'name'>;

export interface Card {
  id: number;
  deck_id: number;
  front: string;
  back: string;
  created_at: string;
  updated_at: string;
  due_date?: string;
  state?: number;
  repetitions?: number;
  interval?: number;
  ease_factor?: number;
}

export type BulkActionType = 'suspend' | 'unsuspend' | 'bury' | 'unbury' | 'move' | 'add_tags' | 'remove_tags' | 'flag';

export interface BulkCardItem {
  card_id: number;
  expected_version: number;
}

export interface BulkActionRequest {
  flag?: number;
  action: BulkActionType;
  cards: BulkCardItem[];
  target_deck_id?: number;
  tags?: string[];
}

export interface BulkActionResult {
  updated: number;
  updated_notes?: number;
}

export interface BrowseCard extends Card {
  deck_name: string;
  next_review?: string | null;
  interval_days?: number | null;
  version: number;
  is_suspended: boolean;
  is_buried: boolean;
  card_state: string;
  note_id: number | null;
}

export interface StudyInterval {
  display: string;
  [key: string]: unknown;
}

export interface StudyCard {
  card_id: number;
  deck_id?: number;
  deck_name: string;
  front: string;
  back: string;
  is_new?: boolean;
  card_state?: string;
  learning_step?: number;
  intervals?: {
    again?: StudyInterval;
    hard?: StudyInterval;
    good?: StudyInterval;
    easy?: StudyInterval;
  };
  version?: number;
  note_id?: number | null;
  card_css?: string;
  rendered?: boolean;
  settings?: Record<string, unknown>;
}

export interface StudyStats {
  total_cards?: number;
  new_cards?: number;
  learn_cards?: number;
  due_cards?: number;
  learned_cards?: number;
  avg_ease?: number;
  streak_days?: number;
  next_learning_at?: string | null;
}

export interface SharedDeck {
  id: number;
  title: string;
  description: string;
  category: string;
  download_count: number;
  rating: number;
  rating_count: number;
  notes_count: number;
  has_audio: boolean;
  has_images: boolean;
  shared_at: string;
  username: string;
  deck_id?: number;
  user_id?: number;
}
