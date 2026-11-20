import type { MessageKey } from '../i18n/en';

// Each step's start (seconds) in public/guide-media/guide-{vi,en}.mp4; the two narrations run at different paces.
export const INTRO_STEPS: { at: { vi: number; en: number }; title: MessageKey; text: MessageKey }[] = [
  { at: { vi: 8, en: 8 }, title: 'intro.step.login', text: 'intro.step.login.text' },
  { at: { vi: 21, en: 24 }, title: 'intro.step.decks', text: 'intro.step.decks.text' },
  { at: { vi: 34, en: 40 }, title: 'intro.step.open', text: 'intro.step.open.text' },
  { at: { vi: 47, en: 54 }, title: 'intro.step.type', text: 'intro.step.type.text' },
  { at: { vi: 56, en: 65 }, title: 'intro.step.correct', text: 'intro.step.correct.text' },
  { at: { vi: 65, en: 75 }, title: 'intro.step.listen', text: 'intro.step.listen.text' },
  { at: { vi: 72, en: 83 }, title: 'intro.step.wrong', text: 'intro.step.wrong.text' },
  { at: { vi: 83, en: 96 }, title: 'intro.step.add', text: 'intro.step.add.text' },
  { at: { vi: 93, en: 109 }, title: 'intro.step.browse', text: 'intro.step.browse.text' },
  { at: { vi: 102, en: 119 }, title: 'intro.step.stats', text: 'intro.step.stats.text' },
  { at: { vi: 112, en: 130 }, title: 'intro.step.custom', text: 'intro.step.custom.text' },
  { at: { vi: 121, en: 140 }, title: 'intro.step.account', text: 'intro.step.account.text' },
];
