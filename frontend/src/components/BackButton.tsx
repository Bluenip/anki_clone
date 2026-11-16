import { Link } from 'react-router-dom';
import { usePrefs } from '../context/usePrefs';

interface BackButtonProps {
  /** The page one level up, e.g. a deck page goes back to the deck list. */
  to: string;
}

/**
 * "← Back" always goes UP to the parent page, never back in browser history.
 * History-based back loops between two pages that link to each other
 * (deck page ⇄ study page), so the deck list could never be reached.
 */
export default function BackButton({ to }: BackButtonProps) {
  const { t } = usePrefs();
  return (
    <Link to={to} className="btn btn-ghost btn-sm back-button">
      ← {t('study.back')}
    </Link>
  );
}
