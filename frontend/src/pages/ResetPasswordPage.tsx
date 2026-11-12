import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { resetPasswordApi } from '../api/auth';
import { usePrefs } from '../context/usePrefs';

const ResetPasswordPage = () => {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { t } = usePrefs();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await resetPasswordApi(token, password);
      setDone(true);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail[0]?.msg ?? t('auth.resetFailed') : t('auth.resetFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass-card">
        <div className="auth-header">
          <span className="auth-icon">🔑</span>
          <h1>{t('auth.chooseNewPassword')}</h1>
        </div>

        {!token && <div className="alert alert-error">{t('auth.missingToken')}</div>}
        {error && <div className="alert alert-error">{error}</div>}
        {done && <div className="alert alert-success">{t('auth.resetDone')}</div>}

        {token && !done && (
          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="new-password">{t('auth.newPassword')}</label>
              <input id="new-password" type="password" minLength={8} maxLength={72} autoComplete="new-password"
                value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">{t('auth.confirmNewPassword')}</label>
              <input id="confirm-password" type="password" minLength={8} maxLength={72} autoComplete="new-password"
                value={confirm} onChange={e => setConfirm(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
              {loading ? t('auth.processing') : t('auth.resetPassword')}
            </button>
          </form>
        )}

        <p className="auth-footer">
          {done ? <Link to="/login">{t('auth.signIn')}</Link> : <Link to="/forgot-password">{t('auth.requestNewLink')}</Link>}
        </p>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
