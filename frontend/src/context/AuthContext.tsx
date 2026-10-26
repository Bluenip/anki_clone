import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { getMeApi } from '../api/auth';
import { clearOffline } from '../utils/offline';
import { AuthContext } from './auth-context-base';
import type { User } from './auth-context-base';

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(localStorage.getItem('token')));

  useEffect(() => {
    if (!token) return;
    let isMounted = true;
    getMeApi()
      .then((res) => {
        if (isMounted) { setUser(res.data); localStorage.setItem('offline-user', JSON.stringify({ token, user: res.data })); }
      })
      .catch((error) => {
        if (!error.response) {
          try {
            const saved = JSON.parse(localStorage.getItem('offline-user') || 'null');
            if (saved?.token === token && saved.user?.id) { if (isMounted) setUser(saved.user); return; }
          } catch { /* Invalid local identity cannot authenticate an offline session. */ }
        }
        if (isMounted) {
          localStorage.removeItem('token');
          setToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('token', newToken);
    localStorage.setItem('offline-user', JSON.stringify({ token: newToken, user: newUser }));
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    if (user) void clearOffline(user.id).catch(() => {});
    localStorage.removeItem('offline-user');
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};
