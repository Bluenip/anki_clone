import { useContext } from 'react';
import { AuthContext } from './auth-context-base';

export const useAuth = () => useContext(AuthContext);
