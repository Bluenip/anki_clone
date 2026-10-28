import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import client from '../api/client';
import { useAuth } from '../context/useAuth';

const AccountPage = () => {
  const [activeTab, setActiveTab] = useState<'email' | 'password'>('email');
  const navigate = useNavigate();
  const { logout } = useAuth();
  
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
      setSuccess('Email updated successfully!');
      setEmailPassword('');
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to update email');
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await client.put('/api/auth/me/password', { current_password: currentPassword, new_password: newPassword });
      setSuccess('Password updated successfully!');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to update password');
    }
  };

  const handleRemoveAccount = async () => {
    if (window.confirm("Delete your account and all its decks, cards, study history, images, audio, backups and import uploads? This action cannot be undone.")) {
      try {
        await client.delete('/api/auth/me');
        logout();
        navigate('/login');
      } catch (err: any) {
        setError(err.response?.data?.detail || 'Failed to delete account. Please retry.');
      }
    }
  };

  return (
    <div className="page-container account-page">
      <div className="account-header">
        <h1>Account Settings</h1>
        <button className="btn btn-ghost" style={{ color: 'var(--accent-cyan)' }} onClick={handleRemoveAccount}>
          Remove Account
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
            Change Email
          </button>
          <button 
            className={`btn ${activeTab === 'password' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ textAlign: 'left', justifyContent: 'flex-start' }}
            onClick={() => { setActiveTab('password'); setError(''); setSuccess(''); }}
          >
            Change Password
          </button>
        </div>

        <div className="account-content">
          {activeTab === 'email' && (
            <form onSubmit={handleUpdateEmail} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <input 
                  type="email" 
                  placeholder="New email" 
                  value={newEmail} 
                  onChange={e => setNewEmail(e.target.value)} 
                  required 
                />
              </div>
              <div className="form-group">
                <input 
                  type="password" 
                  placeholder="Current password" 
                  value={emailPassword} 
                  onChange={e => setEmailPassword(e.target.value)} 
                  required 
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary">Update</button>
              </div>
            </form>
          )}

          {activeTab === 'password' && (
            <form onSubmit={handleUpdatePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <input 
                  type="password" 
                  placeholder="Current password" 
                  value={currentPassword} 
                  onChange={e => setCurrentPassword(e.target.value)} 
                  required 
                />
              </div>
              <div className="form-group">
                <input 
                  type="password" 
                  placeholder="New password" 
                  value={newPassword} 
                  onChange={e => setNewPassword(e.target.value)} 
                  required 
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary">Update</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default AccountPage;
