import { createEmptyCard, fsrs, State } from 'ts-fsrs';
import type { Card as Memory, Grade, StepUnit } from 'ts-fsrs';
import type { CachedCard } from './offline';
export type LocalState = { card_state: string; learning_step: number; interval_days: number; ease_factor: number; repetitions: number; lapse_count: number; is_suspended: boolean; next_review: string | null; fsrs_card?: Record<string, unknown>; memory?: Memory };
const seconds = (value: unknown) => String(value ?? '').trim().split(/\s+/).filter(Boolean).map(token => { const match = token.match(/^(\d+(?:\.\d+)?)([smhd]?)$/)!; return Math.floor(Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] || 'm']!)); });
function localParts(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, Number(p.value)]));
}
export function nextLocalDay(now: Date, zone: string, rollover: number, days: number): Date {
  const p = localParts(now, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day + days - (p.hour < rollover ? 1 : 0), rollover);
  let utc = wall;
  for (let i = 0; i < 4; i++) { const candidate = localParts(new Date(utc), zone); const offset = Date.UTC(candidate.year, candidate.month - 1, candidate.day, candidate.hour, candidate.minute, candidate.second) - utc; const next = wall - offset; if (next === utc) break; utc = next; }
  return new Date(utc);
}

// Local timing keeps learning usable without connectivity. Server replay owns
// the final schedule, including collection-wide load balancing and sibling bury.
export function scheduleOffline(card: CachedCard, rating: number, now = new Date()): CachedCard {
  const c = card.offline_config || card.settings || {};
  const n = (key: string, fallback: number) => Number(c[key] ?? fallback);
  const original = card.offline_state;
  if (!original) return { ...card, eligible: false, version: (card.version ?? 0) + 1 };
  const state = structuredClone(original);
  let due: Date;
  if (c.fsrs) {
    let memory = state.memory;
    if (!memory) {
      const raw = state.fsrs_card || {};
      memory = { ...createEmptyCard(now), elapsed_days: 0, scheduled_days: state.interval_days, due: raw.due ? new Date(String(raw.due)) : now,
        stability: Number(raw.stability || 0), difficulty: Number(raw.difficulty || 0),
        state: raw.stability == null ? State.New : Number(raw.state), learning_steps: Number(raw.step || 0),
        reps: state.repetitions, lapses: state.lapse_count,
        last_review: raw.last_review ? new Date(String(raw.last_review)) : undefined };
    }
    const steps = (value: unknown) => seconds(value).map(s => `${s / 60}m` as StepUnit);
    const scheduler = fsrs({ request_retention: n('fsrs_desired_retention', .9), maximum_interval: n('maximum_interval', 36500), enable_fuzz: false,
      ...(Array.isArray(c.fsrs_parameters) ? { w: c.fsrs_parameters as number[] } : {}), learning_steps: steps(c.learning_steps ?? '1m 10m'), relearning_steps: steps(c.relearning_steps ?? '10m') });
    const next = scheduler.next(memory, now, rating as Grade).card;
    state.memory = next; state.card_state = next.state === State.Review ? 'review' : next.state === State.Relearning ? 'relearning' : 'learning';
    state.learning_step = next.learning_steps; state.repetitions = next.reps; state.lapse_count = next.lapses;
    state.interval_days = next.scheduled_days; due = next.due;
  } else {
    let delay = 0;
    const graduate = (relearn: boolean) => {
      state.card_state = 'review'; state.learning_step = 0;
      state.interval_days = relearn ? Math.max(Math.floor(state.interval_days * n('new_interval', 0)), n('minimum_interval', 1)) : rating === 4 ? n('easy_interval', 4) : n('graduating_interval', 1);
      state.repetitions = relearn ? 0 : 1;
    };
    const reviewInterval = () => {
      const old = state.interval_days, reps = state.repetitions, mod = n('interval_modifier', 1);
      if (rating === 2) state.interval_days = reps === 0 ? 1 : reps === 1 ? Math.max(Math.floor(n('hard_interval', 1.2) * mod), 1) : Math.max(Math.floor(old * n('hard_interval', 1.2) * mod), old + 1);
      if (rating === 3) state.interval_days = reps === 0 ? n('graduating_interval', 1) : reps === 1 ? 6 : Math.max(Math.floor(old * state.ease_factor * mod), old + 1);
      if (rating === 4) state.interval_days = reps === 0 ? n('easy_interval', 4) : reps === 1 ? Math.max(Math.floor(6 * n('easy_bonus', 1.3) * mod), 7) : Math.max(Math.floor(old * state.ease_factor * n('easy_bonus', 1.3) * mod), old + 1);
      const q = [0, 0, 3, 4, 5][rating]; state.ease_factor = Math.max(1.3, Math.round((state.ease_factor + .1 - (5-q) * (.08 + (5-q) * .02)) * 100) / 100);
      state.repetitions++;
    };
    if (state.card_state === 'review') {
      if (rating === 1) {
        state.ease_factor = Math.max(1.3, Math.round((state.ease_factor - .8) * 100) / 100); state.lapse_count++;
        const steps = seconds(c.relearning_steps ?? '10m');
        if (steps.length) { state.card_state = 'relearning'; state.learning_step = 0; delay = steps[0]; } else graduate(true);
      } else reviewInterval();
    } else {
      const relearn = state.card_state === 'relearning';
      const steps = seconds(relearn ? c.relearning_steps ?? '10m' : c.learning_steps ?? '1m 10m');
      state.card_state = relearn ? 'relearning' : 'learning';
      if (!steps.length) { if (relearn) graduate(true); else { state.repetitions = 0; reviewInterval(); state.interval_days = Math.max(state.interval_days, n('graduating_interval', 1)); state.card_state = 'review'; } }
      else if (rating === 4) graduate(relearn);
      else if (rating === 1) { state.learning_step = 0; delay = steps[0]; }
      else if (rating === 2) { const i = Math.min(state.learning_step, steps.length - 1); delay = i === 0 ? steps.length > 1 ? Math.floor((steps[0] + steps[1]) / 2) : Math.floor(steps[0] * 1.5) : steps[i]; }
      else { state.learning_step++; if (state.learning_step >= steps.length) graduate(relearn); else delay = steps[state.learning_step]; }
    }
    state.interval_days = Math.min(state.interval_days, n('maximum_interval', 36500));
    due = new Date(now.getTime() + delay * 1000);
  }
  if (state.card_state === 'review') due = nextLocalDay(now, String(c.timezone || 'UTC'), n('day_starts_at', 0), Math.max(1, state.interval_days));
  if (state.lapse_count >= n('leech_threshold', 8) && ['Suspend Card', 'suspend'].includes(String(c.leech_action))) state.is_suspended = true;
  state.next_review = due.toISOString();
  return { ...card, version: (card.version ?? 0) + 1, card_state: state.card_state, learning_step: state.learning_step, offline_state: state, local_due: due.toISOString() };
}
