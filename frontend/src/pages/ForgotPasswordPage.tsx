import { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPasswordApi } from '../api/auth';

const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setNewPassword('');
    setLoading(true);
    
    try {
      const res = await forgotPasswordApi(email);
      setMessage(res.data.message);
      if (res.data.new_password) {
        setNewPassword(res.data.new_password);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to process request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass-card">
        <div className="auth-header">
          <span className="auth-icon">🔑</span>
          <h1>Reset Password</h1>
          <p>Enter your email to receive a new password</p>
        </div>
        
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        
        {newPassword && (
          <div className="alert alert-warning" style={{ textAlign: 'left', marginTop: '10px' }}>
            <strong>Your temporary password is:</strong>
            <div style={{ fontSize: '1.2rem', padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', margin: '10px 0', textAlign: 'center', letterSpacing: '2px' }}>
              {newPassword}
            </div>
            <small>Please copy this password, log in, and change it immediately in your Account Settings.</small>
          </div>
        )}

        {!newPassword && (
          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="email">Email</label>
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
              {loading ? 'Processing...' : 'Reset Password'}
            </button>
          </form>
        )}
        
        <p className="auth-footer">
          Remembered your password? <Link to="/login">Sign In</Link>
        </p>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;
