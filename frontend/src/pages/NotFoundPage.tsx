import { Link, useLocation } from 'react-router-dom';
import { usePrefs } from '../context/usePrefs';

/** Shown for any address that no route matches, instead of an empty page. */
const NotFoundPage = () => {
  const { t } = usePrefs();
  const { pathname } = useLocation();
  return (
    <div className="page-container" style={{ maxWidth: 560, paddingTop: '3rem' }}>
      <div className="empty-state glass-card">
        <span className="empty-icon" aria-hidden="true">🧭</span>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{t('notFound.title')}</h1>
        <p><code>{pathname}</code></p>
        <p>{t('notFound.text')}</p>
        <Link to="/decks" className="btn btn-primary">{t('notFound.home')}</Link>
      </div>
    </div>
  );
};

export default NotFoundPage;
