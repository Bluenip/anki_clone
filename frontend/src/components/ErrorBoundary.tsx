import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { usePrefs } from '../context/usePrefs';

function CrashNotice() {
  const { t } = usePrefs();
  return (
    <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
      <p>{t('common.pageCrashed')}</p>
      <p>{t('common.pageCrashedHint')}</p>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        {t('common.reload')}
      </button>
    </div>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack);
  }

  render() {
    return this.state.failed ? <CrashNotice /> : this.props.children;
  }
}

/** Keeps a crashing page (or a page chunk deleted by a newer deploy) from blanking the whole app.
 *  Navigating to another route gives that page a fresh try. */
export default function ErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
