import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { CardFaceRef } from './CardFace';
import type { StudyCard } from '../api/types';

export default function StudyAutomation({ card, face, showAnswer, busy, onReveal, onRate, onBury }: {
  card: StudyCard; face: RefObject<CardFaceRef | null>; showAnswer: boolean; busy: boolean;
  onReveal: () => void; onRate: (rating: number) => void; onBury: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  const latest = useRef({ busy, onReveal, onRate, onBury });
  useLayoutEffect(() => { latest.current = { busy, onReveal, onRate, onBury }; }, [busy, onReveal, onRate, onBury]);
  useEffect(() => { started.current = Date.now(); }, [card.card_id]);
  useEffect(() => {
    const settings = card.settings || {}, phaseStarted = Date.now();
    const currentFace = face.current;
    let acted = false, played = false;
    const timer = setInterval(() => {
      if (!(showAnswer && settings.stop_on_screen_timer_on_answer)) setElapsed(Math.min(Number(settings.maximum_answer_seconds) || 60, Math.floor((Date.now() - started.current) / 1000)));
      if (!played && Date.now() - phaseStarted >= 100 && face.current?.getIframe()?.contentDocument?.readyState === 'complete') {
        played = true;
        if (!settings.dont_play_audio_automatically) void face.current.playAudio({ skipFront: showAnswer && Boolean(settings.skip_question_when_replaying_answer) });
      }
      if (!played || acted || latest.current.busy) return;
      const seconds = Number(showAnswer ? settings.seconds_to_show_answer_for : settings.seconds_to_show_question_for) || 0;
      if (seconds <= 0 || Date.now() - phaseStarted < seconds * 1000 || settings.wait_for_audio !== false && face.current?.isPlaying()) return;
      acted = true;
      if (!showAnswer) {
        const action = String(settings.question_action || 'Show Answer').toLowerCase().replaceAll('_', ' ');
        if (action === 'show answer') latest.current.onReveal();
        else if (action.includes('bury')) latest.current.onBury();
      } else {
        const action = String(settings.answer_action || 'Bury Card').toLowerCase();
        const rating = ({ again: 1, hard: 2, good: 3, easy: 4 } as Record<string, number>)[action];
        if (rating) latest.current.onRate(rating);
        else if (action.includes('bury')) latest.current.onBury();
      }
    }, 100);
    return () => { clearInterval(timer); currentFace?.stopAudio(); };
  }, [card.card_id, card.settings, showAnswer, face]);
  return card.settings?.show_on_screen_timer ? <span aria-label="Study timer">{elapsed}s</span> : null;
}
