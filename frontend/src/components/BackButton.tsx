import { useLocation, useNavigate } from 'react-router-dom';
import { usePrefs } from '../context/usePrefs';

interface BackButtonProps {
  /** Where to go when there is no in-app page to return to (opened from a link or a reload). */
  fallback: string;
}

/** "← Back": returns to the previous in-app page, else to the page's logical parent. */
export default function BackButton({ fallback }: BackButtonProps) {
  const { t } = usePrefs();
  const navigate = useNavigate();
  const location = useLocation();
  // React Router gives the first entry of a session the key "default"; anything else came from in-app navigation.
  const canGoBack = location.key !== 'default';
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm back-button"
      onClick={() => (canGoBack ? navigate(-1) : navigate(fallback))}
    >
      ← {t('study.back')}
    </button>
  );
}
