import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import client from '../api/client';

const AccountPage = () => {
  const [activeTab, setActiveTab] = useState<'email' | 'password'>('email');
  const navigate = useNavigate();
  
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
    if (window.confirm("Are you sure you want to completely remove your account? This action cannot be undone.")) {
      try {
        await client.delete('/api/auth/me');
        localStorage.removeItem('token');
        navigate('/login');
      } catch (err) {
        alert('Failed to delete account');
      }
    }
  };

  return (
    <div className="page-container" style={{ maxWidth: '900px', margin: '2rem auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', margin: 0 }}>Account Settings</h1>
        <button className="btn btn-ghost" style={{ color: 'var(--accent-cyan)' }} onClick={handleRemoveAccount}>
          Remove Account
        </button>
      </div>

      {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}
      {success && <div className="success-message" style={{ color: 'var(--success)', marginBottom: '1rem' }}>{success}</div>}

      <div style={{ display: 'flex', gap: '2rem', background: 'var(--surface-light)', borderRadius: '12px', padding: '2rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: '200px' }}>
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

        <div style={{ flex: 1 }}>
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
