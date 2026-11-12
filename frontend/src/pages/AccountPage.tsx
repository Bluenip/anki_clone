import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import client from '../api/client';
import { useAuth } from '../context/useAuth';
import { usePrefs } from '../context/usePrefs';

const AccountPage = () => {
  const [activeTab, setActiveTab] = useState<'email' | 'password'>('email');
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { t } = usePrefs();
  
  // Email Form State
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  
  // Password Form State
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleUpdateEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await client.put('/api/auth/me/email', { new_email: newEmail, password: emailPassword });
      setSuccess(t('account.emailUpdated'));
      setEmailPassword('');
    } catch (err: any) {
      setError(err.response?.data?.detail || t('account.emailFailed'));
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await client.put('/api/auth/me/password', { current_password: currentPassword, new_password: newPassword });
      setSuccess(t('account.passwordUpdated'));
      setCurrentPassword('');
      setNewPassword('');
    } catch (err: any) {
      setError(err.response?.data?.detail || t('account.passwordFailed'));
    }
  };

  const handleRemoveAccount = async () => {
    if (window.confirm(t('account.confirmDelete'))) {
      try {
        await client.delete('/api/auth/me');
        logout();
        navigate('/login');
      } catch (err: any) {
        setError(err.response?.data?.detail || t('account.deleteFailed'));
      }
    }
  };

  return (
    <div className="page-container account-page">
      <div className="account-header">
        <h1>{t('account.title')}</h1>
        <button className="btn btn-ghost" style={{ color: 'var(--accent-cyan)' }} onClick={handleRemoveAccount}>
          {t('account.remove')}
        </button>
      </div>

      {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}
      {success && <div className="success-message" style={{ color: 'var(--success)', marginBottom: '1rem' }}>{success}</div>}

      <div className="account-layout glass-card">
        <div className="account-tabs">
          <button 
            className={`btn ${activeTab === 'email' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ textAlign: 'left', justifyContent: 'flex-start' }}
            onClick={() => { setActiveTab('email'); setError(''); setSuccess(''); }}
          >
            {t('account.changeEmail')}
          </button>
          <button 
            className={`btn ${activeTab === 'password' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ textAlign: 'left', justifyContent: 'flex-start' }}
            onClick={() => { setActiveTab('password'); setError(''); setSuccess(''); }}
          >
            {t('account.changePassword')}
          </button>
        </div>

        <div className="account-content">
          {activeTab === 'email' && (
            <form onSubmit={handleUpdateEmail} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <input 
                  type="email" 
                  placeholder={t('account.newEmail')} 
                  value={newEmail} 
                  onChange={e => setNewEmail(e.target.value)} 
                  required 
                />
              </div>
              <div className="form-group">
                <input 
                  type="password" 
                  placeholder={t('account.currentPassword')} 
                  value={emailPassword} 
                  onChange={e => setEmailPassword(e.target.value)} 
                  required 
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary">{t('account.update')}</button>
              </div>
            </form>
          )}

          {activeTab === 'password' && (
            <form onSubmit={handleUpdatePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <input 
                  type="password" 
                  placeholder={t('account.currentPassword')} 
                  value={currentPassword} 
                  onChange={e => setCurrentPassword(e.target.value)} 
                  required 
                />
              </div>
              <div className="form-group">
                <input 
                  type="password" 
                  placeholder={t('auth.newPassword')} 
                  value={newPassword} 
                  onChange={e => setNewPassword(e.target.value)} 
                  required 
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary">{t('account.update')}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default AccountPage;
