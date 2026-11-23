import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { getMeApi, logoutApi } from '../api/auth';
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
        if (isMounted) setUser(res.data);
      })
      .catch(() => {
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
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    void logoutApi().catch(() => undefined);  // clears the media cookie
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
