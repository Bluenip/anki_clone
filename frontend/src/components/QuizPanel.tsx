import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { checkQuiz } from '../api/study';
import type { QuizAnswer } from '../api/study';
import type { QuizExercise, QuizResult, StudyCard } from '../api/types';
import { usePrefs } from '../context/usePrefs';
import type { MessageKey } from '../i18n/en';
import './QuizPanel.css';

const RATING_KEYS: Record<number, MessageKey> = { 1: 'rate.again', 2: 'rate.hard', 3: 'rate.good', 4: 'rate.easy' };
const INTERVAL_KEYS = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' } as const;

/** Loose client-side match used only to unlock "Continue" after a wrong answer. */
const loose = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\s]+/gu, ' ').trim();

interface QuizPanelProps {
  card: StudyCard;
  exercise: QuizExercise;
  disabled: boolean;
  onReveal: () => void;
  onSubmit: (answer: QuizAnswer, rating: number) => void;
}

export default function QuizPanel({ card, exercise, disabled, onReveal, onSubmit }: QuizPanelProps) {
  const { t } = usePrefs();
  const [response, setResponse] = useState('');
  const [hintUsed, setHintUsed] = useState(false);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [retype, setRetype] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState<number[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const retypeRef = useRef<HTMLInputElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isChoice = exercise.type === 'multiple_choice';
  const needsRetype = Boolean(result && !result.correct && !isChoice);
  const retypeOk = !needsRetype || (result !== null && loose(retype) === loose(result.expected));

  const speak = useCallback(() => {
    if (exercise.audio) {
      audioRef.current?.pause();
      // Same-origin path (proxied to the backend), like card audio; the page CSP only allows media-src 'self'.
      const audio = new Audio(exercise.audio);
      audioRef.current = audio;
      void audio.play().catch(() => undefined);
      return;
    }
    if (exercise.tts && window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined') {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(exercise.tts.text);
      utterance.lang = exercise.tts.lang;
      utterance.rate = 0.9;
      const voice = window.speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').startsWith(exercise.tts!.lang));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    }
  }, [exercise]);
  const canSpeak = Boolean(exercise.audio || exercise.tts);

  useEffect(() => {
    if (exercise.type === 'listening' || exercise.type === 'copy') {
      const timer = setTimeout(speak, 250);
      return () => clearTimeout(timer);
    }
  }, [exercise, speak]);

  useEffect(() => () => {
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => { if (!isChoice) inputRef.current?.focus(); }, [isChoice]);
  useEffect(() => {
    if (!result) return;
    if (needsRetype) retypeRef.current?.focus();
    else continueRef.current?.focus();
  }, [result, needsRetype]);

  const submit = useCallback(async (value: string) => {
    if (checking || result || disabled) return;
    if (!value.trim()) { inputRef.current?.focus(); return; }
    setChecking(true);
    setError(null);
    try {
      const res = await checkQuiz(card.card_id, { response: value, hint_used: hintUsed });
      setResponse(value);
      setResult(res.data);
      onReveal();
    } catch (err: any) {
      setError(err?.response?.data?.detail || t('quiz.checkFailed'));
    } finally {
      setChecking(false);
    }
  }, [checking, result, disabled, card.card_id, hintUsed, onReveal, t]);

  const finish = useCallback(() => {
    if (!result || !retypeOk || disabled) return;
    onSubmit({ response, hint_used: hintUsed }, result.rating);
  }, [result, retypeOk, disabled, onSubmit, response, hintUsed]);

  // Number keys pick a multiple-choice option; Enter continues after feedback.
  // Bound before paint (like StudyPage) so a key pressed as soon as the card appears is not lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toUpperCase();
      if (result && e.key === 'Enter' && tag !== 'BUTTON' && (tag !== 'INPUT' || retypeOk)) {
        e.preventDefault();
        finish();
      } else if (!result && canSpeak && (e.key === 'r' || e.key === 'R') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        // Before answering, R replays the exercise audio (the card itself is still hidden).
        e.preventDefault();
        speak();
      } else if (!result && isChoice && /^[1-9]$/.test(e.key) && exercise.options) {
        const option = exercise.options[Number(e.key) - 1];
        if (option !== undefined) { e.preventDefault(); void submit(option); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result, retypeOk, finish, isChoice, exercise.options, submit, canSpeak, speak]);

  const prompt = () => {
    switch (exercise.type) {
      case 'copy':
        return (
          <>
            <p className="quiz-instruction">{t('quiz.copy')}</p>
            <div className="quiz-word">
              {exercise.word}
              {canSpeak && <button type="button" className="quiz-speaker quiz-speaker-sm" onClick={speak} aria-label={t('quiz.playAgain')} title={`${t('quiz.playAgain')} (R)`}>🔊</button>}
            </div>
            {exercise.meaning && <div className="quiz-meaning">{exercise.meaning}</div>}
            {exercise.example && <div className="quiz-example">{exercise.example}</div>}
          </>
        );
      case 'typing':
        return (
          <>
            <p className="quiz-instruction">{t('quiz.typing')}</p>
            <div className="quiz-meaning quiz-big">{exercise.meaning}</div>
          </>
        );
      case 'listening':
        return (
          <>
            <p className="quiz-instruction">{t('quiz.listening')}</p>
            <button type="button" className="quiz-speaker" onClick={speak} aria-label={t('quiz.playAgain')}>🔊</button>
            {!canSpeak && <p role="status">{t('card.noSpeech')}</p>}
          </>
        );
      case 'cloze':
        return (
          <>
            <p className="quiz-instruction">{t('quiz.cloze')}</p>
            <div className="quiz-sentence">{exercise.sentence}</div>
            {exercise.meaning && <div className="quiz-meaning">{exercise.meaning}</div>}
          </>
        );
      case 'scramble':
        return (
          <>
            <p className="quiz-instruction">{t('quiz.scramble')}</p>
            <div className="quiz-meaning quiz-big">{exercise.meaning}</div>
            <div className="quiz-letters">
              {(exercise.letters || []).map((letter, index) => (
                <button key={index} type="button" className="quiz-letter" disabled={used.includes(index) || Boolean(result)}
                  onClick={() => { setUsed(u => [...u, index]); setResponse(r => r + letter); inputRef.current?.focus(); }}>
                  {letter}
                </button>
              ))}
            </div>
          </>
        );
      case 'multiple_choice':
        return exercise.direction === 'word_to_meaning' ? (
          <>
            <p className="quiz-instruction">{t('quiz.chooseMeaning')}</p>
            <div className="quiz-word">
              {exercise.word}
              {canSpeak && <button type="button" className="quiz-speaker quiz-speaker-sm" onClick={speak} aria-label={t('quiz.playAgain')}>🔊</button>}
            </div>
          </>
        ) : (
          <>
            <p className="quiz-instruction">{t('quiz.chooseWord')}</p>
            <div className="quiz-meaning quiz-big">{exercise.meaning}</div>
          </>
        );
    }
  };

  const verdictKey: MessageKey = !result ? 'quiz.correct' : result.result === 'correct' ? 'quiz.correct' : result.result === 'close' ? 'quiz.close' : 'quiz.wrong';
  const interval = result ? card.intervals?.[INTERVAL_KEYS[result.rating as 1 | 2 | 3 | 4]]?.display : undefined;

  return (
    <div className="quiz-panel glass-card" data-testid="quiz-panel">
      <div className="quiz-type-label">{t(`quiz.type.${exercise.type}` as MessageKey)}</div>
      <div className="quiz-prompt">{prompt()}</div>

      {isChoice ? (
        <div className="quiz-options">
          {(exercise.options || []).map((option, index) => {
            const state = !result ? '' : loose(option) === loose(result.expected) ? 'is-correct' : option === response ? 'is-wrong' : 'is-dim';
            return (
              <button key={index} type="button" className={`quiz-option ${state}`} disabled={Boolean(result) || checking || disabled}
                onClick={() => void submit(option)}>
                <span className="quiz-option-key">{index + 1}</span>{option}
              </button>
            );
          })}
        </div>
      ) : (
        <form className="quiz-form" onSubmit={e => { e.preventDefault(); void submit(response); }}>
          <input
            ref={inputRef}
            className={`quiz-input ${result ? (result.correct ? 'is-correct' : 'is-wrong') : ''}`}
            value={response}
            onChange={e => { setResponse(e.target.value); if (exercise.type === 'scramble' && !e.target.value) setUsed([]); }}
            readOnly={Boolean(result)}
            placeholder={t('quiz.placeholder')}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            aria-label={t('quiz.placeholder')}
          />
          {!result && (
            <div className="quiz-form-actions">
              {exercise.type === 'scramble' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResponse(''); setUsed([]); inputRef.current?.focus(); }}>
                  {t('quiz.clear')}
                </button>
              )}
              {exercise.hint && (
                hintUsed
                  ? <span className="quiz-hint" aria-live="polite">{exercise.hint}</span>
                  : <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setHintUsed(true); inputRef.current?.focus(); }}>💡 {t('quiz.hint')}</button>
              )}
              <button type="submit" className="btn btn-primary" disabled={checking || disabled || !response.trim()}>
                {t('quiz.check')}
              </button>
            </div>
          )}
        </form>
      )}

      {error && <p className="quiz-error" role="alert">{error}</p>}

      {result && (
        <div className={`quiz-feedback quiz-${result.result}`} role="status">
          <div className="quiz-verdict">
            {result.result === 'correct' ? '✅' : result.result === 'close' ? '🟡' : '❌'} {t(verdictKey)}
          </div>
          {result.result !== 'correct' && (
            <div className="quiz-expected">{t('quiz.answerIs')} <strong>{result.expected}</strong></div>
          )}
          {needsRetype && (
            <input
              ref={retypeRef}
              className={`quiz-input ${retypeOk ? 'is-correct' : ''}`}
              value={retype}
              onChange={e => setRetype(e.target.value)}
              placeholder={t('quiz.retype')}
              aria-label={t('quiz.retype')}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
          )}
          <div className="quiz-continue-row">
            <span className="quiz-rating">
              {t('quiz.countedAs')} <strong className={`quiz-rating-${result.rating}`}>{t(RATING_KEYS[result.rating])}</strong>
              {interval && <> · {interval}</>}
              {hintUsed && result.correct && <> · {t('quiz.hintUsed')}</>}
            </span>
            <button ref={continueRef} type="button" className="btn btn-primary" disabled={!retypeOk || disabled} onClick={finish}>
              {t('quiz.continue')} ↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
