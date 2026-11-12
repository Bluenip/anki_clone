import { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPasswordApi } from '../api/auth';
import { usePrefs } from '../context/usePrefs';

const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { t } = usePrefs();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    
    try {
      const res = await forgotPasswordApi(email);
      setMessage(res.data.message);
    } catch {
      setError(t('auth.requestFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass-card">
        <div className="auth-header">
          <span className="auth-icon">🔑</span>
          <h1>{t('auth.resetPassword')}</h1>
          <p>{t('auth.enterEmail')}</p>
        </div>
        
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        
        {!message && (
          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="email">{t('auth.email')}</label>
              <input 
                id="email" 
                type="email" 
                value={email} 
                onChange={e => setEmail(e.target.value)} 
                placeholder="your@email.com" 
                required 
              />
            </div>
            <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
              {loading ? t('auth.processing') : t('auth.resetPassword')}
            </button>
          </form>
        )}
        
        <p className="auth-footer">
          {t('auth.remembered')} <Link to="/login">{t('auth.signIn')}</Link>
        </p>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;
