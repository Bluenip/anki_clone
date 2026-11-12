import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loginApi } from '../api/auth';
import { useAuth } from '../context/useAuth';
import { usePrefs } from '../context/usePrefs';

const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const { t } = usePrefs();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await loginApi(email, password);
      login(res.data.access_token, res.data.user);
      navigate('/decks');
    } catch (err: any) {
      setError(err.response?.data?.detail || t('auth.loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass-card">
        <div className="auth-header">
          <span className="auth-icon">⚡</span>
          <h1>{t('auth.welcomeBack')}</h1>
          <p>{t('auth.signInSubtitle')}</p>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">{t('auth.email')}</label>
            <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" required />
          </div>
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="password">{t('auth.password')}</label>
              <Link to="/forgot-password" style={{ fontSize: '0.85rem', color: 'var(--accent-blue)', textDecoration: 'none' }}>
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? t('auth.signingIn') : t('auth.signIn')}
          </button>
        </form>
        <p className="auth-footer">
          {t('auth.noAccount')} <Link to="/register">{t('nav.signup')}</Link>
        </p>
        <p className="auth-footer">
          {t('auth.firstTime')} <Link to="/intro">{t('auth.watchGuide')}</Link>
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
