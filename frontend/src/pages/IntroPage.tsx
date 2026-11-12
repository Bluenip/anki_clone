import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import type { MessageKey } from '../i18n/en';
import './IntroPage.css';
import { usePrefs } from '../context/usePrefs';

// Start time (seconds) of each step in public/intro/huong-dan.mp4.
export const INTRO_STEPS: { at: number; title: MessageKey; text: MessageKey }[] = [
  { at: 8, title: 'intro.step.login', text: 'intro.step.login.text' },
  { at: 22, title: 'intro.step.decks', text: 'intro.step.decks.text' },
  { at: 41, title: 'intro.step.open', text: 'intro.step.open.text' },
  { at: 54, title: 'intro.step.front', text: 'intro.step.front.text' },
  { at: 71, title: 'intro.step.rate', text: 'intro.step.rate.text' },
  { at: 92, title: 'intro.step.add', text: 'intro.step.add.text' },
  { at: 110, title: 'intro.step.browse', text: 'intro.step.browse.text' },
  { at: 128, title: 'intro.step.stats', text: 'intro.step.stats.text' },
  { at: 142, title: 'intro.step.custom', text: 'intro.step.custom.text' },
  { at: 156, title: 'intro.step.account', text: 'intro.step.account.text' },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const IntroPage = () => {
  const { user } = useAuth();
  const { t } = usePrefs();
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
          <video ref={video} controls preload="metadata" playsInline poster="/guide-media/poster.jpg">
            <source src="/guide-media/huong-dan.mp4" type="video/mp4" />
            {t('intro.noVideo')} <a href="/guide-media/huong-dan.mp4">{t('intro.download')}</a>.
          </video>
        </div>

        <ol className="intro-steps" aria-label={t('intro.steps')}>
          {INTRO_STEPS.map((s, i) => (
            <li key={s.at}>
              <button type="button" onClick={() => jump(s.at)}>
                <span className="intro-step-num">{i + 1}</span>
                <span className="intro-step-body">
                  <span className="intro-step-title">{t(s.title)}<time>{fmt(s.at)}</time></span>
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
