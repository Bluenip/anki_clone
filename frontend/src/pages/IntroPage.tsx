import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import type { MessageKey } from '../i18n/en';
import './IntroPage.css';
import { usePrefs } from '../context/usePrefs';

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

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const IntroPage = () => {
  const { user } = useAuth();
  const { t, lang } = usePrefs();
  const src = `/guide-media/guide-${lang}.mp4`;
  const video = useRef<HTMLVideoElement>(null);

  const jump = (at: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = at;
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
    v.play().catch(() => {});
  };

  return (
    <div className="intro-page">
      <header className="intro-hero">
        <p className="intro-kicker">{t('intro.kicker')}</p>
        <h1>{t('intro.title')}</h1>
        <p className="intro-lead">{t('intro.lead')}</p>
        <div className="intro-actions">
          {user ? (
            <Link to="/decks" className="btn btn-primary">{t('intro.goDecks')}</Link>
          ) : (
            <>
              <Link to="/register" className="btn btn-primary">{t('intro.createFree')}</Link>
              <Link to="/login" className="btn btn-ghost">{t('auth.signIn')}</Link>
            </>
          )}
        </div>
      </header>

      <div className="intro-layout">
        <div className="intro-video glass-card">
          {/* key: switching language loads the other narration from the start */}
          <video key={lang} ref={video} controls preload="metadata" playsInline poster={`/guide-media/poster-${lang}.jpg`}>
            <source src={src} type="video/mp4" />
            {t('intro.noVideo')} <a href={src}>{t('intro.download')}</a>.
          </video>
        </div>

        <ol className="intro-steps" aria-label={t('intro.steps')}>
          {INTRO_STEPS.map((s, i) => (
            <li key={s.title}>
              <button type="button" onClick={() => jump(s.at[lang])}>
                <span className="intro-step-num">{i + 1}</span>
                <span className="intro-step-body">
                  <span className="intro-step-title">{t(s.title)}<time>{fmt(s.at[lang])}</time></span>
                  <span className="intro-step-text">{t(s.text)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};

export default IntroPage;
